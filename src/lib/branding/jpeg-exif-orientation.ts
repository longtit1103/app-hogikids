// src/lib/branding/jpeg-exif-orientation.ts

/**
 * Đọc thẻ Exif Orientation (0x0112) của JPEG, KHÔNG giải mã ảnh — `next/og` (Satori) vẽ ảnh THEO
 * ĐÚNG điểm ảnh lưu trong file, không tự xoay theo cờ EXIF như trình duyệt. Logo chụp bằng điện
 * thoại thường gắn cờ này (máy giữ nguyên điểm ảnh theo hướng cầm máy, chỉ đổi cờ) ⇒ icon app vẽ
 * lệch 90°/180° nếu không bù tay — dùng ở `app-icon.tsx`.
 *
 * MỌI bước đọc đều bounds-check TRƯỚC khi đọc byte: header hỏng/cắt cụt/không phải JPEG luôn trả
 * về mặc định `1` (không xoay), KHÔNG BAO GIỜ ném, KHÔNG BAO GIỜ đọc vượt `bytes.length`.
 */

export type HuongXoayExif = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** Không có EXIF / không tìm thấy Orientation / dữ liệu hỏng ⇒ coi như ảnh đã đúng chiều. */
const HUONG_MAC_DINH: HuongXoayExif = 1;

function laHuongXoayHopLe(n: number): n is HuongXoayExif {
  return Number.isInteger(n) && n >= 1 && n <= 8;
}

const DAU_HIEU_EXIF = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // ASCII "Exif" + 2 byte 0
const TAG_ORIENTATION = 0x0112;
const KIEU_SHORT = 3; // Orientation luôn khai kiểu SHORT trong mọi encoder thật gặp được

// Chặn `count` IFD giả mạo (vd 0xffff) khiến vòng lặp quét xa hơn cần thiết — ảnh thật không bao
// giờ có quá vài chục thẻ trong IFD0. Không phải lỗ hổng (đã bounds-check từng bước) — chỉ đỡ phí.
const SO_THE_IFD_TOI_DA = 512;

/** Đọc Orientation trong đoạn APP1 (Exif) đã xác định vị trí `[start, end)` trong `bytes`. */
function docOrientationTuApp1(bytes: Uint8Array, view: DataView, start: number, end: number): HuongXoayExif | null {
  if (end - start < 14) return null; // "Exif\0\0" (6) + header TIFF tối thiểu (8)
  for (let k = 0; k < DAU_HIEU_EXIF.length; k++) {
    if (bytes[start + k] !== DAU_HIEU_EXIF[k]) return null;
  }
  const tiff = start + 6;
  const leTiff = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49; // "II" — little-endian
  const beTiff = bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d; // "MM" — big-endian
  if (!leTiff && !beTiff) return null;
  if (view.getUint16(tiff + 2, leTiff) !== 0x002a) return null; // hằng số TIFF bắt buộc
  const ifdOffset = view.getUint32(tiff + 4, leTiff);
  const ifdStart = tiff + ifdOffset;
  // IFD0 không thể nằm trong 8 byte đầu (chính header TIFF) — offset < 8 là dữ liệu giả.
  if (ifdOffset < 8 || ifdStart + 2 > end) return null;

  const soThe = Math.min(view.getUint16(ifdStart, leTiff), SO_THE_IFD_TOI_DA);
  for (let n = 0; n < soThe; n++) {
    const entry = ifdStart + 2 + n * 12;
    if (entry + 12 > end) return null;
    if (view.getUint16(entry, leTiff) !== TAG_ORIENTATION) continue;
    if (view.getUint16(entry + 2, leTiff) !== KIEU_SHORT) return null; // kiểu khác ⇒ dữ liệu giả/hỏng
    // Trường value/offset (4 byte) — SHORT (2 byte) nằm ở 2 byte ĐẦU, đúng cho cả hai byte order.
    const gia = view.getUint16(entry + 8, leTiff);
    return laHuongXoayHopLe(gia) ? gia : null;
  }
  return null;
}

/** `bytes` là JPEG (đã qua `hasValidMagicBytes`) → Orientation (1–8), mặc định 1. */
export function docHuongXoayExif(bytes: Uint8Array): HuongXoayExif {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return HUONG_MAC_DINH;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return HUONG_MAC_DINH;
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i += 1; // byte đệm giữa hai marker — thử lại từ vị trí kế
      continue;
    }
    if (marker === 0xd9) return HUONG_MAC_DINH; // EOI — hết ảnh, không có APP1
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // TEM/RST0-7 — marker đứng một mình, không có trường length
      continue;
    }
    const segLen = view.getUint16(i + 2, false); // độ dài segment LUÔN big-endian trong JPEG
    if (segLen < 2 || i + 2 + segLen > bytes.length) return HUONG_MAC_DINH;
    if (marker === 0xe1) {
      const huong = docOrientationTuApp1(bytes, view, i + 4, i + 2 + segLen);
      if (huong !== null) return huong;
      // APP1 không phải Exif (vd XMP) hoặc không có Orientation — vẫn có thể còn APP1 khác phía
      // sau (hiếm nhưng không cấm); đi tiếp thay vì dừng ở đây.
    }
    if (marker === 0xda) return HUONG_MAC_DINH; // SOS — hết phần header, vào dữ liệu nén
    i += 2 + segLen;
  }
  return HUONG_MAC_DINH;
}

/**
 * CSS `transform` bù cờ Orientation — Satori hỗ trợ `rotate`/`scaleX`/`scaleY` (không hỗ trợ
 * biến đổi 3D). `1` (đa số ảnh, và MỌI ảnh không phải JPEG) ⇒ `undefined`, khỏi thêm style thừa.
 */
const TRANSFORM_THEO_HUONG: Record<HuongXoayExif, string | undefined> = {
  1: undefined,
  2: "scaleX(-1)",
  3: "rotate(180deg)",
  4: "scaleY(-1)",
  5: "rotate(-90deg) scaleX(-1)",
  6: "rotate(90deg)",
  7: "rotate(90deg) scaleX(-1)",
  8: "rotate(-90deg)",
};

export function cssXoayTheoExif(huong: HuongXoayExif): string | undefined {
  return TRANSFORM_THEO_HUONG[huong];
}
