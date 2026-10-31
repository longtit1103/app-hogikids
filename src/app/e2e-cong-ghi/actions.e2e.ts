"use server";

/**
 * Server action CHỈ-TEST (đuôi `.e2e.ts`: chỉ được nạp bởi trang `page.e2e.tsx`, mà trang đó chỉ có trong
 * bản build `E2E_CONG_GHI_BUILD=1`) cho `tests/e2e/cong-ghi-prod.spec.ts`. Gác như action thật: cổng chủ
 * shop là câu đầu, rồi lớp phòng thủ thứ hai (thiếu `E2E_CONG_GHI=1` lúc chạy ⇒ từ chối như không tồn tại).
 *
 * Hai action đi qua cửa ghi THẬT (`vaoCuaGhi`) đúng khuôn mọi action ghi trong `src/lib/actions`: cửa ở
 * bundle ACTION, còn bộ đếm/cờ được đọc và bật ở bundle ROUTE — hai bên phải thấy cùng một trạng thái.
 * `ghiNgoaiCuaE2e` CỐ Ý không qua cửa (như câu ghi lúc render trang) để đo lưới cấp op.
 */
import { laLoiCongGhiDangKhoa, vaoCuaGhi } from "@/lib/backup/cong-ghi-toan-cuc";
import { choBarrierE2e, e2eCongGhiDangBat, ghiThuE2e } from "@/lib/backup/cong-ghi-e2e-chi-test";
import { LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { congChuShopAction } from "@/lib/quyen/cong-action";

/** `loai: "cong-ghi-chan"` = lỗi do lưới cấp op ném, đã nhận diện bằng `laLoiCongGhiDangKhoa`. */
export type KetQuaGhiE2e =
  | { ok: true; xongLuc: number; giaTri: string }
  | { ok: false; error: string; loai?: "cong-ghi-chan" };

const TAT: KetQuaGhiE2e = { ok: false, error: "Không tồn tại." };

/** Ghi "truoc" → chờ barrier (route chỉ-test thả) → ghi "sau". Giữ cửa suốt lượt. */
export async function ghiGiuBarrierE2e(): Promise<KetQuaGhiE2e> {
  const cong = await congChuShopAction();
  if (!cong.ok) return cong;
  if (!e2eCongGhiDangBat()) return TAT;
  const cua = vaoCuaGhi();
  if (!cua.ok) return cua.loi;
  try {
    await ghiThuE2e("giu", "truoc");
    await choBarrierE2e();
    const giaTri = await ghiThuE2e("giu", "sau");
    return { ok: true, xongLuc: Date.now(), giaTri };
  } finally {
    cua.ra();
  }
}

/** Ghi ngay (không barrier) — đo cửa action từ chối khi cờ do bundle route bật. */
export async function ghiNgayE2e(): Promise<KetQuaGhiE2e> {
  const cong = await congChuShopAction();
  if (!cong.ok) return cong;
  if (!e2eCongGhiDangBat()) return TAT;
  const cua = vaoCuaGhi();
  if (!cua.ok) return cua.loi;
  try {
    const giaTri = await ghiThuE2e("ngay", "x");
    return { ok: true, xongLuc: Date.now(), giaTri };
  } finally {
    cua.ra();
  }
}

/**
 * Ghi NGOÀI cửa (không `vaoCuaGhi`) — cùng hình với câu ghi lúc render (vd bộ sinh chi phí định kỳ). Cờ bật
 * ⇒ lưới cấp op ném; lỗi dựng ở bản module mà singleton Prisma nạp, nên nhận diện bằng
 * `laLoiCongGhiDangKhoa` (nhãn `Symbol.for`), KHÔNG `instanceof`. Lỗi khác ném tiếp.
 */
export async function ghiNgoaiCuaE2e(): Promise<KetQuaGhiE2e> {
  const cong = await congChuShopAction();
  if (!cong.ok) return cong;
  if (!e2eCongGhiDangBat()) return TAT;
  try {
    const giaTri = await ghiThuE2e("ngoai-cua", "x");
    return { ok: true, xongLuc: Date.now(), giaTri };
  } catch (e) {
    if (laLoiCongGhiDangKhoa(e)) return { ok: false, error: LOI_DANG_PHUC_HOI, loai: "cong-ghi-chan" };
    throw e;
  }
}
