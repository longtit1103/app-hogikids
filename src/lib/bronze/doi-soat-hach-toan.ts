import type { CauHinhShop } from "@/lib/ket-noi/cau-hinh-shop";
import type { UpsertStats } from "@/lib/ingest/pancake-upsert";

import { type BronzeStream } from "./streams";

/**
 * ĐỐI SOÁT "đã land" vs "đã hạch toán" — MỘT nguồn công thức cho cả hai cổng đang soi
 * (`/api/ingest/raw`, đường webhook đơn) và cho test khoá hành vi.
 *
 * Vì sao phải dùng chung: công thức này từng nằm ở 3 nơi rồi trôi — bản trong test thiếu
 * `ordersSkippedStale` nên nó pass cả khi route bỏ mất bộ đếm đó (happy-path luôn có giá trị 0).
 * Một cổng chống-mất-dữ-liệu mà test của nó im lặng thì coi như không có cổng.
 */

/**
 * Số id đã land được HẠCH TOÁN ĐÚNG Ý: vào Silver, bị luật loại CÓ CHỦ ĐÍCH (mirror kho), hoặc
 * không ghi vì Silver đang giữ bản MỚI HƠN của chính bản ghi đó.
 *
 * `skipped` (hỏng shape / upsert lỗi) CỐ Ý KHÔNG tính: nó đã nằm trong Bronze nhưng KHÔNG vào
 * Silver, mà dedupe theo hash chặn transform lại ⇒ kẹt vĩnh viễn = thiếu số âm thầm. Phải để nó
 * làm lệch phép so sánh để người gọi bật cờ backlog và kêu to.
 *
 * `ordersSkippedStale` CÓ tính: Silver đang giữ bản MỚI HƠN của chính đơn đó — dữ liệu ĐÚNG, không
 * mất dòng. Bỏ sót nó là báo động giả mỗi lần hai lượt dựng Silver chạy so le, mà đường hạ cờ chắc
 * chắn nhất (dựng lại toàn bảng bằng script) lại kéo tồn kho realtime lùi về ảnh ban đêm.
 *
 * `ordersDiscardedGiuaChung` CÓ tính — cùng luật với `ordersSkippedStale`: dòng vừa bị lượt "Xóa dữ
 * liệu giao dịch" đóng `DISCARDED` GIỮA khe land→transform. Số phận dòng đã chốt ĐÚNG Ý chủ shop
 * (lượt ghi Silver đã cuộn lại, không hồi sinh) — không phải mất dòng. Không tính thì chính lượt xoá
 * hợp lệ bật cờ backlog giả, và banner "chạy rebuild" lại xui hồi sinh đúng đơn vừa xoá.
 *
 * KHÔNG cộng `variantsUpserted` (nhiều biến thể trong MỘT product ⇒ tổng vượt số product đã land,
 * che mất product bị bỏ) và KHÔNG cộng `adsUpserted`/`adsExpensesUpserted`/`boQuaCoChuDich` (thuộc
 * stream không có quan hệ 1:1, hoặc chỉ ghi ở lượt dựng lại — xem `coTheDoiSoat`). Riêng
 * `boQuaCoChuDich` tăng ở 2 stream báo cáo quảng cáo (mà `coTheDoiSoat` loại cả hai) và ở nhánh
 * chặn `chanKhiCoDonKhacCungKenhMa` của upsert đơn — nhánh đó chỉ script bù đơn (chạy tay) truyền,
 * không đi qua hai cổng gọi hàm này ⇒ cộng vào đây vẫn là thêm một số hạng luôn bằng 0, đọc thì
 * tưởng cổng này có soi phần chi phí ads.
 */
export function demDaHachToan(stats: UpsertStats): number {
  return (
    stats.ordersUpserted +
    stats.ordersSkippedMirror +
    stats.ordersSkippedStale +
    stats.ordersDiscardedGiuaChung +
    stats.productsUpserted +
    stats.settlementsUpserted +
    stats.paymentsUpserted +
    stats.shopeeUpserted
  );
}

/**
 * Stream + shop này có quan hệ 1:1 "một id land → một dòng Silver" để so được số không?
 *
 * Chỉ đúng khi transform ĐỌC ĐÚNG shop vừa land (xem từng nhánh ở `transform-pancake-orders.ts` / `transform-tiktok-shopee-settlement.ts`):
 *  - `orders`: mọi shop đều dựng Silver.
 *  - `products`: transform CHỈ đọc shop KHO (nguồn giá vốn); trang products của shop bán land để
 *    đối chiếu, CỐ Ý không hạch toán.
 *  - `tiktok/statements`, `tiktok/payments`, `shopee/wallet`: mỗi record land = một dòng Silver.
 *
 * CỐ Ý LOẠI `tiktok/statement_transactions`: stream này land MỌI giao dịch của statement nhưng chỉ
 * khoản `type=GMV_PAYMENT_FOR_TIKTOK_ADS` có bảng Silver (nhận diện DUY NHẤT bằng `type`) ⇒ soi sẽ
 * kêu oan mỗi đêm. Cũng loại mọi stream land-only và 2 stream báo cáo quảng cáo (chỉ ghi sổ ở lượt
 * dựng lại có chủ đích).
 *
 * Điều kiện `shopId` là BẢN SOI GƯƠNG bộ lọc của transform, không phải kiểm tra thừa: hôm nay
 * `landRaw` đã chặn shopId lạ theo whitelist, nhưng luật "chỉ soi được khi transform đọc đúng shop
 * vừa land" phải nằm TƯỜNG MINH ở đây — bỏ đi thì mai ai nới whitelist là cổng soi kêu oan mà
 * không hiểu vì sao.
 */
export function coTheDoiSoat(
  stream: BronzeStream,
  shopId: string,
  cauHinh: CauHinhShop | null
): boolean {
  // Hàm GIỮ THUẦN (không tự đọc DB): cấu hình do người gọi resolve sẵn — route resolve TRƯỚC
  // transaction land (xem ghi chú ở /api/ingest/raw) rồi truyền xuống, test truyền thẳng object.
  // `null` = route KHÔNG resolve (stream danh sách mở — ads): các stream đó vốn ngoài phạm vi soi.
  if (cauHinh === null) return false;
  switch (stream) {
    case "orders":
      return true;
    case "products":
      return shopId === cauHinh.kho;
    case "tiktok/statements":
    case "tiktok/payments":
      return cauHinh.tiktokShop !== null && shopId === cauHinh.tiktokShop;
    case "shopee/wallet":
      return shopId === cauHinh.shopee;
    default:
      return false;
  }
}
