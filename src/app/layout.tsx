import type { Metadata, Viewport } from "next";
import { EB_Garamond, Inter, JetBrains_Mono } from "next/font/google";
import { connection } from "next/server";
import { Toaster } from "sonner";
import "./globals.css";

// Display/heading serif — weight 400 with negative tracking (claude-DESIGN.md display tokens)
const ebGaramond = EB_Garamond({
  variable: "--font-eb-garamond",
  subsets: ["latin", "vietnamese"],
  weight: ["400", "500"],
});

// Body/UI sans
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin", "vietnamese"],
});

// Code / figures (JetBrains Mono has no vietnamese subset — used for code blocks + monospace numerals only)
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "HogiKids — Quản lý lãi/lỗ",
  description: "Lớp P&L trên Pancake POS cho shop thời trang trẻ em HogiKids",
  // PWA iPhone: "Thêm vào MH chính" mở toàn màn hình. `default` (không `black-translucent`) để
  // nội dung KHÔNG chui dưới thanh trạng thái.
  appleWebApp: { capable: true, title: "HogiKids", statusBarStyle: "default" },
  // iOS ưu tiên apple-touch-icon trong <head> hơn icon manifest. Route động, xem pwa-icon/[size].
  icons: { apple: [{ url: "/pwa-icon/180", sizes: "180x180", type: "image/png" }] },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Cho nội dung chạm mép màn hình iPhone; phần bị tai thỏ/thanh home che được bù bằng đệm
  // safe-area ở globals.css.
  viewportFit: "cover",
  themeColor: "#faf9f5",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Ép MỌI trang render động theo request: CSP ở `src/proxy.ts` cấp nonce MỚI mỗi request, trang
  // prerender tĩnh (vd 404) sẽ mang HTML thiếu nonce ⇒ script Next bị chặn, trang mất tương tác.
  // Trang trong app vốn đã động nhờ cookie phiên — dòng này chỉ đổi thêm trang 404.
  await connection();

  return (
    <html lang="vi">
      <head>
        {/*
          Manifest PWA — ĐÚNG MỘT thẻ, tự render (không dùng metadata.manifest / app/manifest.ts):
          cần `crossOrigin="use-credentials"` để lượt tải manifest mang cookie Cloudflare Access.
          Lý do đầy đủ ở src/app/manifest.webmanifest/route.ts.
        */}
        <link rel="manifest" href="/manifest.webmanifest" crossOrigin="use-credentials" />
      </head>
      <body
        className={`${ebGaramond.variable} ${inter.variable} ${jetbrainsMono.variable} antialiased`}
      >
        {children}
        <Toaster
          position="top-right"
          // PWA iPhone: toast `fixed` không hưởng đệm safe-area của body — giữ lề mặc định của sonner
          // (24px khi rộng > 600px, 16px khi hẹp hơn) và cộng thêm inset từng cạnh. `offset` áp cả khi
          // iPhone XOAY NGANG (rộng > 600px). Máy tính inset = 0 ⇒ y như trước.
          offset={{
            top: "calc(24px + env(safe-area-inset-top))",
            right: "calc(24px + env(safe-area-inset-right))",
            bottom: "calc(24px + env(safe-area-inset-bottom))",
            left: "calc(24px + env(safe-area-inset-left))",
          }}
          mobileOffset={{
            top: "calc(16px + env(safe-area-inset-top))",
            right: "calc(16px + env(safe-area-inset-right))",
            bottom: "calc(16px + env(safe-area-inset-bottom))",
            left: "calc(16px + env(safe-area-inset-left))",
          }}
          toastOptions={{
            classNames: {
              toast: "rounded-lg bg-surface-dark px-4 py-3 text-sm text-on-dark shadow-lg",
              title: "text-on-dark",
              description: "text-on-dark/80",
              // Nền surface-dark dùng chung → phân biệt thành công/lỗi bằng viền trái màu
              // ngữ nghĩa (bỏ `richColors` nên không còn màu nền phân biệt sẵn).
              success: "border-l-4 border-success",
              error: "border-l-4 border-error",
            },
          }}
        />
      </body>
    </html>
  );
}
