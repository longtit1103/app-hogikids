import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Công tắc mô phỏng transform CHẾT giữa chừng (Bronze đã commit, Silver chưa ghi).
// `truocKhiTransform`: chen một việc vào ĐÚNG khe land→transform — dựng lại interleaving lượt
// "Xóa dữ liệu giao dịch" chạy đè webhook (webhook KHÔNG có SyncLog nên không phép kiểm nào thấy nó).
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

import { dongDauDaXoaTay } from "@/lib/bronze/ket-cuc-silver";
import { SHOP_SHOPEE } from "../helpers/shop-ids-fixture";
import { xuLySuKienWebhook } from "@/lib/ingest/webhook-processor";
import { prisma } from "@/lib/prisma";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Đường webhook có ĐÚNG cùng khe với đường API: land trong transaction, dựng Silver ở ngoài. Nhưng
 * nó còn một cửa thoát sớm mà đường API không có — GUARD THỨ TỰ. Sự kiện gửi lại mang đúng
 * `updated_at` cũ nên guard kết luận "cũ hơn" và hàm trả về TRƯỚC đoạn tự chữa ⇒ đơn kẹt vĩnh viễn.
 *
 * Suite này khoá cả hai chiều: phải dựng nốt được phần dở, mà KHÔNG được nới lỏng guard (payload
 * webhook đang bị chặn tuyệt đối không được ghi đè bản API).
 */

const UPDATED_AT = "2026-07-01T10:00:00.000000";

const suKienDon = (opts: { id: string; updatedAt?: string; themKhach?: boolean }) =>
  `{"type":"orders","id":"${opts.id}","status":3,` +
  `"inserted_at":"2026-07-01T09:00:00.000000","updated_at":"${opts.updatedAt ?? UPDATED_AT}",` +
  `"order_sources_name":"Shopee","marketplace_id":"-3",` +
  (opts.themKhach ? `"customer":{"name":"Khách webhook"},` : "") +
  `"total_price":200000,"total_discount":0,"fee_marketplace":15000,` +
  `"items":[{"quantity":2,"discount_each_product":0,` +
  `"variation_info":{"display_id":"SKU-WH1","name":"SP","retail_price":100000}}]}`;

const banTin = (payload: string) => xuLySuKienWebhook({ shopId: SHOP_SHOPEE, payload });

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

