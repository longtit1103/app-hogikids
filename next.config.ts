import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Next.js mặc định giới hạn Server Action body = 1MB (vẫn đúng ở 16.3.1) — thấp hơn cap logo
    // 2MB của app (MAX_LOGO_BYTES ở settings.ts/shop-info-section.tsx) nên
    // ảnh hợp lệ (~1.4MB PNG) bị framework chặn TRƯỚC khi action chạy validate
    // riêng. Nới lên 3MB để chính app-level validate (không phải framework)
    // là bên từ chối file quá cỡ.
    serverActions: { bodySizeLimit: "3mb" },
    // Next 16.3 bật cache Turbopack cho `next build` theo MẶC ĐỊNH, ghi vào
    // `.next/cache/turbopack`. Cache đó chỉ có ích khi lượt build sau đọc lại được
    // nó — mà `Dockerfile` build trong layer SẠCH mỗi lượt và không mount/khôi phục
    // `.next/cache`, rồi `COPY --from=build --chown=node:node /app ./` lại bê
    // nguyên khối sang runner: image prod mang theo một cache KHÔNG BAO GIỜ được đọc.
    // Đo 2026-08-17: `.next/cache/turbopack` = 128,5 MB. Doc chính thức
    // (`turbopackFileSystemCache`) khuyên đúng ca này: "If your build environment
    // never preserves `.next/cache`, set `turbopackFileSystemCacheForBuild: false`
    // to skip writing a cache that will not be read."
    // GIỮ `turbopackFileSystemCacheForDev` mặc định `true`: cache dev ghi ở
    // `.next/dev/cache/turbopack`, KHÔNG vào image, và ĐƯỢC đọc lại mỗi lần
    // khởi động lại dev server nên nó có ích thật.
    turbopackFileSystemCacheForBuild: false,
  },
  images: {
    // App chỉ hiện thumbnail 32–64px (avatar shop, ảnh sản phẩm) + 1 SVG minh hoạ
    // đăng nhập. 5/6 chỗ <Image> đã tự khai `unoptimized` từng chỗ, và SVG thì
    // Next vốn không tối ưu (trừ khi bật dangerouslyAllowSVG) ⇒ bật toàn cục là
    // no-op về hiển thị, đồng thời bỏ luôn nhánh tối ưu ảnh lúc chạy (hardening).
    // LƯU Ý: cảnh báo `sharp` trong npm audit được vá nhờ Next 16.3.1 kéo
    // sharp ^0.35.3, KHÔNG phải nhờ cờ này.
    unoptimized: true,
  },

  // `X-Powered-By: Next.js` mặc định BẬT. Nó không mở cửa nào, nhưng là thứ nói thẳng cho máy quét
  // biết cần thử bộ CVE nào — mà app này vừa dính một CVE critical của chính Next (16.3.1,
  // GHSA-2xp9-vwfh-vxw4). Tắt đi: không mất gì, bớt một chỉ dẫn miễn phí cho kẻ dò.
  poweredByHeader: false,

  /**
   * Security header toàn cục. App là bảng điều khiển tài chính phơi công khai qua Cloudflare
   * Tunnel, trước bản vá này KHÔNG có một header phòng thủ nào (chỉ `nosniff` đặt tay ở 3 route
   * phục vụ bytes).
   *
   * Vì sao vẫn đáng thêm dù đã có `sameSite=lax`: cookie lax chặn được clickjacking THEO HỆ QUẢ
   * (iframe cross-site không mang cookie ⇒ trang nhúng chỉ hiện màn đăng nhập), nhưng đó là hiệu
   * ứng phụ của một cơ chế sinh ra cho việc khác. Đổi một thuộc tính cookie là mất luôn lớp chắn
   * mà không ai nhận ra. `X-Frame-Options: DENY` nói thẳng điều mình muốn.
   *
   * HAI thứ KHÔNG đặt ở đây:
   *  - **HSTS** — origin chỉ nghe `127.0.0.1:3000`, TLS do Cloudflare terminate ở edge. Header
   *    HSTS phát từ Next không bao giờ tới trình duyệt qua đường HTTP trần, nên đặt ở đây là
   *    trang trí. Chỗ đúng là Cloudflare → SSL/TLS → Edge Certificates. Và đặt `max-age` +
   *    `includeSubDomains` thôi, KHÔNG `preload`: preload gần như không gỡ được và ghim cứng cho
   *    MỌI subdomain của `example.com` — dựng một subdomain HTTP sau này là gãy.
   *  - **CSP** — Next inline bootstrap script nên CSP đúng phải mang nonce MỚI mỗi request, mà
   *    `headers()` ở đây là tĩnh. CSP vì vậy do `src/proxy.ts` gắn (chính sách ở
   *    `src/lib/content-security-policy.ts`), lưới Playwright `tests/e2e/csp-nonce.spec.ts` canh
   *    0 vi phạm trên các trang chính — CSP sai là TRẮNG TRANG.
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Cấm nhúng vào iframe ở MỌI nơi — app không có ca nhúng hợp lệ nào.
          { key: "X-Frame-Options", value: "DENY" },
          // Cấm trình duyệt đoán lại Content-Type (đã đặt tay ở /api/uploads + 2 route export;
          // đây là lớp phủ toàn cục cho mọi route còn lại).
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // App không dùng 3 quyền này — khai tường minh để một thư viện bên thứ ba cũng không xin được.
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
