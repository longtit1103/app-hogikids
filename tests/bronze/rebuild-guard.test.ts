import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { hasBronzeBacklog, markBronzeBacklog } from "@/lib/bronze/bronze-only";
import { landRaw } from "@/lib/bronze/land-raw";
import { dungLaiGiaoDichTuKhoTho, rebuildFromRaw } from "@/lib/bronze/rebuild";
import { SHOP_KHO, SHOP_SHOPEE, SHOP_TIKTOK_SHOP } from "../helpers/shop-ids-fixture";
import { transformFromRaw } from "@/lib/bronze/transform-from-raw";
import { giuKhoaGhiChiTieuAds } from "@/lib/ingest/khoa-ghi-chi-tieu-ads";
import { prisma } from "@/lib/prisma";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * BẤT BIẾN TIỀN quan trọng nhất của dự án: rebuild dựng lại Silver TỪ BRONZE, và TUYỆT ĐỐI
 * không đụng dữ liệu APP-OWNED (Pancake không có — chủ shop tự nhập):
 *   Variant.costPrice, Variant.lowStockThreshold, Expense (mọi source), ExpenseCategory tự tạo.
 * Rebuild đè costPrice về average_imported_price ⇒ COGS sai toàn bộ, P&L sai, không hoàn tác được.
 */

const body = (items: string) => `{"success":true,"data":[${items}]}`;

/** Product shop KHO — nguồn giá vốn (average_imported_price = 40.000). */
const PRODUCT = `{"id":"P-1","name":"Váy hè","variations":[
  {"id":"V-KHO-1","display_id":"SKU-1","retail_price":100000,
   "remain_quantity":10,"average_imported_price":40000}]}`;

/**
 * Đơn Shopee: `variation_id` là UUID RIÊNG của shop bán (KHÔNG khớp `V-KHO-1`) → item chỉ tra
 * được Variant qua SKU. Đây là đường sống của COGS (giá vốn nằm ở variant kho).
 */
const ORDER = `{
  "id":"ORD-1","status":3,"inserted_at":"2026-07-01T10:00:00.000000",
  "order_sources_name":"Shopee","marketplace_id":"-3",
  "total_price":200000,"total_discount":0,"fee_marketplace":15000,
  "items":[{"quantity":2,"discount_each_product":0,"variation_id":"V-SHOPEE-KHAC",
    "variation_info":{"display_id":"SKU-1","name":"Váy hè","retail_price":100000}}]}`;

/** Sao kê TikTok Shop hợp lệ → Silver "Tiền đã về" (dòng tiền đối chiếu, ĐỘC LẬP P&L). */
const STATEMENT = `{"code":0,"message":"Success","data":{"statements":[
  {"id":"7639761649183852290","statement_time":1778803200,"settlement_amount":"159902","currency":"VND"}]}}`;

/** Đơn MIRROR shop kho (nguồn Affiliate + marketplace −3) — luật HIỆN TẠI loại khỏi Silver. */
const MIRROR = `{
  "id":"AF1942992175O9","status":3,"inserted_at":"2026-07-01T10:00:00.000000",
  "order_sources_name":"Affiliate","marketplace_id":"-3",
  "total_price":999000,"total_discount":0,"fee_marketplace":0,"items":[]}`;

/** Báo cáo chi tiêu Meta (shape thật) — dùng để lượt dựng lại phải đi qua NHÁNH TẠO DÒNG ads. */
const ACT_META = "act_415299582336742";
const BAO_CAO_META =
  `{"data":[{"spend":"120000","campaign_id":"23851","campaign_name":"Ao vay be gai",` +
  `"account_currency":"VND","date_start":"2026-05-20","date_stop":"2026-05-20","impressions":"1200"}],` +
  `"paging":{"cursors":{"after":"MjQZD"}}}`;

/**
 * Chờ tới khi điều kiện đúng, KHÔNG dùng `sleep` đoán chừng: máy chậm / Tailscale chậm sẽ làm test
 * canh giờ đỏ ngẫu nhiên, mà đỏ ngẫu nhiên thì lần sau người ta chạy lại cho qua.
 */
