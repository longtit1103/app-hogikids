import { describe, expect, it } from "vitest";

import { matKhauMoiSchema, matKhauMoiVaXacNhanSchema } from "@/lib/mat-khau-moi-schema";
import { MAX_PASSWORD_LENGTH } from "@/lib/password";
import { sinhMatKhauTam } from "@/lib/quan-tri/mat-khau-tam";

describe("sinhMatKhauTam", () => {
  it("16 ký tự, không ký tự dễ nhầm, luôn có chữ + số, và tự nó đạt luật mật khẩu mới", () => {
    const daThay = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const mk = sinhMatKhauTam();
      expect(mk).toMatch(/^[A-Za-z2-9]{16}$/);
      expect(mk).not.toMatch(/[0O1lI]/);
      expect(mk).toMatch(/[a-zA-Z]/);
      expect(mk).toMatch(/\d/);
      expect(matKhauMoiSchema.safeParse(mk).success).toBe(true);
      daThay.add(mk);
    }
    expect(daThay.size).toBe(500);
  });
});

describe("matKhauMoiSchema", () => {
  it("≥12 ký tự, có chữ và số, trần MAX_PASSWORD_LENGTH", () => {
    expect(matKhauMoiSchema.safeParse("abc12345678").success).toBe(false); // 11
    expect(matKhauMoiSchema.safeParse("abcdefghijkl").success).toBe(false); // không số
    expect(matKhauMoiSchema.safeParse("123456789012").success).toBe(false); // không chữ
    expect(matKhauMoiSchema.safeParse("abcdefghijk1").success).toBe(true);
    expect(matKhauMoiSchema.safeParse(`a1${"x".repeat(MAX_PASSWORD_LENGTH - 2)}`).success).toBe(true);
    expect(matKhauMoiSchema.safeParse(`a1${"x".repeat(MAX_PASSWORD_LENGTH - 1)}`).success).toBe(false);
  });

  it("xác nhận lệch ⇒ lỗi gắn confirmPassword", () => {
    const r = matKhauMoiVaXacNhanSchema.safeParse({ newPassword: "abcdefghijk1", confirmPassword: "abcdefghijk2" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(["confirmPassword"]);
  });
});
