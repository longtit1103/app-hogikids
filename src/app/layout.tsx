import type { Metadata } from "next";
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
      <body
        className={`${ebGaramond.variable} ${inter.variable} ${jetbrainsMono.variable} antialiased`}
      >
        {children}
        <Toaster
          position="top-right"
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
