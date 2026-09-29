import { cookies } from "next/headers";

import type { DateRangeSelection } from "@/lib/date-range";
import { docLuaChonTuCookie, TEN_COOKIE_KHOANG_NGAY } from "@/lib/date-range-cookie";

/**
 * Lựa chọn khoảng ngày đã lưu của request hiện tại (cookie `hogikids_khoang_ngay`), đã kiểm hình —
 * hỏng/không có ⇒ `null`. CHỈ đọc: Next 16 chỉ cho ghi cookie trong Server Function/Route Handler.
 * Dùng ở 6 trang có bộ chọn ngày (truyền vào `resolveRangeFromParams`) và ở layout (truyền xuống
 * `DateRangeProvider`) — để nhãn và số liệu cùng một nguồn.
 */
export async function docLuaChonDaLuu(now: Date = new Date()): Promise<DateRangeSelection | null> {
  const cookieStore = await cookies();
  return docLuaChonTuCookie(cookieStore.get(TEN_COOKIE_KHOANG_NGAY)?.value, now);
}
