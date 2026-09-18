import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { clearBronzeBacklog } from "@/lib/bronze/bronze-only";
import { SHOP_KHO, SHOP_SHOPEE, SHOP_TIKTOK } from "../helpers/shop-ids-fixture";
import { KET_CUC_CAN_XEM, xuLySuKienWebhook } from "@/lib/ingest/webhook-processor";
import { WAREHOUSE_KHO_TONG } from "../helpers/shop-ids-fixture";
import { prisma } from "@/lib/prisma";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Tồn kho realtime từ webhook `variations_warehouses`.
 *
 * Mọi payload dưới đây copy khuôn từ SỰ KIỆN THẬT trong hộp thư prod (đo 2026-07-27, 114 sự kiện):
 * 9 khoá phẳng, không bọc envelope, `inserted_at` naive = giờ UTC (bất biến #3), tồn nằm ở
 * `remain_quantity` (KHÔNG phải `actual_remain_quantity` — đo: remain khớp `Variant.stock` 4/4,
 * actual chỉ 3/4).
 */

/** UUID biến thể thật của shop kho (đã đo là khớp `Variant.pancakeId`). */
const VARIATION_ID = "ea8b07f0-6d00-44fc-974f-fe96702a4071";

const SU_KIEN = (opts: {
  remain: number;
  insertedAt: string;
  variationId?: string;
  warehouseId?: string;
  actual?: number;
}) =>
  `{"type":"variations_warehouses","inserted_at":"${opts.insertedAt}",` +
  `"variation_id":"${opts.variationId ?? VARIATION_ID}",` +
  `"warehouse_id":"${opts.warehouseId ?? WAREHOUSE_KHO_TONG}",` +
  `"remain_quantity":${opts.remain},"order_id":"AF100975192O582","change_quantity":-1,` +
  `"is_actual_remain_quantity":false,"actual_remain_quantity":${opts.actual ?? 99}}`;

/**
 * Sự kiện do PHIẾU NHẬP KHO sinh ra — shape khác hẳn sự kiện do đơn hàng, copy nguyên từ hộp thư
 * prod (phiếu nhập thật 2026-09-04 22:32:46 giờ VN, 8 mã × 30 cái):
 *
 *   {"type":"variations_warehouses","inserted_at":"2026-09-04 15:32:46.779394",
 *    "variation_id":"7dc17043-…","warehouse_id":"8ea354a7-…","remain_quantity":29,
 *    "actual_remain_quantity":30,"change_quantity":30,"is_actual_remain_quantity":true}
 *
 * Ba khác biệt so với sự kiện đơn hàng, cả ba đều là chỗ dễ vỡ nếu ai siết schema:
 *  - **`order_id` VẮNG HẲN** (8 khoá, không phải 9) — không có đơn nào gây ra biến động này.
 *  - `change_quantity` DƯƠNG (hàng vào kho), không âm như bán hàng.
 *  - `is_actual_remain_quantity` = `true`, và `remain` vẫn có thể KHÁC `actual` (ca SP000417 thật:
 *    remain 29 vs actual 30 — 1 cái đang giữ cho đơn chưa xuất).
 */
const SU_KIEN_PHIEU_NHAP = (opts: {
  remain: number;
  insertedAt: string;
  actual?: number;
  changeQuantity?: number;
}) =>
  `{"type":"variations_warehouses","inserted_at":"${opts.insertedAt}",` +
  `"variation_id":"${VARIATION_ID}","warehouse_id":"${WAREHOUSE_KHO_TONG}",` +
  `"remain_quantity":${opts.remain},"actual_remain_quantity":${opts.actual ?? opts.remain},` +
  `"change_quantity":${opts.changeQuantity ?? 30},"is_actual_remain_quantity":true}`;

/** `syncedAt` = lần cuối API ghi biến thể. Guard thứ tự so mốc sự kiện với nó. */
async function taoVariant(stock: number, syncedAt: Date, pancakeId = VARIATION_ID): Promise<void> {
  const p = await prisma.product.create({
    data: { pancakeId: `P-${pancakeId}`, name: "SP test", syncedAt },
  });
  await prisma.variant.create({
    data: {
      pancakeId,
      productId: p.id,
      sku: "SP000426",
      label: "90/Đỏ",
      sellPrice: 100_000,
      stock,
      costPrice: 50_000,
      syncedAt,
    },
  });
}

async function tonHienTai(): Promise<{ stock: number; stockUpdatedAt: Date | null; costPrice: number }> {
  const v = await prisma.variant.findUniqueOrThrow({ where: { pancakeId: VARIATION_ID } });
  return { stock: v.stock, stockUpdatedAt: v.stockUpdatedAt, costPrice: v.costPrice };
}

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await clearBronzeBacklog();
});

