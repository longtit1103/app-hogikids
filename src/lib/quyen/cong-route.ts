/**
 * Cổng ROUTE HANDLER — trả `Response` JSON dựng sẵn cho nhánh từ chối: chưa đăng nhập 401, phải đổi
 * mật khẩu 403, thiếu quyền 403 (+ nhật ký `TU_CHOI_QUYEN`). Dùng lại đúng logic cổng action để hai
 * cổng không trôi lệch nhau.
 *
 * Mẫu: `const c = await congRoute("ton-kho:xem"); if (!c.ok) return c.response; const { nguoiDung } = c;`
 */
import type { Quyen } from "@/lib/quyen/danh-muc-quyen";
import type { NguoiDung } from "@/lib/quyen/nguoi-dung-phien";
import { congAction, congChuShopAction, type KetQuaCong } from "@/lib/quyen/cong-action";

export type KetQuaCongRoute = { ok: true; nguoiDung: NguoiDung } | { ok: false; response: Response };

function sangRoute(c: KetQuaCong): KetQuaCongRoute {
  if (c.ok) return c;
  if (c.code === "CHUA_DANG_NHAP") {
    return { ok: false, response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  return { ok: false, response: Response.json({ error: c.error, code: c.code }, { status: 403 }) };
}

/** `quyen` mảng = có ÍT NHẤT MỘT. */
export async function congRoute(quyen?: Quyen | readonly Quyen[]): Promise<KetQuaCongRoute> {
  return sangRoute(await congAction(quyen));
}

/** Route chỉ chủ shop (OWNER) — `/api/backup`, `/api/restore`. */
export async function congChuShopRoute(): Promise<KetQuaCongRoute> {
  return sangRoute(await congChuShopAction());
}
