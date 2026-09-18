import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { clearBronzeBacklog, hasBronzeBacklog, markBronzeBacklog } from "@/lib/bronze/bronze-only";
import { landRaw } from "@/lib/bronze/land-raw";
import { SHOP_KHO, SHOP_SHOPEE, SHOP_TIKTOK } from "../helpers/shop-ids-fixture";
import { transformFromRaw } from "@/lib/bronze/transform-from-raw";
import { sniffLoaiSuKien, xuLySuKienWebhook } from "@/lib/ingest/webhook-processor";
import { prisma } from "@/lib/prisma";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Bộ xử lý webhook Pancake pha 2.
 *
 * Shape payload lấy từ SỰ KIỆN THẬT trong hộp thư prod (đo 2026-07-27, 534 sự kiện — báo cáo
 * `plans/reports/danh-gia-mau-webhook-pancake-260727-1317-doi-chieu-api-vs-webhook-report.md`):
 *  - mọi sự kiện có field `type` (`orders` | `products` | `variations_warehouses`) — `event_type`
 *    thì KHÔNG (kho = null) nên tuyệt đối không dùng `event_type` để định tuyến;
 *  - `id` đơn là CHUỖI có nháy, kể cả id 18 chữ số của TikTok;
 *  - THỨ TỰ KHOÁ trong payload KHÔNG ổn định giữa các lần bắn (đo thật) — dedupe phải băm trên
 *    jsonb đã chuẩn hoá, không băm text thô;
 *  - `variations_warehouses` không có `id`, chỉ có `variation_id` + `remain_quantity`.
 */

/**
 * Đơn TikTok — id 18 chữ số (int64 nếu để trần). CỐ Ý KHÔNG có `customer`, giống payload webhook
 * thật (đo: 7 đơn webhook hệ mới vắng hẳn khoá này).
 */
const DON_TIKTOK = (id: string, fee = 15000, updatedAt = "2026-07-01T12:00:00.000000", status = 3) =>
  `{"type":"orders","event_type":"update","id":"${id}","status":${status},` +
  `"inserted_at":"2026-07-01T10:00:00.000000","updated_at":"${updatedAt}",` +
  `"order_sources_name":"Tiktok","marketplace_id":"-9",` +
  `"total_price":200000,"total_discount":0,"fee_marketplace":${fee},` +
  `"items":[{"quantity":2,"discount_each_product":0,` +
  `"variation_info":{"display_id":"WH-SKU-1","name":"Áo thun","retail_price":100000}}]}`;

/** Như trên nhưng ĐỦ mọi field mapping — dùng khi muốn guard "thiếu field" không kích hoạt. */
const DON_TIKTOK_DU_FIELD = (id: string, fee: number, updatedAt: string, status = 3) =>
  `{"type":"orders","event_type":"update","id":"${id}","system_id":"${id}","status":${status},` +
  `"status_name":"x","inserted_at":"2026-07-01T10:00:00.000000","updated_at":"${updatedAt}",` +
  `"status_history":[],"order_sources_name":"Tiktok","marketplace_id":"-9",` +
  `"total_price":200000,"total_discount":0,"shipping_fee":0,"fee_marketplace":${fee},` +
  `"advanced_platform_fee":{"payment_fee":0},"customer":{"name":"Chị Hoa"},` +
  `"items":[{"quantity":2,"discount_each_product":0,` +
  `"variation_info":{"display_id":"WH-SKU-1","name":"Áo thun","retail_price":100000}}]}`;

/** Trang API (envelope `{data:[…]}`) của CÙNG đơn — ĐỦ field như Pancake trả thật. */
const TRANG_API = (id: string, fee: number, updatedAt: string, status = 3, returnedFee?: number) =>
  `{"success":true,"data":[{"id":"${id}","system_id":"${id}","status":${status},` +
  `"status_name":"x","inserted_at":"2026-07-01T10:00:00.000000","updated_at":"${updatedAt}",` +
  `"status_history":[],"is_abandoned_order":false,"order_sources_name":"Tiktok","marketplace_id":"-9",` +
  `"total_price":200000,"total_discount":0,"shipping_fee":0,"fee_marketplace":${fee},` +
  `"advanced_platform_fee":{"payment_fee":0${returnedFee === undefined ? "" : `,"returned_fee":${returnedFee}`}},` +
  `"customer":{"name":"Chị Hoa"},` +
  `"items":[{"quantity":2,"discount_each_product":0,` +
  `"variation_info":{"display_id":"WH-SKU-1","name":"Áo thun","retail_price":100000}}]}]}`;

