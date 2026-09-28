import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/session", () => ({
  requireUser: vi.fn(async () => "test-user-id"),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// Bọc SPY quanh bản THẬT (không thay bằng hàm giả): cần khẳng định hàng rào được LẮP vào đường
// xoá, chứ không chỉ tồn tại trong thư viện — lỗi đã gặp là viết hàng rào rồi quên gọi nó.
vi.mock("@/lib/backup/khoa-viec-nang", async (importActual) => {
  const that =
    await importActual<typeof import("@/lib/backup/khoa-viec-nang")>();
  return {
    ...that,
    kiemGiuKhoaTrongTransaction: vi.fn(that.kiemGiuKhoaTrongTransaction),
  };
});

import {
  giuKhoaViecNang,
  MatKhoaViecNang,
  taoCheckpoint,
  traKhoaViecNang,
} from "@/lib/backup/khoa-viec-nang";
import { rebuildFromRaw } from "@/lib/bronze/rebuild";
import { SHOP_KHO, SHOP_SHOPEE } from "../helpers/shop-ids-fixture";
import { prisma } from "@/lib/prisma";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * HÀNG RÀO PHẢI NẰM Ở CALLER THẬT, không chỉ trong primitive.
 *
 * Kịch bản hỏng: lượt dựng lại (chạy hàng phút) giành khoá rồi không gia hạn ⇒ khoá hết hạn ⇒ lượt
 * "Xóa dữ liệu giao dịch" giành được, chốt kho thô thành đã-xoá-tay rồi xoá Sổ ⇒ lượt dựng lại CŨ
 * vẫn chạy tiếp với quyền ghi đè của lượt tay và dựng dữ liệu trở lại. Nút xoá báo thành công nhưng
 * bị hoàn tác ngầm.
 *
 * Suite này ép đúng lịch xen kẽ đó: tạm dừng caller thật giữa chừng → ép hết hạn → cho việc khác
 * giành → cho caller cũ chạy tiếp → khẳng định nó DỪNG và dữ liệu vừa xoá KHÔNG sống lại.
 */

const KHOA_KEY = "khoaViecNang";

const don = (id: string) => ({
  id,
  status: 3,
  inserted_at: "2026-07-01T10:00:00.000000",
  order_sources_name: "Shopee",
  marketplace_id: "-3",
  total_price: 200000,
  total_discount: 0,
  fee_marketplace: 15000,
  items: [
    {
      quantity: 2,
      discount_each_product: 0,
      variation_info: {
        display_id: "SKU-MK1",
        name: "SP",
        retail_price: 100000,
      },
    },
  ],
});

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.rawPancakeOrder.deleteMany();
  await prisma.rawShopeeWalletTxn.deleteMany();
  await prisma.rawPancakeProduct.deleteMany();
  await prisma.variant.deleteMany();
  await prisma.product.deleteMany();
  await prisma.shopeeSettlement.deleteMany();
  await prisma.setting.deleteMany({ where: { key: KHOA_KEY } });
});

