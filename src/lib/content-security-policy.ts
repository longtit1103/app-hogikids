/**
 * Content-Security-Policy cho mọi trang HTML — dựng theo từng request vì `script-src` mang NONCE.
 *
 * VÌ SAO NONCE chứ không `'unsafe-inline'`: Next chèn script bootstrap + payload RSC INLINE vào
 * HTML. `'unsafe-inline'` cho chạy chúng nhưng cũng cho chạy MỌI script inline kẻ khác chèn được
 * (XSS) — tức header không bảo vệ gì. Nonce ngẫu nhiên mỗi request chỉ cấp phép cho đúng script
 * Next tự sinh; `'strict-dynamic'` để các chunk mà script có nonce nạp tiếp cũng được tin (Next
 * nạp chunk bằng thẻ `<script>` tạo động). Next tự đọc nonce từ header CSP của REQUEST
 * (`src/proxy.ts` đặt) rồi gắn vào script của nó — không component nào phải tự truyền.
 *
 * Từng chỉ thị và lý do:
 *  - `script-src` — dev THÊM `'unsafe-eval'`: React dev dựng lại call stack bằng `eval`, thiếu là
 *    lỗi đỏ khắp console. Production KHÔNG có (không cần, và đó chính là thứ CSP phải chặn).
 *  - `style-src 'unsafe-inline'` — CỐ Ý, không dùng nonce cho style: (1) component render
 *    thuộc tính `style="..."` phía server (~27 chỗ `style={{ backgroundColor }}` cho chấm màu
 *    kênh/danh mục, recharts vẽ SVG với style inline) — thuộc tính style KHÔNG gắn được nonce;
 *    (2) `sonner` tự chèn thẻ `<style>` lúc chạy. Và nếu `style-src` có nonce thì trình duyệt
 *    BỎ QUA `'unsafe-inline'` ⇒ không thể trộn hai thứ. Rủi ro còn lại (chèn CSS) thấp hơn hẳn
 *    chèn script, và script mới là thứ header này gác.
 *  - `img-src` — `'self'` (logo qua `/api/uploads`, minh hoạ trong `public/`), `data:`, `blob:`
 *    (xem trước logo vừa chọn bằng `URL.createObjectURL`), và `https:`: ảnh sản phẩm là URL gốc
 *    của Pancake lưu trong `Product.imageUrl` (app KHÔNG tải ảnh về) — nhưng field này KHÔNG có
 *    allowlist host phía app, Pancake đổi CDN hay merchant gắn ảnh ở host khác vẫn phải hiện được.
 *    Bỏ allowlist `*.pancake.vn` để không vỡ ảnh khi host đổi; `https:` rủi ro thấp — `img-src`
 *    không thực thi được mã, chỉ load ảnh (khác hẳn `script-src`, thứ header này gác chặt).
 *  - `connect-src 'self'` — trình duyệt chỉ gọi về chính app (Server Action, route `/api/*`).
 *    Mọi lượt gọi API bên ngoài (Pancake, TikTok, Meta, n8n) đều chạy PHÍA SERVER.
 *  - `font-src 'self' data:` — `next/font/google` tự host font lúc build, không gọi Google lúc chạy.
 *  - `frame-ancestors 'none'` — cùng ý `X-Frame-Options: DENY` ở `next.config.ts` (giữ cả hai:
 *    trình duyệt cũ chỉ hiểu cái sau).
 *  - `object-src 'none'`, `base-uri 'self'`, `form-action 'self'` — đóng các đường né CSP
 *    quen thuộc (plugin, đổi `<base>` để trỏ script tương đối ra ngoài, form post ra ngoài).
 *
 * CỐ Ý KHÔNG có `upgrade-insecure-requests`: TLS đã do Cloudflare ép ở edge, còn ở dev/e2e
 * (`http://localhost:3000`) chỉ thị này có thể đẩy tài nguyên cùng origin sang `https://` ⇒ trắng trang.
 */

/** Sinh nonce mới cho MỘT request — base64 của UUID ngẫu nhiên (đúng mẫu tài liệu CSP của Next). */
export function taoNonce(): string {
  return btoa(crypto.randomUUID());
}

/** Dựng giá trị header CSP một dòng cho nonce đã cho. `isDev` bật `'unsafe-eval'` cho React dev. */
export function taoContentSecurityPolicy(nonce: string, isDev: boolean): string {
  const chiThi: string[] = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  return chiThi.join("; ");
}
