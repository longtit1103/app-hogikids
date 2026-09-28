"use server";

import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { chayNoiTiepTheoEmail, QuaNhieuLuotDangNhap } from "@/lib/login-gate";
import { MAX_PASSWORD_LENGTH, verifyPassword } from "@/lib/password";
import { createSession, destroySession } from "@/lib/session";
import {
  getLockoutSecondsRemaining,
  recordFailedAttempt,
  resetAttempts,
} from "@/lib/login-lockout";
import type { ActionResult } from "@/lib/actions/action-result";

/**
 * Same message for "no such email" and "wrong password" — a single-user app
 * has no legitimate reason to tell a caller which one was wrong (no user
 * enumeration).
 */
const INVALID_CREDENTIALS_ERROR = "Email hoặc mật khẩu không đúng";

/**
 * Chạm trần hàng đợi của một email (xem `login-gate.ts`). Nói "thử lại sau" chứ KHÔNG nói sai
 * mật khẩu — lượt này chưa hề được kiểm. Người dùng thật gần như không bao giờ gặp: phải có ≥5
 * lượt đăng nhập cùng email cùng lúc.
 */
const LOI_QUA_NHIEU_LUOT = "Đang có quá nhiều lượt đăng nhập cho email này. Thử lại sau ít giây.";

/**
 * A syntactically-valid stored hash (`"<saltHex>:<derivedKeyHex>"`, matching
 * `src/lib/password.ts` / `prisma/seed.ts`'s format exactly: 32 hex chars =
 * 16-byte salt, 128 hex chars = 64-byte key) that no real password can ever
 * produce a matching derived key for. Used ONLY as the `verifyPassword`
 * argument when no user row was found, so a login attempt for a
 * non-existent email still runs the full scrypt computation instead of
 * short-circuiting — otherwise the missing-user path would return
 * measurably faster than a wrong-password path, letting a caller time
 * responses to enumerate which emails have an account.
 */
const DUMMY_HASH = `${"0".repeat(32)}:${"0".repeat(128)}`;

// Giới hạn độ dài để một request không thể nhồi chuỗi khổng lồ vào scrypt
// (verifyPassword) hay câu truy vấn DB — 254 là trần email theo RFC 5321.
// Trần mật khẩu lấy từ `MAX_PASSWORD_LENGTH` dùng CHUNG với màn đổi mật khẩu:
// hai nơi khai hai số khác nhau là chủ shop tự khoá mình vĩnh viễn (xem ghi
// chú ở `password.ts`). Vượt trần chỉ rớt về nhánh safeParse thất bại bên
// dưới, dùng CHUNG thông báo lỗi INVALID_CREDENTIALS_ERROR — không được lộ ra
// là do "quá dài" (dò tài khoản).
const loginSchema = z.object({
  email: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
    z.email().max(254)
  ),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

/**
 * Authenticates the single app user against the seeded/DB-stored scrypt
 * hash. Lockout is keyed by normalized email (see `login-lockout.ts`) — 5
 * consecutive failures block that account for 60s.
 */
export async function login(formData: FormData): Promise<ActionResult> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { ok: false, error: INVALID_CREDENTIALS_ERROR };
  }

  const { email, password } = parsed.data;
  const remember = formData.get("remember") === "on";

  // TOÀN BỘ khối kiểm khoá → tra DB → so mật khẩu → ghi kết quả phải nằm TRONG cổng nối tiếp:
  // đó là một chuỗi đọc-rồi-ghi vắt qua hai lệnh `await`, để hở thì các lượt chạy song song đều
  // đọc "chưa khoá" trước khi lượt đầu tiên kịp ghi (đo thật: 1000 request đồng thời ⇒ 1000 lượt
  // đoán, 0 bị chặn). Xem `login-gate.ts`.
  let ketQua: { ok: false; error: string; code?: "LOCKED" } | { ok: true; userId: string };
  try {
    ketQua = await chayNoiTiepTheoEmail(email, async () => {
      return kiemMatKhauDangNhap(email, password);
    });
  } catch (err) {
    if (err instanceof QuaNhieuLuotDangNhap) {
      // Fail-closed: chạm trần hàng đợi thì TỪ CHỐI, không xếp thêm. Dùng chung mã "LOCKED" với
      // lượt khoá thật để màn đăng nhập xử lý y hệt và không lộ ra đây là nhánh nào.
      return { ok: false, error: LOI_QUA_NHIEU_LUOT, code: "LOCKED" };
    }
    throw err;
  }

  if (!ketQua.ok) return ketQua;

  // NGOÀI cổng: ghi cookie không đụng tới bộ đếm khoá, giữ đoạn nối tiếp ngắn nhất có thể.
  await createSession(ketQua.userId, remember);
  return { ok: true, data: undefined };
}

