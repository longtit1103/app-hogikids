import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

const transformControl = vi.hoisted(() => ({ failNextWith: null as Error | null }));

vi.mock("@/lib/bronze/transform-from-raw", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/bronze/transform-from-raw")>();
  const transformFromRaw: typeof actual.transformFromRaw = async (...args) => {
    if (transformControl.failNextWith) {
      const err = transformControl.failNextWith;
      transformControl.failNextWith = null;
      throw err;
    }
    return actual.transformFromRaw(...args);
  };
  return { ...actual, transformFromRaw };
});

vi.mock("@/lib/session", () => ({ requireUser: vi.fn(async () => "test-user-id") }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { POST as ingestRaw } from "@/app/api/ingest/raw/route";
import { POST as reconcile } from "@/app/api/ingest/reconcile-orders/route";
import { QUA_HAN_PHUT } from "@/lib/bronze/doi-soat-don-con-do";
import { SHOP_SHOPEE } from "../helpers/shop-ids-fixture";
import { prisma } from "@/lib/prisma";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Lượt đối soát đêm — lưới an toàn thứ hai. Dấu kết cục chỉ giúp lượt GỬI LẠI tự chữa, mà đơn đã
 * yên vị (giao xong / đã hoàn) thì Pancake không gửi lại nữa — đúng lớp đơn mang doanh thu chốt.
 *
 * Hai ranh giới phải giữ, cả hai đều có test riêng ở đây:
 *  - CHỈ nhặt dòng chưa đóng dấu; `LEGACY` là việc của script backfill có xác nhận.
 *  - KHÔNG được dựng lại thứ chủ shop vừa chủ ý xoá bằng nút "Xóa dữ liệu giao dịch".
 */

const don = (id: string) => `{
  "id":"${id}","status":3,"inserted_at":"2026-07-01T10:00:00.000000",
  "order_sources_name":"Shopee","marketplace_id":"-3",
  "total_price":200000,"total_discount":0,"fee_marketplace":15000,
  "items":[{"quantity":2,"discount_each_product":0,
    "variation_info":{"display_id":"SKU-DS1","name":"SP","retail_price":100000}}]}`;

const goiDon = (id: string) =>
  ingestRaw(
    new Request("http://localhost/api/ingest/raw", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({
        stream: "orders",
        shopId: SHOP_SHOPEE,
        payload: `{"success":true,"data":[${don(id)}]}`,
      }),
    })
  );

const goiDoiSoat = () =>
  reconcile(
    new Request("http://localhost/api/ingest/reconcile-orders", {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
    })
  );

/** Đẩy `fetchedAt` lùi quá ngưỡng để lượt đối soát chịu nhặt (nó bỏ qua dòng vừa land). */
const dayLuiQuaHan = () =>
  prisma.rawPancakeOrder.updateMany({
    data: { fetchedAt: new Date(Date.now() - (QUA_HAN_PHUT + 5) * 60_000) },
  });

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.rawPancakeOrder.deleteMany();
  await prisma.setting.deleteMany({ where: { key: "bronzeBacklogPending" } });
  transformControl.failNextWith = null;
});

afterAll(async () => {
  await prisma.rawPancakeOrder.deleteMany();
  await prisma.setting.deleteMany({ where: { key: "bronzeBacklogPending" } });
});

