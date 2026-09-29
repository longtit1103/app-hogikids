import {
  selectionFromQuery,
  serializeDateRange,
  type DateRangeSelection,
  type RangePreset,
} from "@/lib/date-range";

/**
 * Cookie giữ lựa chọn khoảng ngày CÓ CHỦ Ý của người dùng (bộ chọn chung + bộ chọn tháng Lãi/Lỗ).
 *
 * Hợp đồng (chủ shop chốt 29/09, #254): server dựng khoảng theo **URL → cookie hợp lệ → "Tháng này"**.
 * URL/drill là ngữ cảnh tạm, KHÔNG BAO GIỜ ghi cookie. Cookie hỏng/sai hình ⇒ bỏ qua, như chưa có.
 *
 * Giá trị: tên preset (`7d`, `last_month`…) hoặc khoảng tuỳ chọn `yyyy-MM-dd..yyyy-MM-dd`. Chỉ gồm
 * chữ, số, `-`, `_`, `.` ⇒ hợp lệ trong cookie mà không phải mã hoá (JSON cần mã hoá dấu nháy/phẩy —
 * thêm một đường giải mã là thêm một nguồn sai).
 */
export const TEN_COOKIE_KHOANG_NGAY = "hogikids_khoang_ngay";

/** Giá trị hợp lệ dài nhất là khoảng tuỳ chọn (22 ký tự); dư rộng nhưng chặn chuỗi rác lớn. */
const DO_DAI_TOI_DA = 64;

/** Dạng chuẩn truyền từ server xuống client (không mang `Date` qua ranh giới server/client). */
export type LuaChonDaLuu = { preset: RangePreset } | { preset: "custom"; tu: string; den: string };

/**
 * Đọc CÓ KIỂM giá trị cookie. Dùng CHUNG luật với URL (`selectionFromQuery` → `parseDateRange`):
 * sai khuôn `yyyy-MM-dd`, ngày không tồn tại, khoảng đảo ngược, preset lạ ⇒ `null`. Khoảng dài quá
 * trần được kẹp y như URL. Không bao giờ ném lỗi.
 */
export function docLuaChonTuCookie(
  giaTri: string | null | undefined,
  now: Date = new Date(),
): DateRangeSelection | null {
  if (!giaTri || giaTri.length > DO_DAI_TOI_DA) return null;
  const phan = giaTri.split("..");
  if (phan.length === 2) return selectionFromQuery({ tu: phan[0], den: phan[1] }, now);
  if (phan.length === 1) return selectionFromQuery({ range: giaTri }, now);
  return null;
}

/** Lựa chọn đã kiểm → dạng chuẩn gửi xuống client. */
export function chuanHoaLuaChonDaLuu(luaChon: DateRangeSelection): LuaChonDaLuu {
  return luaChon.preset === "custom"
    ? { preset: "custom", ...serializeDateRange(luaChon.range) }
    : { preset: luaChon.preset };
}

/** Lựa chọn đã kiểm → giá trị cookie chuẩn (`7d` hoặc `yyyy-MM-dd..yyyy-MM-dd`). */
export function giaTriCookieLuaChon(luaChon: DateRangeSelection): string {
  if (luaChon.preset !== "custom") return luaChon.preset;
  const { tu, den } = serializeDateRange(luaChon.range);
  return `${tu}..${den}`;
}

/** Dạng chuẩn server gửi xuống → lựa chọn (qua CHÍNH luật kiểm của URL; sai hình ⇒ `null`). */
export function luaChonTuDangChuan(daLuu: LuaChonDaLuu, now: Date = new Date()): DateRangeSelection | null {
  return daLuu.preset === "custom"
    ? selectionFromQuery({ tu: daLuu.tu, den: daLuu.den }, now)
    : selectionFromQuery({ range: daLuu.preset }, now);
}
