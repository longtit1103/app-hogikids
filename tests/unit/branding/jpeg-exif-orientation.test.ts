import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { cssXoayTheoExif, docHuongXoayExif, type HuongXoayExif } from "@/lib/branding/jpeg-exif-orientation";

/**
 * Dựng tay một JPEG tối thiểu chỉ đủ để `docHuongXoayExif` quét được — KHÔNG cần dữ liệu ảnh thật
 * (parser không giải mã ảnh, chỉ đọc marker/IFD). Cấu trúc: SOI · APP1("Exif\0\0" + TIFF little-endian
 * "II" + IFD0 1 thẻ Orientation).
 */
function u16le(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff];
}
function u16be(n: number): number[] {
  return [(n >> 8) & 0xff, n & 0xff];
}
function u32le(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
}

const EXIF_SIG = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"

/** Thân đoạn Exif (sau "Exif\0\0"): TIFF header little-endian + IFD0 1 thẻ Orientation (kiểu SHORT). */
function tiffIfd0MotThe(orientationValue: number, opts: { kieuSai?: boolean } = {}): number[] {
  const kieu = opts.kieuSai ? 5 : 3; // 3 = SHORT đúng chuẩn; 5 = RATIONAL (giả để test "kiểu hỏng")
  return [
    ...[0x49, 0x49], // "II" little-endian
    ...u16le(0x002a), // hằng số TIFF
    ...u32le(8), // offset IFD0 = ngay sau header 8 byte
    ...u16le(1), // IFD0: 1 thẻ
    ...u16le(0x0112), // tag Orientation
    ...u16le(kieu),
    ...u32le(1), // count = 1
    ...u16le(orientationValue), // value (2 byte đầu của trường 4 byte)
    ...u16le(0), // 2 byte đệm còn lại của trường value
    ...u32le(0), // offset IFD kế = 0 (hết)
  ];
}

function app1(data: number[]): number[] {
  const len = data.length + 2; // độ dài TÍNH CẢ trường length
  return [0xff, 0xe1, ...u16be(len), ...data];
}

function jpegVoiExif(orientationValue: number, opts: { kieuSai?: boolean } = {}): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, ...app1([...EXIF_SIG, ...tiffIfd0MotThe(orientationValue, opts)]), 0xff, 0xd9]);
}

describe("docHuongXoayExif — orientation hợp lệ", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8] as const)("đọc đúng orientation %i", (huong) => {
    expect(docHuongXoayExif(jpegVoiExif(huong))).toBe(huong);
  });

  it("TIFF big-endian ('MM') đọc đúng", () => {
    const tiffBE = [
      ...[0x4d, 0x4d], // "MM"
      ...u16be(0x002a),
      ...u32BE(8),
      ...u16be(1),
      ...u16be(0x0112),
      ...u16be(3),
      ...u32BE(1),
      ...u16be(6),
      ...u16be(0),
      ...u32BE(0),
    ];
    const buf = Uint8Array.from([0xff, 0xd8, ...app1([...EXIF_SIG, ...tiffBE]), 0xff, 0xd9]);
    expect(docHuongXoayExif(buf)).toBe(6);
  });
});

function u32BE(n: number): number[] {
  return [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

describe("docHuongXoayExif — không có EXIF ⇒ mặc định 1", () => {
  it("JPEG chỉ có APP0 (JFIF), không APP1", () => {
    const jfif = [0xff, 0xe0, ...u16be(16), 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0];
    const buf = Uint8Array.from([0xff, 0xd8, ...jfif, 0xff, 0xd9]);
    expect(docHuongXoayExif(buf)).toBe(1);
  });

  it("JPEG trơn — chỉ SOI + EOI", () => {
    expect(docHuongXoayExif(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]))).toBe(1);
  });

  it("APP1 nhưng không phải Exif (vd XMP)", () => {
    const xmp = [...Array.from("http://ns.adobe.com/xap/1.0/\0").map((c) => c.charCodeAt(0)), 1, 2, 3];
    const buf = Uint8Array.from([0xff, 0xd8, ...app1(xmp), 0xff, 0xd9]);
    expect(docHuongXoayExif(buf)).toBe(1);
  });

  it("IFD0 không có thẻ Orientation", () => {
    const tiffKhongOrientation = [
      ...[0x49, 0x49],
      ...u16le(0x002a),
      ...u32le(8),
      ...u16le(1), // 1 thẻ, nhưng KHÔNG phải Orientation
      ...u16le(0x0110), // tag Model (khác 0x0112)
      ...u16le(2),
      ...u32le(1),
      ...u16le(0),
      ...u16le(0),
      ...u32le(0),
    ];
    const buf = Uint8Array.from([0xff, 0xd8, ...app1([...EXIF_SIG, ...tiffKhongOrientation]), 0xff, 0xd9]);
    expect(docHuongXoayExif(buf)).toBe(1);
  });
});

