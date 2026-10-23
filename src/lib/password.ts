import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// Hằng số sống ở `do-dai-mat-khau.ts` (không kéo `node:crypto`) để form phía client dùng được; re-export
// giữ nguyên đường import cũ của phía server. Import TƯƠNG ĐỐI: file này còn được runner Playwright
// nạp trực tiếp (seed tài khoản), nơi không giải được alias `@/`.
export { MAX_PASSWORD_LENGTH } from "./do-dai-mat-khau";

/**
 * HAI định dạng hash lưu trong `User.passwordHash`:
 *
 * - Hiện hành `"s2$<N>$<saltHex>:<keyHex>"` — scrypt với N ghi NGAY TRONG hash, r=8, p=1. Ghi N vào
 *   hash để lần nâng tham số sau chỉ cần đổi `SCRYPT_N_HIEN_HANH`, hash cũ vẫn đọc được.
 * - Cũ `"<saltHex>:<keyHex>"` — scrypt mặc định của Node (N=16384, r=8, p=1). VẪN verify được; đăng
 *   nhập đúng với hash cũ thì `auth.ts` băm lại sang định dạng hiện hành (`canNangCapHash`).
 *
 * Ở CẢ HAI định dạng, salt là CHUỖI hex thô truyền thẳng vào scrypt (không bao giờ
 * `Buffer.from(salt, "hex")`) và khoá dài 64 byte — đổi một trong hai là mọi hash trong DB vô hiệu.
 * Seed (`prisma/seed-lib.ts`) và helper test gọi thẳng `hashPassword` ở đây — đừng tự băm chỗ khác.
 *
 * ROLLBACK: ảnh cũ chỉ hiểu định dạng cũ — hash `s2$…` ở ảnh cũ luôn verify SAI (tách ở dấu `:` đầu
 * tiên ra "salt" `s2$131072$<salt>`). Lùi ảnh thì tài khoản đã nâng cấp phải đặt lại hash định dạng cũ.
 */
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

/** N của định dạng cũ = mặc định `crypto.scrypt` của Node. */
const SCRYPT_N_CU = 16_384;

/**
 * N cho mọi hash mới (OWASP: 2^17). Đo 23/10/2026 trên máy dev (Node 25): ~285–293 ms/lượt, bộ nhớ
 * 128·N·r = 128 MiB/lượt. scrypt chạy trên threadpool libuv (mặc định 4 luồng) ⇒ đỉnh ~512 MiB khi 4
 * lượt chồng nhau.
 */
export const SCRYPT_N_HIEN_HANH = 131_072;

/** Tiền tố định dạng có phiên bản. Salt hex không bao giờ bắt đầu bằng `s` ⇒ không lẫn với định dạng cũ. */
const TIEN_TO_S2 = "s2$";

/** Khoảng N chấp nhận khi ĐỌC hash — chặn chuỗi hỏng/lạ đòi N khổng lồ (ăn hết RAM) hay N vô nghĩa. */
const N_DOC_TOI_THIEU = SCRYPT_N_CU;
const N_DOC_TOI_DA = 1 << 20;

/**
 * `maxmem` gấp đôi mức scrypt thật sự cần (128·N·r). Mặc định của Node chỉ 32 MiB — đủ cho N=16384
 * nhưng N=2^17 cần 128 MiB, thiếu `maxmem` là scrypt ném ngay.
 */
function maxmemCho(n: number): number {
  return 128 * n * SCRYPT_R * 2;
}

function scryptVoiN(password: string, salt: string, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      SCRYPT_KEY_LENGTH,
      { N: n, r: SCRYPT_R, p: SCRYPT_P, maxmem: maxmemCho(n) },
      (loi, khoa) => (loi ? reject(loi) : resolve(khoa)),
    );
  });
}

type HashDaTach = { n: number; salt: string; keyHex: string };

