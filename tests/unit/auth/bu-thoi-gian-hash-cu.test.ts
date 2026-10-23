import { randomBytes, scryptSync } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `verifyPassword` với hash N thấp hơn hiện hành mà so SAI phải chạy thêm ĐÚNG một lượt scrypt ở
 * `SCRYPT_N_HIEN_HANH` — nếu không, gõ sai cho email có thật còn hash cũ trả lời nhanh hơn email lạ
 * (so với hash giả N hiện hành) ~250 ms, đủ để dò email nào có tài khoản. Đếm lượt gọi scrypt theo N
 * (bọc hàm thật), KHÔNG đo đồng hồ — đo thời gian trên máy CI là test chập chờn.
 */
vi.mock("node:crypto", async (importOriginal) => {
  const that = await importOriginal<typeof import("node:crypto")>();
  const scrypt = vi.fn(that.scrypt);
  return { ...that, default: { ...that, scrypt }, scrypt };
});

import { scrypt } from "node:crypto";

import { hashPassword, SCRYPT_N_HIEN_HANH, verifyPassword } from "@/lib/password";

const N_CU = 16_384;

/** Dựng hash định dạng CŨ đúng cách bản trước sinh ra (salt là chuỗi hex thô, scrypt mặc định). */
function hashDinhDangCu(matKhau: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(matKhau, salt, 64).toString("hex")}`;
}

/** Danh sách N của mọi lượt `scrypt` (bất đồng bộ) đã gọi, theo thứ tự. */
function cacNDaGoi(): number[] {
  return vi.mocked(scrypt).mock.calls.map((thamSo) => (thamSo[3] as unknown as { N: number }).N);
}

beforeEach(() => {
  vi.mocked(scrypt).mockClear();
});

describe("verifyPassword — bù thời gian cho hash N thấp", () => {
  it("hash định dạng cũ + mật khẩu SAI ⇒ thêm đúng 1 lượt scrypt ở N hiện hành", async () => {
    const cu = hashDinhDangCu("mat-khau-cu");
    await expect(verifyPassword("mat-khau-sai", cu)).resolves.toBe(false);
    expect(cacNDaGoi()).toEqual([N_CU, SCRYPT_N_HIEN_HANH]);
  });

  it("hash `s2$` với N thấp + mật khẩu SAI ⇒ cũng bù 1 lượt", async () => {
    const salt = randomBytes(16).toString("hex");
    const thap = `s2$${N_CU}$${salt}:${scryptSync("mk", salt, 64).toString("hex")}`;
    await expect(verifyPassword("sai", thap)).resolves.toBe(false);
    expect(cacNDaGoi()).toEqual([N_CU, SCRYPT_N_HIEN_HANH]);
  });

  it("hash định dạng cũ + mật khẩu ĐÚNG ⇒ không bù (người gọi đã biết mật khẩu)", async () => {
    const cu = hashDinhDangCu("mat-khau-cu");
    await expect(verifyPassword("mat-khau-cu", cu)).resolves.toBe(true);
    expect(cacNDaGoi()).toEqual([N_CU]);
  });

  it("hash hiện hành + mật khẩu SAI ⇒ chỉ 1 lượt (đã ngang nhánh email lạ)", async () => {
    const hienHanh = await hashPassword("Mat-khau-manh-123");
    vi.mocked(scrypt).mockClear();
    await expect(verifyPassword("sai", hienHanh)).resolves.toBe(false);
    expect(cacNDaGoi()).toEqual([SCRYPT_N_HIEN_HANH]);
  });
});
