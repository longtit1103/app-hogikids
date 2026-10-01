/**
 * Bước HAI của cổng "sửa giá vốn" — gọi NGAY SAU `congAction("san-pham:sua")` đã qua:
 *
 * ```ts
 * const cong = await congAction("san-pham:sua");
 * if (!cong.ok) return cong;
 * const giaVon = await kiemQuyenXemGiaVon(cong.nguoiDung);
 * if (!giaVon.ok) return giaVon;
 * ```
 *
 * Sửa/nhập/áp giá vốn đòi CẢ `san-pham:sua` LẪN `gia-von-loi-nhuan:xem` (spec phân quyền §1.1): người
 * không được xem giá vốn mà vẫn sửa được thì vừa ghi mò (không thấy giá đang có), vừa dò ngược được giá
 * qua bảng so sánh của bước xem trước. Thiếu quyền nào cũng `KHONG_CO_QUYEN` + dòng `TU_CHOI_QUYEN`.
 * Ngưỡng tồn KHÔNG đi qua đây — đó không phải dữ liệu giá vốn, chỉ cần `san-pham:sua`.
 *
 * Không phải file `"use server"`: đây là hàm server nội bộ, không được lộ thành Server Action.
 */
import { ghiNhatKyLoi } from "@/lib/nhat-ky/ghi-nhat-ky";
import { HANH_DONG } from "@/lib/nhat-ky/hanh-dong";
import type { KetQuaCong } from "@/lib/quyen/cong-action";
import type { Quyen } from "@/lib/quyen/danh-muc-quyen";
import { coQuyen, type NguoiDung } from "@/lib/quyen/nguoi-dung-phien";

const QUYEN_XEM_GIA_VON: Quyen = "gia-von-loi-nhuan:xem";

export async function kiemQuyenXemGiaVon(nguoiDung: NguoiDung): Promise<KetQuaCong> {
  if (coQuyen(nguoiDung, QUYEN_XEM_GIA_VON)) return { ok: true, nguoiDung };
  await ghiNhatKyLoi({
    actor: { id: nguoiDung.id, email: nguoiDung.email },
    hanhDong: HANH_DONG.TU_CHOI_QUYEN,
    ghiChu: { quyenThieu: QUYEN_XEM_GIA_VON },
  });
  return { ok: false, error: "Bạn không có quyền xem giá vốn", code: "KHONG_CO_QUYEN" };
}
