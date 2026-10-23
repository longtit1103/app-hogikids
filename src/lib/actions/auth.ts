"use server";

import { headers } from "next/headers";
import { z } from "zod";

import { docIpCloudflare, ghiLuotSaiTheoIp, giayConKhoaTheoIp } from "@/lib/auth/khoa-dang-nhap-theo-ip";
import { dangPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { chuanHoaEmail } from "@/lib/chuan-hoa-email";
import { prisma } from "@/lib/prisma";
import { chayNoiTiepTheoEmail, QuaNhieuLuotDangNhap } from "@/lib/login-gate";
import { ghiNhatKy, ghiNhatKyLoi } from "@/lib/nhat-ky/ghi-nhat-ky";
import { HANH_DONG } from "@/lib/nhat-ky/hanh-dong";
import {
  canNangCapHash,
  hashPassword,
  MAX_PASSWORD_LENGTH,
  SCRYPT_N_HIEN_HANH,
  verifyPassword,
} from "@/lib/password";
import { docNguoiDungPhien, type NguoiDung } from "@/lib/quyen/nguoi-dung-phien";
import { createSession, destroySession } from "@/lib/session";
import {
  getLockoutSecondsRemaining,
  recordFailedAttempt,
  resetAttempts,
} from "@/lib/login-lockout";
import type { ActionResult } from "@/lib/actions/action-result";

/**
 * Same message for "no such email" and "wrong password" — the app has no
 * legitimate reason to tell a caller which one was wrong (no user
 * enumeration). Tài khoản bị khoá mà gõ SAI mật khẩu cũng nhận đúng thông báo này.
 */
const INVALID_CREDENTIALS_ERROR = "Email hoặc mật khẩu không đúng";

/**
 * Chỉ trả khi mật khẩu ĐÚNG — người biết mật khẩu mới được biết tài khoản đã bị chủ shop khoá, nên
 * không mở đường dò tài khoản.
 */
const LOI_TAI_KHOAN_BI_KHOA = "Tài khoản đã bị khoá, liên hệ chủ shop";

/**
 * Chạm trần hàng đợi của một email (xem `login-gate.ts`). Nói "thử lại sau" chứ KHÔNG nói sai
 * mật khẩu — lượt này chưa hề được kiểm. Người dùng thật gần như không bao giờ gặp: phải có ≥5
 * lượt đăng nhập cùng email cùng lúc.
 */
const LOI_QUA_NHIEU_LUOT = "Đang có quá nhiều lượt đăng nhập cho email này. Thử lại sau ít giây.";

/**
 * A syntactically-valid stored hash in the CURRENT `hashPassword` format
 * (`"s2$<N>$<saltHex>:<derivedKeyHex>"`: 32 hex chars = 16-byte salt, 128 hex
 * chars = 64-byte key) that no real password can ever produce a matching
 * derived key for. Used ONLY as the `verifyPassword` argument when no user row
 * was found, so a login attempt for a non-existent email still runs the full
 * scrypt computation instead of short-circuiting — otherwise the missing-user
 * path would return measurably faster than a wrong-password path, letting a
 * caller time responses to enumerate which emails have an account.
 *
 * PHẢI cùng N với `hashPassword` hiện hành (đọc từ `SCRYPT_N_HIEN_HANH`): N lệch là chi phí scrypt lệch
 * hàng trăm ms giữa nhánh "không có email" và nhánh "sai mật khẩu". Tài khoản còn hash ĐỊNH DẠNG CŨ
 * (N=16384, kể cả tài khoản bị khoá không bao giờ được băm lại) gõ sai thì `verifyPassword` tự chạy
 * thêm một lượt scrypt ở N hiện hành để không trả lời nhanh hơn email lạ (`buThoiGianHashCu`).
 */
const DUMMY_HASH = `s2$${SCRYPT_N_HIEN_HANH}$${"0".repeat(32)}:${"0".repeat(128)}`;

// Giới hạn độ dài để một request không thể nhồi chuỗi khổng lồ vào scrypt
// (verifyPassword) hay câu truy vấn DB — 254 là trần email theo RFC 5321.
// Trần mật khẩu lấy từ `MAX_PASSWORD_LENGTH` dùng CHUNG với màn đổi mật khẩu:
// hai nơi khai hai số khác nhau là chủ shop tự khoá mình vĩnh viễn (xem ghi
// chú ở `password.ts`). Vượt trần chỉ rớt về nhánh safeParse thất bại bên
// dưới, dùng CHUNG thông báo lỗi INVALID_CREDENTIALS_ERROR — không được lộ ra
// là do "quá dài" (dò tài khoản).
const loginSchema = z.object({
  email: z.preprocess(
    (value) => (typeof value === "string" ? chuanHoaEmail(value) : value),
    z.email().max(254)
  ),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

/** Kết quả một lượt kiểm trong cổng nối tiếp — nội bộ, KHÔNG trả thẳng cho client. */
type KetQuaKiemMatKhau =
  | { ok: false; loai: "KHOA_TAM"; error: string }
  | { ok: false; loai: "SAI"; emailTonTai: boolean }
  | {
      ok: true;
      userId: string;
      email: string;
      sessionEpoch: string;
      isActive: boolean;
      /** Hash vừa xác thực, CHỈ khi nó là định dạng/tham số cũ cần băm lại; còn lại `null`. */
      hashCanNangCap: string | null;
    };

/**
 * IP client từ `cf-connecting-ip` (xem `khoa-dang-nhap-theo-ip.ts`). Ngoài request scope (test gọi
 * thẳng action, script) `headers()` ném — coi như không có IP: lớp khoá theo IP tự tắt, khoá theo email
 * vẫn chạy đủ.
 */
async function docIpDangNhap(): Promise<string | null> {
  try {
    return docIpCloudflare(await headers());
  } catch {
    return null;
  }
}

/**
 * Đăng nhập bằng email + mật khẩu (scrypt). Lockout theo email đã chuẩn hoá (xem `login-lockout.ts`)
 * — 5 lần sai liên tiếp khoá email đó 60 giây; thêm lớp phụ theo IP client (`cf-connecting-ip`, 20 lượt
 * sai ⇒ khoá IP 5 phút, xem `khoa-dang-nhap-theo-ip.ts`). Hash định dạng cũ được băm lại sau lượt đúng.
 *
 * Cookie mang epoch của ĐÚNG dòng `User` đã so hash (không đọc lại DB): một lượt reset/khoá chen vào
 * giữa lúc xác thực và lúc cấp cookie ⇒ cookie mang epoch cũ ⇒ request kế tiếp bị từ chối.
 */
export async function login(formData: FormData): Promise<ActionResult> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    // Không ghi nhật ký lỗi dữ liệu form (nhiễu, và chưa có email hợp lệ để ghi).
    return { ok: false, error: INVALID_CREDENTIALS_ERROR };
  }

  const { email, password } = parsed.data;
  const remember = formData.get("remember") === "on";
  const ip = await docIpDangNhap();

  // TOÀN BỘ khối kiểm khoá → tra DB → so mật khẩu → ghi kết quả phải nằm TRONG cổng nối tiếp:
  // đó là một chuỗi đọc-rồi-ghi vắt qua hai lệnh `await`, để hở thì các lượt chạy song song đều
  // đọc "chưa khoá" trước khi lượt đầu tiên kịp ghi (đo thật: 1000 request đồng thời ⇒ 1000 lượt
  // đoán, 0 bị chặn). Xem `login-gate.ts`.
  let ketQua: KetQuaKiemMatKhau;
  try {
    ketQua = await chayNoiTiepTheoEmail(email, async () => {
      return kiemMatKhauDangNhap(email, password, ip);
    });
  } catch (err) {
    if (err instanceof QuaNhieuLuotDangNhap) {
      // Fail-closed: chạm trần hàng đợi thì TỪ CHỐI, không xếp thêm. Dùng chung mã "LOCKED" với
      // lượt khoá thật để màn đăng nhập xử lý y hệt và không lộ ra đây là nhánh nào.
      return { ok: false, error: LOI_QUA_NHIEU_LUOT, code: "LOCKED" };
    }
    throw err;
  }

  // Mọi nhật ký ghi NGOÀI cổng nối tiếp (giữ đoạn bất khả phân ngắn nhất) và bỏ qua khi đang phục
  // hồi DB: schema đích đang bị thay, dòng ghi lúc này hoặc lỗi hoặc bị bản backup lùi mất.
  const ghiDuocDb = !dangPhucHoi();

  if (!ketQua.ok) {
    if (ketQua.loai === "KHOA_TAM") return { ok: false, error: ketQua.error, code: "LOCKED" };
    // CHỈ ghi khi email CÓ tài khoản: số dòng khi đó bị chốt khoá theo email chặn trên (≤ 5 dòng/phút
    // mỗi tài khoản thật, bất kể bao nhiêu IP). Kẻ rải lượt thì mỗi lượt một email lạ mới — trần "1 dòng
    // mỗi email lạ mỗi phút" không chặn được kiểu đó (email mới nào cũng được một dòng), chỉ thêm một
    // Map phải dọn; bỏ hẳn mới chặn được bảng AuditLog phình. Thông báo trả về y hệt hai nhánh — không
    // lộ tài khoản; email là danh tính KHAI, không phải actor.
    if (ghiDuocDb && ketQua.emailTonTai) {
      await ghiNhatKyLoi({ danhTinhKhaiBao: email, hanhDong: HANH_DONG.DANG_NHAP_SAI });
    }
    return { ok: false, error: INVALID_CREDENTIALS_ERROR };
  }

  const actor = { id: ketQua.userId, email: ketQua.email };
  if (!ketQua.isActive) {
    if (ghiDuocDb) await ghiNhatKyLoi({ actor, hanhDong: HANH_DONG.DANG_NHAP_BI_KHOA });
    return { ok: false, error: LOI_TAI_KHOAN_BI_KHOA, code: "BI_KHOA" };
  }

  await createSession(ketQua.userId, remember, ketQua.sessionEpoch);
  await ghiDauVetDangNhapThanhCong(actor);
  await nangCapHashMatKhau(ketQua.userId, ketQua.hashCanNangCap, password);
  return { ok: true, data: undefined };
}

/**
 * Băm lại mật khẩu sang tham số scrypt hiện hành khi hash lưu trữ còn định dạng/tham số cũ — chỉ lúc
 * đăng nhập ĐÚNG mới có mật khẩu thô để băm. BEST-EFFORT, NGOÀI cổng nối tiếp (lượt băm ~300 ms không
 * được kéo dài đoạn bất khả phân): phiên đã cấp, ghi hỏng chỉ log, lần đăng nhập sau thử lại.
 *
 * So-rồi-đổi (`updateMany` khớp CẢ hash cũ): có lượt đổi/đặt lại mật khẩu chen vào giữa lúc xác thực
 * và lúc ghi thì dòng đã mang hash MỚI — ghi đè là hồi sinh mật khẩu cũ. Khớp 0 dòng ⇒ bỏ qua.
 * KHÔNG đụng `sessionEpoch`: cùng một mật khẩu, không có lý do thu hồi phiên nào.
 * Bỏ qua khi đang phục hồi DB (cùng luật `ghiDauVetDangNhapThanhCong`).
 */
async function nangCapHashMatKhau(userId: string, hashCu: string | null, password: string): Promise<void> {
  if (hashCu === null || dangPhucHoi()) return;
  try {
    const hashMoi = await hashPassword(password);
    await prisma.user.updateMany({
      where: { id: userId, passwordHash: hashCu },
      data: { passwordHash: hashMoi },
    });
  } catch (loi) {
    console.error("[auth] Không nâng cấp được hash mật khẩu:", loi);
  }
}

/**
 * `lastLoginAt` + nhật ký `DANG_NHAP_OK` — BEST-EFFORT: phiên đã cấp, dấu vết hỏng không được biến
 * lượt đăng nhập đúng thành lỗi. Cùng một transaction để hai dấu vết không lệch nhau.
 *
 * Tự bỏ qua khi đang phục hồi DB (không chặn cả lượt đăng nhập như các action ghi khác: chặn đăng
 * nhập không giữ thêm dữ liệu nào, còn dòng ghi lúc schema đang bị thay thì hoặc lỗi hoặc bị bản
 * backup lùi mất). Vì thế `auth.login` vẫn nằm nhóm không-chặn của lưới `khoa-bao-tri-duong-ghi`.
 */
async function ghiDauVetDangNhapThanhCong(actor: { id: string; email: string }): Promise<void> {
  if (dangPhucHoi()) return;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: actor.id }, data: { lastLoginAt: new Date() } });
      await ghiNhatKy(tx, { actor, hanhDong: HANH_DONG.DANG_NHAP_OK });
    });
  } catch (loi) {
    console.error("[auth] Không ghi được lastLoginAt/nhật ký đăng nhập:", loi);
  }
}

