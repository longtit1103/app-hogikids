// tests/helpers/dung-jpeg-mo-phong-may-anh-that.ts
/**
 * Dựng byte JPEG mô phỏng cấu trúc ẢNH MÁY THẬT (iPhone/Android) để kiểm `docHuongXoayExif` —
 * khác với `jpeg-exif-orientation.test.ts` (JPEG tối giản 1 thẻ IFD0, chỉ đủ để hàm quét được).
 *
 * Thứ tự marker mô phỏng đúng thực tế: SOI → APP0(JFIF) → APP1(XMP, `ns.adobe.com`) → APP1(Exif
 * TIFF thật: nhiều thẻ IFD0 trước/sau Orientation + IFD1 thumbnail mang Orientation KHÁC) →
 * SOF0 (kích thước không vuông) → EOI. `docHuongXoayExif` trả về NGAY khi gặp APP1 Exif hợp lệ nên
 * thực tế SOF0 không bao giờ được quét tới — vẫn dựng đủ để hồ sơ JPEG hợp lệ và khoá bất biến
 * "kết quả không phụ thuộc kích thước ảnh" cho tương lai.
 *
 * Các thẻ KHÔNG PHẢI Orientation (Make/Model/DateTime/ExifIFDPointer/GPSInfoIFDPointer) dùng
 * offset/value BỊA — `docHuongXoayExif` không bao giờ dereference chúng (chỉ so `tag`), nên không
 * cần dựng dữ liệu thật đằng sau các con trỏ đó.
 */

type IfdEntryKieu = 2 | 3 | 4; // 2=ASCII, 3=SHORT, 4=LONG — đủ cho các thẻ dựng ở đây

function packU16(n: number, be: boolean): number[] {
  return be ? [(n >> 8) & 0xff, n & 0xff] : [n & 0xff, (n >> 8) & 0xff];
}
function packU32(n: number, be: boolean): number[] {
  const b = [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
  return be ? b.reverse() : b;
}

/** 1 thẻ IFD = 12 byte cố định (tag·kiểu·count·value/offset) — ĐÚNG cho mọi kiểu thẻ. */
function ifdEntry(tag: number, kieu: IfdEntryKieu, count: number, valueField4Byte: number[], be: boolean): number[] {
  if (valueField4Byte.length !== 4) throw new Error("value/offset field phải đúng 4 byte");
  return [...packU16(tag, be), ...packU16(kieu, be), ...packU32(count, be), ...valueField4Byte];
}

function orientationEntry(value: number, be: boolean): number[] {
  return ifdEntry(0x0112, 3, 1, [...packU16(value, be), 0, 0], be);
}

export const EXIF_SIG = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"

/**
 * TIFF header (8) + IFD0 thật (6 thẻ, Orientation ở giữa, thứ tự tag TĂNG DẦN đúng chuẩn TIFF) +
 * tuỳ chọn IFD1 (thumbnail) mang Orientation KHÁC — kịch bản đối kháng: dữ liệu bất thường/bị sửa
 * tay, khoá bất biến "luôn ưu tiên IFD0" dù thực tế thumbnail hiếm khi lặp thẻ Orientation.
 */
export function dungTiffExif(opts: { be: boolean; orientation: number; ifd1Orientation?: number }): number[] {
  const { be, orientation, ifd1Orientation } = opts;
  const header = [...(be ? [0x4d, 0x4d] : [0x49, 0x49]), ...packU16(0x002a, be), ...packU32(8, be)];

  // 6 thẻ, tag tăng dần: Make · Model · Orientation · DateTime · ExifIFDPointer · GPSInfoIFDPointer.
  const ifd0Entries = [
    ifdEntry(0x010f, 2, 6, packU32(0xc4, be), be), // Make, offset bịa — không bao giờ bị đọc
    ifdEntry(0x0110, 2, 14, packU32(0xd0, be), be), // Model
    orientationEntry(orientation, be),
    ifdEntry(0x0132, 2, 20, packU32(0xe0, be), be), // DateTime
    ifdEntry(0x8769, 4, 1, packU32(0x100, be), be), // ExifIFDPointer (LONG value nằm THẲNG, không offset)
    ifdEntry(0x8825, 4, 1, packU32(0x140, be), be), // GPSInfoIFDPointer
  ];
  const coIfd1 = ifd1Orientation !== undefined;
  // Offset IFD0 luôn = 8 (ngay sau header) ⇒ IFD1 (nếu có) nằm ngay sau IFD0: 8 + 2 + 6*12 + 4 = 86.
  const ifd0 = [...packU16(6, be), ...ifd0Entries.flat(), ...packU32(coIfd1 ? 86 : 0, be)];
  const ifd1 = coIfd1 ? [...packU16(1, be), ...orientationEntry(ifd1Orientation, be), ...packU32(0, be)] : [];

  return [...header, ...ifd0, ...ifd1];
}

function u16be(n: number): number[] {
  return [(n >> 8) & 0xff, n & 0xff];
}

/** APP1 hoàn chỉnh (marker + length + data) — length TÍNH CẢ 2 byte length, luôn big-endian. */
function app1(data: number[]): number[] {
  return [0xff, 0xe1, ...u16be(data.length + 2), ...data];
}

/** APP0 JFIF tối giản, hợp lệ — đứng TRƯỚC APP1 trong mọi ảnh máy thật xuất chuẩn. */
function app0Jfif(): number[] {
  return [0xff, 0xe0, ...u16be(16), 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0];
}

/** APP1 XMP (Adobe) — nhiều máy/app chỉnh ảnh chèn TRƯỚC APP1 Exif thật. */
function app1Xmp(): number[] {
  const ident = Array.from("http://ns.adobe.com/xap/1.0/\0").map((c) => c.charCodeAt(0));
  return app1([...ident, 1, 2, 3]);
}

/** SOF0 (Start Of Frame, baseline) — trường LUÔN big-endian bất kể byte order TIFF trong APP1. */
function sof0(width: number, height: number): number[] {
  const components = [1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]; // Y·Cb·Cr chuẩn JFIF
  const data = [8, ...u16be(height), ...u16be(width), 3, ...components];
  return [0xff, 0xc0, ...u16be(data.length + 2), ...data];
}

/**
 * JPEG hoàn chỉnh mô phỏng ảnh máy thật: SOI·APP0(JFIF)·APP1(XMP)·APP1(Exif)·SOF0·EOI.
 * `width`/`height` mặc định 60×40 (KHÔNG vuông) — khoá bất biến kết quả Orientation không phụ
 * thuộc kích thước ảnh.
 */
export function dungJpegMoPhongMayAnhThat(opts: {
  be: boolean;
  orientation?: number;
  ifd1Orientation?: number;
  width?: number;
  height?: number;
}): Uint8Array {
  const { be, orientation, ifd1Orientation, width = 60, height = 40 } = opts;
  const app1Exif = orientation === undefined ? [] : app1([...EXIF_SIG, ...dungTiffExif({ be, orientation, ifd1Orientation })]);
  return Uint8Array.from([0xff, 0xd8, ...app0Jfif(), ...app1Xmp(), ...app1Exif, ...sof0(width, height), 0xff, 0xd9]);
}
