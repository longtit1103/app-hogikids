/**
 * Logic seed tài khoản chủ shop, tách khỏi `prisma/seed.ts` để test gọi được với client trỏ DB test
 * bất kỳ (`seed.ts` chỉ đọc env rồi gọi hàm ở đây).
 *
 * Import TƯƠNG ĐỐI (không alias `@/`): file chạy bằng `tsx prisma/seed.ts` — ngoài bundler của Next.
 */
import type { PrismaClient } from "@prisma/client";

// Trần độ dài + hàm băm lấy TỪ nguồn duy nhất của app (seed từng tự khai bản băm riêng — hai bản
// trôi lệch là mọi lượt đăng nhập tài khoản seed hỏng câm). Trần phải trùng màn đăng nhập: màn đó
// từ chối mật khẩu quá dài với đúng một thông báo chung ("Email hoặc mật khẩu không đúng" — cố ý
// không nói lý do, chống dò tài khoản), nên seed mà cho qua thì người vận hành thấy seed BÁO THÀNH
// CÔNG rồi đăng nhập hoài không được, không manh mối; đường thoát duy nhất là sửa tay trong DB —
// nguy nhất đúng lượt go-live/phục hồi thảm hoạ.
import { chuanHoaEmail } from "../src/lib/chuan-hoa-email";
import { hashPassword, MAX_PASSWORD_LENGTH } from "../src/lib/password";

/** Hồ sơ shop singleton `id = 1` — chỉ tạo khi chưa có, KHÔNG ghi đè thông tin chủ shop đã sửa. */
export async function damBaoShopProfile(db: Pick<PrismaClient, "shopProfile">): Promise<void> {
  await db.shopProfile.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
}

/**
 * Tạo tài khoản OWNER (nếu chưa có email đó) + hồ sơ shop, trong MỘT transaction.
 *
 * - Email chuẩn hoá trước khi tra/tạo.
 * - Đã có user cùng email ⇒ GIỮ NGUYÊN (không ghi đè hash — đổi mật khẩu là việc của màn Cài đặt).
 * - Đã có OWNER khác email ⇒ DB từ chối (partial unique `User_owner_duy_nhat`) — ném to, không tạo
 *   OWNER thứ hai.
 * - Mật khẩu dài quá trần màn đăng nhập ⇒ ném TRƯỚC khi ghi gì (xem ghi chú import ở trên).
 */
export async function seedChuShop(
  db: PrismaClient,
  p: { email: string; password: string },
): Promise<void> {
  const email = chuanHoaEmail(p.email);
  if (!email) throw new Error("Email chủ shop trống — không seed được tài khoản.");
  if (!p.password) throw new Error("Mật khẩu chủ shop trống — không seed được tài khoản.");
  if (p.password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(
      `Mật khẩu chủ shop dài ${p.password.length} ký tự, vượt trần ${MAX_PASSWORD_LENGTH} của màn ` +
        `đăng nhập — tài khoản seed ra sẽ KHÔNG đăng nhập được. Rút ngắn mật khẩu rồi chạy lại seed.`,
    );
  }

  // Băm NGOÀI transaction: scrypt chậm có chủ đích, đừng giữ transaction mở trong lúc băm.
  const passwordHash = await hashPassword(p.password);
  await db.$transaction(async (tx) => {
    await tx.user.upsert({
      where: { email },
      update: {},
      create: { email, passwordHash, role: "OWNER" },
    });
    await damBaoShopProfile(tx);
  });
}
