import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

/**
 * Trần độ dài mật khẩu, dùng CHUNG cho cả màn đăng nhập lẫn màn đổi mật khẩu.
 *
 * PHẢI là một hằng số duy nhất, không được để mỗi nơi tự khai một số: nếu màn đổi mật khẩu cho
 * đặt chuỗi dài hơn trần của màn đăng nhập thì chủ shop đặt xong sẽ TỰ KHOÁ MÌNH VĨNH VIỄN —
 * hash mới lưu thành công, mọi phiên bị thu hồi theo thiết kế, rồi lượt đăng nhập kế tiếp bị
 * chặn ngay ở bước kiểm dữ liệu và chỉ nhận đúng thông báo chung "Email hoặc mật khẩu không
 * đúng" (thông báo cố ý không nói lý do để chống dò tài khoản), nên không có cách nào đoán ra.
 * Đường thoát duy nhất khi đó là vào tận DB sửa tay.
 *
 * 200 dư sức cho cả passphrase dài lẫn chuỗi do trình quản lý mật khẩu sinh, mà vẫn chặn được
 * payload cỡ MB nhồi vào scrypt.
 */
export const MAX_PASSWORD_LENGTH = 200;

/**
 * MUST stay in sync with `prisma/seed.ts`'s `hashPassword` — same key length
 * and, critically, the same salt encoding: the salt is the raw hex STRING
 * itself passed straight into `scrypt` (never `Buffer.from(salt, "hex")`).
 * If either side changes independently, every seeded login silently fails.
 */
const SCRYPT_KEY_LENGTH = 64;

/** Hashes a plaintext password into the `"<saltHex>:<derivedKeyHex>"` format used by prisma/seed.ts. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = (await scrypt(password, salt, SCRYPT_KEY_LENGTH)) as Buffer;
  return `${salt}:${derivedKey.toString("hex")}`;
}

/**
 * Verifies a plaintext password against a stored `"<saltHex>:<derivedKeyHex>"`
 * hash (as produced by `hashPassword` / `prisma/seed.ts`). Uses
 * `timingSafeEqual` to avoid leaking timing information, and never throws on
 * malformed input — a corrupt/foreign hash format just fails verification.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const separatorIndex = stored.indexOf(":");
  if (separatorIndex === -1) {
    return false;
  }

  const salt = stored.slice(0, separatorIndex);
  const storedKeyHex = stored.slice(separatorIndex + 1);
  const storedKey = Buffer.from(storedKeyHex, "hex");

  // Salt is passed to scrypt as the raw hex STRING (matching seed.ts) — do
  // NOT hex-decode it into a Buffer here.
  const derivedKey = (await scrypt(password, salt, SCRYPT_KEY_LENGTH)) as Buffer;

  if (derivedKey.length !== storedKey.length) {
    // timingSafeEqual throws on length mismatch — treat as "wrong password"
    // instead of letting a malformed/foreign hash crash the login flow.
    return false;
  }

  return timingSafeEqual(derivedKey, storedKey);
}