/**
 * Một lượt kiểm mật khẩu HOÀN CHỈNH cho `email`. CHỈ được gọi bên trong `chayNoiTiepTheoEmail`
 * — tách ra để thấy rõ ranh giới đoạn phải bất khả phân, không phải để dùng lại chỗ khác.
 */
async function kiemMatKhauDangNhap(
  email: string,
  password: string
): Promise<{ ok: false; error: string; code?: "LOCKED" } | { ok: true; userId: string }> {
  const lockedSeconds = getLockoutSecondsRemaining(email);
  if (lockedSeconds > 0) {
    return {
      ok: false,
      error: `Tài khoản tạm khóa do đăng nhập sai nhiều lần. Thử lại sau ${lockedSeconds} giây.`,
      code: "LOCKED",
    };
  }

  // Case-insensitive match: the stored User.email may differ in casing from
  // what the user types, even after our own lowercasing above.
  const khopHoaThuong = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
  });

  // `mode: "insensitive"` được Prisma dịch thành `ILIKE`, mà ILIKE coi `_` là KÝ TỰ ĐẠI DIỆN
  // (khớp 1 ký tự bất kỳ) — chuỗi người dùng gõ đi thẳng vào đó, KHÔNG được escape. Đo thật trên
  // DB: `_____@hogikids.test` khớp đúng tài khoản `admin@hogikids.test`. Hai hậu quả, cái sau
  // nặng hơn:
  //  1. Đăng nhập được bằng một email KHÔNG TỒN TẠI (vẫn phải đúng mật khẩu, nhưng phiên cấp ra
  //     là của tài khoản thật).
  //  2. NGHIÊM TRỌNG HƠN — khoá chống dò mật khẩu bị vô hiệu: khoá lockout là CHUỖI NGƯỜI DÙNG
  //     GÕ, nên mỗi biến thể `_` là một bộ đếm RIÊNG. Local part n ký tự ⇒ 2^n bộ đếm độc lập,
  //     mỗi cái được 5 lượt sai; `admin@…` đang bị khoá thì `_dmin@…` vẫn thoải mái. Kẻ tấn công
  //     thậm chí không cần biết email, chỉ cần tên miền và độ dài.
  // Vì vậy: kết quả truy vấn CHỈ được coi là tìm thấy khi email thật khớp ĐÚNG chuỗi đã gõ (so
  // sau khi cùng chuẩn hoá) — vẫn giữ nguyên ý đồ khớp không phân biệt hoa/thường.
  const user =
    khopHoaThuong && khopHoaThuong.email.trim().toLowerCase() === email ? khopHoaThuong : null;

  // Always run verifyPassword — against the real hash when the user exists,
  // against DUMMY_HASH otherwise — so both branches pay the same scrypt cost
  // and this check can't be used as a timing oracle for account existence.
  const passwordMatches = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !passwordMatches) {
    // Bộ đếm CHỈ nhích khi mật khẩu THỰC SỰ sai — giữ đúng ngữ nghĩa "5 lần thất bại".
    recordFailedAttempt(email);
    return { ok: false, error: INVALID_CREDENTIALS_ERROR };
  }

  resetAttempts(email);
  return { ok: true, userId: user.id };
}

/** Ends this device's session. */
export async function logout(): Promise<ActionResult> {
  await destroySession();
  return { ok: true, data: undefined };
}
