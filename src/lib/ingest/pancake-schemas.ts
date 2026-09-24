import { z } from "zod";

/**
 * Zod schemas cho payload Pancake POS (base `pos.pages.fm/api/v1`).
 * Shape theo dữ liệu THẬT — xem `tests/fixtures/pancake/ghi-chu-shape-thuc-te.md`.
 * `.passthrough()` để không vỡ khi Pancake thêm field.
 *
 * Nguồn:
 *  - products: shop KHO (`714995134`) — có `average_imported_price` (giá vốn).
 *  - orders: shop Shopee (`1942992175`) + TikTok (`100975192`) — đơn gốc, phí sàn thật.
 */

const idStr = z.union([z.string(), z.number()]).transform(String);
/** id-like nullable (display_id/custom_id/barcode có thể là số hoặc chuỗi) → chuỗi. */
const idStrN = z.union([z.string(), z.number()]).transform(String).nullish();
/** Tiền/số lượng: coerce string|number → number, null/undefined → 0. */
const money = z.coerce.number().default(0);

export const pancakeFieldSchema = z
  .object({ name: z.string().nullish(), value: z.string().nullish() })
  .passthrough();

// ---- PRODUCTS (shop kho) ----------------------------------------------------

export const pancakeVariationSchema = z
  .object({
    id: idStr, // UUID biến thể (per-shop) → Variant.pancakeId
    display_id: idStrN, // SKU biến thể "SB0190"/"SP000168" → Variant.sku (khoá liên kết)
    custom_id: idStrN, // thường rỗng ở biến thể
    barcode: idStrN,
    retail_price: money, // giá bán
    remain_quantity: money, // tồn realtime
    average_imported_price: money, // giá vốn TB → prefill Variant.costPrice (chỉ khi CREATE)
    last_imported_price: money,
    is_hidden: z.boolean().nullish(),
    fields: z.array(pancakeFieldSchema).nullish(), // [{name:"Kích cỡ",value:"90"}]
  })
  .passthrough();

export const pancakeProductSchema = z
  .object({
    id: idStr, // UUID sản phẩm (per-shop) → Product.pancakeId
    name: z.string(),
    custom_id: idStrN, // mã SP (vd "SB01") → Product.code
    display_id: idStrN,
    category_name: z.string().nullish(),
    categories: z.array(z.unknown()).nullish(),
    image: z.string().nullish(),
    image_url: z.string().nullish(),
    is_hidden: z.boolean().nullish(),
    is_published: z.boolean().nullish(),
    variations: z.array(pancakeVariationSchema).default([]),
  })
  .passthrough();

// ---- ORDERS (shop Shopee/TikTok) -------------------------------------------

export const pancakeVariationInfoSchema = z
  .object({
    name: z.string().nullish(), // tên SP/biến thể → OrderItem.productName
    display_id: idStrN, // SKU biến thể → OrderItem.sku (tra Variant bySku)
    product_display_id: idStrN,
    barcode: idStrN,
    retail_price: money, // đơn giá 1 sp (gross, trước giảm) → OrderItem.unitPrice
    average_imported_price: money.nullish(), // = 0 ở đơn gốc (giá vốn ở kho)
    last_imported_price: money.nullish(),
    fields: z.array(pancakeFieldSchema).nullish(),
    detail: z.string().nullish(),
  })
  .passthrough();

export const pancakeOrderItemSchema = z
  .object({
    id: idStr.nullish(),
    product_id: idStr.nullish(),
    variation_id: idStr.nullish(), // UUID per-shop — KHÔNG dùng tra kho (dùng sku)
    quantity: z.coerce.number().int().nonnegative().default(0),
    discount_each_product: money, // giảm giá MỖI ĐƠN VỊ (OpenAPI: "Giảm giá cho từng sản phẩm") — phải × quantity
    total_discount: money.nullish(), // = quantity × discount_each_product do Pancake tính sẵn → dùng làm cổng chặn ngữ nghĩa
    variation_info: pancakeVariationInfoSchema.nullish(),
  })
  .passthrough();

/** Breakdown phí sàn thật (chỉ tham chiếu; P&L dùng tổng `fee_marketplace`). */
export const pancakeAdvancedPlatformFeeSchema = z
  .object({
    platform_commission: money.nullish(),
    payment_fee: money.nullish(),
    service_fee: money.nullish(),
    seller_transaction_fee: money.nullish(),
    tax: money.nullish(),
    returned_fee: money.nullish(), // phí sàn THỰC giữ trên đơn hoàn/hủy → Order.returnedFee
    // Phần khuyến mãi do SÀN trả thay khách, đã nằm trong `discount_each_product` của các dòng.
    // Shop không mất tiền khoản này ⇒ cộng lại vào doanh thu (xem `voucher-san-tai-tro.ts`).
    marketplace_voucher: money.nullish(),
    /**
     * Chênh phí vận chuyển sàn tính lại. KHÔNG vào Silver — chỉ để `suy-voucher-san-tu-cod.ts` biết
     * đơn có dính tiền ship mà TỪ CHỐI suy khoản sàn tài trợ (cod gồm ship ⇒ đẳng thức thiếu số hạng).
     */
    diff_shipping_fee: money.nullish(),
  })
  .passthrough();