describe("mất khoá giữa chừng ⇒ caller THẬT phải dừng ghi", () => {
  it("lượt dựng lại mất khoá ⇒ ném ở checkpoint và KHÔNG dựng lại dữ liệu vừa bị xoá", async () => {
    // Kho thô có 30 đơn, đã bị chốt là "đã xoá tay" (như thể lượt xoá vừa chạy xong).
    await prisma.rawPancakeOrder.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({
        shopId: SHOP_SHOPEE,
        externalId: `ORD-MK-${i}`,
        payloadHash: `h-${i}`,
        payload: don(`ORD-MK-${i}`),
        fetchedAt: new Date(Date.now() - 60_000),
        silverOutcome: "DISCARDED",
      })),
    });
    expect(await prisma.order.count()).toBe(0);

    const g = await giuKhoaViecNang("dựng lại từ kho thô");
    if (!g.the) throw new Error("phải giành được khoá");

    // Ép khoá hết hạn NGAY (như thể lượt dựng bị treo lâu hơn hạn) rồi cho việc khác giành.
    await prisma.setting.update({
      where: { key: KHOA_KEY },
      data: {
        value: `${g.the.token}|${Date.now() - 1000}|dựng lại từ kho thô`,
      },
    });
    const kia = await giuKhoaViecNang("xoá dữ liệu giao dịch");
    expect(kia.the).not.toBeNull();

    // Caller CŨ chạy tiếp: checkpoint phải chặn nó lại.
    await expect(
      rebuildFromRaw([], taoCheckpoint(g.the)),
    ).rejects.toBeInstanceOf(MatKhoaViecNang);

    // Dữ liệu vừa bị xoá KHÔNG được sống lại.
    expect(await prisma.order.count()).toBe(0);
    const conDISCARDED = await prisma.rawPancakeOrder.count({
      where: { silverOutcome: "DISCARDED" },
    });
    expect(conDISCARDED).toBe(30);

    if (kia.the) await traKhoaViecNang(kia.the);
  });

  it("còn giữ khoá thì checkpoint cho chạy tiếp bình thường", async () => {
    // Chống vá quá tay: hàng rào không được chặn nhầm lượt đang giữ khoá hợp lệ.
    await prisma.rawPancakeOrder.create({
      data: {
        shopId: SHOP_SHOPEE,
        externalId: "ORD-MK-OK",
        payloadHash: "h-ok",
        payload: don("ORD-MK-OK"),
        fetchedAt: new Date(Date.now() - 60_000),
      },
    });

    const g = await giuKhoaViecNang("dựng lại từ kho thô");
    if (!g.the) throw new Error("phải giành được khoá");
    try {
      const stats = await rebuildFromRaw([], taoCheckpoint(g.the));
      expect(stats.ordersUpserted).toBe(1);
      expect(await prisma.order.count()).toBe(1);
    } finally {
      await traKhoaViecNang(g.the);
    }
  });

  it("checkpoint GIA HẠN khoá — việc khác không giành được giữa chừng", async () => {
    // Gia hạn phải gắn với TIẾN ĐỘ THẬT: mỗi lần chấm mốc là một lần đẩy hạn. Nhờ vậy không cần
    // timer nền — thứ mà repo đã chốt là không dùng, vì timer sống độc lập với công việc nên việc
    // treo cứng vẫn giữ khoá vô hạn.
    const g = await giuKhoaViecNang("việc dài");
    if (!g.the) throw new Error("phải giành được khoá");
    try {
      await prisma.setting.update({
        where: { key: KHOA_KEY },
        data: { value: `${g.the.token}|${Date.now() + 500}|việc dài` }, // sắp hết hạn
      });

      await taoCheckpoint(g.the)(); // chấm mốc ⇒ đẩy hạn ra xa

      const kia = await giuKhoaViecNang("việc khác");
      expect(kia.the).toBeNull(); // không giành nổi vì hạn đã tươi
    } finally {
      await traKhoaViecNang(g.the);
    }
  });

  it("mất lease Ở STREAM MUỘN (sau orders): dừng trước, KHÔNG dựng lại bảng đã xoá", async () => {
    // Test đầu ép hết hạn TRƯỚC khi chạy nên checkpoint ĐẦU TIÊN đã đủ chặn — gỡ hết checkpoint
    // phía sau vẫn xanh. Đây mới là ca thật: caller chạy, gia hạn thành công vài lần, rồi MỚI mất
    // lease ở một stream muộn. Chốt: dòng ví Shopee (stream muộn) KHÔNG được dựng lại sau khi Sổ
    // của nó đã bị xoá.
    await prisma.rawPancakeOrder.create({
      data: {
        shopId: SHOP_SHOPEE,
        externalId: "ORD-MK-EARLY",
        payloadHash: "h-early",
        payload: don("ORD-MK-EARLY"),
        fetchedAt: new Date(Date.now() - 60_000),
      },
    });
    // Dòng ví Shopee đã land ở kho thô, nhưng Silver "Tiền đã về" đã bị xoá (như thể vừa xoá dữ
    // liệu). Nếu lượt dựng lại chạy tới stream shopee thì nó sẽ tái tạo — mà nó KHÔNG được, vì đã
    // mất lease từ trước đó.
    await prisma.rawShopeeWalletTxn.create({
      data: {
        shopId: SHOP_SHOPEE,
        externalId: "2026-07-01T10:00:00+07:00|REVENUE|ORD9|50000",
        payloadHash: "h-wallet",
        payload: {
          txnTime: "2026-07-01T10:00:00+07:00",
          type: "REVENUE",
          orderCode: "ORD9",
          amount: 50000,
          status: "done",
          runningBalance: 50000,
        },
      },
    });

    const g = await giuKhoaViecNang("dựng lại từ kho thô");
    if (!g.the) throw new Error("phải giành được khoá");

    // Checkpoint THẬT, nhưng cướp lease ngay khi phát hiện orders đã xong (Order.count > 0) — tức
    // ở một mốc SAU orders, TRƯỚC khi tới stream shopee. Tại checkpoint của orders (i=0) thì Order
    // còn rỗng nên không cướp; orders ghi xong; mốc kế tiếp mới cướp.
    let daCuop = false;
    const cp = async () => {
      if (!daCuop && (await prisma.order.count()) > 0) {
        daCuop = true;
        await prisma.setting.update({
          where: { key: KHOA_KEY },
          data: {
            value: `${g.the.token}|${Date.now() - 1000}|dựng lại từ kho thô`,
          },
        });
        const kia = await giuKhoaViecNang("xoá dữ liệu giao dịch");
        expect(kia.the).not.toBeNull();
      }
      await taoCheckpoint(g.the)();
    };

    await expect(rebuildFromRaw([], cp)).rejects.toBeInstanceOf(
      MatKhoaViecNang,
    );

    expect(daCuop).toBe(true); // đã đi qua orders và bị cướp ở stream muộn
    expect(await prisma.order.count()).toBeGreaterThan(0); // orders ĐÃ ghi trước khi mất lease
    // Stream shopee KHÔNG bao giờ chạy ⇒ Sổ ví vừa xoá KHÔNG sống lại.
    expect(await prisma.shopeeSettlement.count()).toBe(0);

    await prisma.setting.deleteMany({ where: { key: KHOA_KEY } });
  });

  it("mất lease GIỮA vòng ghi của một stream muộn: dừng ở lô kế, không ghi tiếp", async () => {
    // Chứng minh checkpoint nằm TRONG chính vòng ghi của stream muộn (shopee), không chỉ ở ranh
    // giới stream. 60 dòng ví: cướp lease ở mốc thứ hai (i=25) ⇒ chỉ lô đầu 25 dòng được ghi.
    await prisma.rawShopeeWalletTxn.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        shopId: SHOP_SHOPEE,
        externalId: `2026-07-01T10:00:${String(i).padStart(2, "0")}+07:00|REVENUE|W${i}|1000`,
        payloadHash: `h-w-${i}`,
        payload: {
          txnTime: `2026-07-01T10:00:${String(i).padStart(2, "0")}+07:00`,
          type: "REVENUE",
          orderCode: `W${i}`,
          amount: 1000,
          status: "done",
          runningBalance: 1000,
        },
      })),
    });

    const g = await giuKhoaViecNang("dựng lại từ kho thô");
    if (!g.the) throw new Error("phải giành được khoá");

    let lan = 0;
    const cp = async () => {
      lan += 1;
      if (lan === 2) {
        await prisma.setting.update({
          where: { key: KHOA_KEY },
          data: { value: `${g.the.token}|${Date.now() - 1000}|dựng lại` },
        });
        await giuKhoaViecNang("xoá dữ liệu giao dịch");
      }
      await taoCheckpoint(g.the)();
    };

    const { transformFromRaw } =
      await import("@/lib/bronze/transform-from-raw");
    await expect(
      transformFromRaw("shopee/wallet", [], { checkpoint: cp }),
    ).rejects.toBeInstanceOf(MatKhoaViecNang);

    // Lô đầu (25 dòng) ghi trước khi mốc thứ hai cướp lease; 35 dòng sau KHÔNG được ghi.
    expect(await prisma.shopeeSettlement.count()).toBe(25);

    await prisma.setting.deleteMany({ where: { key: KHOA_KEY } });
  });

  it("nhánh PRODUCTS cũng nhận checkpoint: mất lease giữa products thì dừng, không ghi tiếp", async () => {
    // products là stream duy nhất materialize trước khi được thread checkpoint — dễ bị quên. Seed
    // 30 sản phẩm, cướp lease khi đã ghi 25: nếu products KHÔNG nhận checkpoint thì cả 30 ghi hết
    // rồi mới phát hiện mất lease ở stream sau — quá muộn.
    await prisma.rawPancakeProduct.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({
        shopId: SHOP_KHO,
        externalId: `P-MK-${i}`,
        payloadHash: `h-p-${i}`,
        payload: {
          id: `P-MK-${i}`,
          name: `SP ${i}`,
          variations: [
            {
              id: `V-MK-${i}`,
              display_id: `SKU-MK-${i}`,
              retail_price: 100000,
              remain_quantity: 5,
              average_imported_price: 40000,
            },
          ],
        },
        fetchedAt: new Date(Date.now() - 60_000),
      })),
    });

    const g = await giuKhoaViecNang("dựng lại từ kho thô");
    if (!g.the) throw new Error("phải giành được khoá");

    let daCuop = false;
    const cp = async () => {
      if (!daCuop && (await prisma.product.count()) >= 25) {
        daCuop = true;
        await prisma.setting.update({
          where: { key: KHOA_KEY },
          data: { value: `${g.the.token}|${Date.now() - 1000}|dựng lại` },
        });
        await giuKhoaViecNang("xoá dữ liệu giao dịch");
      }
      await taoCheckpoint(g.the)();
    };

    await expect(rebuildFromRaw([], cp)).rejects.toBeInstanceOf(
      MatKhoaViecNang,
    );

    // Chỉ 25 sản phẩm đầu được ghi; 5 sản phẩm sau dừng vì mất lease GIỮA products.
    expect(await prisma.product.count()).toBe(25);

    await prisma.setting.deleteMany({ where: { key: KHOA_KEY } });
  });

  it("mất lease NGAY SAU products ⇒ KHÔNG xoá stockUpdatedAt (câu ghi ngoài vòng lặp cũng phải fenced)", async () => {
    // `variant.updateMany({ stockUpdatedAt: null })` nằm NGOÀI vòng ghi của products. chamMoc trong
    // products chỉ bảo vệ các lượt TRONG vòng; câu này cần một checkpoint RIÊNG trước nó. Nếu
    // products trả rỗng (không chamMoc nào chạy) mà lease đã mất, không có hàng rào thì ta vẫn xoá
    // stockUpdatedAt sau khi mất quyền — kéo lùi tồn realtime của webhook.
    const sp = await prisma.product.create({
      data: { pancakeId: "P-STOCK", name: "SP", syncedAt: new Date() },
    });
    await prisma.variant.create({
      data: {
        pancakeId: "V-STOCK",
        productId: sp.id,
        sku: "SKU-STOCK",
        label: "L",
        stock: 7,
        stockUpdatedAt: new Date("2026-07-27T18:00:00+07:00"),
        syncedAt: new Date(),
      },
    });
    // KHÔNG seed RawPancakeProduct ⇒ products stream chạy 0 dòng (không chamMoc nào trong vòng).

    const g = await giuKhoaViecNang("dựng lại từ kho thô");
    if (!g.the) throw new Error("phải giành được khoá");

    let lan = 0;
    const cp = async () => {
      lan += 1;
      // Lần 1 = mốc trước products (lease còn) ⇒ qua. Lần 2 = mốc TRƯỚC updateMany ⇒ cướp lease
      // rồi để nó ném. Products rỗng nên giữa hai lần này không có chamMoc nào.
      if (lan === 2) {
        await prisma.setting.update({
          where: { key: KHOA_KEY },
          data: { value: `${g.the.token}|${Date.now() - 1000}|dựng lại` },
        });
        await giuKhoaViecNang("xoá dữ liệu giao dịch");
      }
      await taoCheckpoint(g.the)();
    };

    await expect(rebuildFromRaw([], cp)).rejects.toBeInstanceOf(
      MatKhoaViecNang,
    );

    // stockUpdatedAt PHẢI còn nguyên — câu xoá không được chạy sau khi mất lease.
    const v = await prisma.variant.findUniqueOrThrow({
      where: { pancakeId: "V-STOCK" },
    });
    expect(v.stockUpdatedAt).not.toBeNull();

    await prisma.setting.deleteMany({ where: { key: KHOA_KEY } });
  });

  it("lượt XOÁ kiểm hàng rào NGAY TRONG transaction xoá (không chỉ trước đó)", async () => {
    // Kiểm trước transaction vẫn còn khe: giữa lúc kiểm và lúc commit, khoá có thể hết hạn và lượt
    // dựng lại giành mất, rồi nó dựng lại đúng phần vừa xoá. Hàng rào phải nằm TRONG transaction,
    // và phải được GỌI — hàng rào viết ra mà không lắp thì y như không có.
    const { kiemGiuKhoaTrongTransaction } =
      await import("@/lib/backup/khoa-viec-nang");
    vi.mocked(kiemGiuKhoaTrongTransaction).mockClear();

    const user = await prisma.user.upsert({
      where: { id: "test-user-id" },
      update: { shopName: "HogiKids Test" },
      create: {
        id: "test-user-id",
        email: "mat-khoa@hogikids.test",
        passwordHash: `${"0".repeat(32)}:${"0".repeat(128)}`,
        shopName: "HogiKids Test",
      },
    });

    const { deleteAllData } = await import("@/lib/actions/data-admin");
    expect((await deleteAllData(user.shopName)).ok).toBe(true);

    expect(vi.mocked(kiemGiuKhoaTrongTransaction)).toHaveBeenCalledTimes(1);
  });
});
