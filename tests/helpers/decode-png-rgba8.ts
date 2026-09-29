import { inflateSync } from "node:zlib";

/**
 * Giải mã PNG RGBA 8-bit KHÔNG interlace (đúng dạng `next/og`/Satori luôn xuất — đo thật 27/09:
 * colorType=6, bitDepth=8, interlace=0) — CHỈ để test đọc đúng MÀU TỪNG ĐIỂM ẢNH của icon dựng ra,
 * không dùng ở code sản phẩm. KHÔNG thêm dependency ảnh (pngjs/sharp…): PNG dùng zlib/deflate cho
 * IDAT — `node:zlib` có sẵn trong Node là đủ, phần còn lại (undo PNG filter theo chuẩn PNG spec
 * §9) chỉ vài chục dòng.
 */

export type AnhRgba = {
  rong: number;
  cao: number;
  /** (x,y) 0-based, gốc TRÊN-TRÁI — trùng hệ toạ độ CSS/canvas. */
  layMau(x: number, y: number): readonly [r: number, g: number, b: number, a: number];
};

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Giải PNG RGBA8 không interlace. Ném lỗi rõ ràng nếu gặp dạng khác (test hạ tầng — cố ý KHÔNG
 * cố gắng đỡ mọi biến thể PNG, chỉ đúng dạng `next/og` xuất ra). */
export function giaiPngRgba8(bytes: Uint8Array): AnhRgba {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!SIG.every((b, i) => buf[i] === b)) throw new Error("giaiPngRgba8: không phải PNG");

  let rong = 0;
  let cao = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatParts: Buffer[] = [];

  let i = 8;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString("ascii", i + 4, i + 8);
    const dataStart = i + 8;
    if (type === "IHDR") {
      rong = buf.readUInt32BE(dataStart);
      cao = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
      interlace = buf[dataStart + 12];
    } else if (type === "IDAT") {
      idatParts.push(buf.subarray(dataStart, dataStart + len));
    } else if (type === "IEND") {
      break;
    }
    i = dataStart + len + 4; // qua CRC
  }

  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(
      `giaiPngRgba8: chỉ hỗ trợ RGBA8 không interlace — gặp bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}`,
    );
  }

  const raw = inflateSync(Buffer.concat(idatParts));
  const bpp = 4; // RGBA 8-bit = 4 byte/điểm ảnh
  const scanlineLen = rong * bpp;
  const pixels = Buffer.alloc(cao * scanlineLen);
  let src = 0;

  for (let y = 0; y < cao; y++) {
    const filterType = raw[src];
    src += 1;
    const rowStart = y * scanlineLen;
    const priorRowStart = (y - 1) * scanlineLen;
    for (let x = 0; x < scanlineLen; x++) {
      const filt = raw[src + x];
      const a = x >= bpp ? pixels[rowStart + x - bpp] : 0; // trái
      const b = y > 0 ? pixels[priorRowStart + x] : 0; // trên
      const c = y > 0 && x >= bpp ? pixels[priorRowStart + x - bpp] : 0; // chéo trên-trái
      let recon: number;
      switch (filterType) {
        case 0:
          recon = filt;
          break;
        case 1:
          recon = filt + a;
          break;
        case 2:
          recon = filt + b;
          break;
        case 3:
          recon = filt + Math.floor((a + b) / 2);
          break;
        case 4:
          recon = filt + paeth(a, b, c);
          break;
        default:
          throw new Error(`giaiPngRgba8: filter type lạ ${filterType} ở dòng ${y}`);
      }
      pixels[rowStart + x] = recon & 0xff;
    }
    src += scanlineLen;
  }

  return {
    rong,
    cao,
    layMau(x, y) {
      const off = y * scanlineLen + x * bpp;
      return [pixels[off], pixels[off + 1], pixels[off + 2], pixels[off + 3]];
    },
  };
}