/** 1 lần chuyển trạng thái trong lịch sử đơn — chỉ cần status + updated_at (naive UTC). */
export const pancakeStatusHistorySchema = z
  .object({
    status: z.union([z.number(), z.string()]).nullish(),
    updated_at: z.string().nullish(),
  })
  .passthrough();

export const pancakeOrderSchema = z
  .object({
    id: idStr, // → Order.pancakeId
    system_id: idStr.nullish(), // mã đơn hiển thị → Order.code (fallback id)
    status: z.union([z.number(), z.string()]), // giữ thô cho mapStatus
    status_name: z.string().nullish(),
    inserted_at: z.string().min(1), // naive UTC (Pancake không có Z) → orderedAt (neo Z); rỗng → reject (tránh Invalid Date)
    updated_at: z.string().nullish(),
    // Lịch sử chuyển trạng thái → statusChangedAt (cột hiển thị, KHÔNG vào P&L).
    // `.catch(undefined)`: shape dị dạng chỉ làm statusChangedAt fallback/null,
    // TUYỆT ĐỐI không được reject cả đơn (safeParse-skip = mất doanh thu âm thầm).
    status_history: z.array(pancakeStatusHistorySchema).nullish().catch(undefined),
    order_sources_name: z.string().nullish(), // "Shopee"|"Tiktok" → mapChannel
    marketplace_id: idStr.nullish(),
    total_price: money, // doanh thu GỘP (trước giảm giá dòng) = Σ qty×retail_price
    total_discount: money, // voucher mức đơn
    shipping_fee: money,
    fee_marketplace: money, // PHÍ SÀN THẬT → platformFeeEst
    /**
     * Tiền hàng ròng Pancake TỰ CHỐT (đã trừ giảm giá + phí sàn). KHÔNG vào Silver — dùng làm
     * TRỌNG TÀI độc lập phát hiện Pancake khai thiếu khoản sàn tài trợ (`suy-voucher-san-tu-cod.ts`).
     * `nullish` vì không phải shape nào cũng có; vắng thì phép kiểm tự bỏ qua đơn đó.
     */
    cod: money.nullish(),
    /**
     * Đơn bán TẠI SHOP (màn "Bán hàng" Pancake) — một trong 3 dấu nhận kênh `direct`. `.catch`: shape
     * lạ chỉ làm đơn không được nhận là bán trực tiếp (về `website` + cảnh báo), KHÔNG reject cả đơn.
     */
    received_at_shop: z.boolean().nullish().catch(undefined),
    // Các khoản khách ĐÃ TRẢ — chỉ đọc cho kênh `direct` → `Order.paidAtShop` (Sổ quỹ). `.catch(0)`:
    // shape lạ ⇒ tổng hụt ⇒ cảnh báo "đã trả ≠ phải trả" ở mapping, KHÔNG reject đơn (mất doanh thu).
    transfer_money: money.catch(0),
    cash: money.catch(0),
    charged_by_card: money.catch(0),
    charged_by_momo: money.catch(0),
    charged_by_qrpay: money.catch(0),
    advanced_platform_fee: pancakeAdvancedPlatformFeeSchema.nullish(),
    customer: z.object({ name: z.string().nullish() }).passthrough().nullish(),
    items: z.array(pancakeOrderItemSchema).default([]),
  })
  .passthrough();

/**
 * Envelope strict (test/tham chiếu shape fixtures). Route ingest KHÔNG dùng: từ Bronze trở đi
 * n8n đẩy TEXT thô sang `/api/ingest/raw`, và transform safeParse TỪNG record đọc từ bảng raw
 * → 1 record hỏng chỉ bị skip, KHÔNG giết cả batch.
 */
export const ingestPancakeBodySchema = z.object({
  orders: z.array(pancakeOrderSchema).max(500).default([]),
  products: z.array(pancakeProductSchema).max(2000).default([]),
});

export type PancakeOrder = z.infer<typeof pancakeOrderSchema>;
export type PancakeProduct = z.infer<typeof pancakeProductSchema>;
export type IngestPancakeBody = z.infer<typeof ingestPancakeBodySchema>;