/** Đơn MIRROR shop kho (`AF<shop>O…`, nguồn Affiliate) — raw GIỮ, Silver BỎ (bất biến #2). */
const DON_MIRROR_KHO =
  `{"type":"orders","id":"AF100975192O582","status":3,` +
  `"inserted_at":"2026-07-01T10:00:00.000000","updated_at":"2026-07-01T12:00:00.000000",` +
  `"order_sources_name":"Affiliate","marketplace_id":"-9",` +
  `"total_price":999000,"total_discount":0,"fee_marketplace":0,"items":[]}`;

/** Sự kiện tồn kho — copy NGUYÊN XI từ hộp thư prod (shop kho, 27/07). Pha này CỐ Ý bỏ qua. */
const TON_KHO = (variationId: string, remain: number) =>
  `{"type":"variations_warehouses","inserted_at":"2026-07-27 04:57:04.925107",` +
  `"variation_id":"${variationId}","warehouse_id":"8ea354a7-2350-4446-a1d5-8308353ff841",` +
  `"remain_quantity":${remain},"order_id":"AF100975192O582","change_quantity":-1,` +
  `"is_actual_remain_quantity":false,"actual_remain_quantity":1}`;

/** Sản phẩm webhook — CỐ Ý thiếu `average_imported_price` + `remain_quantity` (đo 0/174 biến thể). */
const SAN_PHAM =
  `{"type":"products","id":"158ef5f1-6083-4b60-b5e0-c4fe95a07327","name":"Áo Sơ Mi",` +
  `"variations":[{"id":"V-1","display_id":"SP000463","retail_price":241000}]}`;

const VARIATION_ID = "ea8b07f0-6d00-44fc-974f-fe96702a4071";

async function taoVariant(pancakeId: string, stock: number): Promise<void> {
  const now = new Date();
  const p = await prisma.product.create({
    data: { pancakeId: `P-${pancakeId}`, name: "SP test", syncedAt: now },
  });
  await prisma.variant.create({
    data: {
      pancakeId,
      productId: p.id,
      sku: "WH-SKU-1",
      label: "90/Đỏ",
      sellPrice: 100000,
      stock,
      costPrice: 50000,
      syncedAt: now,
    },
  });
}

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.rawPancakeOrder.deleteMany();
  await prisma.rawPancakeProduct.deleteMany();
  await clearBronzeBacklog();
});

describe("sniffLoaiSuKien", () => {
  it("đọc được `type` của cả 3 loại sự kiện thật", () => {
    expect(sniffLoaiSuKien(DON_TIKTOK("1")).type).toBe("orders");
    expect(sniffLoaiSuKien(SAN_PHAM).type).toBe("products");
    expect(sniffLoaiSuKien(TON_KHO(VARIATION_ID, 0)).type).toBe("variations_warehouses");
  });

  it("payload không phải JSON object → laJsonObject=false (không đoán bừa)", () => {
    expect(sniffLoaiSuKien("không phải json").laJsonObject).toBe(false);
    expect(sniffLoaiSuKien("[1,2,3]").laJsonObject).toBe(false);
    expect(sniffLoaiSuKien("null").laJsonObject).toBe(false);
  });

  it("JSON object hợp lệ nhưng thiếu `type` → type=null, KHÔNG ném lỗi", () => {
    expect(sniffLoaiSuKien(`{"id":"X"}`)).toEqual({ laJsonObject: true, type: null });
  });
});

