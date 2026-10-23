import { randomBytes, scryptSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canNangCapHash, hashPassword, SCRYPT_N_HIEN_HANH, verifyPassword } from "@/lib/password";

/**
 * Hash mật khẩu có PHIÊN BẢN: định dạng mới `s2$<N>$<saltHex>:<keyHex>` (N=2^17) cùng tồn tại với định
 * dạng cũ `<saltHex>:<keyHex>` (scrypt mặc định N=16384). Hash cũ PHẢI verify được — nếu không, mọi tài
 * khoản đang có bị khoá ngoài ngay sau deploy.
 */

/** Dựng hash định dạng CŨ đúng cách bản trước sinh ra (salt là chuỗi hex thô, scrypt mặc định). */
function hashDinhDangCu(matKhau: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(matKhau, salt, 64).toString("hex")}`;
}

describe("hashPassword — định dạng có phiên bản", () => {
  it("sinh `s2$131072$<salt 16 byte>:<key 64 byte>`", async () => {
    expect(SCRYPT_N_HIEN_HANH).toBe(131_072);
    const hash = await hashPassword("Mat-khau-manh-123");
    expect(hash).toMatch(/^s2\$131072\$[0-9a-f]{32}:[0-9a-f]{128}$/);
  });

  it("hash mới verify đúng/sai và KHÔNG cần nâng cấp", async () => {
    const hash = await hashPassword("Mat-khau-manh-123");
    await expect(verifyPassword("Mat-khau-manh-123", hash)).resolves.toBe(true);
    await expect(verifyPassword("mat-khau-sai", hash)).resolves.toBe(false);
    expect(canNangCapHash(hash)).toBe(false);
  });
});

describe("verifyPassword — vẫn đọc hash định dạng cũ", () => {
  it("hash cũ verify đúng/sai và CẦN nâng cấp", async () => {
    const cu = hashDinhDangCu("mat-khau-cu");
    await expect(verifyPassword("mat-khau-cu", cu)).resolves.toBe(true);
    await expect(verifyPassword("mat-khau-khac", cu)).resolves.toBe(false);
    expect(canNangCapHash(cu)).toBe(true);
  });

  it("hash `s2$` với N thấp hơn hiện hành vẫn verify và cần nâng cấp", async () => {
    const salt = randomBytes(16).toString("hex");
    const thap = `s2$16384$${salt}:${scryptSync("mk", salt, 64).toString("hex")}`;
    await expect(verifyPassword("mk", thap)).resolves.toBe(true);
    expect(canNangCapHash(thap)).toBe(true);
  });
});

describe("hash hỏng/lạ — không ném, chỉ là sai", () => {
  const HONG = [
    "",
    "not-a-valid-hash",
    "s2$",
    "s2$abc$aa:bb",
    "s2$131072aa:bb", // thiếu `$` sau N
    "s2$131072$aabb", // thiếu `:`
    "s2$1000$aa:bb", // dưới N tối thiểu
    "s2$131073$aa:bb", // không phải lũy thừa của 2
    "s2$2097152$aa:bb", // vượt N tối đa — chặn chuỗi lạ đòi scrypt ăn hết RAM
    "s2$131072$" + "0".repeat(32) + ":zz", // key không phải hex ⇒ lệch độ dài
  ];

  it.each(HONG)("%j ⇒ verify false, canNangCapHash false", async (hong) => {
    await expect(verifyPassword("bat-ky", hong)).resolves.toBe(false);
    expect(canNangCapHash(hong)).toBe(false);
  });
});
