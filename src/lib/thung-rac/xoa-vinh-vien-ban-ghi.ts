import { ghiNhatKy } from "@/lib/nhat-ky/ghi-nhat-ky";
import { prisma } from "@/lib/prisma";
import type { NguoiDung } from "@/lib/quyen/nguoi-dung-phien";
import { kiemQuyenBang } from "@/lib/thung-rac/quyen-thung-rac";

export type KetQuaXoaVinhVien = { ok: true } | { ok: false; lyDo: string };

const KHONG_TIM_THAY = "Không tìm thấy mục trong thùng rác";

/**
 * Xoá VĨNH VIỄN một mục thùng rác — sau lượt này không còn đường nào lấy lại ngoài bản sao lưu. Chỉ
 * xoá dòng snapshot: bản ghi gốc đã bị xoá cứng từ trước.
 *
 * MỘT transaction (khuôn `khoiPhucBanGhiDaXoa`): đọc `bang` từ DB → kiểm quyền theo loại (spec phân
 * quyền §1.4, không tin client) → xoá → nhật ký là câu CUỐI. Nhật ký ném ⇒ mục vẫn còn trong thùng rác.
 * Thiếu quyền ⇒ NÉM `LoiThieuQuyenThungRac` ra ngoài cho tầng action ghi `TU_CHOI_QUYEN`.
 */
export async function xoaVinhVienBanGhiDaXoa(id: string, actor: NguoiDung): Promise<KetQuaXoaVinhVien> {
  try {
    return await prisma.$transaction(async (tx): Promise<KetQuaXoaVinhVien> => {
      const dong = await tx.banGhiDaXoa.findUnique({
        where: { id },
        select: { bang: true, banGhiId: true, anh: true },
      });
      if (!dong) return { ok: false, lyDo: KHONG_TIM_THAY };

      kiemQuyenBang(actor, dong.bang, dong.anh);

      await tx.banGhiDaXoa.delete({ where: { id } });
      await ghiNhatKy(tx, {
        actor,
        hanhDong: "THUNG_RAC_XOA_VINH_VIEN",
        doiTuong: { loai: dong.bang, id: dong.banGhiId },
        ghiChu: { loaiBanGhi: dong.bang },
      });
      return { ok: true };
    });
  } catch (e) {
    // P2025 = "record not found" của Prisma: lượt song song vừa xoá mất giữa lúc đọc và lúc xoá. Chỉ
    // mã này mới là "không tìm thấy" — lỗi mạng đội lốt câu đó làm chủ shop tưởng mục đã biến mất.
    if ((e as { code?: string })?.code === "P2025") return { ok: false, lyDo: KHONG_TIM_THAY };
    throw e;
  }
}
