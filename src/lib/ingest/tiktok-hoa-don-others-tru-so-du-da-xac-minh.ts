import { createHash } from "node:crypto";

import type { TruongHoaDonTho } from "./tiktok-ads-hoa-don-mapping";

/**
 * Hoá đơn TikTok Business `amount_type = "OTHERS"` đã XÁC MINH TỪNG GIAO DỊCH là trừ SỐ DƯ NẠP TRƯỚC (không trừ thẻ).
 * THUẦN — không DB, không đồng hồ.
 *
 * Mapping (`mapHoaDonTiktok`) KHÔNG đổi: OTHERS vẫn là "không biết chiều tiền" ⇒ bước transform bỏ dòng, đếm `skipped`,
 * route báo SyncLog ERROR + bật cờ backlog. Ngoại lệ DUY NHẤT là tập dấu băm dưới đây: dòng khớp ⇒ bỏ CÓ CHỦ ĐÍCH
 * (không Silver, không `skipped`, không cảnh báo lỗi), đếm riêng `boQuaTruSoDuDaXacMinh`. Bỏ là ĐÚNG cho nợ thẻ: tiền
 * đã rời thẻ ở lần nạp `ADD_BALANCE` (đã vào nợ thẻ); cộng các dòng này là đếm hai lần.
 *
 * Chủ shop chốt KHÔNG phân loại OTHERS tự động theo dấu hiệu payload: dòng ngoài tập, hoặc trong tập mà GIÁ TRỊ một
 * trường đã băm khác lúc xác minh, đều GIỮ ERROR + backlog. "Giá trị" = chuỗi Postgres rút bằng `#>> '{}'`, nên các dạng
 * sau cho CÙNG băm (tương đương nghĩa, mapping cũng coi như nhau): null / `""` / vắng khoá; số JSON và chuỗi cùng chữ số
 * (`2345675` ≡ `"2345675"`; jsonb tự chuẩn hoá `2.345675e6` thành `2345675`); `bc_id` có khoảng trắng hai đầu, rỗng hay vắng
 * mà giải ra cùng bc_id (luật `giaiBcId`). Các dạng cho băm KHÁC ⇒ ERROR: `2345675.0` (jsonb giữ scale), chuỗi có khoảng
 * trắng trong trường khác `bc_id`, chuỗi `"null"`, đổi chữ hoa/thường, đổi số tiền / giờ / múi / tài khoản / loại giao dịch.
 * Hoá đơn khớp tập mà bảng Silver ĐÃ có dòng cùng `transaction_id` (TikTok từng trả bản POSITIVE/NEGATIVE) ⇒ bước transform
 * cũng báo ERROR + backlog, giữ dòng Silver (xem `transform-tiktok-ads-hoa-don.ts`). Thêm dòng vào tập = PR mới kèm bằng
 * chứng sao kê thẻ + Business Center cho TỪNG giao dịch; tính băm từ kho thô bằng SQL chỉ đọc (nối `||` + `coalesce`,
 * KHÔNG `concat_ws` — hàm đó bỏ NULL ⇒ thiếu dòng `amount` ⇒ băm sai).
 *
 * Lưu BĂM thay cho `transaction_id` chỉ để repo không chứa mã giao dịch NGUYÊN VĂN và để tập ràng buộc cả NỘI DUNG dòng
 * chứ không chỉ mã. Đây KHÔNG phải cách giữ bí mật: mã TikTok phần lớn là dấu thời gian, các trường khác đoán được ⇒ dò
 * ngược được băm. Vì vậy snapshot CÔNG KHAI không mang tập thật: script publish thay khối khai báo bên dưới bằng tập RỖNG
 * (chỉ trên staging) và DỪNG nếu staging còn dấu băm thật nào — khối phải giữ ĐÚNG dạng: một dòng mở nguyên văn, mỗi dòng
 * một `"<64 hex>",` (chú thích cuối dòng tuỳ ý), dòng đóng `]);`. Publisher đòi ĐÚNG `DAU_BAM_SO_DUYET` dấu băm khác nhau
 * ⇒ thêm/bớt dấu băm PHẢI đổi hằng đó trong `scripts/publish-public-snapshot.sh` + số lượng/vân tay trong test chỉ-private
 * (`tests/ingest/tiktok-hoa-don-others-tap-dau-bam-that-chi-private.test.ts`) trong CÙNG PR có bằng chứng. Path file này +
 * tên hằng là hợp đồng với publisher (`DAU_BAM_FILE`/`DAU_BAM_TEN`): chuyển/đổi tên module mà không sửa publisher ⇒ DỪNG.
 */

/** Tiền tố phiên bản của chuỗi chuẩn hoá — đổi cách chuẩn hoá thì đổi tiền tố và tính lại TOÀN BỘ tập. */
export const PHIEN_BAN_DAU_BAM_OTHERS = "tiktok-hoa-don-others-tru-so-du-v1";

