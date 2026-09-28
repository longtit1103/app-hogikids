import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

// Công tắc mô phỏng transform CHẾT (DB chập giữa chừng) — không bật thì chạy bản THẬT.
// `truocKhiTransform`: chen MỘT việc vào ĐÚNG khe land→transform (land đã commit, transform chưa
// chạy) — dựng lại interleaving thật của lượt "Xóa dữ liệu giao dịch" chạy đè lượt ingest.
const transformControl = vi.hoisted(() => ({
  failNextWith: null as Error | null,
  truocKhiTransform: null as (() => Promise<void>) | null,
}));

vi.mock("@/lib/bronze/transform-from-raw", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/bronze/transform-from-raw")>();
  const transformFromRaw: typeof actual.transformFromRaw = async (...args) => {
    if (transformControl.truocKhiTransform) {
      const chen = transformControl.truocKhiTransform;
      transformControl.truocKhiTransform = null;
      await chen();
    }
    if (transformControl.failNextWith) {
      const err = transformControl.failNextWith;
      transformControl.failNextWith = null;
      throw err;
    }
    return actual.transformFromRaw(...args);
  };
  return { ...actual, transformFromRaw };
});

import { POST } from "@/app/api/ingest/raw/route";
import { hasBronzeBacklog } from "@/lib/bronze/bronze-only";
import {
  dongDauDaXoaTay,
  dongDauKetCuc,
  KET_CUC,
  KetCucDaXoaTay,
} from "@/lib/bronze/ket-cuc-silver";
import { SHOP_KHO, SHOP_SHOPEE } from "../helpers/shop-ids-fixture";
import { prisma } from "@/lib/prisma";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Hợp đồng của cột kết cục trên `RawPancakeOrder`: dòng Bronze phải TỰ NÓI được nó đã dựng Silver
 * xong hay chưa, thay vì để cả hệ thống suy đoán từ một bit cờ toàn cục ghi sau khi Bronze đã
 * commit. Trạng thái mặc định là "chưa xong" nên chết giữa chừng thì hỏng CÓ TIẾNG.
 *
 * Chốt cả các QUYỀN HẠN: đường ghi thường được tự dọn việc dở của chính nó (`NULL`), nhưng TUYỆT
 * ĐỐI không được tự ý dựng lại kho dữ liệu cũ (`LEGACY`) — việc đó phải do người bấm nút.
 */

const don = (id: string) => `{
  "id":"${id}","status":3,"inserted_at":"2026-07-01T10:00:00.000000",
  "order_sources_name":"Shopee","marketplace_id":"-3",
  "total_price":200000,"total_discount":0,"fee_marketplace":15000,
  "items":[{"quantity":2,"discount_each_product":0,
    "variation_info":{"display_id":"SKU-KC1","name":"SP","retail_price":100000}}]}`;

/** Đơn MIRROR của shop kho — luật doanh thu loại khỏi Silver CÓ CHỦ ĐÍCH. */
const donMirror = `{
  "id":"AF1942992175O-KC-1","status":3,"inserted_at":"2026-07-01T10:00:00.000000",
  "order_sources_name":"Affiliate","marketplace_id":"-3",
  "total_price":200000,"total_discount":0,"fee_marketplace":0,
  "items":[{"quantity":1,"discount_each_product":0,
    "variation_info":{"display_id":"SKU-KC1","name":"SP","retail_price":200000}}]}`;

const post = (payload: string, shopId: string = SHOP_SHOPEE) =>
  POST(
    new Request("http://localhost/api/ingest/raw", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ stream: "orders", shopId, payload }),
    })
  );

const goiDon = (id: string, shopId: string = SHOP_SHOPEE) =>
  post(`{"success":true,"data":[${don(id)}]}`, shopId);

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.rawPancakeOrder.deleteMany();
  await prisma.setting.deleteMany({ where: { key: "bronzeBacklogPending" } });
  transformControl.failNextWith = null;
  transformControl.truocKhiTransform = null;
});

afterAll(async () => {
  await prisma.rawPancakeOrder.deleteMany();
  await prisma.setting.deleteMany({ where: { key: "bronzeBacklogPending" } });
});

