/**
 * Đọc danh sách tài khoản cho trang `/quan-tri` (CHỈ chủ shop — trang gọi `yeuCauChuShopTrang` trước).
 *
 * Chỉ chọn trường hiển thị: KHÔNG `passwordHash`, KHÔNG `sessionEpoch` — hàng này đi thẳng vào props RSC.
 */
import type { Role } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { laQuyen, type Quyen } from "@/lib/quyen/danh-muc-quyen";

export type TaiKhoanRow = {
  id: string;
  email: string;
  tenHienThi: string;
  role: Role;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  /** Mã quyền đang lưu, đã lọc mã không còn trong danh mục (DB đời cũ/sửa tay). */
  quyen: Quyen[];
};

/** OWNER đứng đầu, rồi theo email (so theo mã ký tự — không phụ thuộc collation của DB). */
export async function listTaiKhoan(): Promise<TaiKhoanRow[]> {
  const rows = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      tenHienThi: true,
      role: true,
      isActive: true,
      mustChangePassword: true,
      lastLoginAt: true,
      quyen: true,
    },
  });
  const hang = (r: { role: Role }) => (r.role === "OWNER" ? 0 : 1);
  return rows
    .map((r) => ({ ...r, quyen: r.quyen.filter(laQuyen) }))
    .sort((a, b) => hang(a) - hang(b) || (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
}