describe("webhook tồn kho — đường ghi", () => {
  it("sự kiện shop KHO mới hơn API → ghi thẳng Variant.stock + đóng mốc", async () => {
    await taoVariant(7, new Date("2026-07-27T04:00:00Z"));

    const kq = await xuLySuKienWebhook({
      shopId: SHOP_KHO,
      payload: SU_KIEN({ remain: 2, insertedAt: "2026-07-27 09:50:12.263269" }),
    });

    expect(kq.processedAs).toBe("ton-kho");
    const v = await tonHienTai();
    expect(v.stock).toBe(2);
    // Mốc lưu ĐÚNG instant UTC của chuỗi naive (bất biến #3) — không lệch 7 giờ.
    expect(v.stockUpdatedAt?.toISOString()).toBe("2026-07-27T09:50:12.263Z");
  });

  it("tồn ÂM là hợp lệ (bán vượt) — vẫn ghi", async () => {
    await taoVariant(1, new Date("2026-07-27T04:00:00Z"));

    const kq = await xuLySuKienWebhook({
      shopId: SHOP_KHO,
      payload: SU_KIEN({ remain: -3, insertedAt: "2026-07-27 09:50:12.000000" }),
    });

    expect(kq.processedAs).toBe("ton-kho");
    expect((await tonHienTai()).stock).toBe(-3);
  });

  it("KHÔNG đụng giá vốn APP-OWNED khi ghi tồn", async () => {
    await taoVariant(7, new Date("2026-07-27T04:00:00Z"));

    await xuLySuKienWebhook({
      shopId: SHOP_KHO,
      payload: SU_KIEN({ remain: 0, insertedAt: "2026-07-27 09:50:12.000000" }),
    });

    expect((await tonHienTai()).costPrice).toBe(50_000);
  });

  it("lấy `remain_quantity`, KHÔNG lấy `actual_remain_quantity`", async () => {
    await taoVariant(7, new Date("2026-07-27T04:00:00Z"));

    await xuLySuKienWebhook({
      shopId: SHOP_KHO,
      payload: SU_KIEN({ remain: 1, actual: 2, insertedAt: "2026-07-27 09:50:12.000000" }),
    });

    expect((await tonHienTai()).stock).toBe(1);
  });
});

/**
 * Ca PHIẾU NHẬP KHO — đo thật 2026-09-04, đóng câu hỏi treo từ 2026-07-27.
 *
 * Phiếu nhập bên Pancake CÓ bắn `variations_warehouses`, độ trễ 1 giây (lưu 22:32:46 → app nhận
 * 22:32:47 giờ VN), 8/8 mã ghi đúng, 0 sự kiện `ton-kho-can-xem`. Trước đó tài liệu chỉ dám hứa
 * "chậm nhất ~24 giờ theo lượt API đêm" vì chưa có mẫu thật.
 *
 * Lưới này giữ đúng hành vi ĐANG ĐÚNG: `order_id` tuỳ chọn là thứ DUY NHẤT cho phép phiếu nhập đi
 * lọt. Ai siết nó thành bắt buộc thì mọi phiếu nhập rơi hết vào `ton-kho-can-xem` — tồn đứng im tới
 * lượt vá đêm mà không cổng nào bắt.
 */
