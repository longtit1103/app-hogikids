// tests/unit/branding/jpeg-exif-orientation-cau-truc-anh-thuc.test.ts
import { describe, expect, it } from "vitest";

import { docHuongXoayExif } from "@/lib/branding/jpeg-exif-orientation";

import { dungJpegMoPhongMayAnhThat } from "../../helpers/dung-jpeg-mo-phong-may-anh-that";

/**
 * `jpeg-exif-orientation.test.ts` chỉ dựng JPEG TỐI GIẢN (1 thẻ IFD0, không JFIF/XMP, không IFD1)
 * — đủ để hàm quét được nhưng KHÁC cấu trúc byte thật của ảnh máy chụp. File này lấp hở đó: mỗi
 * ca dựng MỘT JPEG "giống ảnh máy thật" gộp cả 4 đặc điểm cùng lúc —
 *   1. byte order TIFF thật (`MM` iPhone / `II` Android) × đủ 8 orientation
 *   2. APP0(JFIF) đứng trước, APP1(XMP) đứng trước APP1(Exif) — đúng thứ tự encoder thật hay ghi
 *   3. IFD0 có nhiều thẻ quanh Orientation (Make/Model/DateTime/ExifIFDPointer/GPSInfoIFDPointer,
 *      tag tăng dần đúng chuẩn) + IFD1 thumbnail mang Orientation KHÁC ⇒ PHẢI lấy IFD0
 *   4. ảnh không vuông (60×40, qua marker SOF0) — khoá bất biến: Orientation không phụ thuộc
 *      kích thước ảnh
 * — thay vì 4 test rời rạc chỉ bật từng cờ một, để đúng tinh thần "giống ảnh máy thật" (một file
 * thật luôn có ĐỦ các đặc điểm này cùng lúc, không tách rời).
 */

describe("docHuongXoayExif — JPEG cấu trúc thật (MM/II · JFIF+XMP trước Exif · IFD0 nhiều thẻ + IFD1 khác · ảnh không vuông)", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8] as const)("byte order MM (iPhone) — orientation %i", (huong) => {
    const jpeg = dungJpegMoPhongMayAnhThat({
      be: true,
      orientation: huong,
      ifd1Orientation: ((huong % 8) + 1) as number, // luôn KHÁC orientation IFD0 để lộ lỗi ưu tiên sai IFD
    });
    expect(docHuongXoayExif(jpeg)).toBe(huong);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8] as const)("byte order II (Android) — orientation %i", (huong) => {
    const jpeg = dungJpegMoPhongMayAnhThat({
      be: false,
      orientation: huong,
      ifd1Orientation: ((huong % 8) + 1) as number,
    });
    expect(docHuongXoayExif(jpeg)).toBe(huong);
  });

  it("không có IFD1 (offset kế = 0, ảnh không có thumbnail) vẫn đọc đúng IFD0", () => {
    const jpeg = dungJpegMoPhongMayAnhThat({ be: false, orientation: 6 });
    expect(docHuongXoayExif(jpeg)).toBe(6);
  });

  it("kích thước ảnh CỰC không vuông (rộng gấp nhiều lần cao) không ảnh hưởng Orientation", () => {
    const jpeg = dungJpegMoPhongMayAnhThat({ be: true, orientation: 8, width: 4000, height: 300 });
    expect(docHuongXoayExif(jpeg)).toBe(8);
  });

  it("JPEG máy thật KHÔNG khai Exif (chỉ JFIF+XMP+SOF0) ⇒ mặc định 1", () => {
    const jpeg = dungJpegMoPhongMayAnhThat({ be: true, orientation: undefined });
    expect(docHuongXoayExif(jpeg)).toBe(1);
  });
});
