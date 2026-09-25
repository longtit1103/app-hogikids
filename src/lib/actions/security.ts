"use server";

import { z } from "zod";

import type { ActionResult } from "@/lib/actions/action-result";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import {
  getLockoutSecondsRemaining,
  recordFailedAttempt,
  resetAttempts,
} from "@/lib/login-lockout";
import { chayNoiTiepTheoEmail, QuaNhieuLuotDangNhap } from "@/lib/login-gate";
import { hashPassword, MAX_PASSWORD_LENGTH, verifyPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";
import { createSession, docGhiNhoCuaPhien, requireUser, thuHoiMoiPhien } from "@/lib/session";

/** Ít nhất 1 chữ cái + 1 chữ số (không ràng buộc ký tự đặc biệt/hoa-thường). */
const NEW_PASSWORD_COMPLEXITY = /(?=.*[a-zA-Z])(?=.*\d)/;

/**
 * Trần dưới của mật khẩu MỚI khi đổi mật khẩu — nâng 8 → 12 ký tự (chốt 24/09). CHỈ áp cho mật
 * khẩu MỚI ở màn này: đăng nhập bằng mật khẩu CŨ ngắn hơn 12 ký tự (đặt từ trước lượt nâng trần
 * này) vẫn phải vào được — màn đăng nhập (`auth.ts`) không có ràng buộc độ dài dưới, chỉ so khớp
 * hash. Không lùi cùng lúc `MAX_PASSWORD_LENGTH` (trần TRÊN, dùng chung với đăng nhập/seed).
 */
const MIN_NEW_PASSWORD_LENGTH = 12;

/**
 * Bộ đếm khoá của màn Đổi mật khẩu PHẢI tách khỏi bộ đếm màn Đăng nhập — trước đây cả hai cùng
 * gọi `login-lockout.ts` bằng `user.email` THẬT, nên sai mật khẩu HIỆN TẠI 5 lần ở Cài đặt khoá
 * LUÔN màn Đăng nhập (chủ shop tự khoá mình dù đang thao tác đúng chỗ). `login-lockout.ts` coi
 * "email" là một chuỗi khoá bất kỳ (chỉ trim + lowercase), nên chỉ cần đưa một chuỗi khoá KHÁC
 * cho namespace này — không cần sửa `login-lockout.ts`.
 *
 * Hàng đợi nối tiếp `chayNoiTiepTheoEmail` (login-gate.ts) thì GIỮ NGUYÊN, vẫn gọi bằng
 * `user.email` thật — cố ý DÙNG CHUNG với màn đăng nhập để hai lượt kiểm mật khẩu của cùng một
 * user (đăng nhập từ thiết bị khác + đổi mật khẩu) không chồng lấn nhau qua `await`.
 */
function khoaDoiMatKhau(email: string): string {
  return `doimatkhau:${email}`;
}

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Vui lòng nhập mật khẩu hiện tại"),
    // Trần TRÊN phải dùng chung hằng số với màn đăng nhập (`MAX_PASSWORD_LENGTH`) — đặt được ở đây
    // mà đăng nhập lại chặn nghĩa là chủ shop tự khoá mình vĩnh viễn, xem ghi chú ở `password.ts`.
    newPassword: z
      .string()
      .min(MIN_NEW_PASSWORD_LENGTH, `Mật khẩu mới phải có ít nhất ${MIN_NEW_PASSWORD_LENGTH} ký tự`)
      .max(MAX_PASSWORD_LENGTH, `Mật khẩu mới tối đa ${MAX_PASSWORD_LENGTH} ký tự`)
      .regex(NEW_PASSWORD_COMPLEXITY, "Mật khẩu mới phải có cả chữ và số"),
    confirmPassword: z.string().min(1, "Vui lòng nhập lại mật khẩu mới"),
  })
  .refine((data) => data.confirmPassword === data.newPassword, {
    message: "Mật khẩu xác nhận không khớp",
    path: ["confirmPassword"],
  });

/**
 * Đổi mật khẩu đăng nhập (app 1 người dùng). Xác thực mật khẩu hiện tại
 * bằng scrypt (`verifyPassword`) trước khi ghi hash mới.
 *
 * THU HỒI MỌI PHIÊN KHÁC trong CÙNG transaction với lượt ghi hash: cookie iron-session là cookie
 * KÝ, không có bản ghi phía máy chủ, nên nếu không đẩy mốc phiên thì cookie "ghi nhớ đăng nhập" 30
 * ngày trên các thiết bị khác vẫn vào được — vô hiệu hoá chính lý do người ta đổi mật khẩu. Hai
 * lượt ghi phải cùng sống hoặc cùng chết, nếu không lỗi ở lượt thứ hai để lại đúng trạng thái tệ
 * nhất: mật khẩu mới đã có hiệu lực mà cookie cũ vẫn vào được. Thiết bị ĐANG thao tác
 * được cấp lại cookie ngay (đúng loại "ghi nhớ" mà phiên này đang dùng) nên chủ shop không bị đá
 * ra giữa chừng; mọi thiết bị khác phải đăng nhập lại.
 */
