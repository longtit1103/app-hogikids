"use server";

import { cookies } from "next/headers";

import type { ActionResult } from "@/lib/actions/action-result";
import { docLuaChonTuCookie, giaTriCookieLuaChon, TEN_COOKIE_KHOANG_NGAY } from "@/lib/date-range-cookie";
import { requireUser } from "@/lib/session";

const MOT_NAM_GIAY = 365 * 24 * 60 * 60;

/**
 * Lưu lựa chọn khoảng ngày CÓ CHỦ Ý (bộ chọn chung / bộ chọn tháng Lãi/Lỗ) vào cookie
 * `hogikids_khoang_ngay` — nguồn lưu DUY NHẤT (#254, thay localStorage).
 *
 * Vì sao Server Action (không ghi `document.cookie`): theo tài liệu Next 16, set cookie trong
 * Server Action (1) dựng lại trang hiện tại + layout trên server ngay trong lượt trả về — nhãn (từ
 * layout) và số liệu (từ trang) đổi CÙNG một commit, không có lượt vẽ sai; (2) xoá Client Cache —
 * tab đã tải sẵn theo lựa chọn cũ không hiện số cũ. Cookie `httpOnly` như cookie phiên.
 *
 * Giá trị đi qua CHÍNH luật kiểm của URL (`docLuaChonTuCookie`) trước khi ghi: client gửi gì sai
 * hình cũng không vào được cookie. KHÔNG ghi DB ⇒ nằm nhóm CHI_DOC của lưới khoá bảo trì.
 * URL/drill KHÔNG BAO GIỜ gọi action này — chỉ `selectPreset`/`applyCustomRange` của bộ chọn.
 */
export async function luuLuaChonKhoangNgay(giaTri: string): Promise<ActionResult<null>> {
  await requireUser();
  // Server Action nhận payload từ mạng: kiểu khai báo không bảo đảm gì lúc chạy.
  if (typeof giaTri !== "string") return { ok: false, error: "Khoảng ngày không hợp lệ — chọn lại." };
  const luaChon = docLuaChonTuCookie(giaTri);
  if (!luaChon) return { ok: false, error: "Khoảng ngày không hợp lệ — chọn lại." };

  const cookieStore = await cookies();
  cookieStore.set(TEN_COOKIE_KHOANG_NGAY, giaTriCookieLuaChon(luaChon), {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: MOT_NAM_GIAY,
  });
  return { ok: true, data: null };
}