describe("docHuongXoayExif — EXIF hỏng/cắt cụt ⇒ mặc định 1, KHÔNG ném", () => {
  it("cắt cụt trước khi đọc hết entry Orientation (buffer đứt ngang giữa APP1 khai báo)", () => {
    const full = jpegVoiExif(6);
    // Mọi điểm cắt < độ dài APP1 KHAI BÁO (segLen, cố định ở đây = 38 tính từ marker APP1) đều phải
    // bị cổng bounds-check ở đầu hàm chặn TRƯỚC khi đọc entry — kể cả cắt sát cuối entry.
    for (const cutAt of [0, 1, 4, 10, 20, 30, 33, 37]) {
      const cut = full.subarray(0, cutAt);
      expect(() => docHuongXoayExif(cut)).not.toThrow();
      expect(docHuongXoayExif(cut)).toBe(1);
    }
  });

  it("cắt CHỈ phần đuôi SAU entry Orientation (EOI) ⇒ vẫn đọc đúng, không rơi về mặc định oan", () => {
    const full = jpegVoiExif(6);
    // Dữ liệu cần thiết (TIFF + IFD0 + entry) đã nằm trọn trước EOI — cắt đúng 1-2 byte cuối không
    // phải "hỏng dữ liệu Orientation", KHÔNG được lẫn với ca cắt cụt thật ở test trên.
    expect(docHuongXoayExif(full.subarray(0, full.length - 1))).toBe(6);
  });

  it("dấu hiệu Exif sai (không phải 'Exif\\0\\0')", () => {
    const gia = [...Array.from("Fake\0\0").map((c) => c.charCodeAt(0)), ...tiffIfd0MotThe(6)];
    const buf = Uint8Array.from([0xff, 0xd8, ...app1(gia), 0xff, 0xd9]);
    expect(docHuongXoayExif(buf)).toBe(1);
  });

  it("byte order TIFF không phải 'II'/'MM'", () => {
    const tiffSai = [0x58, 0x58, ...u16le(0x002a), ...u32le(8), ...u16le(0)];
    const buf = Uint8Array.from([0xff, 0xd8, ...app1([...EXIF_SIG, ...tiffSai]), 0xff, 0xd9]);
    expect(docHuongXoayExif(buf)).toBe(1);
  });

  it("hằng số TIFF (0x002A) sai", () => {
    const tiffSai = [0x49, 0x49, ...u16le(0x1234), ...u32le(8), ...u16le(0)];
    const buf = Uint8Array.from([0xff, 0xd8, ...app1([...EXIF_SIG, ...tiffSai]), 0xff, 0xd9]);
    expect(docHuongXoayExif(buf)).toBe(1);
  });

  it("offset IFD0 trỏ ra ngoài đoạn APP1 ⇒ không đọc tràn, trả mặc định", () => {
    const tiffOffsetBay = [0x49, 0x49, ...u16le(0x002a), ...u32le(999_999)];
    const buf = Uint8Array.from([0xff, 0xd8, ...app1([...EXIF_SIG, ...tiffOffsetBay]), 0xff, 0xd9]);
    expect(docHuongXoayExif(buf)).toBe(1);
  });

  it("kiểu thẻ Orientation không phải SHORT ⇒ coi là dữ liệu giả", () => {
    expect(docHuongXoayExif(jpegVoiExif(6, { kieuSai: true }))).toBe(1);
  });

  it("orientation ngoài khoảng 1–8 ⇒ mặc định", () => {
    const buf = jpegVoiExif(99);
    expect(docHuongXoayExif(buf)).toBe(1);
  });

  it("buffer rỗng / quá ngắn", () => {
    expect(docHuongXoayExif(Uint8Array.from([]))).toBe(1);
    expect(docHuongXoayExif(Uint8Array.from([0xff]))).toBe(1);
    expect(docHuongXoayExif(Uint8Array.from([0xff, 0xd8]))).toBe(1);
  });
});

describe("docHuongXoayExif — ảnh PNG (không phải JPEG) ⇒ mặc định 1", () => {
  it("chữ ký PNG", () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
    expect(docHuongXoayExif(png)).toBe(1);
  });
});

describe("docHuongXoayExif — file JPG THẬT do Pillow ghi (không phải buffer dựng tay)", () => {
  it("fixture logo-mau-exif-xoay-90.jpg khai Orientation=6", async () => {
    const bytes = await readFile(path.join(process.cwd(), "tests/fixtures/branding/logo-mau-exif-xoay-90.jpg"));
    expect(docHuongXoayExif(bytes)).toBe(6);
  });

  it("fixture logo-mau.jpg (không khai EXIF) ⇒ mặc định 1", async () => {
    const bytes = await readFile(path.join(process.cwd(), "tests/fixtures/branding/logo-mau.jpg"));
    expect(docHuongXoayExif(bytes)).toBe(1);
  });
});

describe("cssXoayTheoExif", () => {
  it("1 ⇒ undefined (khỏi thêm style thừa)", () => {
    expect(cssXoayTheoExif(1)).toBeUndefined();
  });
  // ĐỦ 8 orientation, KHÔNG bỏ sót cái nào — 5 và 7 (mirror + xoay 90° NGƯỢC dấu nhau) chỉ khác
  // nhau đúng dấu `90deg` vs `-90deg` nên dễ gõ hoán đổi nhầm khi viết tay bảng
  // `TRANSFORM_THEO_HUONG` mà một `it.each` thiếu 2 ca đó sẽ không bắt được. File này chỉ khoá
  // ĐÚNG CHUỖI CSS; đối chiếu ĐÚNG CHIỀU màu thật (render + decode pixel) ở
  // `icon-huong-xoay-mau-goc.test.ts`.
  it.each([
    [2, "scaleX(-1)"],
    [3, "rotate(180deg)"],
    [4, "scaleY(-1)"],
    [5, "rotate(-90deg) scaleX(-1)"],
    [6, "rotate(90deg)"],
    [7, "rotate(90deg) scaleX(-1)"],
    [8, "rotate(-90deg)"],
  ] as const)("%i ⇒ %s", (huong: HuongXoayExif, css) => {
    expect(cssXoayTheoExif(huong)).toBe(css);
  });
});