describe("xuLySuKienWebhook — đơn hàng", () => {
  it("đơn TikTok → land Bronze + dựng Silver, id 18 chữ số giữ NGUYÊN từng chữ số", async () => {
    const id = "585229755054261862";

    const kq = await xuLySuKienWebhook({ shopId: SHOP_TIKTOK, payload: DON_TIKTOK(id) });

    expect(kq.processedAs).toBe("don-hang");
    const raw = await prisma.rawPancakeOrder.findFirst({ where: { externalId: id } });
    expect(raw).not.toBeNull(); // khoá không bị làm tròn thành …860/…900
    const don = await prisma.order.findUnique({ where: { pancakeId: id } });
    expect(don?.itemsTotal).toBe(200_000);
    expect(don?.platformFeeEst).toBe(15_000); // phí THẬT fee_marketplace
  });

  it("đơn mirror kho → hạch toán ĐÚNG Ý: raw giữ, Silver BỎ (không đếm doanh thu 2 lần)", async () => {
    const kq = await xuLySuKienWebhook({ shopId: SHOP_KHO, payload: DON_MIRROR_KHO });

    expect(kq.processedAs).toBe("don-hang");
    expect(kq.note).toContain("mirror");
    expect(await prisma.rawPancakeOrder.count()).toBe(1);
    expect(await prisma.order.count()).toBe(0);
  });

  it("bắn lại payload Y HỆT → guard chặn, KHÔNG nhân đôi dòng Bronze", async () => {
    const id = "585229755054261862";
    await xuLySuKienWebhook({ shopId: SHOP_TIKTOK, payload: DON_TIKTOK(id) });

    const lai = await xuLySuKienWebhook({ shopId: SHOP_TIKTOK, payload: DON_TIKTOK(id) });

    expect(lai.processedAs).toBe("don-hang-cu-hon");
    expect(await prisma.rawPancakeOrder.count()).toBe(1);
  });

  it("THỨ TỰ KHOÁ đổi, nội dung y hệt, KHÔNG có updated_at → trùng hash (băm trên jsonb chuẩn hoá)", async () => {
    // Thiếu `updated_at` ⇒ guard không so được thứ tự ⇒ đi tới nhánh dedupe theo hash. Pancake thật
    // ĐỔI thứ tự khoá giữa các lần bắn nên hash phải băm trên jsonb đã chuẩn hoá, không băm text.
    const a = `{"type":"orders","id":"KEY-ORDER","status":3,"inserted_at":"2026-07-01T10:00:00.000000","order_sources_name":"Tiktok","marketplace_id":"-9","total_price":200000,"total_discount":0,"fee_marketplace":15000,"items":[]}`;
    const b = `{"id":"KEY-ORDER","status":3,"total_price":200000,"type":"orders","marketplace_id":"-9","inserted_at":"2026-07-01T10:00:00.000000","fee_marketplace":15000,"order_sources_name":"Tiktok","total_discount":0,"items":[]}`;
    await xuLySuKienWebhook({ shopId: SHOP_TIKTOK, payload: a });

    const sau = await xuLySuKienWebhook({ shopId: SHOP_TIKTOK, payload: b });

    expect(sau.note).toContain("trùng hash");
    expect(await prisma.rawPancakeOrder.count()).toBe(1);
  });

  it("Bronze có mốc mà sự kiện THIẾU updated_at → vẫn xử lý nhưng NÓI RÕ là không so được thứ tự", async () => {
    const id = "585229755054261862";
    await landRaw("orders", SHOP_TIKTOK, TRANG_API(id, 15_000, "2026-07-01T12:00:00.000000"));
    const khongMoc = DON_TIKTOK_DU_FIELD(id, 15_000, "BO-DI", 3).replace(
      `"updated_at":"BO-DI",`,
      "",
    );

    const kq = await xuLySuKienWebhook({ shopId: SHOP_TIKTOK, payload: khongMoc });

    // Mất guard mà im lặng là nguy hiểm nhất — phải để lại vết trên panel.
    expect(kq.note).toContain("thiếu updated_at");
  });

  it("phí sàn đổi (tạm → thật) → land bản MỚI, Silver lấy bản mới nhất", async () => {
    const id = "585229755054261862";
    // Pancake LUÔN bump `updated_at` khi phí đổi (đo 30/30 cặp trên dữ liệu thật).
    await xuLySuKienWebhook({
      shopId: SHOP_TIKTOK,
      payload: DON_TIKTOK(id, 10_450, "2026-07-02T08:00:00.000000"),
    });

    await xuLySuKienWebhook({
      shopId: SHOP_TIKTOK,
      payload: DON_TIKTOK(id, 55_999, "2026-07-05T09:00:00.000000"),
    });

    expect(await prisma.rawPancakeOrder.count()).toBe(2); // append-only: giữ cả lịch sử
    const don = await prisma.order.findUnique({ where: { pancakeId: id } });
    expect(don?.platformFeeEst).toBe(55_999);
  });
});

