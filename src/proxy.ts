import { NextResponse, type NextRequest } from "next/server";

import { taoContentSecurityPolicy, taoNonce } from "@/lib/content-security-policy";

/**
 * Proxy (Next 16 đổi tên `middleware` → `proxy`) — CHỈ làm một việc: gắn Content-Security-Policy
 * có nonce MỚI cho mỗi request trang HTML. KHÔNG xác thực ở đây: cổng phiên vẫn là
 * `requireUser()` trong layout `(app)` — dời auth vào proxy là đổi mô hình bảo vệ, việc khác.
 *
 * Nonce phải đi HAI chiều:
 *  - header CSP của REQUEST ⇒ Next đọc nonce từ đây lúc render và gắn vào mọi `<script>` nó sinh;
 *  - header CSP của RESPONSE ⇒ trình duyệt thực thi chính sách.
 * Hai bản PHẢI cùng nonce, lệch là script Next bị chặn ⇒ trắng trang.
 *
 * Hệ quả: nonce đổi mỗi request nên trang KHÔNG được prerender tĩnh (HTML tĩnh mang nonce cũ/không
 * có nonce ⇒ script bị chặn). Mọi trang của app vốn đã động vì đọc cookie phiên; root layout gọi
 * `connection()` để chốt điều đó cho cả trang 404.
 */
export function proxy(request: NextRequest) {
  const nonce = taoNonce();
  const csp = taoContentSecurityPolicy(nonce, process.env.NODE_ENV === "development");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Bỏ qua: `/api/*` (trả JSON/bytes — gồm ảnh logo `/api/uploads`, không phải trang HTML nên
      // không cần CSP và không tốn lượt sinh nonce), asset build `_next/static`, `_next/image`,
      // favicon.
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      // Lượt prefetch của router chỉ lấy payload RSC, không phải trang HTML — bỏ qua như mẫu của
      // tài liệu Next để không sinh nonce vô ích.
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
