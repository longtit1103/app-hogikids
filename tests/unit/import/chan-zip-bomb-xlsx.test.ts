import { deflateRawSync } from "node:zlib";

import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";

import { parseCostWorkbook } from "@/lib/import/cost-excel";
import {
  LoiFileGiaiNenQuaLon,
  LoiFileTuChoi,
  LoiFileZipHong,
  TRAN_GIAI_NEN_ZIP_BYTES,
  TRAN_SO_MUC_ZIP,
  kiemZipTruocKhiDoc,
} from "@/lib/import/kiem-zip-truoc-khi-doc";
import { readSheetRows } from "@/lib/import/xlsx-shared";

/**
 * Zip-bomb .xlsx phải bị chặn TRƯỚC `XLSX.read` — đo thật: file 460 KB nén 1000:1 làm SheetJS ăn
 * 3 GB RAM (container `mem_limit: 3g`). Ca CHẤP NHẬN file cỡ thật đứng đầu để chống vá quá tay.
 *
 * Bom được dựng TAY (không qua SheetJS) để điều khiển được từng ô kích thước khai báo: header thật
 * thà, header nói dối nhỏ, header khai 0 (data descriptor), ZIP64, mục lục hỏng.
 */

type MucZip = {
  ten: string;
  duLieu: Uint8Array;
  /** Mặc định deflate. */
  phuongPhap?: 0 | 8;
  /** Ghi đè `uncompressed size` ở central directory (mặc định = thật). */
  cdUsz?: number;
  /** Ghi đè `uncompressed size` ở local header (mặc định = thật). */
  localUsz?: number;
  /** Bật cờ data descriptor (bit 3). */
  coDataDescriptor?: boolean;
  /** Byte extra field đặt vào central directory / local header (nguyên khối, gồm id + len). */
  extraCd?: Buffer;
  extraLocal?: Buffer;
  /** Ghi 0xFFFFFFFF vào trường kích thước 32-bit (báo "giá trị thật nằm trong extra ZIP64"). */
  cdUszSentinel?: boolean;
  localUszSentinel?: boolean;
};

/** Extra field ZIP64 chỉ mang `uncompressed size` 64-bit (id 0x0001, len 8). */
function extraZip64Usz(usz: number): Buffer {
  const e = Buffer.alloc(12);
  e.writeUInt16LE(0x0001, 0);
  e.writeUInt16LE(8, 2);
  e.writeBigUInt64LE(BigInt(usz), 4);
  return e;
}

/** Dựng ZIP tối giản: local header + dữ liệu từng mục, rồi central directory + EOCD. CRC để 0. */
function dungZip(cacMuc: MucZip[], opts: { soMucEocd?: number } = {}): Uint8Array {
  const phanLocal: Buffer[] = [];
  const phanCd: Buffer[] = [];
  let offset = 0;
  for (const m of cacMuc) {
    const phuongPhap = m.phuongPhap ?? 8;
    const nen = phuongPhap === 8 ? deflateRawSync(m.duLieu) : Buffer.from(m.duLieu);
    const ten = Buffer.from(m.ten, "utf8");
    const usz = m.duLieu.length;
    const co = m.coDataDescriptor ? 0x0008 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(co, 6);
    local.writeUInt16LE(phuongPhap, 8);
    local.writeUInt32LE(m.coDataDescriptor ? 0 : nen.length, 18);
    local.writeUInt32LE(m.localUszSentinel ? 0xffffffff : (m.localUsz ?? (m.coDataDescriptor ? 0 : usz)), 22);
    local.writeUInt16LE(ten.length, 26);
    local.writeUInt16LE(m.extraLocal?.length ?? 0, 28);
    phanLocal.push(local, ten, m.extraLocal ?? Buffer.alloc(0), nen);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(co, 8);
    cd.writeUInt16LE(phuongPhap, 10);
    cd.writeUInt32LE(nen.length, 20);
    cd.writeUInt32LE(m.cdUszSentinel ? 0xffffffff : (m.cdUsz ?? usz), 24);
    cd.writeUInt16LE(ten.length, 28);
    cd.writeUInt16LE(m.extraCd?.length ?? 0, 30);
    cd.writeUInt32LE(offset, 42);
    phanCd.push(cd, ten, m.extraCd ?? Buffer.alloc(0));

    offset += local.length + ten.length + (m.extraLocal?.length ?? 0) + nen.length;
  }
  const cdBuf = Buffer.concat(phanCd);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(opts.soMucEocd ?? cacMuc.length, 8);
  eocd.writeUInt16LE(opts.soMucEocd ?? cacMuc.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...phanLocal, cdBuf, eocd]));
}