/**
 * GUARD THỨ TỰ — lỗi CRITICAL tìm ra ở review đối kháng 2026-07-27, đã chứng minh thực nghiệm.
 *
 * `landRaw` đóng dấu `fetchedAt = now()`, transform chọn bản `fetchedAt` mới nhất ⇒ nguồn land SAU
 * luôn thắng bất kể nội dung chụp lúc nào. Webhook là nguồn ĐẦU TIÊN có thể mang nội dung CŨ tới
 * muộn (2 sự kiện chạy song song trong n8n, hoặc sự kiện bắn trước lượt sync nhưng tới sau).
 * Nếu không chặn: phí sàn tụt từ số THẬT về số tạm, đơn hoàn/hủy lùi về PENDING rồi được tính lại
 * vào doanh thu — và KHÔNG tự lành (lượt API sau trùng hash; rebuild cũng chọn bản webhook cũ).
 */
describe("xuLySuKienWebhook — guard thứ tự (không để Silver thụt lùi)", () => {
  const ID = "584292701589702461";

  it("webhook CŨ hơn bản API đang có → KHÔNG land, KHÔNG đụng Silver", async () => {
    // API đã land bản mới: phí THẬT sau đối soát.
    await landRaw("orders", SHOP_TIKTOK, TRANG_API(ID, 214_639, "2026-07-05T09:00:00.000000"));
    await transformFromRaw("orders", [], { shopId: SHOP_TIKTOK });
    const soDongBronze = await prisma.rawPancakeOrder.count();

    // Sự kiện webhook chụp TRƯỚC đó (phí còn là số tạm) mới tới.
    const kq = await xuLySuKienWebhook({
      shopId: SHOP_TIKTOK,
      payload: DON_TIKTOK_DU_FIELD(ID, 43_500, "2026-07-02T08:00:00.000000", 1),
    });

    expect(kq.processedAs).toBe("don-hang-cu-hon");
    // KHÔNG land: dòng Bronze cũ-nội-dung-mới-fetchedAt là quả mìn cho mọi lần rebuild sau này.
    expect(await prisma.rawPancakeOrder.count()).toBe(soDongBronze);
    const don = await prisma.order.findUnique({ where: { pancakeId: ID } });
    expect(don?.platformFeeEst).toBe(214_639); // phí THẬT giữ nguyên
    expect(don?.status).toBe("COMPLETED"); // không lùi về PENDING
  });

  it("rebuild-from-raw sau đó VẪN ra số đúng (sự kiện cũ không nằm trong Bronze)", async () => {
    await landRaw("orders", SHOP_TIKTOK, TRANG_API(ID, 214_639, "2026-07-05T09:00:00.000000"));
    await transformFromRaw("orders", [], { shopId: SHOP_TIKTOK });
    await xuLySuKienWebhook({
      shopId: SHOP_TIKTOK,
      payload: DON_TIKTOK_DU_FIELD(ID, 43_500, "2026-07-02T08:00:00.000000", 1),
    });

    await transformFromRaw("orders", []); // đường rebuild: quét cả bảng

    const don = await prisma.order.findUnique({ where: { pancakeId: ID } });
    expect(don?.platformFeeEst).toBe(214_639);
  });

  it("webhook MỚI hơn → land + dựng Silver bình thường (guard không chặn nhầm)", async () => {
    await landRaw("orders", SHOP_TIKTOK, TRANG_API(ID, 43_500, "2026-07-02T08:00:00.000000", 1));
    await transformFromRaw("orders", [], { shopId: SHOP_TIKTOK });

    const kq = await xuLySuKienWebhook({
      shopId: SHOP_TIKTOK,
      payload: DON_TIKTOK_DU_FIELD(ID, 214_639, "2026-07-05T09:00:00.000000"),
    });

    expect(kq.processedAs).toBe("don-hang");
    const don = await prisma.order.findUnique({ where: { pancakeId: ID } });
    expect(don?.platformFeeEst).toBe(214_639);
  });

  /**
   * Ca THẬT đo được 2026-07-27 (đơn `584110837587871182`): Pancake sửa phí sàn lúc ĐỐI SOÁT
   * — `fee_marketplace` 16.000 → 5.839 kèm `returned_fee` xuất hiện — mà **giữ nguyên `updated_at`**.
   * Nên `updated_at` KHÔNG phải số phiên bản đáng tin, và guard phải chặn cả bản CÙNG mốc:
   * cho đi tiếp là sự kiện webhook cũ đè mất số đã đối soát, không cách nào tự lành.
   */
  it("CÙNG mốc updated_at nhưng phí KHÁC (Pancake đối soát không bump mốc) → giữ số API", async () => {
    await landRaw("orders", SHOP_TIKTOK, TRANG_API(ID, 5_839, "2026-06-02T07:17:40.657139", 4));
    await transformFromRaw("orders", [], { shopId: SHOP_TIKTOK });

    const kq = await xuLySuKienWebhook({
      shopId: SHOP_TIKTOK,
      payload: DON_TIKTOK_DU_FIELD(ID, 16_000, "2026-06-02T07:17:40.657139", 4),
    });

    expect(kq.processedAs).toBe("don-hang-cu-hon");
    const don = await prisma.order.findUnique({ where: { pancakeId: ID } });
    expect(don?.platformFeeEst).toBe(5_839); // phí ĐÃ ĐỐI SOÁT giữ nguyên, không bị đè về 16.000
  });

  /**
   * "API mạnh hơn webhook" (user chốt 2026-07-27, đối chiếu TikTok Seller). Transform ghi đè CẢ
   * DÒNG, nên field webhook không mang sẽ thành null/0 và xoá mất số API đã có. Ca thật đã đo:
   * đơn `585179421329622462` có `customer.name` bên API nhưng payload webhook vắng khoá `customer`.
   */
  it("webhook MỚI HƠN nhưng THIẾU field API đang có → nhường API, không xoá dữ liệu", async () => {
    await landRaw("orders", SHOP_TIKTOK, TRANG_API(ID, 15_000, "2026-07-01T12:00:00.000000"));
    await transformFromRaw("orders", [], { shopId: SHOP_TIKTOK });
    // Sự kiện mới hơn (T+4 ngày) nhưng vắng hẳn khoá `customer`.
    const thieuCustomer = DON_TIKTOK(ID, 15_000, "2026-07-05T09:00:00.000000").replace(
      `"order_sources_name"`,
      `"khac":1,"order_sources_name"`,
    );

    const kq = await xuLySuKienWebhook({ shopId: SHOP_TIKTOK, payload: thieuCustomer });

    expect(kq.processedAs).toBe("don-hang-cu-hon");
    expect(kq.note).toContain("customer");
    const don = await prisma.order.findUnique({ where: { pancakeId: ID } });
    expect(don?.customerName).toBe("Chị Hoa"); // tên khách API mang về VẪN CÒN
  });

  it("webhook thiếu returned_fee mà API đang có → nhường API (tiền hoàn không bị xoá)", async () => {
    await landRaw("orders", SHOP_TIKTOK, TRANG_API(ID, 5_839, "2026-06-02T07:17:40.657139", 4, 5_839));
    await transformFromRaw("orders", [], { shopId: SHOP_TIKTOK });

    const kq = await xuLySuKienWebhook({
      shopId: SHOP_TIKTOK,
      payload: DON_TIKTOK_DU_FIELD(ID, 16_000, "2026-06-10T09:00:00.000000", 4),
    });

    expect(kq.processedAs).toBe("don-hang-cu-hon");
    expect(kq.note).toContain("returned_fee");
    const don = await prisma.order.findUnique({ where: { pancakeId: ID } });
    expect(don?.returnedFee).toBe(5_839); // phí hoàn thật GIỮ NGUYÊN
  });

  it("webhook thiếu marketplace_voucher mà API đang có → nhường API (doanh thu không tụt)", async () => {
    // Giảm giá dòng = 2 × 30.000 = 60.000 (discount_each_product là giảm giá MỖI ĐƠN VỊ) mà SÀN tài
    // trợ trọn ⇒ doanh thu đúng = 200.000 (giá gốc). Thiếu voucher ⇒ tụt về 140.000.
    const ruot = (voucher: boolean) =>
      `"total_price":200000,"total_discount":0,"shipping_fee":0,"fee_marketplace":0,` +
      `"advanced_platform_fee":{"payment_fee":0${voucher ? `,"marketplace_voucher":60000` : ""}},` +
      `"customer":{"name":"Chị Hoa"},` +
      `"items":[{"quantity":2,"discount_each_product":30000,` +
      `"variation_info":{"display_id":"WH-SKU-1","name":"Áo thun","retail_price":100000}}]`;
    const banApi =
      `{"success":true,"data":[{"id":"${ID}","system_id":"${ID}","status":3,"status_name":"x",` +
      `"inserted_at":"2026-07-01T10:00:00.000000","updated_at":"2026-06-02T07:17:40.657139",` +
      `"status_history":[],"order_sources_name":"Tiktok","marketplace_id":"-9",${ruot(true)}}]}`;
    const suKienThieuVoucher =
      `{"type":"orders","event_type":"update","id":"${ID}","system_id":"${ID}","status":3,"status_name":"x",` +
      `"inserted_at":"2026-07-01T10:00:00.000000","updated_at":"2026-06-10T09:00:00.000000",` +
      `"status_history":[],"order_sources_name":"Tiktok","marketplace_id":"-9",${ruot(false)}}`;

    await landRaw("orders", SHOP_TIKTOK, banApi);
    await transformFromRaw("orders", [], { shopId: SHOP_TIKTOK });
    expect((await prisma.order.findUnique({ where: { pancakeId: ID } }))?.itemsTotal).toBe(200_000);

    const kq = await xuLySuKienWebhook({ shopId: SHOP_TIKTOK, payload: suKienThieuVoucher });

    expect(kq.processedAs).toBe("don-hang-cu-hon");
    expect(kq.note).toContain("marketplace_voucher");
    const don = await prisma.order.findUnique({ where: { pancakeId: ID } });
    expect(don?.itemsTotal).toBe(200_000); // KHÔNG tụt về 140.000
  });

  it("guard chỉ so trong CÙNG shop — đơn shop khác không chặn nhầm", async () => {
    await landRaw("orders", SHOP_TIKTOK, TRANG_API(ID, 214_639, "2026-07-05T09:00:00.000000"));

    // Cùng externalId nhưng shop khác (giả định): phải land, không bị bản shop kia chặn.
    const kq = await xuLySuKienWebhook({
      shopId: SHOP_SHOPEE,
      payload: DON_TIKTOK(ID, 9_000, "2026-07-02T08:00:00.000000").replace(
        `"marketplace_id":"-9"`,
        `"marketplace_id":"-3"`,
      ),
    });

    expect(kq.processedAs).toBe("don-hang");
  });
});

