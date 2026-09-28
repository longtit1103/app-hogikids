import { describe, expect, it } from "vitest";

import { isSafeRedirectPath } from "@/lib/safe-redirect-path";

describe("isSafeRedirectPath", () => {
  it("accepts a same-origin relative path", () => {
    expect(isSafeRedirectPath("/don-hang")).toBe(true);
  });

  it("rejects a protocol-relative URL (//evil.com)", () => {
    expect(isSafeRedirectPath("//evil.com")).toBe(false);
  });

  it("rejects a backslash escape (/\\evil.com)", () => {
    expect(isSafeRedirectPath("/\\evil.com")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isSafeRedirectPath("")).toBe(false);
  });

  it("rejects an absolute URL", () => {
    expect(isSafeRedirectPath("http://evil.com")).toBe(false);
  });

  it("rejects a javascript: pseudo-URL", () => {
    expect(isSafeRedirectPath("javascript:alert(1)")).toBe(false);
  });
});

/**
 * Lỗ THẬT đã đo: bộ phân tích URL xoá tab/LF/CR TRƯỚC khi phân tích, nên guard cũ (chỉ nhìn ký tự
 * đầu) cho qua rồi trình duyệt resolve thành `https://evil.com/`. Mỗi ca dưới đây là một chuỗi đã
 * được xác minh là vượt được guard cũ.
 */
describe("isSafeRedirectPath — ký tự điều khiển bị bộ phân tích URL xoá", () => {
  const vuotGuardCu = [
    ["tab", "/\t/evil.com"],
    ["newline", "/\n/evil.com"],
    ["carriage return", "/\r/evil.com"],
    ["tab + backslash", "/\t\\evil.com"],
    ["tab + protocol-relative", "/\t//evil.com"],
  ] as const;

  for (const [ten, chuoi] of vuotGuardCu) {
    it(`từ chối ${ten} (${JSON.stringify(chuoi)})`, () => {
      expect(isSafeRedirectPath(chuoi)).toBe(false);
      // Chốt đối chứng: chuỗi này THẬT SỰ thoát origin nếu được cho qua.
      expect(new URL(chuoi, "https://base-noi-bo.invalid").origin).not.toBe(
        "https://base-noi-bo.invalid"
      );
    });
  }

  it("vẫn nhận path hợp lệ có query + fragment", () => {
    expect(isSafeRedirectPath("/bao-cao?tab=pnl&tu=2026-09-01#tong")).toBe(true);
  });

  it("từ chối ký tự NUL", () => {
    expect(isSafeRedirectPath("/don-hang\u0000")).toBe(false);
  });
});

/**
 * Ghim LỚP 3 (soi lại `pathname`). Review đối kháng 20/09 đo bằng mutant: bỏ hẳn lớp 3 mà bộ test
 * cũ VẪN XANH — tức lớp đó không được khoá. Ba chuỗi dưới đây giữ nguyên origin nên lọt lớp 1+2 và
 * lọt cả phép so origin; chỉ phép soi `pathname` mới từ chối được chúng.
 */
describe("isSafeRedirectPath — chuỗi chuẩn hoá thành pathname //", () => {
  const chuanHoaThanhHaiGach = ["/.//evil.com", "/..//evil.com", "/a/../..//evil.com"];

  for (const chuoi of chuanHoaThanhHaiGach) {
    it(`từ chối ${JSON.stringify(chuoi)} (pathname chuẩn hoá thành "//evil.com")`, () => {
      expect(isSafeRedirectPath(chuoi)).toBe(false);
      // Đối chứng: origin KHÔNG đổi — nên phép so origin một mình là không đủ.
      const u = new URL(chuoi, "https://base-noi-bo.invalid");
      expect(u.origin).toBe("https://base-noi-bo.invalid");
      expect(u.pathname).toBe("//evil.com");
    });
  }

  it("vẫn nhận path có đoạn .. hợp lệ, không chuẩn hoá ra //", () => {
    expect(isSafeRedirectPath("/a/../don-hang")).toBe(true);
  });
});
