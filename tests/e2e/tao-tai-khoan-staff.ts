import type { PrismaClient } from "../../src/generated/prisma/client";

// Import TƯƠNG ĐỐI (không alias `@/`): file dùng chung cho Playwright runner (TS transform riêng,
// không chắc giải được alias) lẫn Vitest.
import { hashPassword } from "../../src/lib/password";
import { chuanHoaQuyen, type Quyen } from "../../src/lib/quyen/danh-muc-quyen";

export type TaiKhoanStaffTest = { id: string; email: string };

/**
 * Tạo (hoặc tạo lại) một tài khoản STAFF với bộ quyền cho test e2e/integration.
 *
 * - Bộ quyền đi qua `chuanHoaQuyen` y như form quản trị: tổ hợp app không thể tạo ra (vd Lãi/Lỗ thiếu
 *   giá vốn) ⇒ ném, để test không bao giờ kiểm một trạng thái không có thật. `sua` tự kéo theo `xem`.
 * - Email chuẩn hoá `trim().toLowerCase()`; dòng cũ cùng email bị xoá trước (chạy lại spec không
 *   va unique) — cùng transaction nên không có khe "đã xoá mà chưa tạo".
 * - Chỉ tạo STAFF: OWNER duy nhất do `global-setup.ts` seed.
 */
export async function taoTaiKhoanStaff(
  prisma: PrismaClient,
  p: { email: string; matKhau: string; quyen: Quyen[]; mustChangePassword?: boolean; tenHienThi?: string },
): Promise<TaiKhoanStaffTest> {
  const email = p.email.trim().toLowerCase();
  if (!email) throw new Error("taoTaiKhoanStaff: email trống");
  const chuan = chuanHoaQuyen(p.quyen);
  if (!chuan.ok) throw new Error(`taoTaiKhoanStaff: bộ quyền không hợp lệ — ${chuan.error}`);

  const passwordHash = await hashPassword(p.matKhau);
  return prisma.$transaction(async (tx) => {
    await tx.user.deleteMany({ where: { email } });
    return tx.user.create({
      data: {
        email,
        passwordHash,
        role: "STAFF",
        quyen: chuan.quyen,
        mustChangePassword: p.mustChangePassword ?? false,
        tenHienThi: p.tenHienThi ?? "",
      },
      select: { id: true, email: true },
    });
  });
}
