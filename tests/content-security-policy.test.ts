import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { taoContentSecurityPolicy, taoNonce } from "@/lib/content-security-policy";
import { config, proxy } from "@/proxy";

/** Tách header CSP thành map `chỉ thị → danh sách nguồn` để assert từng chỉ thị, không so chuỗi thô. */
function tachChiThi(csp: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const phan of csp.split(";")) {
    const [ten, ...nguon] = phan.trim().split(/\s+/);
    if (ten) map.set(ten, nguon);
  }
  return map;
}

describe("taoContentSecurityPolicy", () => {
  it("script-src chỉ tin nonce của request + 'strict-dynamic', KHÔNG 'unsafe-inline'", () => {
    const script = tachChiThi(taoContentSecurityPolicy("abc123", false)).get("script-src");
    expect(script).toEqual(["'self'", "'nonce-abc123'", "'strict-dynamic'"]);
  });

  it("production KHÔNG có 'unsafe-eval'; dev có (React dev dựng call stack bằng eval)", () => {
    expect(taoContentSecurityPolicy("n", false)).not.toContain("unsafe-eval");
    expect(tachChiThi(taoContentSecurityPolicy("n", true)).get("script-src")).toContain("'unsafe-eval'");
  });

  it("style-src dùng 'unsafe-inline' và KHÔNG kèm nonce (có nonce thì trình duyệt bỏ qua 'unsafe-inline')", () => {
    const style = tachChiThi(taoContentSecurityPolicy("n", false)).get("style-src") ?? [];
    expect(style).toContain("'unsafe-inline'");
    expect(style.some((s) => s.startsWith("'nonce-"))).toBe(false);
  });

  it("đóng các đường né CSP: object/base/form/frame-ancestors, và connect-src chỉ về chính app", () => {
    const m = tachChiThi(taoContentSecurityPolicy("n", false));
    expect(m.get("object-src")).toEqual(["'none'"]);
    expect(m.get("base-uri")).toEqual(["'self'"]);
    expect(m.get("form-action")).toEqual(["'self'"]);
    expect(m.get("frame-ancestors")).toEqual(["'none'"]);
    expect(m.get("connect-src")).toEqual(["'self'"]);
    expect(m.get("default-src")).toEqual(["'self'"]);
  });

  it("img-src cho logo (self), xem trước ảnh (blob:), và ảnh sản phẩm ở bất kỳ host https (không allowlist *.pancake.vn)", () => {
    const img = tachChiThi(taoContentSecurityPolicy("n", false)).get("img-src");
    expect(img).toEqual(["'self'", "data:", "blob:", "https:"]);
  });
});

describe("taoNonce", () => {
  it("mỗi lần gọi ra nonce khác nhau, chỉ gồm ký tự base64 (không phá cú pháp header)", () => {
    const a = taoNonce();
    const b = taoNonce();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9+/=]{16,}$/);
  });
});

describe("proxy", () => {
  it("gắn CÙNG MỘT CSP vào request (để Next đọc nonce) lẫn response (để trình duyệt thực thi)", () => {
    const res = proxy(new NextRequest("http://localhost:3000/don-hang"));
    const cspResponse = res.headers.get("Content-Security-Policy");
    expect(cspResponse).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
    // NextResponse.next({ request: { headers } }) chuyển header request đã sửa qua tiền tố
    // `x-middleware-request-*` — đó là thứ Next dùng để dựng lại request cho bước render.
    expect(res.headers.get("x-middleware-request-content-security-policy")).toBe(cspResponse);
  });

  it("hai request liên tiếp nhận hai nonce khác nhau", () => {
    const a = proxy(new NextRequest("http://localhost:3000/")).headers.get("Content-Security-Policy");
    const b = proxy(new NextRequest("http://localhost:3000/")).headers.get("Content-Security-Policy");
    expect(a).not.toBe(b);
  });

  it("matcher bỏ qua /api/*, asset build và favicon — nhưng vẫn khớp trang thường", () => {
    const source = config.matcher[0].source;
    const re = new RegExp(`^${source}$`);
    for (const duongBoQua of [
      "/api/uploads/logo.png",
      "/api/export/ton-kho",
      "/_next/static/chunks/a.js",
      "/_next/image",
      "/favicon.ico",
    ]) {
      expect(re.test(duongBoQua), duongBoQua).toBe(false);
    }
    for (const trang of ["/", "/dang-nhap", "/tai-chinh", "/kenh/shopee"]) {
      expect(re.test(trang), trang).toBe(true);
    }
  });
});