describe("webhook đơn — guard chặn sự kiện nhưng vẫn dựng nốt bản Bronze còn dở", () => {
  it("chết giữa chừng rồi gửi lại CÙNG updated_at ⇒ vẫn dựng được đơn", async () => {
    const sk = suKienDon({ id: "ORD-WH-KET" });

    transformControl.failNextWith = new Error("mô phỏng DB chập giữa transform");
    await banTin(sk); // land Bronze xong rồi chết

    expect(await prisma.rawPancakeOrder.count()).toBe(1);
    expect(await prisma.order.count()).toBe(0);
    expect((await prisma.rawPancakeOrder.findFirstOrThrow()).silverOutcome).toBeNull();

    // n8n bắn lại đúng sự kiện đó: guard so `updated_at` thấy BẰNG NHAU ⇒ kết luận "cũ hơn".
    const kq = await banTin(sk);

    expect(kq.processedAs).toBe("don-hang");
    expect(await prisma.order.count()).toBe(1);
    expect((await prisma.rawPancakeOrder.findFirstOrThrow()).silverOutcome).toBe("APPLIED");
  });

  it("payload cũ khi bản mới nhất ĐÃ dựng xong ⇒ vẫn bị chặn, không dựng lại", async () => {
    const sk = suKienDon({ id: "ORD-WH-XONG" });

    const lan1 = await banTin(sk); // dựng bình thường
    expect(lan1.processedAs).toBe("don-hang");
    expect((await prisma.rawPancakeOrder.findFirstOrThrow()).silverOutcome).toBe("APPLIED");

    const lan2 = await banTin(sk); // gửi lại: không còn gì dở để chữa

    expect(lan2.processedAs).toBe("don-hang-cu-hon");
    expect(await prisma.rawPancakeOrder.count()).toBe(1); // KHÔNG land thêm bản nào
  });

  it("dựng nốt gặp MÃ TRẠNG THÁI LẠ ⇒ vẫn phải báo cần xem, không trả xanh", async () => {
    // Nhánh tự chữa từng trả `don-hang` ngay khi đủ số hạch toán, tức đi vòng qua chốt "mã trạng
    // thái Pancake lạ". Mã lạ làm đơn bị map thành CANCELLED và LOẠI khỏi doanh thu — đúng dạng
    // mất tiền âm thầm mà chốt đó sinh ra để chặn. Nay mọi nhánh transform chung một chính sách
    // hậu-transform nên tín hiệu không thể rơi ở một nhánh mà còn ở nhánh kia.
    const skLa = suKienDon({ id: "ORD-WH-LA" }).replace('"status":3', '"status":999');

    transformControl.failNextWith = new Error("mô phỏng DB chập giữa transform");
    await banTin(skLa); // land Bronze xong rồi chết

    const kq = await banTin(skLa); // gửi lại: guard chặn, đi đường tự chữa

    expect(kq.processedAs).toBe("don-hang-can-xem");
    expect(kq.note).toContain("mã trạng thái");
  });

  it("BRONZE_ONLY + còn bản dở ⇒ bật cờ và nói đúng tên, không báo như sự kiện cũ bình thường", async () => {
    // Công tắc chỉ-land đang bật thì KHÔNG được dựng Silver. Nhưng cũng không được trả về như một
    // sự kiện cũ vô hại: ta vừa nhìn thấy một dòng chưa hoàn tất, phải bật cờ để lượt sau biết còn
    // nợ. Ca này xảy ra khi lượt trước chết CỨNG (dòng NULL) rồi công tắc mới được bật.
    const sk = suKienDon({ id: "ORD-WH-BO" });

    transformControl.failNextWith = new Error("mô phỏng DB chập giữa transform");
    await banTin(sk);
    await prisma.setting.deleteMany({ where: { key: "bronzeBacklogPending" } }); // như thể chưa kịp bật cờ

    process.env.BRONZE_ONLY = "true";
    try {
      const kq = await banTin(sk);

      expect(kq.processedAs).toBe("bronze-only");
      const co = await prisma.setting.findUnique({ where: { key: "bronzeBacklogPending" } });
      expect(co?.value).toBe("1");
      expect(await prisma.order.count()).toBe(0); // KHÔNG lách công tắc
    } finally {
      delete process.env.BRONZE_ONLY;
    }
  });

  it("sự kiện THIẾU field mà bản Bronze có ⇒ không được ghi đè, kể cả khi có việc dở", async () => {
    // Luật "API mạnh hơn webhook": payload webhook thiếu `customer` mà bản đang có thì nhường —
    // ghi đè sẽ xoá mất tên khách. Đường tự chữa TUYỆT ĐỐI không được thành cửa sau cho ca này:
    // nó dựng lại BẢN BRONZE MỚI NHẤT (bản đầy đủ), không phải payload đang bị chặn.
    transformControl.failNextWith = new Error("mô phỏng DB chập giữa transform");
    await banTin(suKienDon({ id: "ORD-WH-THIEU", themKhach: true })); // bản ĐẦY ĐỦ, chết dở

    expect(await prisma.order.count()).toBe(0);

    // Sự kiện sau THIẾU `customer` (và mốc mới hơn để không bị chặn bởi luật thứ tự).
    const kq = await banTin(suKienDon({ id: "ORD-WH-THIEU", updatedAt: "2026-07-01T11:00:00.000000" }));

    // Guard chặn vì thiếu field; đơn vẫn được dựng từ bản Bronze đầy đủ đang còn dở.
    expect(kq.processedAs).toBe("don-hang");
    const don = await prisma.order.findUniqueOrThrow({ where: { pancakeId: "ORD-WH-THIEU" } });
    expect(don.customerName).toBe("Khách webhook"); // tên khách KHÔNG bị xoá
    expect(await prisma.rawPancakeOrder.count()).toBe(1); // payload thiếu field KHÔNG được land
  });

  it("XEN KẼ xoá-vs-webhook: land xong → xoá đóng DISCARDED → transform chạy tiếp ⇒ KHÔNG hồi sinh, KHÔNG backlog giả", async () => {
    // Webhook KHÔNG ghi SyncLog nên không phép kiểm "đang đồng bộ" nào thấy nó đang ở khe
    // land→transform — phòng tuyến duy nhất là chính CAS đóng dấu: thua vì DISCARDED phải được xử
    // là kết cục CÓ CHỦ ĐÍCH (cuộn lại lượt ghi, không đếm mất dòng), nếu không thì mỗi lần xoá đè
    // webhook là một lần bật cờ backlog giả + panel tô đỏ đơn khoẻ.
    transformControl.truocKhiTransform = async () => {
      await dongDauDaXoaTay(prisma);
      await prisma.orderItem.deleteMany();
      await prisma.order.deleteMany();
    };

    const kq = await banTin(suKienDon({ id: "ORD-WH-XOA-RACE" }));

    expect(kq.processedAs).toBe("don-hang"); // KHÔNG tô đỏ panel
    expect(kq.note).toContain("DISCARDED");
    expect(await prisma.order.count()).toBe(0); // KHÔNG hồi sinh đơn vừa xoá
    const co = await prisma.setting.findUnique({ where: { key: "bronzeBacklogPending" } });
    expect(co?.value ?? "0").not.toBe("1"); // KHÔNG bật cờ backlog giả
    expect((await prisma.rawPancakeOrder.findFirstOrThrow()).silverOutcome).toBe("DISCARDED");
  });

  it("XEN KẼ xoá-vs-webhook với MÃ TRẠNG THÁI LẠ: vẫn don-hang + DISCARDED, không 'cần xem' oan", async () => {
    // Chốt ② (mã trạng thái lạ) chạy TRƯỚC nhánh DISCARDED ③b — nếu transform vẫn đếm
    // unknownStatusOrders cho đơn vừa bị xoá tay thì webhook trả "cần xem" đỏ cho một đơn đã cố ý
    // xoá. Kết cục DISCARDED phải thắng: không đếm, không cảnh báo, trả don-hang + ghi chú xoá tay.
    transformControl.truocKhiTransform = async () => {
      await dongDauDaXoaTay(prisma);
      await prisma.orderItem.deleteMany();
      await prisma.order.deleteMany();
    };

    const kq = await banTin(
      suKienDon({ id: "ORD-WH-XOA-LA" }).replace('"status":3', '"status":999')
    );

    expect(kq.processedAs).toBe("don-hang"); // KHÔNG phải don-hang-can-xem
    expect(kq.note).toContain("DISCARDED");
    expect(kq.note ?? "").not.toContain("mã trạng thái");
    expect(await prisma.order.count()).toBe(0);
    const co = await prisma.setting.findUnique({ where: { key: "bronzeBacklogPending" } });
    expect(co?.value ?? "0").not.toBe("1");
  });
});
