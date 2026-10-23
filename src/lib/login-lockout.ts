/**
 * Khoá đăng nhập trong bộ nhớ theo EMAIL đã chuẩn hoá — chốt CHÍNH chống dò mật khẩu: 5 lượt sai
 * liên tiếp khoá email đó 60 giây.
 *
 * KHÔNG khoá theo địa chỉ socket: app nằm sau MỘT Cloudflare Tunnel, mọi request tới Node đều đến từ
 * cùng một IP (cloudflared) — khoá theo IP đó là khoá luôn người dùng thật ngay khi bất kỳ ai (hay bot
 * nào) gõ sai. Lớp đếm theo IP THẬT của client (header `cf-connecting-ip`) là lớp PHỤ, ngưỡng rộng hơn,
 * sống riêng ở `src/lib/auth/khoa-dang-nhap-theo-ip.ts`.
 *
 * Cơ chế dọn + trần (và hai "đường thua" đã thử, đừng tối ưu lại) nằm ở bộ đếm dùng chung
 * `src/lib/auth/bo-dem-khoa-tam.ts`.
 */

import { taoBoDemKhoaTam } from "@/lib/auth/bo-dem-khoa-tam";
import { chuanHoaEmail } from "@/lib/chuan-hoa-email";

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 60_000;

/**
 * Trần số email được theo dõi cùng lúc. Export chỉ để test xác nhận việc
 * dọn/chặn trần hoạt động đúng — không phải để chỗ khác chỉnh ở runtime.
 */
export const MAX_TRACKED_EMAILS = 1000;

// Amortize chi phí quét: không quét toàn bộ Map ở MỌI lượt ghi, chỉ định kỳ.
const SWEEP_INTERVAL_WRITES = 100;

const boDemTheoEmail = taoBoDemKhoaTam({
  soLanSaiToiDa: MAX_FAILED_ATTEMPTS,
  thoiGianKhoaMs: LOCKOUT_DURATION_MS,
  tranSoKhoa: MAX_TRACKED_EMAILS,
  quetSauSoLanGhi: SWEEP_INTERVAL_WRITES,
  // Giữ nguyên ngữ nghĩa lịch sử của khoá theo email: bộ đếm chỉ về 0 khi hết một lần khoá / đăng
  // nhập đúng / entry bị dọn.
  quenKhiImLang: false,
});

/** Seconds remaining in the current lockout window, or 0 when not locked. */
export function getLockoutSecondsRemaining(email: string, now: number = Date.now()): number {
  return boDemTheoEmail.giayConKhoa(chuanHoaEmail(email), now);
}

/**
 * Records a failed login attempt. Locks the account for LOCKOUT_DURATION_MS
 * once MAX_FAILED_ATTEMPTS consecutive failures are reached. If a previous
 * lockout window has already fully elapsed, the counter restarts fresh so
 * lockout always reflects "N consecutive failures", not a lifetime total.
 */
export function recordFailedAttempt(email: string, now: number = Date.now()): void {
  boDemTheoEmail.ghiLuotSai(chuanHoaEmail(email), now);
}

/** Clears failure history for an email — call on successful login. */
export function resetAttempts(email: string): void {
  boDemTheoEmail.xoa(chuanHoaEmail(email));
}
