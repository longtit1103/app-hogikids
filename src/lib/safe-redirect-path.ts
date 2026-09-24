/**
 * Guards a post-login `redirect` query-param value before it is ever passed
 * to `router.push` / `redirect()`.
 *
 * Bắt chặn theo HÌNH DẠNG là con đường THUA. Bộ phân tích URL của trình duyệt (WHATWG URL) **xoá
 * mọi ký tự tab / newline / CR khỏi chuỗi TRƯỚC khi phân tích**, nên mọi guard chỉ nhìn ký tự đầu
 * đều vượt được bằng cách chèn một ký tự điều khiển vào giữa. Đo thật bằng chính `new URL()` của
 * Node — cả bốn chuỗi dưới đây từng QUA guard cũ (`startsWith("/") && !startsWith("//") &&
 * !startsWith("/\\")`) rồi resolve thành `https://evil.com/`:
 *
 *     "/\t/evil.com"   "/\n/evil.com"   "/\r/evil.com"   "/\t\\evil.com"
 *
 * Hậu quả: chủ shop bấm link `…/dang-nhap?redirect=/%09/evil.com` sẽ thấy trang đăng nhập THẬT
 * (đúng domain, đúng chứng chỉ, kiểm domain thấy hợp lệ), đăng nhập xong bị đẩy sang trang giả
 * "phiên hết hạn, đăng nhập lại" — mất đúng cặp credential mở toàn bộ app tài chính.
 *
 * Vì vậy guard này KHÔNG liệt kê thêm hình dạng nữa mà đổi sang hỏi thẳng bộ phân tích URL. Ba
 * lớp, và nói CHÍNH XÁC lớp nào làm gì — review đối kháng 20/09 bắt được bản đầu mô tả quá lời:
 *   1. Loại mọi ký tự điều khiển — thứ khiến chuỗi bị viết lại sau lưng mình. BẮT BUỘC.
 *   2. Hai phép kiểm hình dạng — chặn `//` và `/\` ngay tại ký tự thứ hai. BẮT BUỘC.
 *   3. Resolve rồi so `origin` VÀ soi lại `pathname`. Phần so `origin` là dự phòng: sau lớp 1+2,
 *      không chuỗi nào còn thoát được origin, nên nó KHÔNG từ chối thêm gì hôm nay — giữ lại để
 *      chắn quirk parser tương lai. Phần soi `pathname` thì làm việc thật, xem ngay dưới.
 *
 * VÌ SAO PHẢI SOI LẠI `pathname`: `/..//evil.com` và `/.//evil.com` giữ nguyên origin (nên lọt
 * lớp 3 nếu chỉ so origin) nhưng bộ phân tích URL CHUẨN HOÁ chúng thành pathname `//evil.com`.
 * Next `router.push` dựng href từ `pathname+search+hash`, tức đẩy đúng chuỗi `//evil.com` vào
 * `history.pushState` — trình duyệt resolve nó thành cross-origin và ném `SecurityError`, làm
 * hỏng luồng đăng nhập. Không phải open redirect, nhưng là một cách làm gãy app bằng URL người
 * khác gửi tới, chặn ở đây rẻ hơn hẳn.
 *
 * Origin giả dùng TLD `.invalid` (RFC 2606, bảo đảm không bao giờ phân giải được) nên phép so
 * không bao giờ vô tình trùng một host thật.
 */
const ORIGIN_GIA = "https://base-noi-bo.invalid";

/** Ký tự điều khiển C0 + DEL — bộ phân tích URL xoá tab/LF/CR, số còn lại không có việc gì ở đây. */
const KY_TU_DIEU_KHIEN = /[\u0000-\u001F\u007F]/;

export function isSafeRedirectPath(path: string): boolean {
  if (KY_TU_DIEU_KHIEN.test(path)) return false;
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return false;

  try {
    const u = new URL(path, ORIGIN_GIA);
    // `pathname` sau chuẩn hoá: `/..//evil.com` → `//evil.com`. Xem docblock.
    return u.origin === ORIGIN_GIA && !u.pathname.startsWith("//");
  } catch {
    // `new URL` ném ⇒ chuỗi không phải path hợp lệ ⇒ từ chối (fail-closed).
    return false;
  }
}
