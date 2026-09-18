"use server";

import { revalidatePath } from "next/cache";

import type { ActionResult } from "@/lib/actions/action-result";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { khoiPhucBanGhiDaXoa } from "@/lib/thung-rac/khoi-phuc-ban-ghi";

/**
 * 2 server action của THÙNG RÁC KHÔI PHỤC (bảng `BanGhiDaXoa`). Việc CHỤP ảnh không ở đây: nó phải
 * nằm trong chính transaction của từng lượt xoá (`expenses.ts` · `cash-movements.ts` ·
 * `khoan-vay.ts` · `so-tiet-kiem.ts`), xem `src/lib/thung-rac/ghi-thung-rac.ts`.
 *
 * Cả hai PHẢI nằm trong `DUONG_GHI` của `tests/khoa-bao-tri-duong-ghi.test.ts` — phép quét AST chỉ
 * đọc THÂN HÀM export nên `dangPhucHoi()` phải gọi TRỰC TIẾP ở đây, không uỷ quyền cho module lõi.
 */

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
  await requireUser();
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  let ketQua;
  try {
    ketQua = await khoiPhucBanGhiDaXoa(id);
  } catch {
    return { ok: false, error: "Lỗi khi khôi phục bản ghi" };
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
  await requireUser();
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  try {
    await prisma.banGhiDaXoa.delete({ where: { id } });
  } catch (e) {
    // P2025 = "record not found" của Prisma. Chỉ mã này mới là "không tìm thấy" — lỗi mạng đội lốt
    // câu đó sẽ làm chủ shop tưởng mục đã biến mất rồi thôi không thử lại.
    const code = (e as { code?: string })?.code;
    return {
      ok: false,
      error: code === "P2025" ? "Không tìm thấy mục trong thùng rác" : "Lỗi khi xoá vĩnh viễn",
    };
  }

  revalidatePath("/tai-chinh");
  return { ok: true, data: undefined };
}