describe("lượt đối soát đơn còn dở", () => {
  it("nhặt đơn kẹt quá hạn và dựng vào Sổ", async () => {
    transformControl.failNextWith = new Error("mô phỏng DB chập giữa transform");
    await goiDon("ORD-DS-KET");
    await dayLuiQuaHan();

    expect(await prisma.order.count()).toBe(0);

    const json = await (await goiDoiSoat()).json();

    expect(json.ok).toBe(true);
    expect(json.stats.status).toBe("clean");
    expect(json.stats.applied).toBe(1);
    expect(json.stats.pendingTotal).toBe(0);
    expect(await prisma.order.count()).toBe(1);
    expect((await prisma.rawPancakeOrder.findFirstOrThrow()).silverOutcome).toBe("APPLIED");
  });

  it("KHÔNG đụng dòng vừa land (lượt ingest của chính nó có thể còn đang chạy)", async () => {
    transformControl.failNextWith = new Error("mô phỏng DB chập giữa transform");
    await goiDon("ORD-DS-MOI"); // chưa đẩy lùi mốc

    const json = await (await goiDoiSoat()).json();

    expect(json.stats.applied).toBe(0);
    expect(await prisma.order.count()).toBe(0);
  });

  it("KHÔNG tự dựng lại LEGACY (kho dữ liệu cũ — việc của script có xác nhận)", async () => {
    transformControl.failNextWith = new Error("mô phỏng DB chập giữa transform");
    await goiDon("ORD-DS-LEGACY");
    await dayLuiQuaHan();
    await prisma.rawPancakeOrder.updateMany({ data: { silverOutcome: "LEGACY" } });

    const json = await (await goiDoiSoat()).json();

    expect(json.stats.applied).toBe(0);
    expect(json.stats.pendingTotal).toBe(0); // LEGACY không tính là "đang dở"
    expect(await prisma.order.count()).toBe(0);
    expect((await prisma.rawPancakeOrder.findFirstOrThrow()).silverOutcome).toBe("LEGACY");
  });

  it("KHÔNG phục hồi dữ liệu chủ shop vừa chủ ý XOÁ", async () => {
    // `silverOutcome` là dấu vết một lần cố xử lý, KHÔNG phải oracle "đơn có trong Silver hay
    // không". Sau nút "Xóa dữ liệu giao dịch", dòng Bronze vẫn APPLIED còn Silver rỗng. Nếu lượt
    // đối soát coi đó là việc phải làm thì nó âm thầm dựng lại đúng phần vừa bị xoá — nút Xoá
    // thành vô tác dụng ngầm, nguy hiểm hơn hẳn thứ đang chữa. Đường phục hồi đúng là nút
    // "Dựng lại từ kho thô".
    await goiDon("ORD-DS-XOA");
    expect(await prisma.order.count()).toBe(1);

    // `deleteAllData` đòi đúng tên shop của user đang đăng nhập làm xác nhận.
    const user = await prisma.user.upsert({
      where: { id: "test-user-id" },
      update: { shopName: "HogiKids Test" },
      create: {
        id: "test-user-id",
        email: "doi-soat@hogikids.test",
        passwordHash: `${"0".repeat(32)}:${"0".repeat(128)}`,
        shopName: "HogiKids Test",
      },
    });

    const { deleteAllData } = await import("@/lib/actions/data-admin");
    const kq = await deleteAllData(user.shopName);
    expect(kq.ok).toBe(true);

    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.rawPancakeOrder.count()).toBe(1); // kho thô GIỮ nguyên
    await dayLuiQuaHan();

    const json = await (await goiDoiSoat()).json();

    expect(json.stats.applied).toBe(0);
    expect(await prisma.order.count()).toBe(0); // KHÔNG dựng lại
  });

  it("đóng SUPERSEDED cho bản cũ không-mới-nhất (chống tồn đọng ma)", async () => {
    await goiDon("ORD-DS-CU");
    const moiNhat = await prisma.rawPancakeOrder.findFirstOrThrow();
    await prisma.rawPancakeOrder.create({
      data: {
        shopId: moiNhat.shopId,
        externalId: moiNhat.externalId,
        payloadHash: "hash-cu-hon",
        payload: moiNhat.payload as object,
        fetchedAt: new Date(moiNhat.fetchedAt.getTime() - 60_000),
      },
    });

    const json = await (await goiDoiSoat()).json();

    expect(json.stats.banCuDaDong).toBe(1);
    const cu = await prisma.rawPancakeOrder.findFirstOrThrow({ where: { payloadHash: "hash-cu-hon" } });
    expect(cu.silverOutcome).toBe("SUPERSEDED");
  });

  it("lỗi CẢ LÔ ⇒ 500, giữ nguyên cảnh báo, và KHÔNG tính là một lượt thử của dòng nào", async () => {
    // Lỗi hạ tầng không nói được dòng nào hỏng vì chính nó. Tính nó thành một lượt thử là dùng một
    // sự cố tạm thời để đẩy cả lô tới ngưỡng dừng-thử-lại — chôn nhầm đơn có tiền.
    transformControl.failNextWith = new Error("mô phỏng DB chập lần 1");
    await goiDon("ORD-DS-LOLO");
    await dayLuiQuaHan();
    await prisma.setting.deleteMany({ where: { key: "bronzeBacklogPending" } });

    transformControl.failNextWith = new Error("DB sập giữa lượt đối soát");
    const res = await goiDoiSoat();
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toContain("không chạy được");
    const log = await prisma.syncLog.findFirstOrThrow({ orderBy: { startedAt: "desc" } });
    expect(log.status).toBe("ERROR");

    const raw = await prisma.rawPancakeOrder.findFirstOrThrow();
    expect(raw.silverOutcome).toBeNull(); // vẫn ở "chưa xong" để đêm sau thử tiếp
    expect(raw.silverAttempts).toBe(0); // KHÔNG bị tính là một lượt thử
    // Reconciler KHÔNG được đụng cờ toàn cục, kể cả ở nhánh lỗi.
    expect(await prisma.setting.findUnique({ where: { key: "bronzeBacklogPending" } })).toBeNull();
  });

  it("HỎNG TẤT ĐỊNH (payload không map được) ⇒ KHÔNG kêu đỏ, chỉ cảnh báo cần xem", async () => {
    // Payload Bronze bất biến nên map hỏng thì đêm nào thử lại cũng hỏng y hệt. Để nó làm lượt đêm
    // đỏ là biến cảnh báo thành tiếng ồn nền trong vài tuần — đúng chế độ hỏng phải tránh. Nó vẫn
    // phải LỘ RA, nhưng qua nhãn dừng-thử-lại + panel, không phải qua báo động mỗi đêm.
    transformControl.failNextWith = new Error("mô phỏng DB chập giữa transform");
    await goiDon("ORD-DS-HONG");
    await dayLuiQuaHan();
    await prisma.rawPancakeOrder.updateMany({ data: { payload: { id: "ORD-DS-HONG" } } });

    // Xoá cờ do LƯỢT INGEST hỏng bật lên, để phần khẳng định dưới soi đúng hành vi của reconciler.
    await prisma.setting.deleteMany({ where: { key: "bronzeBacklogPending" } });

    const res = await goiDoiSoat();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.stats.status).toBe("needs_attention");
    expect(json.stats.failedShape).toBe(1);
    expect(json.stats.needsAttentionTotal).toBe(1);
    expect((await prisma.rawPancakeOrder.findFirstOrThrow()).silverOutcome).toBe("FAILED_SHAPE");
    // Cờ tồn đọng TOÀN CỤC không được đụng tới: nó chỉ hạ được bằng nút bấm tay, nên mượn nó làm
    // tín hiệu cho một điều kiện đã theo dõi được theo từng dòng là để banner đỏ dính vĩnh viễn.
    expect(await prisma.setting.findUnique({ where: { key: "bronzeBacklogPending" } })).toBeNull();
  });

  it("BRONZE_ONLY ⇒ bỏ qua, KHÔNG dựng Silver", async () => {
    transformControl.failNextWith = new Error("mô phỏng DB chập giữa transform");
    await goiDon("ORD-DS-BO");
    await dayLuiQuaHan();

    process.env.BRONZE_ONLY = "true";
    try {
      const json = await (await goiDoiSoat()).json();
      expect(json.stats.status).toBe("skipped");
      expect(await prisma.order.count()).toBe(0);
    } finally {
      delete process.env.BRONZE_ONLY;
    }
  });

  it("hỏng LẶP LẠI: đủ số lượt thử (cách xa nhau) ⇒ dừng thử lại tự động", async () => {
    // "Chưa xong = lỗi tự lành được" chỉ là giả định. Một lỗi ghi TẤT ĐỊNH (payload lọt zod nhưng
    // Prisma từ chối) sẽ hỏng y hệt mọi đêm ⇒ lượt đêm hỏng vĩnh viễn, mà lượt đêm hỏng mãi thì
    // vài tuần là không ai đọc nữa. Đếm lượt thử để nó có đường thoát.
    const { ghiNhanThuThatBai, SO_LUOT_THU_TOI_DA, CACH_NHAU_TOI_THIEU_GIO } = await import(
      "@/lib/bronze/ket-cuc-silver"
    );
    transformControl.failNextWith = new Error("mô phỏng DB chập");
    await goiDon("ORD-DS-LAP");
    const raw = await prisma.rawPancakeOrder.findFirstOrThrow();

    for (let i = 1; i <= SO_LUOT_THU_TOI_DA; i += 1) {
      const dung = await ghiNhanThuThatBai(raw.id, `hỏng lượt ${i}`);
      expect(dung).toBe(i === SO_LUOT_THU_TOI_DA);
      if (i < SO_LUOT_THU_TOI_DA) {
        // Đẩy mốc lượt thử lùi lại: hai lượt QUÁ GẦN nhau là cùng một sự cố, không phải hai bằng
        // chứng độc lập — không có ràng buộc này thì bấm lại vài lần là chôn sống một đơn có tiền.
        await prisma.rawPancakeOrder.update({
          where: { id: raw.id },
          data: {
            silverLastAttemptAt: new Date(Date.now() - (CACH_NHAU_TOI_THIEU_GIO + 1) * 3_600_000),
          },
        });
      }
    }

    const sau = await prisma.rawPancakeOrder.findUniqueOrThrow({ where: { id: raw.id } });
    expect(sau.silverOutcome).toBe("FAILED_RETRY_LIMIT");
    expect(sau.silverAttempts).toBe(SO_LUOT_THU_TOI_DA);
  });

  it("lượt thử QUÁ GẦN lượt trước KHÔNG được tính", async () => {
    const { ghiNhanThuThatBai } = await import("@/lib/bronze/ket-cuc-silver");
    transformControl.failNextWith = new Error("mô phỏng DB chập");
    await goiDon("ORD-DS-GAN");
    const raw = await prisma.rawPancakeOrder.findFirstOrThrow();

    await ghiNhanThuThatBai(raw.id, "lượt 1");
    await ghiNhanThuThatBai(raw.id, "lượt 2 ngay sau đó");
    await ghiNhanThuThatBai(raw.id, "lượt 3 ngay sau đó");

    const sau = await prisma.rawPancakeOrder.findUniqueOrThrow({ where: { id: raw.id } });
    expect(sau.silverAttempts).toBe(1); // 3 lần bấm liên tiếp vẫn chỉ là MỘT bằng chứng
    expect(sau.silverOutcome).toBeNull();
  });

  it("xoá dữ liệu khi dòng còn dở ⇒ đóng DISCARDED, đối soát KHÔNG dựng lại", async () => {
    transformControl.failNextWith = new Error("mô phỏng DB chập giữa transform");
    await goiDon("ORD-DS-DISCARD"); // land xong, chết dở ⇒ dòng ở "chưa xong"
    expect((await prisma.rawPancakeOrder.findFirstOrThrow()).silverOutcome).toBeNull();

    const user = await prisma.user.upsert({
      where: { id: "test-user-id" },
      update: { shopName: "HogiKids Test" },
      create: {
        id: "test-user-id",
        email: "discard@hogikids.test",
        passwordHash: `${"0".repeat(32)}:${"0".repeat(128)}`,
        shopName: "HogiKids Test",
      },
    });
    const { deleteAllData } = await import("@/lib/actions/data-admin");
    expect((await deleteAllData(user.shopName)).ok).toBe(true);

    expect((await prisma.rawPancakeOrder.findFirstOrThrow()).silverOutcome).toBe("DISCARDED");

    await dayLuiQuaHan();
    const json = await (await goiDoiSoat()).json();

    expect(json.stats.pendingTotal).toBe(0);
    expect(await prisma.order.count()).toBe(0); // KHÔNG dựng lại thứ vừa chủ ý xoá
  });

  it("mất quyền đóng dấu giữa chừng ⇒ lượt ghi Sổ CUỘN LẠI", async () => {
    // Nếu dòng bị đóng DISCARDED trong lúc ta đang ghi Sổ, lượt ghi PHẢI hỏng (cuộn lại): ghi tiếp
    // là dựng lại đúng phần dữ liệu người ta vừa chủ ý xoá. Ném LỚP RIÊNG `KetCucDaXoaTay` — vẫn
    // huỷ lượt ghi, nhưng caller đếm được là kết cục CÓ CHỦ ĐÍCH (không bật cờ backlog giả).
    const { dongDauKetCuc, KET_CUC, KetCucDaXoaTay } = await import("@/lib/bronze/ket-cuc-silver");
    transformControl.failNextWith = new Error("mô phỏng DB chập");
    await goiDon("ORD-DS-CAS");
    const raw = await prisma.rawPancakeOrder.findFirstOrThrow();
    await prisma.rawPancakeOrder.update({
      where: { id: raw.id },
      data: { silverOutcome: KET_CUC.DISCARDED },
    });

    await expect(dongDauKetCuc(prisma, raw.id, KET_CUC.APPLIED)).rejects.toThrow(KetCucDaXoaTay);
  });

  it("tồn đọng vượt trần lô: đếm THẬT, không bị trần chặn", async () => {
    const { demTonDong } = await import("@/lib/bronze/ket-cuc-silver");
    const rows = Array.from({ length: 5 }, (_, i) => ({
      shopId: SHOP_SHOPEE,
      externalId: `ORD-DS-N${i}`,
      payloadHash: `h${i}`,
      payload: { id: `ORD-DS-N${i}` },
      fetchedAt: new Date(Date.now() - (QUA_HAN_PHUT + 10) * 60_000),
    }));
    await prisma.rawPancakeOrder.createMany({ data: rows });

    const { tong, cuNhat } = await demTonDong(QUA_HAN_PHUT);
    expect(tong).toBe(5);
    expect(cuNhat).not.toBeNull();
  });
});
