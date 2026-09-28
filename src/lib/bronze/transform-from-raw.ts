import type { BronzeStream } from "./streams";
import {
  transformMetaAdsReport,
  transformTiktokAdsReport,
} from "./transform-ads-expense";
import { transformOrders, transformProducts } from "./transform-pancake-orders";
import {
  empty,
  type TransformOptions,
  type TransformStats,
} from "./transform-raw-helpers";
import {
  transformShopeeWallet,
  transformTiktokAdsTxns,
  transformTiktokPayments,
  transformTiktokStatements,
} from "./transform-tiktok-shopee-settlement";

export type { TransformOptions, TransformStats };

/**
 * Stream CỐ Ý không có Silver (land-only): 6 stream Pancake phụ + `tiktok/orders` (cố ý không kéo)
 * + hoá đơn quảng cáo TikTok. 3 stream TikTok settlement (statements/statement_transactions/payments)
 * NAY CÓ Silver (Phase 2), 2 stream báo cáo ads (`meta/report`, `tiktokbusiness/report`) NAY dựng lại
 * `Expense` ở lượt dựng lại — đều đã gỡ. Liệt kê TƯỜNG MINH để stream mới thêm vào registry mà quên quyết định
 * transform sẽ THROW ở đây, thay vì lặng lẽ trả stats rỗng và bị đọc nhầm là "đã dựng Silver xong,
 * không có gì để dựng".
 */
const LAND_ONLY: readonly BronzeStream[] = [
  "products/variations",
  "purchases",
  "inventory_histories",
  "transactions",
  "marketplace/reverse_order",
  "customers",
  // tiktok/statements + statement_transactions + payments: nay CÓ transform Silver
  // (TiktokSettlement/AdsSettlement/Payment — "Tiền đã về", Phase 2) → gỡ khỏi land-only.
  "tiktok/orders",
  // Hoá đơn quảng cáo TikTok: KHÔNG có bảng Silver riêng — nó là NGUỒN ĐO VAT mà nhánh
  // `tiktokbusiness/report` đọc thẳng từ kho thô (xem `buildVatByMonth`), không phải sổ sách.
  "tiktokbusiness/invoice",
  // 4 stream analytics + GMV Max cấp item: SỐ SÀN, cố ý KHÔNG có bảng Silver (spec §3 — "bảng Silver
  // cho analytics" nằm ngoài phạm vi). Reader `src/lib/reports/marketing/*` đọc thẳng Bronze bằng
  // DISTINCT ON, đúng khuôn `quang-cao-chien-dich.ts`. Quên khai ở đây ⇒ `transformFromRaw` không tìm
  // thấy nhánh và ném "stream chưa có nhánh dựng Silver" cho MỌI trang land.
  "tiktok/analytics_shop",
  "tiktok/analytics_products",
  "tiktok/analytics_videos",
  "tiktok/analytics_lives",
  "tiktokbusiness/gmvmax_item",
  // Đơn affiliate cấp dòng SKU (P3): SỐ SÀN như 4 stream analytics — reader `creator-tiktok.ts`
  // đọc thẳng Bronze; không đường nào chạm `Expense`/`pnl.ts` (hoa hồng THẬT đã có từ Pancake).
  "tiktok/affiliate_orders",
];

/** Thân nhánh dựng Silver: cộng dồn vào `stats` sẵn có, không tự tạo bộ đếm riêng. */
type NhanhTransform = (
  stats: TransformStats,
  warnings: string[],
  opts: TransformOptions,
) => Promise<void>;

/**
 * Nhánh dựng Silver của từng stream. Thân nhánh nằm ở module theo DOMAIN (đường tiền · tiền đã về ·
 * chi tiêu ads) — file này chỉ còn việc CHỌN nhánh, để sửa một domain không đọc nhầm biến của domain
 * khác.
 *
 * `Map` chứ KHÔNG phải object literal: tra khoá trên object literal đi qua prototype, nên một
 * `stream` mang tên như `constructor`/`toString` sẽ trả về một hàm kế thừa và được gọi như nhánh
 * thật — lọt cả cổng chặn `LAND_ONLY` rồi trả stats rỗng trong im lặng, đúng thứ cổng đó sinh ra để
 * chặn. `Map` chỉ trả đúng khoá đã đặt.
 */
const NHANH = new Map<BronzeStream, NhanhTransform>([
  ["products", transformProducts],
  ["orders", transformOrders],
  // TikTok Shop settlement + ví Shopee → Silver "Tiền đã về" (Phase 2). Dòng tiền đối chiếu,
  // ĐỘC LẬP P&L/doanh thu (bất biến #2).
  ["tiktok/statements", transformTiktokStatements],
  ["tiktok/statement_transactions", transformTiktokAdsTxns],
  ["tiktok/payments", transformTiktokPayments],
  ["shopee/wallet", transformShopeeWallet],
  // Chi tiêu quảng cáo: 2 nhánh này TỰ đứng yên khi không phải lượt dựng lại (xem module).
  ["meta/report", transformMetaAdsReport],
  ["tiktokbusiness/report", transformTiktokAdsReport],
]);

/**
 * TRANSFORM — đọc TỪ BẢNG RAW ra Silver. KHÔNG đọc HTTP body ⇒ chạy lại lúc nào cũng ra đúng
 * kết quả. Stream nào không có nhánh dựng Silver phải nằm trong `LAND_ONLY` (trả stats rỗng).
 *
 * NGOẠI LỆ DUY NHẤT chạm bảng do app sở hữu: 2 stream báo cáo quảng cáo dựng lại `Expense`, và CHỈ
 * khi `opts.rebuild` (lượt dựng lại có chủ đích), CHỈ dòng `source = "ADS_API"` (cổng chặn nằm ở
 * `upsertOneAdsExpense`). Chi phí chủ shop nhập tay không có bản gốc nào để dựng lại nên tuyệt đối
 * không được đụng tới.
 *
 * Luật giữ nguyên phase 2:
 *  - zod safeParse TỪNG record → hỏng chỉ `skipped++` + warning, KHÔNG giết batch.
 *  - Đơn MIRROR shop kho → raw GIỮ, Silver BỎ (chống đếm 2 lần — invariant #2).
 *  - Products CHỈ lấy từ shop KHO — nguồn giá vốn (invariant #5). Shop bán cũng có `/products`
 *    (đã land để đối chiếu) nhưng product id khác nhau mỗi shop và không có giá vốn ⇒ transform
 *    chúng sẽ đẻ Variant trùng SKU với costPrice 0 → tra giá vốn theo SKU nhập nhằng, COGS sai.
 */
export async function transformFromRaw(
  stream: BronzeStream,
  warnings: string[],
  opts: TransformOptions = {},
): Promise<TransformStats> {
  const stats = empty();

  const nhanh = NHANH.get(stream);
  if (nhanh) {
    await nhanh(stats, warnings, opts);
    return stats;
  }

  if (!LAND_ONLY.includes(stream)) {
    throw new Error(
      `Stream "${stream}" chưa khai báo cách transform: thêm nhánh dựng Silver, hoặc ghi vào LAND_ONLY ` +
        `nếu cố ý chỉ land Bronze. Không được im lặng trả stats rỗng.`,
    );
  }
  return stats; // land-only: Bronze giữ raw, Silver đứng yên
}
