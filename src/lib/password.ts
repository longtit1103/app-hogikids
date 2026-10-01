import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

// Hằng số sống ở `do-dai-mat-khau.ts` (không kéo `node:crypto`) để form phía client dùng được; re-export
// giữ nguyên đường import cũ của phía server. Import TƯƠNG ĐỐI: file này còn được runner Playwright
// nạp trực tiếp (seed tài khoản), nơi không giải được alias `@/`.
export { MAX_PASSWORD_LENGTH } from "./do-dai-mat-khau";

/**
 * Key length + salt encoding are part of the STORED hash format: the salt is
 * the raw hex STRING itself passed straight into `scrypt` (never
 * `Buffer.from(salt, "hex")`). Changing either invalidates every existing
 * hash in the DB. The seed (`prisma/seed-lib.ts`) and test helpers call this
 * module's `hashPassword` directly — do not re-implement hashing elsewhere.
 */
const SCRYPT_KEY_LENGTH = 64;

/** Hashes a plaintext password into the stored `"<saltHex>:<derivedKeyHex>"` format. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = (await scrypt(password, salt, SCRYPT_KEY_LENGTH)) as Buffer;
  return `${salt}:${derivedKey.toString("hex")}`;
}

/**
 * Verifies a plaintext password against a stored `"<saltHex>:<derivedKeyHex>"`
 * hash (as produced by `hashPassword`). Uses
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

  // Salt is passed to scrypt as the raw hex STRING (matching `hashPassword`) — do
  // NOT hex-decode it into a Buffer here.
  const derivedKey = (await scrypt(password, salt, SCRYPT_KEY_LENGTH)) as Buffer;

  if (derivedKey.length !== storedKey.length) {
    // timingSafeEqual throws on length mismatch — treat as "wrong password"
    // instead of letting a malformed/foreign hash crash the login flow.
    return false;
  }

  return timingSafeEqual(derivedKey, storedKey);
}
