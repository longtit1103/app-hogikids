"use server";

import { revalidatePath } from "next/cache";

import type { ActionResult } from "@/lib/actions/action-result";
import { maLoiNhatKy } from "@/lib/actions/khoan-vay-chung";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import type { HanhDong } from "@/lib/nhat-ky/hanh-dong";
import { ghiNhatKyLoi } from "@/lib/nhat-ky/ghi-nhat-ky";
import { congAction } from "@/lib/quyen/cong-action";
import type { NguoiDung } from "@/lib/quyen/nguoi-dung-phien";
import { khoiPhucBanGhiDaXoa } from "@/lib/thung-rac/khoi-phuc-ban-ghi";
import { LoiThieuQuyenThungRac, QUYEN_VAO_THUNG_RAC } from "@/lib/thung-rac/quyen-thung-rac";
import { xoaVinhVienBanGhiDaXoa } from "@/lib/thung-rac/xoa-vinh-vien-ban-ghi";

/**
 * 2 server action của THÙNG RÁC KHÔI PHỤC (bảng `BanGhiDaXoa`). Việc CHỤP ảnh không ở đây: nó phải
 * nằm trong chính transaction của từng lượt xoá (`expenses.ts` · `cash-movements.ts` ·
 * `khoan-vay.ts` · `so-tiet-kiem.ts`), xem `src/lib/thung-rac/ghi-thung-rac.ts`.
 *
 * Cả hai PHẢI nằm trong `DUONG_GHI` của `tests/khoa-bao-tri-duong-ghi.test.ts` — phép quét AST chỉ
 * đọc THÂN HÀM export nên `dangPhucHoi()` phải gọi TRỰC TIẾP ở đây, không uỷ quyền cho module lõi.
 *
 * QUYỀN hai tầng (spec phân quyền §1.4): cổng action chỉ đòi ÍT NHẤT MỘT quyền `sua` vào thùng rác;
 * quyền thật theo LOẠI bản ghi kiểm TRONG transaction của helper, trên `bang` đọc từ DB. Thiếu ⇒
 * helper ném `LoiThieuQuyenThungRac`, ở đây ghi `TU_CHOI_QUYEN` + trả `KHONG_CO_QUYEN` (cùng hợp
 * đồng với cổng action).
 */

const LOI_KHONG_CO_QUYEN = "Bạn không có quyền thực hiện thao tác này";

/** Dịch lỗi ném từ helper thùng rác: thiếu quyền ⇒ nhật ký từ chối; lỗi khác ⇒ dòng LOI kèm mã. */
async function xuLyLoiThungRac(
  e: unknown,
  nguoiDung: NguoiDung,
  hanhDong: HanhDong,
  id: string,
  loiChung: string
): Promise<ActionResult<never>> {
  if (e instanceof LoiThieuQuyenThungRac) {
    await ghiNhatKyLoi({
      actor: nguoiDung,
      hanhDong: "TU_CHOI_QUYEN",
      doiTuong: { loai: "BanGhiDaXoa", id },
      ghiChu: { quyenThieu: e.quyenThieu },
    });
    return { ok: false, error: LOI_KHONG_CO_QUYEN, code: "KHONG_CO_QUYEN" };
  }
  await ghiNhatKyLoi({
    actor: nguoiDung,
    hanhDong,
    doiTuong: { loai: "BanGhiDaXoa", id },
    ghiChu: { lyDo: maLoiNhatKy(e) },
  });
  return { ok: false, error: loiChung };
}

/**
 * Làm mới mọi màn đọc số tiền: khôi phục một dòng chi phí đổi Lãi/Lỗ (`/` · `/kenh`), đổi Sổ quỹ
 * (`/tai-chinh`), và dòng chi phí có thể gắn kênh nên trang sản phẩm/kênh cũng phải tươi lại.
 */
function lamMoiMoiMan(): void {
  revalidatePath("/tai-chinh");
  revalidatePath("/");
  revalidatePath("/kenh");
  revalidatePath("/san-pham");
}

/**
 * Dựng lại bản ghi (và cụm con của nó) với đúng id cũ. Lý do từ chối đã là câu tiếng Việt sẵn.
 *
 * `data` là CẢNH BÁO (hoặc null): lượt khôi phục thành công nhưng có thứ app CỐ Ý không làm — hiện
 * chỉ một ca, sổ tiết kiệm nay đã trỏ sang khoản vay khác nên không nối lại. Trả về để client nói ra
 * thay vì nuốt im lặng.
 */
export async function khoiPhucBanGhi(id: string): Promise<ActionResult<string | null>> {
  const c = await congAction(QUYEN_VAO_THUNG_RAC);
  if (!c.ok) return c;
  const { nguoiDung } = c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  let ketQua;
  try {
    // KHÔNG bọc transaction ngoài: helper tự mở MỘT transaction (quyền + CAS + ghi + nhật ký).
    ketQua = await khoiPhucBanGhiDaXoa(id, nguoiDung);
  } catch (e) {
    return xuLyLoiThungRac(e, nguoiDung, "THUNG_RAC_KHOI_PHUC", id, "Lỗi khi khôi phục bản ghi");
  }
  if (!ketQua.ok) return { ok: false, error: ketQua.lyDo };

  lamMoiMoiMan();
  return { ok: true, data: ketQua.canhBao };
}

/**
 * Xoá VĨNH VIỄN một mục thùng rác — sau lượt này không còn đường nào lấy lại ngoài bản sao lưu.
 * Chỉ xoá dòng snapshot: bản ghi gốc đã bị xoá cứng từ trước, ở đây không có gì để dọn thêm.
 */
export async function xoaVinhVienBanGhi(id: string): Promise<ActionResult> {
  const c = await congAction(QUYEN_VAO_THUNG_RAC);
  if (!c.ok) return c;
  const { nguoiDung } = c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  let ketQua;
  try {
    ketQua = await xoaVinhVienBanGhiDaXoa(id, nguoiDung);
  } catch (e) {
    return xuLyLoiThungRac(e, nguoiDung, "THUNG_RAC_XOA_VINH_VIEN", id, "Lỗi khi xoá vĩnh viễn");
  }
  if (!ketQua.ok) return { ok: false, error: ketQua.lyDo };

  revalidatePath("/tai-chinh");
  return { ok: true, data: undefined };
}