/**
 * Một lượt kiểm mật khẩu HOÀN CHỈNH cho `email`. CHỈ được gọi bên trong `chayNoiTiepTheoEmail`
 * — tách ra để thấy rõ ranh giới đoạn phải bất khả phân, không phải để dùng lại chỗ khác.
 *
 * `sessionEpoch`/`isActive` lấy từ CHÍNH dòng đã so hash (cùng một lượt `findUnique`) — đọc lại ở
 * bước sau là mở khe cho reset/khoá chen giữa. Tài khoản bị khoá mà mật khẩu ĐÚNG không nhích bộ
 * đếm lockout (không phải lượt đoán sai).
 */
async function kiemMatKhauDangNhap(
  email: string,
  password: string,
  ip: string | null,
): Promise<KetQuaKiemMatKhau> {
  // Lớp IP xét TRƯỚC: IP đang khoá thì không tốn scrypt, không chạm DB, không ghi nhật ký. Thông báo
  // mang ĐÚNG MỘT con số (giây) — màn đăng nhập đọc số đầu tiên trong thông báo để đếm ngược.
  const giayKhoaIp = ip === null ? 0 : giayConKhoaTheoIp(ip);
  if (giayKhoaIp > 0) {
    return {
      ok: false,
      loai: "KHOA_TAM",
      error: `Quá nhiều lượt đăng nhập sai từ mạng này. Thử lại sau ${giayKhoaIp} giây.`,
    };
  }

  const lockedSeconds = getLockoutSecondsRemaining(email);
  if (lockedSeconds > 0) {
    return {
      ok: false,
      loai: "KHOA_TAM",
      error: `Tài khoản tạm khóa do đăng nhập sai nhiều lần. Thử lại sau ${lockedSeconds} giây.`,
    };
  }

  // Tra CHÍNH XÁC trên email đã chuẩn hoá (`chuanHoaEmail`, ở schema phía trên): mọi đường ghi
  // `User.email` đều lưu dạng chuẩn hoá (DB có unique `lower(email)`), nên không cần so không phân
  // biệt hoa/thường ở DB. TUYỆT ĐỐI không quay lại `mode: "insensitive"`: Prisma dịch thành `ILIKE`,
  // mà ILIKE coi `_`/`%` là KÝ TỰ ĐẠI DIỆN — chuỗi người dùng gõ đi thẳng vào đó. Có nhiều tài khoản
  // thì `kho_1@…` khớp cả `khoa1@…`, `findFirst` trả nhầm dòng ⇒ chủ nhân `kho_1` đúng mật khẩu vẫn
  // bị báo sai rồi tự bị khoá tạm; và mỗi biến thể `_` là một bộ đếm lockout riêng (dò mật khẩu
  // lách khoá). Test: `tests/auth-login-tai-khoan-khoa.integration.test.ts`.
  const user = await prisma.user.findUnique({ where: { email } });

  // Always run verifyPassword — against the real hash when the user exists,
  // against DUMMY_HASH otherwise — so both branches pay the same scrypt cost
  // and this check can't be used as a timing oracle for account existence.
  const passwordMatches = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !passwordMatches) {
    // Bộ đếm CHỈ nhích khi mật khẩu THỰC SỰ sai — giữ đúng ngữ nghĩa "5 lần thất bại".
    recordFailedAttempt(email);
    if (ip !== null) ghiLuotSaiTheoIp(ip);
    return { ok: false, loai: "SAI", emailTonTai: user !== null };
  }

  // Đăng nhập đúng KHÔNG xoá bộ đếm IP (xem `khoa-dang-nhap-theo-ip.ts`).
  resetAttempts(email);
  return {
    ok: true,
    userId: user.id,
    email: user.email,
    sessionEpoch: user.sessionEpoch,
    isActive: user.isActive,
    hashCanNangCap: canNangCapHash(user.passwordHash) ? user.passwordHash : null,
  };
}

/**
 * Ends this device's session. Đọc ngữ cảnh TRƯỚC khi xoá cookie để nhật ký biết ai đăng xuất; mọi
 * lỗi đọc/ghi nhật ký đều nuốt — đăng xuất không bao giờ được thất bại vì DB.
 */
export async function logout(): Promise<ActionResult> {
  let nguoiDung: NguoiDung | null = null;
  try {
    nguoiDung = await docNguoiDungPhien();
  } catch (loi) {
    console.error("[auth] Không đọc được ngữ cảnh khi đăng xuất:", loi);
  }

  await destroySession();

  if (nguoiDung && !dangPhucHoi()) {
    try {
      await ghiNhatKy(prisma, {
        actor: { id: nguoiDung.id, email: nguoiDung.email },
        hanhDong: HANH_DONG.DANG_XUAT,
      });
    } catch (loi) {
      console.error("[auth] Không ghi được nhật ký đăng xuất:", loi);
    }
  }
  return { ok: true, data: undefined };
}
