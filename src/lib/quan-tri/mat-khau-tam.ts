import { randomInt } from "node:crypto";

/**
 * Bảng chữ mật khẩu tạm: chữ hoa/thường + số, BỎ ký tự dễ đọc nhầm khi chủ shop đọc/nhắn lại cho nhân
 * sự (`0 O 1 l I`). 24 hoa + 25 thường + 8 số = 57 ký tự ⇒ 16 ký tự ≈ 93 bit.
 */
const CHU_HOA = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const CHU_THUONG = "abcdefghijkmnopqrstuvwxyz";
const CHU_SO = "23456789";
const BANG_CHU = CHU_HOA + CHU_THUONG + CHU_SO;
const DO_DAI = 16;

/**
 * Mật khẩu tạm ngẫu nhiên MẬT MÃ (`crypto.randomInt`, không `Math.random`) cho tài khoản mới / đặt lại
 * mật khẩu. Luôn có ≥ 1 chữ + ≥ 1 số — đúng luật mật khẩu mới (`mat-khau-moi-schema.ts`), nên chuỗi
 * này tự nó cũng là một mật khẩu hợp lệ. Lấy mẫu lại đến khi đạt (không chèn ký tự vào vị trí cố
 * định — giữ phân bố đều trên mọi vị trí).
 */
export function sinhMatKhauTam(): string {
  for (;;) {
    let s = "";
    for (let i = 0; i < DO_DAI; i++) s += BANG_CHU[randomInt(BANG_CHU.length)];
    if (/[a-zA-Z]/.test(s) && /\d/.test(s)) return s;
  }
}
