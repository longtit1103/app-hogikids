import { prisma } from "@/lib/prisma";
import type { AnhBanGhi, BangThungRac } from "@/lib/thung-rac/chup-anh-ban-ghi";
import { doTinhTrang, tachAnh } from "@/lib/thung-rac/do-tinh-trang-khoi-phuc";
import { lyDoKhongKhoiPhuc } from "@/lib/thung-rac/ly-do-khong-khoi-phuc";

/** Số dòng mỗi trang màn thùng rác — thùng rác nội bộ, không cần khớp cỡ trang của bảng nghiệp vụ. */
export const THUNG_RAC_PAGE_SIZE = 20;

/** Nhãn tiếng Việt của cột "Loại", dịch từ tên model Prisma lưu trong `BanGhiDaXoa.bang`. */
export const NHAN_LOAI_THUNG_RAC: Record<BangThungRac, string> = {
  Expense: "Sổ chi phí",
  CashMovement: "Dòng tiền",
  ThuNhap: "Thu nhập",
  Loan: "Khoản vay",
  SoTietKiem: "Sổ tiết kiệm",
};

export type ThungRacRow = {
  id: string;
  bang: BangThungRac;
  nhan: string;
  soTien: number;
  ngay: Date;
  xoaLuc: Date;
  khoiPhucLuc: Date | null;
  /** null = còn khôi phục được (và chưa khôi phục). Câu chữ đến THẲNG từ `lyDoKhongKhoiPhuc`. */
  lyDo: string | null;
};

/**
 * Liệt kê thùng rác, mới xoá lên trước.
 *
 * Tính "khôi phục được không" cho MỖI dòng bằng đúng `doTinhTrang` mà `khoiPhucBanGhiDaXoa` dùng
 * lúc ghi — chỉ khác là gọi bằng `prisma` (đọc thường) thay vì `tx` transaction, vì đây là màn liệt
 * kê không ghi gì. Dùng lại thay vì tự dò lại là để bảng KHÔNG BAO GIỜ nói "khôi phục được" rồi bấm
 * vào lại báo lỗi khác — hai đường tính phải luôn là MỘT đường.
 */
export async function listThungRac(page: number): Promise<{ rows: ThungRacRow[]; total: number }> {
  const [total, dong] = await Promise.all([
    prisma.banGhiDaXoa.count(),
    prisma.banGhiDaXoa.findMany({
      orderBy: { xoaLuc: "desc" },
      skip: (page - 1) * THUNG_RAC_PAGE_SIZE,
      take: THUNG_RAC_PAGE_SIZE,
    }),
  ]);

  const rows = await Promise.all(
    dong.map(async (d): Promise<ThungRacRow> => {
      const bang = d.bang as BangThungRac;
      const anh = d.anh as unknown as AnhBanGhi;
      const canDung = tachAnh(bang, anh);
      const tinhTrang = await doTinhTrang(prisma, d.khoiPhucLuc !== null, canDung);
      return {
        id: d.id,
        bang,
        nhan: d.nhan,
        soTien: d.soTien,
        ngay: d.ngay,
        xoaLuc: d.xoaLuc,
        khoiPhucLuc: d.khoiPhucLuc,
        lyDo: lyDoKhongKhoiPhuc(tinhTrang),
      };
    })
  );

  return { rows, total };
}