export async function changePassword(formData: FormData): Promise<ActionResult> {
  const userId = await requireUser();
  // Lượt phục hồi lùi CẢ `User.passwordHash` LẪN mốc thu hồi phiên về bản backup. Đổi mật khẩu
  // trong cửa sổ đó = chủ shop tin mật khẩu mới có hiệu lực, còn mật khẩu CŨ mới là cái vào được.
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = changePasswordSchema.safeParse({
    currentPassword: formData.get("currentPassword"),
    newPassword: formData.get("newPassword"),
    confirmPassword: formData.get("confirmPassword"),
  });

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: issue?.message ?? "Dữ liệu không hợp lệ",
      field: typeof issue?.path[0] === "string" ? issue.path[0] : undefined,
    };
  }

  const { currentPassword, newPassword } = parsed.data;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    return { ok: false, error: "Không tìm thấy người dùng" };
  }

  // Khối kiểm khoá → so mật khẩu hiện tại → ghi kết quả có ĐÚNG hình dạng đọc-rồi-ghi vắt qua
  // `await` như màn đăng nhập, nên dùng CHUNG cổng nối tiếp theo email (`login-gate.ts`) — cùng
  // một bộ đếm khoá thì phải cùng một cổng, tách ra là hở lại đúng khe vừa bịt. Rủi ro ở đây
  // thấp hơn (đòi phiên hợp lệ) nhưng dùng chung primitive rẻ hơn là giải thích vì sao ngoại lệ.
  const khoaBoDem = khoaDoiMatKhau(user.email);
  const kiemMatKhauHienTai = await chayNoiTiepTheoEmail(user.email, async () => {
    const lockedSeconds = getLockoutSecondsRemaining(khoaBoDem);
    if (lockedSeconds > 0) {
      return { ok: false as const, error: `Thử lại sau ${lockedSeconds} giây` };
    }
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      recordFailedAttempt(khoaBoDem);
      return { ok: false as const, error: "Mật khẩu hiện tại không đúng" };
    }
    // Xoá bộ đếm NGAY TẠI ĐÂY, trong cổng — giống `login()` xoá ngay sau khi xác thực xong.
    // Để tận cuối hàm (sau khi băm mật khẩu mới hàng trăm ms, ghi DB rồi cấp cookie) là mở một
    // cửa sổ rộng: một lượt đăng nhập SAI chen vào giữa sẽ bị lượt xoá muộn này thổi bay, khoá
    // 60 giây rơi về 0. Đòi phải có một lượt đổi mật khẩu thành công chạy đồng thời nên xác suất
    // thấp, nhưng cửa sổ là thật và đóng lại không tốn gì.
    resetAttempts(khoaBoDem);
    return { ok: true as const };
  }).catch((err: unknown) => {
    if (err instanceof QuaNhieuLuotDangNhap) {
      return { ok: false as const, error: "Đang có quá nhiều lượt kiểm mật khẩu. Thử lại sau ít giây." };
    }
    throw err;
  });

  if (!kiemMatKhauHienTai.ok) {
    return { ok: false, error: kiemMatKhauHienTai.error, field: "currentPassword" };
  }

  if (newPassword === currentPassword) {
    return {
      ok: false,
      error: "Mật khẩu mới phải khác mật khẩu hiện tại",
      field: "newPassword",
    };
  }

  // Đọc lựa chọn "ghi nhớ" TRƯỚC khi đẩy mốc — sau đó cookie cũ hết hiệu lực, không đọc lại được.
  const ghiNho = await docGhiNhoCuaPhien();

  // scrypt tốn hàng trăm ms — tính XONG rồi mới mở transaction, đừng giữ transaction qua nó.
  const hashMoi = await hashPassword(newPassword);

  // Hash mới + mốc thu hồi phiên phải cùng SỐNG hoặc cùng CHẾT. Tách rời thì lỗi ở lệnh thứ hai để
  // lại đúng trạng thái tệ nhất: mật khẩu mới đã có hiệu lực nhưng cookie 30 ngày trên máy khác vẫn
  // vào được, mà UI thì báo "thất bại" nên chủ shop nhập lại mật khẩu cũ và tự khoá mình ra ngoài.
  try {
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { passwordHash: hashMoi } });
      await thuHoiMoiPhien(tx);
    });
  } catch {
    return { ok: false, error: "Không lưu được mật khẩu mới — thử lại" };
  }

  // NGOÀI transaction: ghi cookie (không phải ghi DB), và phải chạy SAU khi mốc mới đã COMMIT —
  // `createSession` đọc mốc hiện hành từ DB, chạy sớm hơn là cấp một cookie vô hiệu ngay lúc sinh.
  await createSession(userId, ghiNho); // cấp lại cho ĐÚNG thiết bị đang thao tác

  return { ok: true, data: undefined };
}
