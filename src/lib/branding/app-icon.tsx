// src/lib/branding/app-icon.tsx
import { readFile } from "node:fs/promises";
import path from "node:path";

import { ImageResponse } from "next/og";
import type { ReactElement } from "react";

import { docShopProfileKhongCache } from "@/lib/shop-profile/doc-shop-profile";

import { cssXoayTheoExif, docHuongXoayExif } from "./jpeg-exif-orientation";
import { duoiLogo, hasValidMagicBytes, kichThuocAnh, tenFileLogoHopLe } from "./logo-file";

/**
 * Icon app cho màn hình chính iPhone (PWA) — dựng ĐỘNG từ logo shop đã upload ở Cài đặt.
 *
 * Hợp đồng: ba kích thước hợp lệ trả 200 `image/png` + `no-store`. Mọi lỗi DỰ KIẾN (DB, chưa có
 * logo, path bẩn, file mất, ảnh không decode được, logo quá nhiều điểm ảnh) ⇒ icon dự phòng chữ "H",
 * không 500: iOS chụp icon ĐÚNG MỘT LẦN lúc "Thêm vào MH chính" — một lượt 500 lúc đó là icon trắng
 * vĩnh viễn. Lỗi cấp TIẾN TRÌNH (hết bộ nhớ, renderer wasm hỏng) nằm ngoài hợp đồng này — nguồn
 * chính của nó (logo khổng lồ) đã bị chặn bằng `CANH_LOGO_TOI_DA`.
 */

export const KICH_THUOC_ICON = [180, 192, 512] as const;
export type KichThuocIcon = (typeof KICH_THUOC_ICON)[number];

export function laKichThuocIcon(n: number): n is KichThuocIcon {
  return (KICH_THUOC_ICON as readonly number[]).includes(n);
}

const NEN_ICON = "#faf9f5"; // token --canvas
const NEN_DU_PHONG = "#cc785c"; // token --primary
const TI_LE_LE = 0.2; // lề an toàn mỗi cạnh — iOS bo góc không cắt vào logo

/**
 * Cạnh logo tối đa (điểm ảnh) được đem render. Icon lớn nhất chỉ 512px; logo lớn hơn mức này
 * không làm icon đẹp hơn mà làm renderer wasm cấp bộ nhớ theo số điểm ảnh (không trả lại) —
 * vượt ngưỡng ⇒ coi như không có logo, dùng icon dự phòng.
 */
export const CANH_LOGO_TOI_DA = 2048;

export type LogoChuShop = { bytes: Buffer; mime: "image/png" | "image/jpeg" };

/**
 * Logo của shop = `ShopProfile.shopLogoPath` (singleton, không thuộc riêng người dùng nào). Route
 * icon KHÔNG có phiên (iOS tải icon không qua đăng nhập app) nên không qua cổng phiên, và chạy
 * ngoài RSC nên đọc bản không cache.
 */
export async function timLogoPathChuShop(): Promise<string | null> {
  return (await docShopProfileKhongCache()).shopLogoPath;
}

type DocLogoDeps = { timLogoPath: () => Promise<string | null>; thuMucUploads: string };

const DOC_LOGO_MAC_DINH: DocLogoDeps = {
  timLogoPath: timLogoPathChuShop,
  // Đọc THẲNG đĩa, không vòng qua `/api/uploads` — cùng lý do route đó tồn tại: `next start` chỉ
  // lập danh sách file `public/` lúc boot, logo upload sau boot không phục vụ tĩnh được.
  thuMucUploads: path.join(process.cwd(), "public", "uploads"),
};

/** Logo chủ shop đã kiểm tên + magic bytes, hoặc `null`. KHÔNG BAO GIỜ ném. */
export async function docLogoChuShop(deps: Partial<DocLogoDeps> = {}): Promise<LogoChuShop | null> {
  const { timLogoPath, thuMucUploads } = { ...DOC_LOGO_MAC_DINH, ...deps };
  try {
    const ten = tenFileLogoHopLe(await timLogoPath());
    if (!ten) return null;
    const bytes = await readFile(path.join(thuMucUploads, ten));
    const ext = duoiLogo(ten);
    if (!hasValidMagicBytes(bytes, ext)) return null;
    const kichThuoc = kichThuocAnh(bytes, ext);
    if (!kichThuoc || kichThuoc.rong > CANH_LOGO_TOI_DA || kichThuoc.cao > CANH_LOGO_TOI_DA) return null;
    return { bytes, mime: ext === "png" ? "image/png" : "image/jpeg" };
  } catch {
    return null;
  }
}

