import { hashPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";
import type { NguoiDung } from "@/lib/quyen/nguoi-dung-phien";

import { nguoiDungGia } from "../helpers/nguoi-dung-gia";

/**
 * Dữ liệu chung cho các suite `tests/tai-khoan/**`: mọi tài khoản test mang đuôi email riêng để dọn
 * đúng phần của mình (DB test dùng chung với suite khác, chạy tuần tự theo file).
 */
export const DUOI_EMAIL = "@tai-khoan.test";

/** Mã nhật ký các suite này sinh ra — dọn theo mã + đối tượng/actor test, không xoá nhật ký suite khác. */
const HANH_DONG_CUA_SUITE = [
  "TAI_KHOAN_TAO",
  "TAI_KHOAN_SUA_QUYEN",
  "TAI_KHOAN_KHOA",
  "TAI_KHOAN_MO_KHOA",
  "TAI_KHOAN_DAT_LAI_MK",
  "TAI_KHOAN_XOA",
  "DOI_MAT_KHAU_LAN_DAU",
];

export const ID_STAFF_GIA = "staff-gia-tai-khoan";

export async function donDuLieuTaiKhoan(): Promise<void> {
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { hanhDong: { in: HANH_DONG_CUA_SUITE } },
        { actorId: ID_STAFF_GIA },
        { actorEmail: { endsWith: DUOI_EMAIL } },
      ],
    },
  });
  await prisma.user.deleteMany({ where: { email: { endsWith: DUOI_EMAIL, mode: "insensitive" } } });
}

/**
 * OWNER duy nhất trong DB test — người gọi action quản trị. Không trông vào seed: suite khác
 * (`tests/phien/sinh-moc-phien.test.ts`) xoá OWNER. Thiếu thì tạo một OWNER mang đuôi email của suite
 * (bị `donDuLieuTaiKhoan` dọn theo ⇒ DB trả về đúng trạng thái trước khi chạy).
 */
export async function chuShopTrongDb(): Promise<NguoiDung> {
  const o =
    (await prisma.user.findFirst({ where: { role: "OWNER" } })) ??
    (await prisma.user.create({
      data: { email: `chu-shop${DUOI_EMAIL}`, passwordHash: "x:y", role: "OWNER", sessionEpoch: "c".repeat(32) },
    }));
  return nguoiDungGia({ id: o.id, email: o.email, role: "OWNER", mocPhien: o.sessionEpoch });
}

export const staffGia = (): NguoiDung =>
  nguoiDungGia({ id: ID_STAFF_GIA, email: `staff-gia${DUOI_EMAIL}`, role: "STAFF" });

/** Tạo nhanh một STAFF trong DB (không qua action) để thử khoá/mở/xoá/đặt lại. */
export async function taoStaffTrongDb(
  ten: string,
  p: { matKhau?: string; quyen?: string[]; mustChangePassword?: boolean; sessionEpoch?: string } = {},
) {
  return prisma.user.create({
    data: {
      email: `${ten}${DUOI_EMAIL}`,
      passwordHash: await hashPassword(p.matKhau ?? "Mat-khau-staff-0000"),
      role: "STAFF",
      quyen: p.quyen ?? [],
      mustChangePassword: p.mustChangePassword ?? false,
      sessionEpoch: p.sessionEpoch ?? "b".repeat(32),
    },
  });
}