describe("webhook tồn kho — phiếu nhập kho (đo thật 2026-09-04)", () => {
  it("phiếu nhập KHÔNG có `order_id` + `change_quantity` DƯƠNG → vẫn ghi tồn", async () => {
    await taoVariant(7, new Date("2026-09-04T10:00:00Z"));

    const kq = await xuLySuKienWebhook({
      shopId: SHOP_KHO,
      payload: SU_KIEN_PHIEU_NHAP({ remain: 37, insertedAt: "2026-09-04 15:32:46.779501" }),
    });

    expect(kq.processedAs).toBe("ton-kho");
    const v = await tonHienTai();
    expect(v.stock).toBe(37);
    expect(v.stockUpdatedAt?.toISOString()).toBe("2026-09-04T15:32:46.779Z");
  });

  it("phiếu nhập: `remain` ≠ `actual` → lấy remain (tồn khả dụng), kể cả khi remain ÂM", async () => {
    // Ca SP000417 thật: 30 cái vừa nhập nhưng 1 cái đang giữ cho đơn chưa xuất ⇒ remain 29, actual 30.
    await taoVariant(-1, new Date("2026-09-04T10:00:00Z"));

    await xuLySuKienWebhook({
      shopId: SHOP_KHO,
      payload: SU_KIEN_PHIEU_NHAP({
        remain: 29,
        actual: 30,
        insertedAt: "2026-09-04 15:32:46.779394",
      }),
    });

    expect((await tonHienTai()).stock).toBe(29);
  });

  it("phiếu nhập KHÔNG đụng giá vốn — Pancake tính lại giá TB, app giữ số của mình", async () => {
    // Đúng chỗ này là lý do giá vốn phải chạy công cụ đối chiếu có người duyệt (bất biến #5):
    // phiếu nhập làm Pancake đổi `average_imported_price`, nhưng webhook TUYỆT ĐỐI không được
    // mang số đó vào — nó chỉ chạm cột `stock`.
    await taoVariant(0, new Date("2026-09-04T10:00:00Z"));

    await xuLySuKienWebhook({
      shopId: SHOP_KHO,
      payload: SU_KIEN_PHIEU_NHAP({ remain: 30, insertedAt: "2026-09-04 15:32:46.779250" }),
    });

    const v = await tonHienTai();
    expect(v.stock).toBe(30);
    expect(v.costPrice).toBe(50_000);
  });

  it("hai sự kiện SONG SINH cùng lô nhập → bản chụp cũ hơn không kéo tồn lùi", async () => {
    // Pancake bắn nhiều sự kiện cho cùng một lô, lệch nhau vài chục micro-giây (đo thật: 6/18 sự
    // kiện của phiếu 04/09 rơi vào `ton-kho-cu-hon`). Bản tới sau nhưng chụp TRƯỚC phải bị bỏ.
    await taoVariant(0, new Date("2026-09-04T10:00:00Z"));

    const moi = await xuLySuKienWebhook({
      shopId: SHOP_KHO,
      payload: SU_KIEN_PHIEU_NHAP({ remain: 30, insertedAt: "2026-09-04 15:32:46.779250" }),
    });
    const cu = await xuLySuKienWebhook({
      shopId: SHOP_KHO,
      payload: SU_KIEN_PHIEU_NHAP({ remain: 0, insertedAt: "2026-09-04 15:32:46.746346" }),
    });

    expect(moi.processedAs).toBe("ton-kho");
    expect(cu.processedAs).toBe("ton-kho-cu-hon");
    expect((await tonHienTai()).stock).toBe(30);
  });
});

describe("webhook tồn kho — guard thứ tự (API mạnh hơn webhook)", () => {
  it("sự kiện CŨ HƠN lần API ghi gần nhất → KHÔNG ghi", async () => {
    await taoVariant(5, new Date("2026-07-27T10:00:00Z"));

    const kq = await xuLySuKienWebhook({
      shopId: SHOP_KHO,
      payload: SU_KIEN({ remain: 99, insertedAt: "2026-07-27 09:50:12.000000" }),
    });

    expect(kq.processedAs).toBe("ton-kho-cu-hon");
    const v = await tonHienTai();
    expect(v.stock).toBe(5);
    expect(v.stockUpdatedAt).toBeNull();
  });

  it("sự kiện CÙNG mốc với lần API ghi → KHÔNG ghi (API thắng khi hoà)", async () => {
    await taoVariant(5, new Date("2026-07-27T09:50:12.000Z"));

    const kq = await xuLySuKienWebhook({
      shopId: SHOP_KHO,
      payload: SU_KIEN({ remain: 99, insertedAt: "2026-07-27 09:50:12.000000" }),
    });

    expect(kq.processedAs).toBe("ton-kho-cu-hon");
    expect((await tonHienTai()).stock).toBe(5);
  });

  it("hai sự kiện tới NGƯỢC thứ tự → bản cũ không kéo tồn lùi lại", async () => {
    await taoVariant(9, new Date("2026-07-27T04:00:00Z"));

    await xuLySuKienWebhook({
      shopId: SHOP_KHO,
      payload: SU_KIEN({ remain: 3, insertedAt: "2026-07-27 09:50:12.000000" }),
    });
    const kq = await xuLySuKienWebhook({
      shopId: SHOP_KHO,
      payload: SU_KIEN({ remain: 8, insertedAt: "2026-07-27 09:40:00.000000" }),
    });

    expect(kq.processedAs).toBe("ton-kho-cu-hon");
    expect((await tonHienTai()).stock).toBe(3);
  });

  it("sự kiện tiếp theo MỚI HƠN mốc webhook trước đó → vẫn ghi bình thường", async () => {
    await taoVariant(9, new Date("2026-07-27T04:00:00Z"));

    await xuLySuKienWebhook({
      shopId: SHOP_KHO,
      payload: SU_KIEN({ remain: 3, insertedAt: "2026-07-27 09:50:12.000000" }),
    });
    const kq = await xuLySuKienWebhook({
      shopId: SHOP_KHO,
      payload: SU_KIEN({ remain: 2, insertedAt: "2026-07-27 10:05:00.000000" }),
    });

    expect(kq.processedAs).toBe("ton-kho");
    expect((await tonHienTai()).stock).toBe(2);
  });
});