describe("xuLySuKienWebhook — tín hiệu phải nổi lên panel", () => {
  it("mã trạng thái Pancake LẠ → kết cục cần-xem (đơn bị loại khỏi doanh thu, không được im)", async () => {
    const kq = await xuLySuKienWebhook({
      shopId: SHOP_TIKTOK,
      payload: DON_TIKTOK("MA-LA-1", 15_000, "2026-07-01T12:00:00.000000", 99),
    });

    expect(kq.processedAs).toBe("don-hang-can-xem");
    expect(kq.note).toContain("mã trạng thái");
  });

  it("sự kiện không dựng lại Silver NHƯNG đang có backlog Bronze → cần-xem, không trả kết cục xanh", async () => {
    const payload = DON_TIKTOK("BACKLOG-1");
    await xuLySuKienWebhook({ shopId: SHOP_TIKTOK, payload });
    await markBronzeBacklog();

    const lai = await xuLySuKienWebhook({ shopId: SHOP_TIKTOK, payload });

    expect(lai.processedAs).toBe("don-hang-can-xem");
    expect(lai.note).toContain("rebuild-from-raw");
  });

  it("shop_id trong đơn khác endpoint → chặn tại cửa (Bronze append-only, land nhầm là vĩnh viễn)", async () => {
    const lech = DON_TIKTOK("LECH-SHOP").replace(`"type":"orders"`, `"type":"orders","shop_id":"1942992175"`);

    const kq = await xuLySuKienWebhook({ shopId: SHOP_TIKTOK, payload: lech });

    expect(kq.processedAs).toBe("khong-nhan-dien");
    expect(kq.note).toContain("shop_id");
    expect(await prisma.rawPancakeOrder.count()).toBe(0);
  });
});

