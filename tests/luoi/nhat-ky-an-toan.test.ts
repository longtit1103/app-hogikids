import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * LƯỚI TĨNH: thư viện nhật ký (`src/lib/nhat-ky/**`) không bao giờ được CHẠM tới bí mật (spec §5,
 * §8.1 mục 5). Nhật ký là bảng chủ shop đọc thoải mái và đi theo bản backup — một dòng
 * `ghiChu: { passwordHash }` hay `matKhauTam` lọt vào là rò bí mật vĩnh viễn. Soi TOÀN VĂN (kể cả
 * comment): thư viện này không có lý do gì để nhắc tên các trường đó.
 */
const GOC = path.resolve(__dirname, "../..");
const THU_MUC = "src/lib/nhat-ky";
const CAM = /passwordHash|matKhauTam|token/i;

/**
 * NGOẠI LỆ DUY NHẤT: tên server action `doiVaLuuTokenMeta` ĐỨNG LÀM KHOÁ trong `ANH_XA_ACTION_HANH_DONG`
 * (`doiVaLuuTokenMeta: HANH_DONG.…`). Đó là tên hàm, không phải bí mật. Chỉ gỡ đúng định danh đó khi
 * nó là khoá (theo sau là `:`), rồi soi phần còn lại của dòng như thường — `doiVaLuuTokenMetaX`, lời
 * gọi `doiVaLuuTokenMeta()` hay một `token` khác cùng dòng vẫn đỏ.
 */
const NGOAI_LE_KHOA_ANH_XA = /(?<![\w$])doiVaLuuTokenMeta(?=\s*:)/g;

/** Dòng có vi phạm từ cấm không, sau khi gỡ ngoại lệ khoá ánh xạ. */
function dongViPham(dong: string): boolean {
  return CAM.test(dong.replace(NGOAI_LE_KHOA_ANH_XA, ""));
}

function lietKe(rel: string): string[] {
  return readdirSync(path.join(GOC, rel), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? lietKe(`${rel}/${e.name}`) : [`${rel}/${e.name}`],
  );
}

describe("lưới nhật ký an toàn", () => {
  it("src/lib/nhat-ky/** không chứa passwordHash|matKhauTam|token", () => {
    const file = lietKe(THU_MUC);
    expect(file.length).toBeGreaterThanOrEqual(2); // hanh-dong.ts + ghi-nhat-ky.ts — lưới không rỗng
    const viPham = file.flatMap((f) =>
      readFileSync(path.join(GOC, f), "utf8")
        .split("\n")
        .map((dong, i) => ({ dong, i }))
        .filter(({ dong }) => dongViPham(dong))
        .map(({ dong, i }) => `${f}:${i + 1}: ${dong.trim()}`),
    );
    expect(viPham).toEqual([]);
  });

  it("chính lưới: mẫu chứa từ cấm (mọi kiểu hoa/thường) ⇒ bắt", () => {
    for (const mau of [`ghiChu: { passwordHash }`, `matKhauTam: x`, `accessToken`, `TOKEN_VAULT_SECRET`]) {
      expect(CAM.test(mau), mau).toBe(true);
    }
    expect(CAM.test(`ghiChu: { soDong, lyDo }`)).toBe(false);
  });

  it("chính lưới: ngoại lệ chỉ đúng khoá ánh xạ `doiVaLuuTokenMeta:` — `token` khác vẫn đỏ", () => {
    expect(dongViPham(`  doiVaLuuTokenMeta: HANH_DONG.KHOA_KET_NOI_THAY_META,`)).toBe(false);
    for (const mau of [
      `  doiVaLuuTokenMeta: HANH_DONG.KHOA_TOKEN,`, // phần sau khoá vẫn bị soi
      `  doiVaLuuTokenMetaX: HANH_DONG.KHOA_KET_NOI_THAY_META,`, // định danh khác
      `  xdoiVaLuuTokenMeta: HANH_DONG.KHOA_KET_NOI_THAY_META,`,
      `  await doiVaLuuTokenMeta(input);`, // không phải khoá
      `  // doiVaLuuTokenMeta ghi accessToken`,
      `  doiVaLuuTokenMeta: x, accessToken: y,`,
      `  refreshToken: HANH_DONG.KHOA_KET_NOI_THAY_META,`,
    ]) {
      expect(dongViPham(mau), mau).toBe(true);
    }
  });
});
