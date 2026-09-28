import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Ghi/ghi đè các khoá trong file `.env`, giữ nguyên phần còn lại.
 * Dùng chung cho 4 script lấy/refresh token (Meta, TikTok Shop, TikTok Business).
 *
 * BẤT BIẾN 1 — ghi đè MỌI dòng trùng tên (cờ `g`), không chỉ dòng đầu. `.env` có 2 dòng cùng tên
 * thì dòng SAU thắng; sửa mỗi dòng đầu sẽ ra token rỗng mà không báo lỗi (đã dính 2026-07-14).
 *
 * BẤT BIẾN 2 — thay thế bằng HÀM replacement `() => \`${k}=${v}\``, KHÔNG dùng chuỗi. String.replace
 * DIỄN GIẢI `$&`, `$\``, `$'`, `$1`, `$$`... nếu replacement là chuỗi — token sàn cấp có chứa `$`
 * (vd `abc$&def`) sẽ bị ghi sai / nhân bản key (`TOK=abcTOK=olddef`). Hàm replacement trả về NGUYÊN
 * VĂN, không diễn giải ký tự đặc biệt nào.
 */
export function ghiEnv(envPath: string, cap: Record<string, string>): void {
  let noiDung = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  for (const [k, v] of Object.entries(cap)) {
    const re = new RegExp(`^${k}=.*$`, "gm");
    const soDong = (noiDung.match(re) ?? []).length;
    if (soDong > 1) console.warn(`  ⚠ .env có ${soDong} dòng "${k}" — ghi đè tất cả`);
    noiDung = soDong > 0 ? noiDung.replace(re, () => `${k}=${v}`) : `${noiDung.trimEnd()}\n${k}=${v}\n`;
  }
  writeFileSync(envPath, noiDung);
}
