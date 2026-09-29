import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { dungIconPng, type LogoChuShop } from "@/lib/branding/app-icon";

import { giaiPngRgba8 } from "../../helpers/decode-png-rgba8";

/**
 * Chứng minh icon PWA dựng từ logo JPG EXIF Orientation xoay ĐÚNG CHIỀU — không chỉ "có xoay xảy
 * ra" (test cũ `app-icon.test.tsx` chỉ so byte khác bản dự phòng, KHÔNG phân biệt được sai 180°
 * so với đúng, đúng như hổng đã lộ ở Orientation 5/7 hoán đổi nhầm).
 *
 * Fixture `logo-4-goc-mau.jpg`: 32×32 (VUÔNG, không có EXIF), 4 góc 4 màu bất đối xứng (đỏ/xanh lá/
 * xanh dương/vàng). Nguồn VUÔNG cố ý: `iconTuLogo` luôn khớp logo vào khung `canh×canh` VUÔNG rồi
 * mới xoay quanh tâm khung — khung vuông xoay 90/180/270° quanh tâm giữ nguyên đúng bounding box
 * của nó, nên 4 điểm mẫu ở 4 góc khung LUÔN CỐ ĐỊNH bất kể orientation nào (không phải tính lại vị
 * trí letterbox theo từng ca xoay). Nhờ vậy so sánh trực tiếp được với bảng màu-4-góc mà
 * `PIL.ImageOps.exif_transpose` (thư viện tham chiếu độc lập) trả về cho CÙNG ảnh 4 góc vuông —
 * phép hoán vị màu theo orientation của một ảnh vuông không phụ thuộc nội dung ảnh.
 *
 * Giải mã PNG thật (`giaiPngRgba8`, PNG RGBA8 không interlace — đúng dạng `next/og` xuất ra) thay
 * vì so byte hay dựng ảnh tham chiếu xoay tay: đọc thẳng MÀU TỪNG ĐIỂM ẢNH nên khẳng định được
 * đúng CHIỀU, không chỉ đúng "có khác byte bản gốc".
 */

function u16be(n: number): number[] {
  return [(n >> 8) & 0xff, n & 0xff];
}
function u16le(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff];
}
function u32le(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
}
const EXIF_SIG = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"

/** APP1/Exif tối thiểu: TIFF little-endian + IFD0 đúng 1 thẻ Orientation. */
function tiffIfd0MotThe(orientationValue: number): number[] {
  return [
    0x49,
    0x49, // "II"
    ...u16le(0x002a),
    ...u32le(8),
    ...u16le(1), // 1 thẻ
    ...u16le(0x0112), // tag Orientation
    ...u16le(3), // kiểu SHORT
    ...u32le(1), // count
    ...u16le(orientationValue),
    ...u16le(0),
    ...u32le(0), // hết IFD
  ];
}

/** Chèn synthetic APP1/Exif khai `huong` NGAY SAU SOI của một JPEG THẬT — không đụng pixel gốc,
 * mô phỏng đúng cách máy ảnh không xoay điểm ảnh mà chỉ gắn cờ. */
function ganHuongExif(base: Buffer, huong: number): Buffer {
  const len = EXIF_SIG.length + tiffIfd0MotThe(huong).length + 2;
  const app1 = Buffer.from([0xff, 0xe1, ...u16be(len), ...EXIF_SIG, ...tiffIfd0MotThe(huong)]);
  return Buffer.concat([base.subarray(0, 2), app1, base.subarray(2)]);
}

const MAU: Record<string, readonly [number, number, number]> = {
  do: [255, 0, 0],
  xanhla: [0, 255, 0],
  xanhduong: [0, 0, 255],
  vang: [255, 255, 0],
};

function tenMauGanNhat(r: number, g: number, b: number): string {
  let ten = "?";
  let khoangCachBinhPhuongNhoNhat = Infinity;
  for (const [tenMau, [cr, cg, cb]] of Object.entries(MAU)) {
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (d < khoangCachBinhPhuongNhoNhat) {
      khoangCachBinhPhuongNhoNhat = d;
      ten = tenMau;
    }
  }
  return ten;
}

/**
 * Ground truth: dựng bằng `PIL.ImageOps.exif_transpose` trên CÙNG ảnh vuông 4 góc, đọc màu tại
 * (2,2)/(w-3,2)/(2,h-3)/(w-3,h-3) cho từng Orientation 1–8 — chạy TRỰC TIẾP, không suy diễn.
 */
const HUONG_DUNG: Record<number, { tl: string; tr: string; bl: string; br: string }> = {
  1: { tl: "do", tr: "xanhla", bl: "xanhduong", br: "vang" },
  2: { tl: "xanhla", tr: "do", bl: "vang", br: "xanhduong" },
  3: { tl: "vang", tr: "xanhduong", bl: "xanhla", br: "do" },
  4: { tl: "xanhduong", tr: "vang", bl: "do", br: "xanhla" },
  5: { tl: "do", tr: "xanhduong", bl: "xanhla", br: "vang" },
  6: { tl: "xanhduong", tr: "do", bl: "vang", br: "xanhla" },
  7: { tl: "vang", tr: "xanhla", bl: "xanhduong", br: "do" },
  8: { tl: "xanhla", tr: "vang", bl: "do", br: "xanhduong" },
};

const KICH_THUOC_TEST = 192;
const LE = Math.round(KICH_THUOC_TEST * 0.2); // đúng TI_LE_LE của app-icon.tsx
const EPS = 8; // cách mép/cách tâm khung đủ xa để tránh mờ biên do xoay/nén JPEG

describe("icon PWA xoay ĐÚNG CHIỀU theo EXIF Orientation (render thật + đọc pixel)", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8] as const)(
    "Orientation %i: 4 góc icon khớp PIL.ImageOps.exif_transpose",
    async (huong) => {
      const base = await readFile(path.join(process.cwd(), "tests/fixtures/branding/logo-4-goc-mau.jpg"));
      const logo: LogoChuShop = { bytes: ganHuongExif(base, huong), mime: "image/jpeg" };
      const res = await dungIconPng(KICH_THUOC_TEST, { docLogo: async () => logo });
      const anh = giaiPngRgba8(new Uint8Array(await res.arrayBuffer()));

      const [rTl, gTl, bTl] = anh.layMau(LE + EPS, LE + EPS);
      const [rTr, gTr, bTr] = anh.layMau(KICH_THUOC_TEST - LE - EPS, LE + EPS);
      const [rBl, gBl, bBl] = anh.layMau(LE + EPS, KICH_THUOC_TEST - LE - EPS);
      const [rBr, gBr, bBr] = anh.layMau(KICH_THUOC_TEST - LE - EPS, KICH_THUOC_TEST - LE - EPS);

      expect({
        tl: tenMauGanNhat(rTl, gTl, bTl),
        tr: tenMauGanNhat(rTr, gTr, bTr),
        bl: tenMauGanNhat(rBl, gBl, bBl),
        br: tenMauGanNhat(rBr, gBr, bBr),
      }).toEqual(HUONG_DUNG[huong]);
    },
    30_000,
  );
});
