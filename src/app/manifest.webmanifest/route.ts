/**
 * GET /manifest.webmanifest — manifest PWA. CỐ Ý là route handler thường, KHÔNG phải file
 * convention `app/manifest.ts`: Next 16.3.6 tự sinh `<link rel="manifest">` cho convention và chỉ
 * gắn `crossorigin="use-credentials"` khi `VERCEL_ENV === "preview"` — không có API sửa. Thiếu
 * `use-credentials` thì lượt tải manifest có thể không kèm cookie Cloudflare Access. Thẻ link do
 * `app/layout.tsx` tự render (ĐÚNG MỘT thẻ).
 */
const MANIFEST = {
  name: "HogiKids",
  short_name: "HogiKids",
  lang: "vi",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#faf9f5",
  theme_color: "#cc785c",
  icons: [
    { src: "/pwa-icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/pwa-icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
  ],
} as const;

export function GET(): Response {
  return new Response(JSON.stringify(MANIFEST), {
    headers: { "Content-Type": "application/manifest+json" },
  });
}