async function choToiKhi(dieuKien: () => Promise<boolean>, moTa: string): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (await dieuKien()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Quá hạn chờ: ${moTa}`);
}

/**
 * Giữ KHOÁ GHI CHI TIÊU ADS để một lượt dựng lại ĐỨNG LẠI đúng ở nhánh tạo dòng ads
 * (`chayTrongKhoaGhiAds`) — mốc đó nằm SAU lúc chụp cờ backlog và TRƯỚC lúc hạ cờ. Nhờ vậy test mô
 * phỏng được "cờ bị bật lại giữa chừng" mà KHÔNG canh giờ (canh giờ = đỏ ngẫu nhiên trên máy chậm,
 * mà đỏ ngẫu nhiên thì lần sau người ta chạy lại cho qua).
 *
 * Dùng cho CẢ HAI đường dựng lại (nút bấm + lệnh chạy tay) — chúng phải theo cùng một luật hạ cờ.
 */
async function giuKhoaGhiAds(): Promise<{ nha: () => Promise<void> }> {
  let moKhoa!: () => void;
  const choMoKhoa = new Promise<void>((r) => (moKhoa = r));
  let daGiu!: () => void;
  const khoaSanSang = new Promise<void>((r) => (daGiu = r));
  const phien = prisma.$transaction(
    async (tx) => {
      await giuKhoaGhiChiTieuAds(tx);
      daGiu();
      await choMoKhoa;
    },
    { timeout: 60_000, maxWait: 10_000 }
  );
  await khoaSanSang;
  return {
    nha: async () => {
      moKhoa();
      await phien;
    },
  };
}

/** Đơn Silver dựng tay — mô phỏng đơn đã lọt vào Silver dưới LUẬT CŨ. */
const silverOrder = (pancakeId: string) =>
  prisma.order.create({
    data: {
      pancakeId,
      code: pancakeId,
      channelId: "shopee",
      status: "COMPLETED",
      orderedAt: new Date("2026-07-01T10:00:00+07:00"),
      itemsTotal: 999_000,
      syncedAt: new Date(),
    },
  });

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.rawPancakeOrder.deleteMany();
  await prisma.rawPancakeProduct.deleteMany();
  await prisma.rawTiktokShopStatement.deleteMany();
  await prisma.rawMetaAdsReport.deleteMany();
  // Cờ backlog sống trong Setting, ngoài truncateBusinessTables() — không xoá thì cờ của test
  // trước sống sót và test sau pass/fail vì lý do sai.
  await prisma.setting.deleteMany({ where: { key: "bronzeBacklogPending" } });
});

describe("rebuildFromRaw — BẤT BIẾN: không đụng dữ liệu APP-OWNED", () => {
  it("giá vốn sửa tay + ngưỡng tồn KHÔNG bị rebuild ghi đè", async () => {
    await landRaw("products", "714995134", body(PRODUCT));
    await transformFromRaw("products", []);

    // Chủ shop sửa giá vốn + ngưỡng bằng tay (Pancake KHÔNG có 2 thứ này).
    await prisma.variant.updateMany({
      where: { sku: "SKU-1" },
      data: { costPrice: 55_000, lowStockThreshold: 3 },
    });

    await rebuildFromRaw(); // dựng lại toàn bộ Silver từ Bronze

    const v = await prisma.variant.findFirst({ where: { sku: "SKU-1" } });
    expect(v?.costPrice).toBe(55_000); // KHÔNG quay về 40.000 (average_imported_price)
    expect(v?.lowStockThreshold).toBe(3); // KHÔNG bị xoá
  });

  it("chi phí nhập tay + danh mục tự tạo KHÔNG bị rebuild xoá", async () => {
    // Danh mục tự tạo (isSystem:false) — truncateBusinessTables GIỮ ExpenseCategory nên upsert
    // để test chạy lại được.
    const cat = await prisma.expenseCategory.upsert({
      where: { id: "cat-tu-tao" },
      create: { id: "cat-tu-tao", name: "Ship nội thành", isSystem: false },
      update: { name: "Ship nội thành", isSystem: false },
    });
    const exp = await prisma.expense.create({
      data: {
        date: new Date("2026-07-01T00:00:00+07:00"),
        categoryId: cat.id,
        description: "Băng keo",
        amount: 350_000,
        source: "MANUAL",
      },
    });

    // BẮT BUỘC land raw TRƯỚC: không có raw thì 2 vòng lặp transform chạy 0 lần ⇒ test pass vì
    // "chẳng có gì chạy", không phải vì Expense được bảo vệ (guard giấy, không cắn).
    await landRaw("products", "714995134", body(PRODUCT));
    await landRaw("orders", "1942992175", body(ORDER));

    const stats = await rebuildFromRaw();
    expect(stats.productsUpserted).toBe(1); // thân vòng lặp transform THẬT SỰ chạy
    expect(stats.ordersUpserted).toBe(1);

    expect(await prisma.expense.findUnique({ where: { id: exp.id } })).not.toBeNull();
    expect(await prisma.expenseCategory.findUnique({ where: { id: cat.id } })).not.toBeNull();
  });

  it("rebuild idempotent — chạy 2 lần không nhân đôi variant/đơn/item", async () => {
    await landRaw("products", "714995134", body(PRODUCT));
    await landRaw("orders", "1942992175", body(ORDER));

    await rebuildFromRaw();
    await rebuildFromRaw();

    expect(await prisma.variant.count({ where: { sku: "SKU-1" } })).toBe(1);
    expect(await prisma.order.count({ where: { pancakeId: "ORD-1" } })).toBe(1);
    expect(await prisma.orderItem.count()).toBe(1);
  });

  it("OrderItem tra Variant qua SKU khi variation_id khác shop → COGS dùng giá vốn kho", async () => {
    await landRaw("products", "714995134", body(PRODUCT));
    await landRaw("orders", "1942992175", body(ORDER));

    // products TRƯỚC orders — nếu ngược lại, item không tra được variant ⇒ COGS = 0.
    const stats = await rebuildFromRaw();

    expect(stats.productsUpserted).toBe(1);
    expect(stats.ordersUpserted).toBe(1);

    const kho = await prisma.variant.findUnique({ where: { pancakeId: "V-KHO-1" } });
    const item = await prisma.orderItem.findFirst({ where: { sku: "SKU-1" } });
    expect(item?.variantId).toBe(kho?.id); // khớp qua SKU, KHÔNG qua variation_id
    expect(kho?.costPrice).toBe(40_000); // prefill từ kho → COGS = 2 × 40.000
  });
});

/**
 * Rebuild CHỈ UPSERT, KHÔNG XOÁ ⇒ đơn đã lọt vào Silver dưới luật cũ vẫn nằm đó khi luật siết lại.
 * Không tự xoá (dữ liệu tiền, không hoàn tác) — nhưng PHẢI kêu to, không im lặng đếm 2 lần.
 */
describe("rebuildFromRaw — phát hiện đơn Silver kẹt", () => {
  it("đơn Silver nay bị luật mirror loại nhưng vẫn còn → cảnh báo đếm 2 lần", async () => {
    await landRaw("orders", "714995134", body(MIRROR));
    await silverOrder("AF1942992175O9"); // lọt vào Silver dưới luật cũ

    const warnings: string[] = [];
    const stats = await rebuildFromRaw(warnings);

    expect(stats.ordersSkippedMirror).toBe(1); // rebuild KHÔNG dựng lại nó
    expect(await prisma.order.count({ where: { pancakeId: "AF1942992175O9" } })).toBe(1); // vẫn kẹt
    expect(warnings.some((w) => w.includes("nay bị luật loại") && w.includes("đếm 2 lần"))).toBe(true);
    expect(warnings.some((w) => w.includes("ngoài cửa sổ Bronze"))).toBe(false); // đơn CÓ raw
  });

  it("đơn Silver không có raw Bronze → cảnh báo lịch sử ngoài cửa sổ Bronze", async () => {
    await landRaw("orders", "1942992175", body(ORDER));
    await silverOrder("ORD-CU-2025"); // đơn cũ hơn cửa sổ Bronze, không còn raw

    const warnings: string[] = [];
    await rebuildFromRaw(warnings);

    expect(warnings.some((w) => w.includes("1 đơn Silver không có raw Bronze"))).toBe(true);
    expect(warnings.some((w) => w.includes("nay bị luật loại"))).toBe(false);
  });

  it("Silver khớp Bronze → không cảnh báo kẹt", async () => {
    await landRaw("products", "714995134", body(PRODUCT));
    await landRaw("orders", "1942992175", body(ORDER));

    const warnings: string[] = [];
    await rebuildFromRaw(warnings);

    expect(warnings.some((w) => w.includes("Silver"))).toBe(false);
  });

  it("đơn BÙ có đơn gốc quay lại cùng (kênh, mã) → cảnh báo đếm 2 lần", async () => {
    // Đơn bù do script tạo (đủ cờ + dấu vết) — rồi Pancake trả lại đơn gốc cùng mã: script bù có
    // cửa sổ đua với sync, và đơn gốc có thể quay lại nhiều ngày sau. Không có guard này thì không
    // một cảnh báo nào bật (đối chiếu kho chỉ soi đơn THIẾU, không soi đơn THỪA).
    await prisma.order.create({
      data: {
        pancakeId: "AF1942992175O77",
        code: "77",
        channelId: "shopee",
        status: "COMPLETED",
        orderedAt: new Date("2026-03-15T10:00:00+07:00"),
        itemsTotal: 500_000,
        syncedAt: new Date(),
        backfilledFromMirror: true,
        raw: { _buTuDonKho: { nguon: "test" } },
      },
    });
    await prisma.order.create({
      data: {
        pancakeId: "SP-GOC-77",
        code: "77",
        channelId: "shopee",
        status: "COMPLETED",
        orderedAt: new Date("2026-03-15T10:00:00+07:00"),
        itemsTotal: 500_000,
        syncedAt: new Date(),
      },
    });

    const warnings: string[] = [];
    await rebuildFromRaw(warnings);

    expect(warnings.some((w) => w.includes("đơn gốc đã quay lại") && w.includes("đếm 2 lần"))).toBe(true);
  });

  it("đơn BÙ đứng một mình (đơn gốc vẫn mất) → KHÔNG cảnh báo đếm đôi", async () => {
    await prisma.order.create({
      data: {
        pancakeId: "AF1942992175O88",
        code: "88",
        channelId: "shopee",
        status: "COMPLETED",
        orderedAt: new Date("2026-03-15T10:00:00+07:00"),
        itemsTotal: 300_000,
        syncedAt: new Date(),
        backfilledFromMirror: true,
        raw: { _buTuDonKho: { nguon: "test" } },
      },
    });

    const warnings: string[] = [];
    await rebuildFromRaw(warnings);

    expect(warnings.some((w) => w.includes("đơn gốc đã quay lại"))).toBe(false);
  });
});

/**
 * Nút "Dựng lại từ kho thô" và cờ backlog Bronze.
 *
 * Cờ nghĩa là "còn dòng Bronze chưa lên Silver", và banner đỏ dính theo nó. Lượt bấm nút quét cả
 * bảng nên chạy HÀNG PHÚT, mà trong lúc đó các đường ghi khác KHÔNG bị chặn: webhook Pancake và
 * `/api/ingest/raw` vẫn bật được cờ vì dữ liệu VỪA tới hỏng. Nên lượt này chỉ được hạ cờ khi hội đủ
 * 3 điều kiện — sạch `skipped`, không còn sản phẩm kho kẹt ở Bronze, và cờ chưa bị bật lại kể từ
 * lúc lượt bắt đầu. Hai phía đều phải khoá bằng test: hạ được khi sạch (không thì banner đỏ dính
 * vĩnh viễn rồi bị bỏ qua), và TUYỆT ĐỐI không hạ khi cảnh báo còn đúng.
 */
describe("dungLaiGiaoDichTuKhoTho — cờ backlog", () => {
  it("lượt dựng lại sạch, không ai bật lại → HẠ cờ (nút tắt được banner)", async () => {
    await landRaw("orders", SHOP_SHOPEE, body(ORDER));
    await landRaw("tiktok/statements", SHOP_TIKTOK_SHOP, STATEMENT);
    await markBronzeBacklog();

    const warnings: string[] = [];
    const stats = await dungLaiGiaoDichTuKhoTho(warnings);

    expect(stats.ordersUpserted).toBe(1);
    expect(stats.settlementsUpserted).toBe(1); // dòng "Tiền đã về" đã lên Silver
    expect(stats.skipped).toBe(0);
    expect(await hasBronzeBacklog()).toBe(false);
    expect(warnings.some((w) => w.includes("backlog"))).toBe(false);
  });

  /**
   * CỔNG QUAN TRỌNG NHẤT của việc cho nút hạ cờ: cờ bật lại GIỮA lượt (một dòng vừa tới không lên
   * được Silver) thì lượt này chưa hề chữa ca đó — hạ là xoá một cảnh báo ĐANG ĐÚNG.
   *
   * Không canh giờ: test giữ sẵn khoá ghi chi tiêu ads nên lượt dựng lại đứng lại ĐÚNG ở nhánh tạo
   * dòng ads (`chayTrongKhoaGhiAds`), tức là sau mốc chụp cờ và trước lúc hạ cờ. Mốc "đơn đã vào
   * Silver" chứng minh lượt chạy đã qua mốc chụp cờ rồi mới bật lại cờ.
   */
  it("cờ bị bật lại GIỮA lượt → KHÔNG hạ cờ + nói rõ lý do", async () => {
    await landRaw("orders", SHOP_SHOPEE, body(ORDER));
    await landRaw("meta/report", ACT_META, BAO_CAO_META);
    await markBronzeBacklog();

    const khoa = await giuKhoaGhiAds();

    const warnings: string[] = [];
    const dangChay = dungLaiGiaoDichTuKhoTho(warnings);
    await choToiKhi(
      async () => (await prisma.order.count()) > 0,
      "lượt dựng lại ghi xong đơn đầu tiên (đã qua mốc chụp cờ)"
    );

    await markBronzeBacklog(); // dòng mới tới hỏng → cảnh báo bật lại giữa chừng
    await khoa.nha();
    const stats = await dangChay;

    expect(stats.skipped).toBe(0); // sạch, nhưng KHÔNG đủ để hạ cờ
    expect(await hasBronzeBacklog()).toBe(true);
    expect(warnings.some((w) => w.includes("bật lại trong lúc lượt này chạy"))).toBe(true);
  });

  it("còn record không dựng được (skipped > 0) → giữ cờ + nêu số record kẹt", async () => {
    // Dòng Bronze hỏng shape vẫn kẹt ở Bronze (dedupe theo hash chặn transform lại).
    await landRaw("orders", SHOP_SHOPEE, body(`{"id":"ORD-HONG-SHAPE"}`));
    await markBronzeBacklog();

    const warnings: string[] = [];
    const stats = await dungLaiGiaoDichTuKhoTho(warnings);

    expect(stats.skipped).toBe(1);
    expect(await hasBronzeBacklog()).toBe(true);
    expect(warnings.some((w) => w.includes("không dựng được"))).toBe(true);
  });

  it("còn sản phẩm kho kẹt ở Bronze → giữ cờ (lượt nút cố ý không dựng sản phẩm)", async () => {
    await landRaw("orders", SHOP_SHOPEE, body(ORDER));
    await landRaw("products", SHOP_KHO, body(PRODUCT)); // land mà KHÔNG transform
    await markBronzeBacklog();

    const warnings: string[] = [];
    const stats = await dungLaiGiaoDichTuKhoTho(warnings);

    expect(stats.skipped).toBe(0);
    expect(await hasBronzeBacklog()).toBe(true);
    expect(warnings.some((w) => w.includes("sản phẩm trong kho thô chưa có đủ bản Silver"))).toBe(true);
  });

  /**
   * Ca mà phép đo cũ ("`externalId` này đã có `Product` chưa") BỎ LỌT: upsert product + variants
   * nằm trong CÙNG transaction, nên một biến thể mới ghi lỗi là rollback cả product — `Product` cũ
   * vẫn còn, chỉ biến thể mới thiếu, và COGS của nó = 0.
   */
  it("sản phẩm đã có nhưng THIẾU biến thể trong kho thô → vẫn giữ cờ", async () => {
    await landRaw("products", SHOP_KHO, body(PRODUCT));
    await transformFromRaw("products", []);
    await prisma.variant.deleteMany({ where: { pancakeId: "V-KHO-1" } }); // biến thể kẹt lại Bronze
    await markBronzeBacklog();

    const warnings: string[] = [];
    await dungLaiGiaoDichTuKhoTho(warnings);

    expect(await prisma.product.count({ where: { pancakeId: "P-1" } })).toBe(1); // product VẪN có
    expect(await hasBronzeBacklog()).toBe(true);
    expect(warnings.some((w) => w.includes("sản phẩm trong kho thô chưa có đủ bản Silver"))).toBe(true);
  });

  it("không có cờ → lượt dựng lại không tự bật cờ, cũng không kêu oan", async () => {
    await landRaw("orders", SHOP_SHOPEE, body(ORDER));

    const warnings: string[] = [];
    await dungLaiGiaoDichTuKhoTho(warnings);

    expect(await hasBronzeBacklog()).toBe(false);
    expect(warnings.some((w) => w.includes("backlog"))).toBe(false);
  });
});

/**
 * Lệnh chạy tay `scripts/rebuild-from-raw.ts` (đường dựng lại ĐỦ NHẤT, có cả sản phẩm) theo ĐÚNG luật
 * hạ cờ của đường nút bấm — hạ cờ vô điều kiện ở đây nguy hiểm y hệt: banner đỏ chỉ thẳng người dùng
 * tới chính lệnh này, nên tắt cờ trong lúc cảnh báo còn đúng là bảo họ "đã chữa xong" trong khi số
 * vẫn thiếu và không còn dấu hiệu nào.
 */
describe("rebuildFromRaw — cờ backlog", () => {
  it("dựng lại toàn bộ SẠCH → hạ cờ", async () => {
    await landRaw("products", SHOP_KHO, body(PRODUCT)); // land mà CHƯA transform
    await landRaw("orders", SHOP_SHOPEE, body(ORDER));
    await markBronzeBacklog();

    const warnings: string[] = [];
    const stats = await rebuildFromRaw(warnings);

    // Cùng dữ liệu đầu vào mà đường NÚT BẤM phải giữ cờ (nó cố ý không dựng sản phẩm), lượt này hạ
    // được vì nó THỰC SỰ dựng lại sản phẩm — đó là lý do đường này không cần hỏi `conSanPhamKetOBronze`.
    expect(stats.productsUpserted).toBe(1);
    expect(stats.skipped).toBe(0);
    expect(await hasBronzeBacklog()).toBe(false);
  });

  /**
   * CỔNG QUAN TRỌNG NHẤT: cờ bật lại GIỮA lượt (một dòng vừa tới không lên được Silver, land SAU khi
   * lượt này đã quét qua bảng đó) thì lệnh này chưa hề chữa ca ấy — hạ cờ là xoá một cảnh báo ĐANG
   * ĐÚNG, mà dedupe theo hash chặn transform chạm lại dòng đó ⇒ thiếu doanh thu vĩnh viễn, không còn
   * dấu hiệu nào. Lượt chạy đứng lại ở nhánh tạo dòng ads (sau mốc chụp cờ, trước lúc hạ cờ).
   */
  it("cờ bị bật lại GIỮA lượt → KHÔNG hạ cờ + nói rõ lý do khác với 'còn record kẹt'", async () => {
    await landRaw("orders", SHOP_SHOPEE, body(ORDER));
    await landRaw("meta/report", ACT_META, BAO_CAO_META);
    await markBronzeBacklog();

    const khoa = await giuKhoaGhiAds();

    const warnings: string[] = [];
    const dangChay = rebuildFromRaw(warnings);
    await choToiKhi(
      async () => (await prisma.order.count()) > 0,
      "lượt dựng lại ghi xong đơn đầu tiên (đã qua mốc chụp cờ)"
    );

    await markBronzeBacklog(); // dòng mới tới hỏng → cảnh báo bật lại giữa chừng
    await khoa.nha();
    const stats = await dangChay;

    expect(stats.skipped).toBe(0); // sạch, nhưng KHÔNG đủ để hạ cờ
    expect(await hasBronzeBacklog()).toBe(true);
    expect(warnings.some((w) => w.includes("BẬT LẠI trong lúc lượt dựng lại chạy"))).toBe(true);
    // Hai kết cục phải phân biệt được: đây KHÔNG phải ca "còn record kẹt, sửa mapping đi".
    expect(warnings.some((w) => w.includes("KHÔNG dựng được sang Silver"))).toBe(false);
  });

  it("còn record kẹt → GIỮ cờ + cảnh báo (không được báo đã xong)", async () => {
    await landRaw("orders", SHOP_SHOPEE, body(`{"id":"ORD-HONG-SHAPE"}`));
    await markBronzeBacklog();

    const warnings: string[] = [];
    const stats = await rebuildFromRaw(warnings);

    expect(stats.skipped).toBe(1);
    expect(await hasBronzeBacklog()).toBe(true);
    expect(warnings.some((w) => w.includes("GIỮ cờ backlog"))).toBe(true);
  });
});
