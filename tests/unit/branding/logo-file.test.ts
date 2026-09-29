// tests/unit/branding/logo-file.test.ts
import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  LOGO_FILENAME_RE,
  duoiLogo,
  hasValidMagicBytes,
  kichThuocAnh,
  tenFileLogoHopLe,
} from "@/lib/branding/logo-file";

describe("tenFileLogoHopLe — chuẩn hoá shopLogoPath về basename an toàn", () => {
  it("nhận path hiện hành /api/uploads/…", () => {
    expect(tenFileLogoHopLe("/api/uploads/logo-1727340000000.png")).toBe("logo-1727340000000.png");
  });
  it("nhận dữ liệu cũ /uploads/…", () => {
    expect(tenFileLogoHopLe("/uploads/logo-1727340000000.jpg")).toBe("logo-1727340000000.jpg");
  });
  it("chuỗi traversal chỉ còn basename — không bao giờ trỏ ra ngoài thư mục", () => {
    expect(tenFileLogoHopLe("/api/uploads/../../etc/passwd")).toBeNull();
    expect(tenFileLogoHopLe("..\\..\\logo-1.png\\..\\secret")).toBeNull();
    expect(tenFileLogoHopLe("/api/uploads/../../logo-5.png")).toBe("logo-5.png");
  });
  it("tên ngoài allowlist ⇒ null", () => {
    expect(tenFileLogoHopLe("/api/uploads/logo-abc.png")).toBeNull();
    expect(tenFileLogoHopLe("/api/uploads/logo-1.gif")).toBeNull();
    expect(tenFileLogoHopLe("/api/uploads/logo-1.png.exe")).toBeNull();
  });
  it("rỗng / null / undefined ⇒ null", () => {
    expect(tenFileLogoHopLe("")).toBeNull();
    expect(tenFileLogoHopLe(null)).toBeNull();
    expect(tenFileLogoHopLe(undefined)).toBeNull();
  });
});

describe("hasValidMagicBytes + duoiLogo", () => {
  it("PNG đúng chữ ký", () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    expect(hasValidMagicBytes(png, "png")).toBe(true);
    expect(hasValidMagicBytes(png, "jpg")).toBe(false);
  });
  it("JPG đúng chữ ký", () => {
    const jpg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
    expect(hasValidMagicBytes(jpg, "jpg")).toBe(true);
    expect(hasValidMagicBytes(jpg, "png")).toBe(false);
  });
  it("buffer ngắn hơn chữ ký ⇒ false", () => {
    expect(hasValidMagicBytes(Uint8Array.from([0x89]), "png")).toBe(false);
  });
  it("duoiLogo theo đuôi tên file", () => {
    expect(duoiLogo("logo-1.png")).toBe("png");
    expect(duoiLogo("logo-1.jpg")).toBe("jpg");
  });
  it("LOGO_FILENAME_RE giữ nguyên mẫu saveLogoFile sinh ra", () => {
    expect(LOGO_FILENAME_RE.test(`logo-${Date.now()}.png`)).toBe(true);
  });
});

describe("kichThuocAnh — đọc rộng×cao từ header, không giải mã ảnh", () => {
  const pngHeader = (rong: number, cao: number) => {
    const b = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write("IHDR", 12, "ascii");
    b.writeUInt32BE(rong, 16);
    b.writeUInt32BE(cao, 20);
    return b;
  };

  it("PNG: đọc IHDR", () => {
    expect(kichThuocAnh(pngHeader(12000, 9000), "png")).toEqual({ rong: 12000, cao: 9000 });
  });
  it("PNG thiếu IHDR / cụt ⇒ null", () => {
    expect(kichThuocAnh(pngHeader(10, 10).subarray(0, 20), "png")).toBeNull();
    const sai = pngHeader(10, 10);
    sai.write("XXXX", 12, "ascii");
    expect(kichThuocAnh(sai, "png")).toBeNull();
  });
  it("JPG thật (fixture 64×32): đọc từ marker SOF", () => {
    const jpg = readFileSync(path.join(process.cwd(), "tests/fixtures/branding/logo-mau.jpg"));
    expect(kichThuocAnh(jpg, "jpg")).toEqual({ rong: 64, cao: 32 });
  });
  it("JPG không có SOF / rác ⇒ null", () => {
    expect(kichThuocAnh(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "jpg")).toBeNull();
    expect(kichThuocAnh(Buffer.from([0xff, 0xd8, 0x00, 0x01, 0x02]), "jpg")).toBeNull();
  });
});