describe("kết cục dựng Silver trên từng dòng đơn Bronze", () => {
  it("đơn mới bình thường: APPLIED, KHÔNG có cảnh báo 'còn dở'", async () => {
    // Dòng vừa insert luôn mang trạng thái "chưa đóng dấu" (mặc định của cột). Nếu lượt hỏi "đơn
    // nào còn dở" gộp cả chúng thì MỌI lượt đồng bộ bình thường đều kèm cảnh báo giả — đúng thứ
    // làm người đọc log mất phản xạ với cảnh báo thật.
    const json = await (await goiDon("ORD-KC-MOI")).json();

    expect(json.ok).toBe(true);
    expect(json.stats.landed).toBe(1);
    expect(json.stats.warnings.some((w: string) => w.includes("còn dở từ lượt trước"))).toBe(false);

    const raw = await prisma.rawPancakeOrder.findFirstOrThrow();
    expect(raw.silverOutcome).toBe("APPLIED");
    expect(raw.silverProcessedAt).not.toBeNull();
  });

  it("chưa đóng dấu + hash trùng ⇒ lượt sau TỰ CHỮA", async () => {
    transformControl.failNextWith = new Error("mô phỏng DB chập giữa transform");
    await goiDon("ORD-KC-CHUA"); // land xong rồi chết giữa chừng

    expect(await prisma.order.count()).toBe(0);
    expect((await prisma.rawPancakeOrder.findFirstOrThrow()).silverOutcome).toBeNull();

    const json = await (await goiDon("ORD-KC-CHUA")).json(); // gửi lại ĐÚNG payload đó

    expect(json.stats.landed).toBe(0); // trùng hash — KHÔNG land lại
    expect(await prisma.order.count()).toBe(1); // vẫn dựng nốt được
    expect(json.stats.warnings.some((w: string) => w.includes("còn dở từ lượt trước"))).toBe(true);
    expect((await prisma.rawPancakeOrder.findFirstOrThrow()).silverOutcome).toBe("APPLIED");
  });

  it("LEGACY + hash trùng: đường ghi thường KHÔNG được tự dựng lại kho dữ liệu cũ", async () => {
    // `LEGACY` khác `NULL` về QUYỀN HẠN chứ không chỉ về nghĩa: nó là dữ liệu có trước khi hệ
    // thống biết đóng dấu, chưa ai kiểm. Dựng lại nó là một quyết định vận hành (script có xác
    // nhận). Gộp chung thì bất kỳ payload cũ nào Pancake gửi lại cũng kéo theo một lượt backfill
    // ngoài ý muốn, giữa đêm, không ai bấm nút.
    transformControl.failNextWith = new Error("mô phỏng DB chập giữa transform");
    await goiDon("ORD-KC-LEGACY");
    await prisma.rawPancakeOrder.updateMany({ data: { silverOutcome: "LEGACY" } });

    const json = await (await goiDon("ORD-KC-LEGACY")).json();

    expect(json.stats.landed).toBe(0);
    expect(await prisma.order.count()).toBe(0); // KHÔNG tự dựng
    expect(json.stats.warnings.some((w: string) => w.includes("còn dở từ lượt trước"))).toBe(false);
    expect((await prisma.rawPancakeOrder.findFirstOrThrow()).silverOutcome).toBe("LEGACY");
  });

  it("lượt tự chữa LẠI hỏng (payload không map được): cổng đối soát phải kêu, dòng thành FAILED_SHAPE", async () => {
    // Phép so cũ lấy số vừa land làm kỳ vọng ⇒ lượt tự chữa có `landed = 0` nên thành `0 > 0`:
    // cổng im lặng đúng lúc lượt cứu chữa thất bại lần nữa, HTTP vẫn 200.
    transformControl.failNextWith = new Error("mô phỏng DB chập lần 1");
    await goiDon("ORD-KC-HONG");

    // Lần 2 hash trùng nên chỉ có đường tự chữa; ép mapping hỏng bằng cách bơm payload rác vào
    // chính dòng Bronze đó (payload Bronze là thứ transform đọc).
    await prisma.rawPancakeOrder.updateMany({ data: { payload: { id: "ORD-KC-HONG" } } });

    const json = await (await goiDon("ORD-KC-HONG")).json();

    expect(await prisma.order.count()).toBe(0);
    expect(json.stats.warnings.some((w: string) => w.includes("hạch toán"))).toBe(true);
    // Map hỏng là lỗi TẤT ĐỊNH (payload bất biến) nên dòng phải mang nhãn dừng-thử-lại, KHÔNG để
    // ở "chưa xong" — nếu không thì đêm nào lượt đối soát cũng thử lại đúng dòng hỏng đó.
    expect((await prisma.rawPancakeOrder.findFirstOrThrow()).silverOutcome).toBe("FAILED_SHAPE");
  });

  it("đơn mirror kho ⇒ EXCLUDED_MIRROR (kết cục ĐÚNG, không phải việc dở)", async () => {
    await post(`{"success":true,"data":[${donMirror}]}`, SHOP_KHO);

    const raw = await prisma.rawPancakeOrder.findFirstOrThrow();
    expect(raw.silverOutcome).toBe("EXCLUDED_MIRROR");
    expect(await prisma.order.count()).toBe(0);
  });

  it("payload không map được ⇒ FAILED_SHAPE (dừng thử lại tự động, vẫn hiện cần xem)", async () => {
    const json = await (await post(`{"success":true,"data":[{"id":"ORD-KC-SHAPE"}]}`)).json();

    expect(json.ok).toBe(true);
    const raw = await prisma.rawPancakeOrder.findFirstOrThrow();
    expect(raw.silverOutcome).toBe("FAILED_SHAPE");
    expect(raw.silverNote).toContain("shape");
  });

  it("bản cũ tới muộn ⇒ SUPERSEDED (Silver giữ bản mới hơn)", async () => {
    await goiDon("ORD-KC-STALE"); // v1 → APPLIED

    // Bơm một dòng Bronze CŨ HƠN của cùng đơn: mốc nguồn cũ nên CAS phải từ chối ghi đè.
    const v1 = await prisma.rawPancakeOrder.findFirstOrThrow();
    const v0 = await prisma.rawPancakeOrder.create({
      data: {
        shopId: v1.shopId,
        externalId: v1.externalId,
        payloadHash: "hash-cu-hon",
        payload: v1.payload as object,
        fetchedAt: new Date(v1.fetchedAt.getTime() - 60_000),
      },
    });

    const { transformFromRaw } = await import("@/lib/bronze/transform-from-raw");
    // Ép transform đúng dòng cũ đó bằng cách xoá dòng mới khỏi tầm nhìn latest-per-key.
    await prisma.rawPancakeOrder.delete({ where: { id: v1.id } });
    await prisma.order.updateMany({ data: { rawFetchedAt: v1.fetchedAt } });
    await transformFromRaw("orders", [], { externalIds: [v1.externalId], shopId: v1.shopId });

    expect((await prisma.rawPancakeOrder.findUniqueOrThrow({ where: { id: v0.id } })).silverOutcome).toBe(
      "SUPERSEDED"
    );
  });

  it("lọc SAU khi chọn bản mới nhất: v1 chưa xong + v2 xong ⇒ KHÔNG chọn lại v1", async () => {
    // Lọc trạng thái trong `WHERE` (chạy TRƯỚC `DISTINCT ON`) cho ra "bản mới nhất TRONG SỐ các
    // bản chưa xong" ⇒ chọn v1 đem dựng lại = đẩy payload CŨ vào Silver. CAS chặn kịp nên không
    // hỏng tiền, nhưng lượt đối soát sẽ hiểu nhầm là "xử lý không được" rồi báo động giả mãi.
    const { locDonChuaDongDau } = await import("@/lib/bronze/ket-cuc-silver");
    const chung = { shopId: SHOP_SHOPEE, externalId: "ORD-KC-2BAN", payload: { id: "x" } };

    await prisma.rawPancakeOrder.create({
      data: { ...chung, payloadHash: "h1", fetchedAt: new Date("2026-07-01T10:00:00Z"), silverOutcome: null },
    });
    await prisma.rawPancakeOrder.create({
      data: {
        ...chung,
        payloadHash: "h2",
        fetchedAt: new Date("2026-07-01T11:00:00Z"),
        silverOutcome: "APPLIED",
      },
    });

    expect(await locDonChuaDongDau(SHOP_SHOPEE, ["ORD-KC-2BAN"])).toEqual([]);
  });

  it("đóng dấu HỎNG ⇒ transaction ghi Silver cuộn lại; lượt sau vẫn thành APPLIED", async () => {
    // Dấu và lượt ghi Silver phải CÙNG SỐNG HOẶC CÙNG CHẾT. Nếu dấu hỏng mà đơn vẫn nằm trong
    // Silver thì lần sau không ai dựng lại nữa (dòng vẫn "chưa xong" nhưng số đã đúng) — còn tệ
    // hơn: nếu dấu ghi được mà Silver cuộn lại thì đơn biến mất vĩnh viễn khỏi mọi lượt đối soát.
    const { upsertOneOrder } = await import("@/lib/ingest/pancake-upsert");
    const { mapPancakeOrder } = await import("@/lib/ingest/pancake-mapping");
    const { pancakeOrderSchema } = await import("@/lib/ingest/pancake-schemas");

    const raw = await prisma.rawPancakeOrder.create({
      data: {
        shopId: SHOP_SHOPEE,
        externalId: "ORD-KC-DAU",
        payloadHash: "h-dau",
        payload: JSON.parse(don("ORD-KC-DAU")),
        fetchedAt: new Date(),
      },
    });
    const mo = mapPancakeOrder(pancakeOrderSchema.parse(JSON.parse(don("ORD-KC-DAU"))), {
      channels: { shopee: { platformFeePct: 0, paymentFeePct: 0 } },
    });
    const stats = {
      ordersUpserted: 0,
      ordersSkippedMirror: 0,
      ordersSkippedStale: 0,
      ordersDiscardedGiuaChung: 0,
      skipped: 0,
      boQuaCoChuDich: 0,
      unknownStatusOrders: 0,
    } as Parameters<typeof upsertOneOrder>[2];

    // `rawRowId` trỏ vào dòng KHÔNG tồn tại ⇒ câu đóng dấu ném ⇒ cả transaction cuộn lại.
    const ketCuc = await upsertOneOrder(mo, {}, stats, [], raw.fetchedAt, { rawRowId: "khong-co-that" });
    expect(ketCuc).toBe("LOI");
    expect(await prisma.order.count()).toBe(0); // Silver KHÔNG được giữ lại phần ghi dở
    // Lỗi ghi kiểu này TỰ LÀNH được ⇒ dòng phải ở lại "chưa xong" để lượt sau còn thử tiếp.
    expect((await prisma.rawPancakeOrder.findUniqueOrThrow({ where: { id: raw.id } })).silverOutcome).toBeNull();

    // Lượt sau với id đúng: cả hai cùng thành công.
    const ketCuc2 = await upsertOneOrder(mo, {}, stats, [], raw.fetchedAt, { rawRowId: raw.id });
    expect(ketCuc2).toBe("APPLIED");
    expect(await prisma.order.count()).toBe(1);
    expect((await prisma.rawPancakeOrder.findUniqueOrThrow({ where: { id: raw.id } })).silverOutcome).toBe(
      "APPLIED"
    );
  });

  it("đóng dấu LŨY ĐẲNG: đóng lại CÙNG kết cục là no-op, KHÔNG ném (chống backlog giả khi 2 luồng đua)", async () => {
    // Hai lượt transform song song trên cùng dòng Bronze đều tới CÙNG kết cục; kẻ thua khoá tư vấn vẫn
    // khớp updateMany rồi tới đây đóng lại APPLIED. Nếu CAS chỉ nhận IS NULL thì kẻ thua ném oan ⇒ nuốt
    // thành skipped ⇒ cổng đối soát lệch ⇒ cờ backlog GIẢ. Đóng lại CÙNG kết cục phải là no-op.
    const raw = await prisma.rawPancakeOrder.create({
      data: {
        shopId: SHOP_SHOPEE,
        externalId: "ORD-KC-IDEM",
        payloadHash: "h-idem",
        payload: JSON.parse(don("ORD-KC-IDEM")),
        fetchedAt: new Date(),
      },
    });

    await dongDauKetCuc(prisma, raw.id, KET_CUC.APPLIED);
    // Lượt thứ hai đóng lại ĐÚNG kết cục cũ — KHÔNG được ném.
    await expect(dongDauKetCuc(prisma, raw.id, KET_CUC.APPLIED)).resolves.toBeUndefined();
    expect((await prisma.rawPancakeOrder.findUniqueOrThrow({ where: { id: raw.id } })).silverOutcome).toBe(
      "APPLIED"
    );
  });

  it("đóng dấu vẫn CHẶN kết cục KHÁC: dòng đã DISCARDED thì đóng APPLIED phải ném (không hồi sinh đơn vừa xoá)", async () => {
    const raw = await prisma.rawPancakeOrder.create({
      data: {
        shopId: SHOP_SHOPEE,
        externalId: "ORD-KC-DISCARDED",
        payloadHash: "h-discarded",
        payload: JSON.parse(don("ORD-KC-DISCARDED")),
        fetchedAt: new Date(),
        silverOutcome: KET_CUC.DISCARDED,
      },
    });

    // Kết cục hiện tại KHÁC kết cục sắp ghi ⇒ CAS trượt ⇒ ném LỚP RIÊNG `KetCucDaXoaTay` (huỷ lượt
    // ghi để không dựng lại thứ vừa xoá — nhưng caller đếm được nó là kết cục có chủ đích).
    await expect(dongDauKetCuc(prisma, raw.id, KET_CUC.APPLIED)).rejects.toThrow(KetCucDaXoaTay);
    expect((await prisma.rawPancakeOrder.findUniqueOrThrow({ where: { id: raw.id } })).silverOutcome).toBe(
      "DISCARDED"
    );
  });

  it("XEN KẼ xoá-vs-ingest: land xong → xoá đóng DISCARDED → transform chạy tiếp ⇒ KHÔNG hồi sinh, KHÔNG backlog giả", async () => {
    // Tái hiện ĐÚNG interleaving thật: trang orders đã LAND (commit, đã nhả khoá land), lượt "Xóa
    // dữ liệu giao dịch" chen vào khe — chạy đúng câu chốt của nó (đóng DISCARDED mọi dòng còn dở)
    // + vét Sổ — RỒI transform của chính trang đó mới chạy tiếp trên các dòng vừa bị đóng.
    transformControl.truocKhiTransform = async () => {
      await dongDauDaXoaTay(prisma);
      await prisma.orderItem.deleteMany();
      await prisma.order.deleteMany();
    };

    const json = await (await goiDon("ORD-KC-XOA-RACE")).json();

    expect(json.ok).toBe(true); // 200 — không phải lỗi
    // Kết cục CÓ CHỦ ĐÍCH: đếm riêng + hạch toán ĐỦ — không skipped, không cảnh báo mất dòng.
    expect(json.stats.ordersDiscardedGiuaChung).toBe(1);
    expect(json.stats.skipped).toBe(0);
    expect(json.stats.warnings.some((w: string) => w.includes("hạch toán"))).toBe(false);
    // KHÔNG hồi sinh đơn vừa xoá (transaction ghi Silver đã cuộn lại), KHÔNG bật cờ backlog giả.
    expect(await prisma.order.count()).toBe(0);
    expect(await hasBronzeBacklog()).toBe(false);
    expect((await prisma.rawPancakeOrder.findFirstOrThrow()).silverOutcome).toBe("DISCARDED");
  });

  it("XEN KẼ xoá-vs-ingest với MÃ TRẠNG THÁI LẠ: không đếm unknownStatus, không cảnh báo ma", async () => {
    // Đơn mang mã trạng thái lạ NHƯNG vừa bị xoá tay giữa chừng: đếm/cảnh báo về nó là nói về thứ
    // đã cố ý xoá — SyncLog giữ cảnh báo ma và webhook (cùng stats này) tô "cần xem" oan. Phải đếm
    // SAU khi biết kết cục ghi và bỏ qua khi kết cục là DISCARDED.
    transformControl.truocKhiTransform = async () => {
      await dongDauDaXoaTay(prisma);
      await prisma.orderItem.deleteMany();
      await prisma.order.deleteMany();
    };

    const payload = `{"success":true,"data":[${don("ORD-KC-XOA-LA").replace('"status":3', '"status":999')}]}`;
    const json = await (await post(payload)).json();

    expect(json.ok).toBe(true);
    expect(json.stats.ordersDiscardedGiuaChung).toBe(1);
    expect(json.stats.unknownStatusOrders).toBe(0); // KHÔNG đếm trạng thái lạ cho đơn đã xoá
    expect(json.stats.warnings.some((w: string) => w.includes("mã trạng thái"))).toBe(false);
    expect(await prisma.order.count()).toBe(0);
    expect(await hasBronzeBacklog()).toBe(false);
  });

  it("XEN KẼ xoá-vs-ingest trên đơn MIRROR: không ném vỡ lô, không đếm nhầm mirror, KHÔNG backlog giả", async () => {
    // Nhánh mirror/shape đóng dấu bằng client thường NGOÀI transaction — trước fix, CAS trượt ở đây
    // ném TRÀO khỏi vòng lặp: huỷ nốt các đơn còn lại của trang + 500 + markBronzeBacklog.
    transformControl.truocKhiTransform = async () => {
      await dongDauDaXoaTay(prisma);
    };

    const json = await (await post(`{"success":true,"data":[${donMirror}]}`, SHOP_KHO)).json();

    expect(json.ok).toBe(true);
    expect(json.stats.ordersDiscardedGiuaChung).toBe(1);
    expect(json.stats.ordersSkippedMirror).toBe(0); // dòng đã xoá tay — không phải kết cục mirror
    expect(await hasBronzeBacklog()).toBe(false);
    expect((await prisma.rawPancakeOrder.findFirstOrThrow()).silverOutcome).toBe("DISCARDED");
  });
});