describe("xuLySuKienWebhook — loại cố ý bỏ qua và loại lạ", () => {
  it("tồn kho shop BÁN → bỏ qua (mã biến thể riêng, không khớp catalog app)", async () => {
    await taoVariant(VARIATION_ID, 7);

    const kq = await xuLySuKienWebhook({ shopId: SHOP_TIKTOK, payload: TON_KHO(VARIATION_ID, 2) });

    expect(kq.processedAs).toBe("ton-kho-bo-qua");
    const v = await prisma.variant.findUnique({ where: { pancakeId: VARIATION_ID } });
    expect(v?.stock).toBe(7);
  });

  it("sản phẩm → BỎ QUA có kết cục: không land, không đẻ variant costPrice=0", async () => {
    const kq = await xuLySuKienWebhook({ shopId: SHOP_KHO, payload: SAN_PHAM });

    expect(kq.processedAs).toBe("san-pham-bo-qua");
    expect(await prisma.rawPancakeProduct.count()).toBe(0);
    expect(await prisma.variant.count()).toBe(0);
  });

  it("type LẠ → `khong-nhan-dien` kèm ghi chú để còn vào fix (không nuốt im lặng)", async () => {
    const kq = await xuLySuKienWebhook({
      shopId: SHOP_SHOPEE,
      payload: `{"type":"auto_call","id":"X"}`,
    });

    expect(kq.processedAs).toBe("khong-nhan-dien");
    expect(kq.note).toContain("auto_call");
  });

  it("payload rác → `khong-nhan-dien`, KHÔNG ném lỗi ra ngoài (hộp thư đã giữ raw)", async () => {
    const kq = await xuLySuKienWebhook({ shopId: SHOP_SHOPEE, payload: "<html>lỗi 502</html>" });

    expect(kq.processedAs).toBe("khong-nhan-dien");
  });

  it("BRONZE_ONLY: đơn LAND nhưng KHÔNG dựng Silver, và bật cờ backlog để buộc rebuild", async () => {
    process.env.BRONZE_ONLY = "true";
    try {
      const kq = await xuLySuKienWebhook({ shopId: SHOP_TIKTOK, payload: DON_TIKTOK("BO-1") });

      expect(kq.processedAs).toBe("bronze-only");
      expect(await prisma.rawPancakeOrder.count()).toBe(1);
      expect(await prisma.order.count()).toBe(0);
      expect(await hasBronzeBacklog()).toBe(true);
    } finally {
      delete process.env.BRONZE_ONLY;
    }
  });

  it("đơn hỏng shape (thiếu inserted_at) → `loi`, raw VẪN land để sửa mapping rồi rebuild", async () => {
    const hong = `{"type":"orders","id":"HONG-1","status":3,"items":[]}`;

    const kq = await xuLySuKienWebhook({ shopId: SHOP_TIKTOK, payload: hong });

    expect(kq.processedAs).toBe("loi");
    expect(await prisma.rawPancakeOrder.count()).toBe(1); // không mất dữ liệu
    expect(await prisma.order.count()).toBe(0);
  });
});
