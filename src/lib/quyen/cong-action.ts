/**
 * Cổng SERVER ACTION — trả kết quả (không ném, không redirect) để form hiện lỗi tại chỗ.
 *
 * Mẫu dùng: `const c = await congAction("chi-phi:sua"); if (!c.ok) return c; const { nguoiDung } = c;`
 * — nhánh lỗi gán thẳng được vào `ActionResult`. Action là request riêng: tự đọc ngữ cảnh, không dựa
 * vào kết quả render trước đó. Thiếu quyền ghi nhật ký `TU_CHOI_QUYEN` (LOI) bằng client gốc.
 */
import { HANH_DONG } from "@/lib/nhat-ky/hanh-dong";
import { ghiNhatKyLoi } from "@/lib/nhat-ky/ghi-nhat-ky";
import type { Quyen } from "@/lib/quyen/danh-muc-quyen";
import {
  coQuyen,
  docNguoiDungPhien,
  duQuyenYeuCau,
  laChuShop,
  moTaQuyenYeuCau,
  type NguoiDung,
} from "@/lib/quyen/nguoi-dung-phien";

export type KetQuaCong =
  | { ok: true; nguoiDung: NguoiDung }
  | { ok: false; error: string; code: "CHUA_DANG_NHAP" | "PHAI_DOI_MAT_KHAU" | "KHONG_CO_QUYEN" };

/** Mô tả quyền thiếu của cổng chỉ-chủ-shop trong nhật ký. */
export const QUYEN_CHU_SHOP = "chu-shop";

const LOI_CHUA_DANG_NHAP = "Phiên đăng nhập đã hết hạn — đăng nhập lại";
const LOI_PHAI_DOI_MAT_KHAU = "Bạn cần đổi mật khẩu trước khi thao tác";
const LOI_KHONG_CO_QUYEN = "Bạn không có quyền thực hiện thao tác này";

async function tuChoiQuyen(nd: NguoiDung, quyenThieu: string): Promise<KetQuaCong> {
  await ghiNhatKyLoi({
    actor: { id: nd.id, email: nd.email },
    hanhDong: HANH_DONG.TU_CHOI_QUYEN,
    ghiChu: { quyenThieu },
  });
  return { ok: false, error: LOI_KHONG_CO_QUYEN, code: "KHONG_CO_QUYEN" };
}

async function nguoiDungHopLe(): Promise<KetQuaCong> {
  const nd = await docNguoiDungPhien();
  if (!nd) return { ok: false, error: LOI_CHUA_DANG_NHAP, code: "CHUA_DANG_NHAP" };
  if (nd.phaiDoiMatKhau) return { ok: false, error: LOI_PHAI_DOI_MAT_KHAU, code: "PHAI_DOI_MAT_KHAU" };
  return { ok: true, nguoiDung: nd };
}

/** `quyen` mảng = có ÍT NHẤT MỘT. Không truyền = chỉ cần đăng nhập (vd đổi mật khẩu của chính mình). */
export async function congAction(quyen?: Quyen | readonly Quyen[]): Promise<KetQuaCong> {
  const c = await nguoiDungHopLe();
  if (!c.ok || quyen === undefined) return c;
  if (!duQuyenYeuCau(c.nguoiDung, quyen)) return tuChoiQuyen(c.nguoiDung, moTaQuyenYeuCau(quyen));
  return c;
}

/**
 * Bước HAI của cổng — gọi SAU `congAction(...)` đã qua, khi quyền cần thêm chỉ biết được sau khi đọc
 * input (vd dòng tiền gắn khoản vay ⇒ đòi thêm quyền Sổ quỹ). Cùng hợp đồng với cổng: thiếu ⇒
 * `KHONG_CO_QUYEN` + dòng `TU_CHOI_QUYEN` nêu đúng quyền thiếu.
 */
export async function kiemThemQuyen(nguoiDung: NguoiDung, quyen: Quyen): Promise<KetQuaCong> {
  if (coQuyen(nguoiDung, quyen)) return { ok: true, nguoiDung };
  return tuChoiQuyen(nguoiDung, quyen);
}

/** Action chỉ chủ shop (OWNER). */
export async function congChuShopAction(): Promise<KetQuaCong> {
  const c = await nguoiDungHopLe();
  if (!c.ok) return c;
  if (!laChuShop(c.nguoiDung)) return tuChoiQuyen(c.nguoiDung, QUYEN_CHU_SHOP);
  return c;
}
