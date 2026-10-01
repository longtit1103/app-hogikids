"use server";

/**
 * Đổi mật khẩu LẦN ĐẦU (sau khi chủ shop tạo tài khoản / đặt lại mật khẩu) — spec phân quyền §3.2, §6.
 *
 * CỐ Ý không qua `congAction`: cả 3 cổng từ chối người đang `phaiDoiMatKhau` (spec §3.3), còn đây là
 * đường DUY NHẤT để thoát trạng thái đó (allowlist lưới `tests/luoi/cong-bat-buoc.test.ts`). Thay cổng,
 * hàm tự đọc `docNguoiDungPhien()` và đòi đúng `phaiDoiMatKhau === true`.
 */
import type { ActionResult } from "@/lib/actions/action-result";
import { mapZodError } from "@/lib/actions/map-zod-error";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { matKhauMoiVaXacNhanSchema } from "@/lib/mat-khau-moi-schema";
import { ghiNhatKy, ghiNhatKyLoi } from "@/lib/nhat-ky/ghi-nhat-ky";
import { HANH_DONG } from "@/lib/nhat-ky/hanh-dong";
import { hashPassword, verifyPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";
import { createSession, docGhiNhoCuaPhien, thuHoiPhienCuaNguoi } from "@/lib/session";

/** Dòng `User` đã đổi trạng thái kể từ lúc cookie đang gọi được cấp — phát hiện DƯỚI khoá dòng. */
class TrangThaiDaDoi extends Error {}

const LOI_TRANG_THAI_DA_DOI = "Trạng thái tài khoản đã đổi, đăng nhập lại";

/**
 * Form: `newPassword`, `confirmPassword` (luật `mat-khau-moi-schema.ts`; phải khác mật khẩu tạm — chủ
 * shop đã thấy mật khẩu tạm).
 *
 * Khe đua (spec §3.2): transaction `SELECT … FOR UPDATE` dòng user rồi đối chiếu `sessionEpoch` với
 * epoch của cookie đang gọi + cờ `mustChangePassword` vẫn bật + tài khoản còn hoạt động. Lệch (đổi lần
 * đầu ở tab khác đã thắng, chủ shop vừa đặt lại/khoá) ⇒ `TRANG_THAI_DA_DOI`, không ghi gì. Ghi hash +
 * bỏ cờ + epoch mới cùng transaction với nhật ký; cookie cấp lại từ epoch transaction TRẢ RA, đúng
 * loại "ghi nhớ" phiên này đang dùng.
 */
export async function doiMatKhauLanDau(formData: FormData): Promise<ActionResult> {
  const nd = await docNguoiDungPhien();
  if (!nd) return { ok: false, error: "Phiên đăng nhập đã hết hạn — đăng nhập lại", code: "CHUA_DANG_NHAP" };
  if (!nd.phaiDoiMatKhau) {
    return { ok: false, error: "Tài khoản không ở trạng thái cần đổi mật khẩu", code: "KHONG_CO_QUYEN" };
  }
  // Lượt phục hồi lùi cả hash lẫn epoch về bản backup — đổi mật khẩu lúc này là người dùng tin mật
  // khẩu mới có hiệu lực trong khi mật khẩu tạm cũ mới là cái vào được.
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };
  const actor = { id: nd.id, email: nd.email };

  const parsed = matKhauMoiVaXacNhanSchema.safeParse({
    newPassword: formData.get("newPassword"),
    confirmPassword: formData.get("confirmPassword"),
  });
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  const { newPassword } = parsed.data;

  // Đọc hash NGOÀI khoá (scrypt chậm): hash có đổi sau lượt đọc này thì epoch cũng đã đổi (mọi đường
  // ghi hash đều thu hồi phiên) ⇒ đối chiếu dưới khoá dòng bên dưới vẫn chặn được.
  const hienTai = await prisma.user.findUnique({ where: { id: nd.id }, select: { passwordHash: true } });
  if (!hienTai) return { ok: false, error: LOI_TRANG_THAI_DA_DOI, code: "TRANG_THAI_DA_DOI" };
  if (await verifyPassword(newPassword, hienTai.passwordHash)) {
    return { ok: false, error: "Mật khẩu mới phải khác mật khẩu tạm", field: "newPassword" };
  }

  // Đọc lựa chọn "ghi nhớ" TRƯỚC khi đổi epoch — sau đó cookie cũ hết hiệu lực.
  const ghiNho = await docGhiNhoCuaPhien();
  const hashMoi = await hashPassword(newPassword);

  let mocMoi: string;
  try {
    mocMoi = await prisma.$transaction(async (tx) => {
      const [dong] = await tx.$queryRaw<
        { role: string; isActive: boolean; sessionEpoch: string; mustChangePassword: boolean }[]
      >`SELECT "role"::text AS "role", "isActive", "sessionEpoch", "mustChangePassword"
        FROM "User" WHERE "id" = ${nd.id} FOR UPDATE`;
      if (!dong || dong.sessionEpoch !== nd.mocPhien || !dong.mustChangePassword || !dong.isActive) {
        throw new TrangThaiDaDoi();
      }
      await tx.user.update({ where: { id: nd.id }, data: { passwordHash: hashMoi, mustChangePassword: false } });
      const moc = await thuHoiPhienCuaNguoi(tx, nd.id);
      await ghiNhatKy(tx, { actor, hanhDong: HANH_DONG.DOI_MAT_KHAU_LAN_DAU });
      return moc;
    });
  } catch (loi) {
    if (loi instanceof TrangThaiDaDoi) {
      await ghiNhatKyLoi({ actor, hanhDong: HANH_DONG.DOI_MAT_KHAU_LAN_DAU, ghiChu: { lyDo: "TRANG_THAI_DA_DOI" } });
      return { ok: false, error: LOI_TRANG_THAI_DA_DOI, code: "TRANG_THAI_DA_DOI" };
    }
    console.error("[doi-mat-khau-lan-dau] Không lưu được mật khẩu mới:", loi);
    await ghiNhatKyLoi({ actor, hanhDong: HANH_DONG.DOI_MAT_KHAU_LAN_DAU, ghiChu: { lyDo: "lỗi lưu" } });
    return { ok: false, error: "Không lưu được mật khẩu mới — thử lại" };
  }

  // NGOÀI transaction, SAU khi epoch mới đã COMMIT: cookie mang đúng epoch transaction trả ra.
  await createSession(nd.id, ghiNho, mocMoi);
  return { ok: true, data: undefined };
}