/** Tách hash lưu trữ (cả hai định dạng). Hỏng/lạ ⇒ `null`, KHÔNG ném. */
function tachHash(stored: string): HashDaTach | null {
  let n = SCRYPT_N_CU;
  let phanSaltKey = stored;

  if (stored.startsWith(TIEN_TO_S2)) {
    const sauTienTo = stored.slice(TIEN_TO_S2.length);
    const viTriDo = sauTienTo.indexOf("$");
    if (viTriDo === -1) return null;
    const chuoiN = sauTienTo.slice(0, viTriDo);
    if (!/^\d{1,8}$/.test(chuoiN)) return null;
    n = Number(chuoiN);
    // scrypt đòi N là lũy thừa của 2.
    if (n < N_DOC_TOI_THIEU || n > N_DOC_TOI_DA || (n & (n - 1)) !== 0) return null;
    phanSaltKey = sauTienTo.slice(viTriDo + 1);
  }

  const viTriHaiCham = phanSaltKey.indexOf(":");
  if (viTriHaiCham === -1) return null;
  return { n, salt: phanSaltKey.slice(0, viTriHaiCham), keyHex: phanSaltKey.slice(viTriHaiCham + 1) };
}

/** Băm mật khẩu sang định dạng hiện hành `"s2$<N>$<saltHex>:<keyHex>"`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = await scryptVoiN(password, salt, SCRYPT_N_HIEN_HANH);
  return `${TIEN_TO_S2}${SCRYPT_N_HIEN_HANH}$${salt}:${derivedKey.toString("hex")}`;
}

/**
 * So mật khẩu với hash lưu trữ (định dạng hiện hành HOẶC cũ). Dùng `timingSafeEqual`, và KHÔNG BAO
 * GIỜ ném vì hash hỏng — hash hỏng/lạ chỉ là "sai mật khẩu". Lỗi thật của scrypt (hết bộ nhớ…) vẫn
 * ném ra: nuốt nó thành "sai" là đếm oan một lượt sai vào bộ đếm khoá.
 *
 * Hash N thấp hơn hiện hành mà so SAI ⇒ bù thời gian (`buThoiGianHashCu`) trước khi trả `false`.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const tach = tachHash(stored);
  if (!tach) return false;

  const storedKey = Buffer.from(tach.keyHex, "hex");
  const derivedKey = await scryptVoiN(password, tach.salt, tach.n);

  // timingSafeEqual ném khi lệch độ dài — coi là sai mật khẩu thay vì làm sập lượt đăng nhập.
  const khop = derivedKey.length === storedKey.length && timingSafeEqual(derivedKey, storedKey);
  if (!khop) await buThoiGianHashCu(password, tach);
  return khop;
}

/**
 * Chặn ORACLE THỜI GIAN dò email có tài khoản. Email lạ được so với hash giả định dạng hiện hành
 * (N=`SCRYPT_N_HIEN_HANH`, ~300 ms — xem `DUMMY_HASH` ở `actions/auth.ts`); hash N=16384 chỉ tốn
 * ~35 ms ⇒ gõ sai cho email có thật mà còn hash cũ trả lời nhanh hơn email lạ ~250 ms, đo một lượt là
 * biết. Hash cũ CHỈ được băm lại khi đăng nhập ĐÚNG và tài khoản còn hoạt động, nên tài khoản bị khoá
 * (`isActive=false`) hay ít đăng nhập sẽ lộ mãi nếu không bù. Lượt bù chạy thêm MỘT scrypt ở N hiện
 * hành (kết quả bỏ đi) ⇒ tổng thời gian ≥ nhánh email lạ.
 *
 * CHỈ bù khi so SAI: so ĐÚNG thì người gọi đã biết mật khẩu, không còn gì để dò. Nhánh tài khoản bị
 * khoá gõ SAI cũng đi qua đây (`auth.ts` so mật khẩu TRƯỚC khi xét `isActive`). Hash hỏng (`tachHash`
 * = null) không qua đây — mọi đường ghi `User.passwordHash` đều qua `hashPassword`.
 */
async function buThoiGianHashCu(password: string, tach: HashDaTach): Promise<void> {
  if (tach.n >= SCRYPT_N_HIEN_HANH) return;
  await scryptVoiN(password, tach.salt, SCRYPT_N_HIEN_HANH);
}

/**
 * `true` khi hash hợp lệ nhưng băm bằng N thấp hơn hiện hành (gồm mọi hash định dạng cũ) — đăng nhập
 * đúng thì nên băm lại. Hash hỏng ⇒ `false` (không có gì để nâng cấp), không ném.
 */
export function canNangCapHash(stored: string): boolean {
  const tach = tachHash(stored);
  return tach !== null && tach.n < SCRYPT_N_HIEN_HANH;
}