const toAb = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/** Sheet XML khổng lồ nhưng nén cực tốt — đúng hình dạng bom thật (một ô chuỗi rất dài). */
const BOM = new Uint8Array(TRAN_GIAI_NEN_ZIP_BYTES + 2 * 1024 * 1024).fill(0x41);

function batLoi(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("không ném");
}

describe("chặn zip-bomb .xlsx trước XLSX.read", () => {
  it("CHẤP NHẬN workbook thật 5.000 dòng × 8 cột (lớn hơn mọi file ví/ads thật)", () => {
    const aoa: (string | number)[][] = [["Ngày", "Loại", "Mã đơn", "Mô tả", "Số tiền", "Số dư", "Trạng thái", "Chi tiết"]];
    for (let i = 0; i < 5_000; i++) {
      aoa.push([`2026-10-${String((i % 28) + 1).padStart(2, "0")} 10:00:00`, "Doanh thu", `ORD${i}`, `Đơn hàng số ${i}`, 120_000 + i, 9_000_000 + i, "Hoàn thành", `Ghi chú ${i}`]);
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Sheet1");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;

    const rows = readSheetRows(buf);
    expect(rows).toHaveLength(5_001);
    expect(parseCostWorkbook(buf).rows).toHaveLength(5_000);
  });

  it("header THẬT THÀ khai giải nén > trần ⇒ LoiFileGiaiNenQuaLon (readSheetRows + giá vốn)", () => {
    const zip = toAb(dungZip([{ ten: "xl/worksheets/sheet1.xml", duLieu: BOM }]));
    expect(zip.byteLength).toBeLessThan(200_000); // vài chục KB nén ⇒ lọt trần body 3 MB

    const loi = batLoi(() => readSheetRows(zip));
    expect(loi).toBeInstanceOf(LoiFileGiaiNenQuaLon);
    expect(loi).toBeInstanceOf(LoiFileTuChoi);
    expect((loi as Error).message).toContain("vượt trần 30 MB");
    expect(() => parseCostWorkbook(zip)).toThrow(LoiFileGiaiNenQuaLon);
  });

  it("header NÓI DỐI nhỏ (CD + local khai 100 byte) ⇒ vẫn chặn nhờ giải nén thử có trần", () => {
    const zip = toAb(dungZip([{ ten: "xl/worksheets/sheet1.xml", duLieu: BOM, cdUsz: 100, localUsz: 100 }]));
    expect(() => readSheetRows(zip)).toThrow(LoiFileGiaiNenQuaLon);
  });

  it("local header khai 0 (cờ data descriptor — SheetJS tự nới buffer vô hạn) ⇒ chặn", () => {
    const zip = toAb(dungZip([{ ten: "xl/worksheets/sheet1.xml", duLieu: BOM, coDataDescriptor: true, cdUsz: 100 }]));
    expect(() => readSheetRows(zip)).toThrow(LoiFileGiaiNenQuaLon);
  });

  it("nhiều mục nhỏ cộng dồn vượt trần ⇒ chặn (trần là TỔNG, không phải từng mục)", () => {
    const manh = new Uint8Array(8 * 1024 * 1024).fill(0x42);
    const zip = toAb(dungZip([0, 1, 2, 3].map((i) => ({ ten: `xl/media/a${i}.xml`, duLieu: manh }))));
    expect(() => readSheetRows(zip)).toThrow(LoiFileGiaiNenQuaLon);
  });

  it(`số mục > ${TRAN_SO_MUC_ZIP} ⇒ chặn`, () => {
    const cacMuc = Array.from({ length: TRAN_SO_MUC_ZIP + 1 }, (_, i) => ({ ten: `m${i}`, duLieu: new Uint8Array(1) }));
    expect(() => readSheetRows(toAb(dungZip(cacMuc)))).toThrow(LoiFileGiaiNenQuaLon);
  });

  it("ZIP64 (kích thước 0xFFFFFFFF) ⇒ LoiFileZipHong", () => {
    const zip = toAb(dungZip([{ ten: "a.xml", duLieu: new Uint8Array(10), cdUsz: 0xffffffff }]));
    const loi = batLoi(() => readSheetRows(zip));
    expect(loi).toBeInstanceOf(LoiFileZipHong);
    expect((loi as Error).message).toContain("ZIP64");
  });

  it("extra ZIP64 mang kích thước 64-bit NHỎ hợp lệ ⇒ qua bước soi (không từ chối oan)", () => {
    const xml = new TextEncoder().encode("<x/>");
    // Extra ZIP64 ở CẢ central directory lẫn local header, kích thước thật = độ dài dữ liệu.
    const e = extraZip64Usz(xml.length);
    const zip = dungZip([
      { ten: "a.xml", duLieu: xml, cdUszSentinel: true, localUszSentinel: true, extraCd: e, extraLocal: e },
    ]);
    expect(() => kiemZipTruocKhiDoc(zip)).not.toThrow();
  });

  it("extra ZIP64 khai kích thước 64-bit KHỔNG LỒ ⇒ LoiFileGiaiNenQuaLon", () => {
    const e = extraZip64Usz(5 * 1024 * 1024 * 1024);
    const zip = toAb(dungZip([{ ten: "a.xml", duLieu: new Uint8Array(10), cdUszSentinel: true, extraCd: e }]));
    expect(() => readSheetRows(zip)).toThrow(LoiFileGiaiNenQuaLon);
  });

  it("local header khai ZIP64 KHỔNG LỒ (central directory khai nhỏ) ⇒ chặn", () => {
    const e = extraZip64Usz(5 * 1024 * 1024 * 1024);
    const zip = toAb(dungZip([{ ten: "a.xml", duLieu: new Uint8Array(10), localUszSentinel: true, extraLocal: e }]));
    expect(() => readSheetRows(zip)).toThrow(LoiFileGiaiNenQuaLon);
  });

  it("trường 32-bit = 0xFFFFFFFF nhưng extra ZIP64 cụt/vượt biên ⇒ LoiFileZipHong", () => {
    const cut = extraZip64Usz(10).subarray(0, 8); // len khai 8 nhưng chỉ còn 4 byte dữ liệu
    const zip = toAb(dungZip([{ ten: "a.xml", duLieu: new Uint8Array(10), cdUszSentinel: true, extraCd: cut }]));
    expect(() => readSheetRows(zip)).toThrow(LoiFileZipHong);
  });

  it("extra ZIP64 có mặt nhưng thiếu trường được yêu cầu (len 0) ⇒ LoiFileZipHong", () => {
    const rong = Buffer.from([0x01, 0x00, 0x00, 0x00]);
    const zip = toAb(dungZip([{ ten: "a.xml", duLieu: new Uint8Array(10), cdUszSentinel: true, extraCd: rong }]));
    expect(() => readSheetRows(zip)).toThrow(LoiFileZipHong);
  });

  it("mục lục khai nhiều mục hơn thật (con trỏ vượt biên) ⇒ LoiFileZipHong, không ném lỗi lạ", () => {
    const zip = toAb(dungZip([{ ten: "a.xml", duLieu: new Uint8Array(10) }], { soMucEocd: 5 }));
    expect(() => readSheetRows(zip)).toThrow(LoiFileZipHong);
  });

  it("luồng deflate hỏng ⇒ LoiFileZipHong (SheetJS dễ dãi hơn zlib, không cho lọt)", () => {
    const zip = dungZip([{ ten: "a.xml", duLieu: new Uint8Array(1000).fill(1) }]);
    // Ghi đè byte đầu luồng nén thành block type 3 (không tồn tại) ⇒ zlib từ chối.
    const batDau = 30 + "a.xml".length;
    zip[batDau] = 0xff;
    expect(() => readSheetRows(toAb(zip))).toThrow(LoiFileZipHong);
  });

  it("chữ ký PK nhưng không có mục lục cuối file ⇒ LoiFileZipHong", () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    expect(() => readSheetRows(toAb(zip))).toThrow(LoiFileZipHong);
  });
});
