// src/lib/branding/logo-file.ts
import path from "node:path";

/**
 * Luật DUY NHẤT về file logo shop trên đĩa (`public/uploads`) — dùng chung cho đường GHI
 * (`saveLogoFile`/`deleteOldLogoFile` ở `lib/actions/settings-shop-info.ts`), đường ĐỌC công khai
 * (`app/api/uploads/[name]/route.ts`) và đường dựng icon app (`lib/branding/app-icon.tsx`).
 * Trước đây regex nằm chép ở 2 file; thêm nơi thứ ba mà chép tiếp là mở đường cho một nơi nới
 * allowlist còn nơi khác không.
 */

export type DuoiLogo = "png" | "jpg";

/** Mẫu tên mà `saveLogoFile` sinh ra: `logo-<Date.now()>.png|jpg`. Allowlist chặn path traversal. */
export const LOGO_FILENAME_RE = /^logo-\d+\.(png|jpg)$/;

/**
 * Magic bytes THẬT của từng định dạng — `File.type` do trình duyệt tự khai, giả được. Cố ý
 * KHÔNG dùng thư viện ảnh: chỉ so vài byte đầu.
 */
const MAGIC_BYTES_BY_EXT: Record<DuoiLogo, readonly number[]> = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpg: [0xff, 0xd8, 0xff],
};

export function hasValidMagicBytes(buffer: Uint8Array, ext: DuoiLogo): boolean {
  return MAGIC_BYTES_BY_EXT[ext].every((byte, i) => buffer[i] === byte);
}

/**
 * `ShopProfile.shopLogoPath` → tên file logo AN TOÀN để ghép với `public/uploads`, hoặc `null`.
 * Chấp nhận cả dạng hiện hành `/api/uploads/logo-…` lẫn dữ liệu cũ `/uploads/logo-…`: CHỈ lấy
 * basename (đổi `\` thành `/` trước để chuỗi kiểu Windows cũng bị cắt) rồi bắt buộc khớp
 * allowlist — thư mục đọc do người gọi cố định, nên phần đầu path không bao giờ được tin.
 */
export function tenFileLogoHopLe(shopLogoPath: string | null | undefined): string | null {
  if (!shopLogoPath) return null;
  const ten = path.posix.basename(shopLogoPath.replaceAll("\\", "/"));
  return LOGO_FILENAME_RE.test(ten) ? ten : null;
}

/** Đuôi của một tên file ĐÃ qua `tenFileLogoHopLe`/`LOGO_FILENAME_RE`. */
export function duoiLogo(tenFile: string): DuoiLogo {
  return tenFile.endsWith(".png") ? "png" : "jpg";
}

export type KichThuocAnh = { rong: number; cao: number };

/**
 * Rộng × cao đọc THẲNG từ header, KHÔNG giải mã ảnh — để chặn logo quá nhiều điểm ảnh TRƯỚC khi
 * đem render (renderer wasm của next/og cấp bộ nhớ theo số điểm ảnh và không trả lại: đo 26/09,
 * PNG phẳng 12000×12000 chỉ 445KB — lọt trần upload 2MB — đẩy RSS lên ~3GB, OOM container).
 * Không đọc được ⇒ `null` (người gọi coi như không có logo).
 */
export function kichThuocAnh(bytes: Uint8Array, ext: DuoiLogo): KichThuocAnh | null {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ext === "png") {
    // Chunk đầu tiên của PNG luôn là IHDR: độ dài (4) + "IHDR" (4) + rộng (4) + cao (4).
    if (bytes.length < 24) return null;
    if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== "IHDR") return null;
    return { rong: v.getUint32(16), cao: v.getUint32(20) };
  }
  // JPG: duyệt marker sau SOI (FFD8) tới marker SOFn — nơi ghi cao (2 byte) rồi rộng (2 byte).
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const m = bytes[i + 1];
    if (m === 0xff) {
      i += 1; // byte đệm
      continue;
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) {
      i += 2; // marker đứng một mình, không có trường độ dài
      continue;
    }
    if (m === 0xd9 || m === 0xda) return null; // hết ảnh / vào dữ liệu nén mà chưa gặp SOF
    // SOF0–SOF15 trừ DHT (C4), JPG (C8), DAC (CC)
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (i + 9 > bytes.length) return null;
      return { cao: v.getUint16(i + 5), rong: v.getUint16(i + 7) };
    }
    i += 2 + v.getUint16(i + 2);
  }
  return null;
}
