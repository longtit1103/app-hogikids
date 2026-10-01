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
import { matKhauMoiVaXacNhanSchema } from "@/lib/mat-khau-moi-schema";
import { ghiNhatKy, ghiNhatKyLoi } from "@/lib/nhat-ky/ghi-nhat-ky";
import { HANH_DONG } from "@/lib/nhat-ky/hanh-dong";
import { hashPassword, verifyPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";
import { congAction } from "@/lib/quyen/cong-action";
import { createSession, docGhiNhoCuaPhien, thuHoiPhienCuaNguoi } from "@/lib/session";

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

/**
 * Mật khẩu hiện tại (chỉ cần có — mật khẩu cũ ngắn hơn luật mới vẫn phải xác thực được) + cặp mật khẩu
 * mới/nhập lại theo luật CHUNG `matKhauMoiVaXacNhanSchema` (≥12 ký tự, có chữ và số, trần dùng chung với
 * đăng nhập). Vế trái đứng trước ⇒ ô hiện tại trống báo lỗi trước các ô mật khẩu mới.
 */
const changePasswordSchema = z
  .object({ currentPassword: z.string().min(1, "Vui lòng nhập mật khẩu hiện tại") })
  .and(matKhauMoiVaXacNhanSchema);

/**
 * Dòng `User` đã đổi trạng thái (bị thu hồi phiên / reset / khoá) kể từ lúc cookie đang gọi được cấp
 * — phát hiện DƯỚI khoá dòng, trong transaction.
 */
class TrangThaiDaDoi extends Error {}

const LOI_TRANG_THAI_DA_DOI = "Trạng thái tài khoản đã đổi, đăng nhập lại";

/**
 * Đổi mật khẩu của CHÍNH người đang đăng nhập (không cần quyền module). Xác thực mật khẩu hiện tại
 * bằng scrypt (`verifyPassword`) trước khi ghi hash mới.
 *
 * THU HỒI MỌI PHIÊN KHÁC CỦA NGƯỜI NÀY trong CÙNG transaction với lượt ghi hash: cookie iron-session
 * là cookie KÝ, không có bản ghi phía máy chủ, nên nếu không đổi epoch thì cookie "ghi nhớ đăng
 * nhập" 30 ngày trên các thiết bị khác vẫn vào được — vô hiệu hoá chính lý do người ta đổi mật khẩu.
 * Hash + epoch + nhật ký cùng sống hoặc cùng chết. Thiết bị ĐANG thao tác được cấp lại cookie từ
 * epoch transaction TRẢ RA (không đọc lại ngữ cảnh đã cache), đúng loại "ghi nhớ" phiên này dùng.
 *
 * Khe đua: transaction `SELECT … FOR UPDATE` dòng user rồi đối chiếu `sessionEpoch` với epoch của
 * cookie đang gọi. Một lượt đổi mật khẩu/reset/khoá khác đã commit trước ⇒ epoch lệch ⇒
 * `TRANG_THAI_DA_DOI`, không ghi gì — hai lượt đổi đồng thời chỉ một lượt thắng.
 */
export async function changePassword(formData: FormData): Promise<ActionResult> {
  const cong = await congAction();
  if (!cong.ok) return cong;
  const nguoiDung = cong.nguoiDung;
  const actor = { id: nguoiDung.id, email: nguoiDung.email };
  // Lượt phục hồi lùi CẢ `User.passwordHash` LẪN epoch phiên về bản backup. Đổi mật khẩu trong cửa
  // sổ đó = người dùng tin mật khẩu mới có hiệu lực, còn mật khẩu CŨ mới là cái vào được.
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

  const user = await prisma.user.findUnique({ where: { id: nguoiDung.id } });
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
      return { ok: false as const, error: "Mật khẩu hiện tại không đúng", saiMatKhau: true };
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
    // Ghi nhật ký lượt sai mật khẩu thật; lượt bị khoá tạm/hàng đợi đầy là chặn tần suất, không ghi.
    if ("saiMatKhau" in kiemMatKhauHienTai) {
      await ghiNhatKyLoi({ actor, hanhDong: HANH_DONG.DOI_MAT_KHAU, ghiChu: { lyDo: "sai mật khẩu hiện tại" } });
    }
    return { ok: false, error: kiemMatKhauHienTai.error, field: "currentPassword" };
  }

  if (newPassword === currentPassword) {
    return {
      ok: false,
      error: "Mật khẩu mới phải khác mật khẩu hiện tại",
      field: "newPassword",
    };
  }

  // Đọc lựa chọn "ghi nhớ" TRƯỚC khi đổi epoch — sau đó cookie cũ hết hiệu lực, không đọc lại được.
  const ghiNho = await docGhiNhoCuaPhien();

  // scrypt tốn hàng trăm ms — tính XONG rồi mới mở transaction, đừng giữ transaction (và khoá dòng)
  // qua nó.
  const hashMoi = await hashPassword(newPassword);

  let mocMoi: string;
  try {
    mocMoi = await prisma.$transaction(async (tx) => {
      const [dong] = await tx.$queryRaw<{ sessionEpoch: string; mustChangePassword: boolean; isActive: boolean }[]>`
        SELECT "sessionEpoch", "mustChangePassword", "isActive" FROM "User" WHERE "id" = ${nguoiDung.id} FOR UPDATE`;
      // Epoch lệch cookie đang gọi (đổi mật khẩu nơi khác / reset / khoá đã commit trước), chủ shop
      // vừa bật "phải đổi mật khẩu", hoặc tài khoản vừa bị khoá ⇒ không ghi đè lên trạng thái mới hơn.
      // Soi `isActive` trực tiếp chứ không trông vào việc lượt khoá có đổi epoch hay không.
      if (!dong || dong.sessionEpoch !== nguoiDung.mocPhien || dong.mustChangePassword || !dong.isActive) {
        throw new TrangThaiDaDoi();
      }
      await tx.user.update({ where: { id: nguoiDung.id }, data: { passwordHash: hashMoi } });
      const moc = await thuHoiPhienCuaNguoi(tx, nguoiDung.id);
      await ghiNhatKy(tx, { actor, hanhDong: HANH_DONG.DOI_MAT_KHAU });
      return moc;
    });
  } catch (loi) {
    if (loi instanceof TrangThaiDaDoi) {
      await ghiNhatKyLoi({ actor, hanhDong: HANH_DONG.DOI_MAT_KHAU, ghiChu: { lyDo: "TRANG_THAI_DA_DOI" } });
      return { ok: false, error: LOI_TRANG_THAI_DA_DOI, code: "TRANG_THAI_DA_DOI" };
    }
    console.error("[security] Không lưu được mật khẩu mới:", loi);
    await ghiNhatKyLoi({ actor, hanhDong: HANH_DONG.DOI_MAT_KHAU, ghiChu: { lyDo: "lỗi lưu" } });
    return { ok: false, error: "Không lưu được mật khẩu mới — thử lại" };
  }

  // NGOÀI transaction (ghi cookie, không ghi DB) và SAU khi epoch mới đã COMMIT: cookie mang đúng
  // epoch transaction trả ra — cấp cho ĐÚNG thiết bị đang thao tác.
  await createSession(nguoiDung.id, ghiNho, mocMoi);

  return { ok: true, data: undefined };
}
