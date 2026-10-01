/**
 * Đọc nhật ký thao tác cho tab Nhật ký của `/quan-tri` (CHỈ chủ shop — trang gọi `yeuCauChuShopTrang`
 * trước). Bảng `AuditLog` vốn không chứa bí mật (lưới `tests/luoi/nhat-ky-an-toan.test.ts`).
 */
import type { AuditLog, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

/**
 * Bộ lọc. `tu`/`den` BAO GỒM cả hai đầu (`tu ≤ thoiDiem ≤ den`) — cùng quy ước `parseDateRange`
 * (`den` = cuối ngày giờ VN).
 */
export type LocNhatKy = { actorId?: string; hanhDong?: string; tu?: Date; den?: Date };

const KICH_THUOC_MAC_DINH = 50;
const KICH_THUOC_TOI_DA = 200;

function soNguyenDuong(x: number, macDinh: number, tran: number): number {
  return Number.isFinite(x) && x >= 1 ? Math.min(Math.floor(x), tran) : macDinh;
}

/**
 * Một trang nhật ký, mới nhất trước (`thoiDiem` giảm dần, `id` phá hoà). `trang` bắt đầu từ 1; trang
 * không hợp lệ (≤ 0, NaN) quy về 1; trang vượt quá trả `rows` rỗng. `tong` = tổng dòng khớp bộ lọc.
 */
export async function listNhatKy(
  loc: LocNhatKy,
  trang: number,
  kichThuoc: number = KICH_THUOC_MAC_DINH,
): Promise<{ rows: AuditLog[]; tong: number }> {
  const soDong = soNguyenDuong(kichThuoc, KICH_THUOC_MAC_DINH, KICH_THUOC_TOI_DA);
  const soTrang = soNguyenDuong(trang, 1, Number.MAX_SAFE_INTEGER);
  const where: Prisma.AuditLogWhereInput = {
    ...(loc.actorId ? { actorId: loc.actorId } : {}),
    ...(loc.hanhDong ? { hanhDong: loc.hanhDong } : {}),
    ...(loc.tu || loc.den
      ? { thoiDiem: { ...(loc.tu ? { gte: loc.tu } : {}), ...(loc.den ? { lte: loc.den } : {}) } }
      : {}),
  };
  const [rows, tong] = await prisma.$transaction([
    prisma.auditLog.findMany({
      where,
      orderBy: [{ thoiDiem: "desc" }, { id: "desc" }],
      skip: (soTrang - 1) * soDong,
      take: soDong,
    }),
    prisma.auditLog.count({ where }),
  ]);
  return { rows, tong };
}

/** Mã hành động đã từng xuất hiện (cho dropdown lọc) — không trùng, sắp theo mã ký tự. */
export async function listHanhDongDaCo(): Promise<string[]> {
  const rows = await prisma.auditLog.findMany({ distinct: ["hanhDong"], select: { hanhDong: true } });
  return rows.map((r) => r.hanhDong).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