/**
 * Các trường payload đi vào dấu băm, ĐÚNG THỨ TỰ (sau tiền tố, `transaction_id`, bc_id đã giải). Gồm mọi trường quyết định
 * số tiền, chiều tiền, thời điểm, tài khoản — `amount_type` có mặt nên một dòng POSITIVE/NEGATIVE không bao giờ khớp tập.
 */
const TRUONG_BAM = [
  "account_id",
  "create_time",
  "timezone",
  "transaction_type",
  "billing_type",
  "amount_type",
  "amount",
  "subtotal",
  "tax_amount",
  "currency",
] as const;

/**
 * Dấu băm các giao dịch đã xác minh — CHỈ ở repo private; bản public là tập rỗng. Tính từ kho thô prod bằng SQL chỉ đọc,
 * đối chứng độc lập từng dấu băm. Tập giao dịch đã xác minh từng dòng bằng sao kê thẻ (không dòng nào khớp số tiền + ngày)
 * + TikTok Business Center → Tài chính → Giao dịch (cột "Phương thức thanh toán: Số dư" khớp giờ tới giây và số tiền);
 * Σ (subtotal + tax) các dòng = đúng một lần nạp `ADD_BALANCE` đã vào nợ thẻ. Hồ sơ bằng chứng giữ ở repo private.
 * Hình dạng hồ sơ gốc: BILL_PAYMENT · CASH · OTHERS · amount JSON null · subtotal/tax là số JSON nguyên · VND ·
 * timezone "UTC+07:00".
 */
// Bản public: tập rỗng — tập dấu băm thật chỉ ở repo private (script publish thay khối này khi dựng snapshot).
export const DAU_BAM_OTHERS_TRU_SO_DU_DA_XAC_MINH: ReadonlySet<string> = new Set<string>([]);

/** bc_id như mapping: payload `bc_id` (trim, khác rỗng), không thì `shopId` của dòng Bronze. Cả hai rỗng ⇒ null. */
function giaiBcId(truong: TruongHoaDonTho, bronzeShopId: string): string | null {
  const tuPayload = truong.bc_id?.trim();
  if (tuPayload) return tuPayload;
  const tuBronze = bronzeShopId.trim();
  return tuBronze === "" ? null : tuBronze;
}

/**
 * Dấu băm một hoá đơn = sha256 hex của 13 dòng nối bằng `"\n"` (không `"\n"` cuối): tiền tố phiên bản, `transaction_id`
 * (= `externalId` Bronze, giữ nguyên), bc_id ĐÃ GIẢI, rồi `TRUONG_BAM` theo thứ tự.
 *
 * Trường payload là chuỗi SQL rút bằng `#>> '{}'` (bản đồ `TruongHoaDonTho`); null/vắng ⇒ chuỗi rỗng. CỐ Ý không trim,
 * không chuẩn hoá số trong JS: `2345675.0` hay `" 2345675"` cho băm KHÁC ⇒ rơi về ERROR — payload khác lúc xác minh thì
 * phải có người nhìn lại. (Phần chuẩn hoá DUY NHẤT là của chính jsonb + `#>>`: số ≡ chuỗi cùng chữ số, mũ e ≡ số nguyên.)
 */
export function dauBamHoaDonOthers(transactionId: string, bcId: string, truong: TruongHoaDonTho): string {
  const phan = [PHIEN_BAN_DAU_BAM_OTHERS, transactionId, bcId, ...TRUONG_BAM.map((k) => truong[k] ?? "")];
  return createHash("sha256").update(phan.join("\n"), "utf8").digest("hex");
}

/**
 * Dòng Bronze này có phải hoá đơn OTHERS trừ số dư ĐÃ XÁC MINH không. `false` ⇒ người gọi xử lý như mọi dòng mapping
 * từ chối (skipped + cảnh báo + ERROR).
 *
 * Từ chối (trả `false`) khi: payload không phải object, `amount_type` không ĐÚNG chuỗi "OTHERS", không giải được bc_id.
 * Không cần chặn `"\n"` trong giá trị: chuỗi ghép của mọi dòng trong tập có đúng 12 dấu xuống dòng, giá trị nào mang
 * thêm `"\n"` là chuỗi ghép có nhiều dòng hơn ⇒ không thể trùng.
 *
 * @param tapDaXacMinh mặc định = tập thật; test truyền tập giả tính từ fixture id GIẢ.
 */
export function laOthersTruSoDuDaXacMinh(
  transactionId: string,
  bronzeShopId: string,
  truong: TruongHoaDonTho | null | undefined,
  tapDaXacMinh: ReadonlySet<string> = DAU_BAM_OTHERS_TRU_SO_DU_DA_XAC_MINH,
): boolean {
  if (!truong || typeof truong !== "object") return false;
  if (truong.amount_type !== "OTHERS") return false;
  const bcId = giaiBcId(truong, bronzeShopId);
  if (bcId === null) return false;
  return tapDaXacMinh.has(dauBamHoaDonOthers(transactionId, bcId, truong));
}
