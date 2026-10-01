import { z } from "zod";

import { MAX_PASSWORD_LENGTH } from "@/lib/do-dai-mat-khau";

/**
 * Luật MẬT KHẨU MỚI dùng chung cho mọi màn người dùng tự đặt mật khẩu (đổi mật khẩu lần đầu, màn Đổi
 * mật khẩu ở Cài đặt — `actions/security.ts`). Chỉ áp cho mật khẩu MỚI — đăng nhập bằng mật
 * khẩu cũ ngắn hơn vẫn phải vào được (màn đăng nhập chỉ so hash).
 *
 * Trần TRÊN là `MAX_PASSWORD_LENGTH` dùng chung với màn đăng nhập: đặt được chuỗi dài hơn trần đăng
 * nhập là người dùng tự khoá mình vĩnh viễn (xem `password.ts`).
 */
export const MIN_MAT_KHAU_MOI = 12;

/** Ít nhất 1 chữ cái + 1 chữ số (không ràng buộc ký tự đặc biệt/hoa-thường). */
export const DO_PHUC_TAP_MAT_KHAU_MOI = /(?=.*[a-zA-Z])(?=.*\d)/;

export const matKhauMoiSchema = z
  .string({ error: "Vui lòng nhập mật khẩu mới" })
  .min(MIN_MAT_KHAU_MOI, `Mật khẩu mới phải có ít nhất ${MIN_MAT_KHAU_MOI} ký tự`)
  .max(MAX_PASSWORD_LENGTH, `Mật khẩu mới tối đa ${MAX_PASSWORD_LENGTH} ký tự`)
  .regex(DO_PHUC_TAP_MAT_KHAU_MOI, "Mật khẩu mới phải có cả chữ và số");

/** Cặp "mật khẩu mới + nhập lại" của form — lỗi lệch gắn vào ô `confirmPassword`. */
export const matKhauMoiVaXacNhanSchema = z
  .object({
    newPassword: matKhauMoiSchema,
    confirmPassword: z.string({ error: "Vui lòng nhập lại mật khẩu mới" }).min(1, "Vui lòng nhập lại mật khẩu mới"),
  })
  .refine((d) => d.confirmPassword === d.newPassword, {
    message: "Mật khẩu xác nhận không khớp",
    path: ["confirmPassword"],
  });