describe("webhook tồn kho — ca phải hiện lên panel", () => {
  it("kho LẠ → `ton-kho-can-xem`, KHÔNG ghi (tồn per-kho sẽ báo thiếu hàng sai)", async () => {
    await taoVariant(7, new Date("2026-07-27T04:00:00Z"));

    const kq = await xuLySuKienWebhook({
      shopId: SHOP_KHO,
      payload: SU_KIEN({
        remain: 0,
        insertedAt: "2026-07-27 09:50:12.000000",
        warehouseId: "a86420cc-3f8c-4341-8948-782783d49876",
      }),
    });

    expect(kq.processedAs).toBe("ton-kho-can-xem");
    expect(kq.note).toContain("kho lạ");
    expect((await tonHienTai()).stock).toBe(7);
  });

  it("chưa có biến thể trong app → kết cục RIÊNG (tự lành, không báo đỏ), KHÔNG tự đẻ variant", async () => {
    const kq = await xuLySuKienWebhook({
      shopId: SHOP_KHO,
      payload: SU_KIEN({
        remain: 4,
        insertedAt: "2026-07-27 09:50:12.000000",
        variationId: "11111111-2222-3333-4444-555555555555",
      }),
    });

    expect(kq.processedAs).toBe("ton-kho-chua-co-bien-the");
    expect(KET_CUC_CAN_XEM).not.toContain("ton-kho-chua-co-bien-the"); // tự lành ⇒ không tô đỏ
    expect(await prisma.variant.count()).toBe(0);
  });

  it("remain_quantity vô lý → `ton-kho-can-xem`, KHÔNG ghi", async () => {
    await taoVariant(7, new Date("2026-07-27T04:00:00Z"));

    const kq = await xuLySuKienWebhook({
      shopId: SHOP_KHO,
      payload: SU_KIEN({ remain: 99_999_999, insertedAt: "2026-07-27 09:50:12.000000" }),
    });

    expect(kq.processedAs).toBe("ton-kho-can-xem");
    expect((await tonHienTai()).stock).toBe(7);
  });

  it("thiếu field bắt buộc → `ton-kho-can-xem` kèm ghi chú, không ném lỗi", async () => {
    const kq = await xuLySuKienWebhook({
      shopId: SHOP_KHO,
      payload: `{"type":"variations_warehouses","variation_id":"${VARIATION_ID}"}`,
    });

    expect(kq.processedAs).toBe("ton-kho-can-xem");
    expect(kq.note).toBeTruthy();
  });
});

describe("webhook tồn kho — shop bán", () => {
  it.each([
    ["TikTok", SHOP_TIKTOK],
    ["Shopee", SHOP_SHOPEE],
  ])("sự kiện shop %s → bỏ qua, không đụng tồn (bộ mã biến thể riêng)", async (_ten, shopId) => {
    await taoVariant(7, new Date("2026-07-27T04:00:00Z"));

    const kq = await xuLySuKienWebhook({
      shopId,
      payload: SU_KIEN({ remain: 0, insertedAt: "2026-07-27 09:50:12.000000" }),
    });

    expect(kq.processedAs).toBe("ton-kho-bo-qua");
    expect((await tonHienTai()).stock).toBe(7);
  });
});

describe("webhook tồn kho — BRONZE_ONLY", () => {
  it("bật BRONZE_ONLY → không ghi tồn, kết cục nói rõ lý do", async () => {
    await taoVariant(7, new Date("2026-07-27T04:00:00Z"));
    process.env.BRONZE_ONLY = "true";
    try {
      const kq = await xuLySuKienWebhook({
        shopId: SHOP_KHO,
        payload: SU_KIEN({ remain: 0, insertedAt: "2026-07-27 09:50:12.000000" }),
      });

      expect(kq.processedAs).toBe("bronze-only");
      expect((await tonHienTai()).stock).toBe(7);
    } finally {
      delete process.env.BRONZE_ONLY;
    }
  });
});