/** Ô vuông nền canvas, căn giữa nội dung — dùng chung cho icon logo và bản "nền trống" để so. */
function khungIcon(noiDung?: ReactElement): ReactElement {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: NEN_ICON,
      }}
    >
      {noiDung}
    </div>
  );
}

function iconTuLogo(logo: LogoChuShop, size: number): ReactElement {
  const le = Math.round(size * TI_LE_LE);
  const canh = size - 2 * le;
  // Logo JPG chụp bằng điện thoại thường mang cờ EXIF Orientation — `next/og` (Satori) vẽ ĐÚNG
  // điểm ảnh lưu trong file, không tự xoay như trình duyệt. PNG không có cờ này (`docHuongXoayExif`
  // trả 1 ngay ở dấu hiệu SOI JPEG không khớp) nên gọi thẳng, không cần rẽ nhánh theo `mime`.
  const xoay = cssXoayTheoExif(docHuongXoayExif(logo.bytes));
  return khungIcon(
    <img
      src={`data:${logo.mime};base64,${logo.bytes.toString("base64")}`}
      width={canh}
      height={canh}
      style={xoay ? { objectFit: "contain", transform: xoay } : { objectFit: "contain" }}
      alt=""
    />,
  );
}

/** Chữ "H" trắng trên nền cam — font mặc định đóng gói sẵn trong next/og (không thêm file font). */
function iconDuPhong(size: number): ReactElement {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: NEN_DU_PHONG,
        color: "#ffffff",
        fontSize: Math.round(size * 0.6),
      }}
    >
      H
    </div>
  );
}

/**
 * Render XONG ra buffer. `ImageResponse` render LƯỜI: lỗi decode ảnh nổ lúc đọc stream, tức SAU
 * khi response đã trả về route — bọc `try` quanh việc khởi tạo là vô dụng. Đọc hết `arrayBuffer()`
 * ở đây thì lỗi nổ TRONG `try` của `dungIconPng`, kịp rơi về dự phòng.
 */
async function renderPng(node: ReactElement, size: number): Promise<ArrayBuffer> {
  return new ImageResponse(node, { width: size, height: size }).arrayBuffer();
}

type DungIconDeps = {
  docLogo: () => Promise<LogoChuShop | null>;
  render: (node: ReactElement, size: number) => Promise<ArrayBuffer>;
};

const DUNG_ICON_MAC_DINH: DungIconDeps = { docLogo: () => docLogoChuShop(), render: renderPng };

export async function dungIconPng(
  size: KichThuocIcon,
  deps: Partial<DungIconDeps> = {},
): Promise<Response> {
  const { docLogo, render } = { ...DUNG_ICON_MAC_DINH, ...deps };
  let png: ArrayBuffer;
  try {
    const logo = await docLogo();
    if (logo) {
      const tuLogo = await render(iconTuLogo(logo, size), size);
      // Ảnh có header hợp lệ nhưng THÂN hỏng (IDAT lỗi, JPG bị cắt): next/og KHÔNG ném mà lặng lẽ
      // vẽ ô nền trống (đo 26/09: trùng từng byte bản không ảnh) — `catch` không bao giờ chạy.
      // So với bản nền trống cùng kích thước: trùng ⇒ logo không vẽ được ⇒ dùng dự phòng.
      const nenTrong = await render(khungIcon(), size);
      png = Buffer.from(tuLogo).equals(Buffer.from(nenTrong))
        ? await render(iconDuPhong(size), size)
        : tuLogo;
    } else {
      png = await render(iconDuPhong(size), size);
    }
  } catch {
    png = await render(iconDuPhong(size), size);
  }
  return new Response(png, {
    status: 200,
    headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
  });
}
