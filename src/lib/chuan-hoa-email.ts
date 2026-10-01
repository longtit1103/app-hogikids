/**
 * Dạng chuẩn DUY NHẤT của email: `trim().toLowerCase()`.
 *
 * Mọi đường GHI `User.email` (seed, tạo tài khoản phụ, migration hạ chữ thường email chủ shop) và mọi
 * đường TRA (đăng nhập, khoá chống dò mật khẩu, hàng đợi nối tiếp theo email) đi qua hàm này — nên
 * đăng nhập tra CHÍNH XÁC được, không cần so không phân biệt hoa/thường ở DB. DB còn unique index
 * `lower(email)` chặn hai dòng chỉ khác hoa/thường.
 *
 * Không import gì: `prisma/seed-lib.ts` chạy ngoài bundler Next (import tương đối).
 */
export function chuanHoaEmail(email: string): string {
  return email.trim().toLowerCase();
}
