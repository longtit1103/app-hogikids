/**
 * Soi cấu trúc ZIP của file .xlsx TRƯỚC khi đưa cho `XLSX.read` — chặn zip-bomb.
 *
 * Vì sao cần: `.xlsx` là ZIP. Trần body 3 MB của Server Action chỉ chặn số byte NÉN; một sheet XML nén
 * 1000:1 vẫn lọt và bung ra hàng trăm MB khi SheetJS giải nén. Đo thật (xlsx 0.20.3, đúng options
 * của `readSheetRows`): file 460 KB → RSS 3,03 GB trong 5,8 s — container `mem_limit: 3g` bị kill.
 * `sheetRows` không cứu được: nó cắt SAU khi SheetJS đã giải nén + dựng chuỗi xong.
 *
 * Hai lớp kiểm, cả hai đều trước `XLSX.read`:
 *  1. KÍCH THƯỚC KHAI BÁO (thuần JS, chạy cả trình duyệt): đọc End-of-Central-Directory + từng mục
 *     central directory + local header của mục đó. SheetJS cấp buffer theo `uncompressed size` ở
 *     LOCAL header (không phải central directory) ⇒ phải soi cả hai, lấy số lớn hơn.
 *  2. KÍCH THƯỚC THẬT (chỉ máy chủ, cần `node:zlib`): giải nén thử từng mục với trần
 *     `maxOutputLength`. Lớp 1 không đủ vì số khai báo do người gửi tự viết: khai nhỏ thì SheetJS
 *     vẫn chạy hết luồng deflate (tốn CPU tỉ lệ kích thước thật), còn khai 0 (cờ data descriptor)
 *     thì bộ giải nén thuần JS của SheetJS tự nới buffer KHÔNG GIỚI HẠN.
 *
 * Cấu trúc lạ (nhiều đĩa, con trỏ vượt biên file, luồng deflate hỏng, extra ZIP64 thiếu/cụt, ZIP64
 * ở mục lục cuối file) ⇒ TỪ CHỐI thay vì đoán. Riêng extra ZIP64 CỦA TỪNG MỤC được đọc đúng đặc tả (một
 * số trình nén ghi kèm cả cho file nhỏ): lấy kích thước 64-bit THẬT đem so trần, không từ chối oan.
 */

/**
 * Trần TỔNG kích thước giải nén của mọi mục trong ZIP.
 *
 * 30 MB: file thật lớn nhất app nhận là báo cáo ads cả tháng (vài nghìn dòng) và ví Shopee (prod
 * 77 dòng tổng lịch sử) — XML giải nén cỡ vài trăm KB tới ~2 MB. Một sheet 20.000 dòng × 8 cột dữ liệu
 * thật cũng chỉ ~5 MB XML. 30 MB dư hơn 10 lần file thật, trong khi RSS SheetJS đo được ~6–7 lần cỡ
 * XML ⇒ chặn trên quanh 200 MB, xa trần 3 GB của container.
 */
export const TRAN_GIAI_NEN_ZIP_BYTES = 30 * 1024 * 1024;

/** Trần số mục trong ZIP. xlsx thật có ~10–20 mục (workbook, sheet, styles, theme, rels…). */
export const TRAN_SO_MUC_ZIP = 1_000;

/**
 * Lớp gốc cho mọi file bị TỪ CHỐI có lý do rõ ràng (vượt trần, cấu trúc lạ). Caller (server action,
 * modal) bắt lớp này rồi hiện NGUYÊN `message` cho người dùng — khác hẳn "file hỏng" chung chung.
 */
export class LoiFileTuChoi extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoiFileTuChoi";
  }
}

/** Tổng giải nén / số mục vượt trần — dấu hiệu zip-bomb. */
export class LoiFileGiaiNenQuaLon extends LoiFileTuChoi {
  constructor(message: string) {
    super(message);
    this.name = "LoiFileGiaiNenQuaLon";
  }
}

/** Cấu trúc ZIP không đọc được an toàn (ZIP64 hỏng/ở mục lục cuối, nhiều đĩa, con trỏ vượt biên, deflate hỏng). */
export class LoiFileZipHong extends LoiFileTuChoi {
  constructor(chiTiet: string) {
    super(`File .xlsx có cấu trúc ZIP không hợp lệ (${chiTiet}) — mở bằng Excel rồi lưu lại .xlsx và thử lại.`);
    this.name = "LoiFileZipHong";
  }
}

const SIG_EOCD = 0x06054b50;
const SIG_CD = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const EXTRA_ZIP64 = 0x0001;
const MB = 1024 * 1024;

type GiaiNenThu = (duLieu: Uint8Array, tran: number) => number;

/**
 * Bộ giải nén thử phía máy chủ, hoặc null ở trình duyệt.
 *
 * KHÔNG `import "node:zlib"` tĩnh: file này nằm trong bundle trình duyệt (modal nhập giá vốn đọc
 * file phía client qua `cost-excel.ts` → `xlsx-shared.ts`). `process.getBuiltinModule` (Node ≥ 22.3,
 * container chạy Node 24) lấy module lúc chạy mà bundler không thấy; ở trình duyệt không có ⇒ chỉ
 * còn lớp kích thước khai báo — bom khi đó chỉ làm treo tab của chính người chọn file.
 */
function layGiaiNenThu(): GiaiNenThu | null {
  if (typeof process === "undefined" || typeof process.getBuiltinModule !== "function") return null;
  const zlib = process.getBuiltinModule("node:zlib");
  if (!zlib) return null;
  return (duLieu, tran) => {
    try {
      return zlib.inflateRawSync(duLieu, { maxOutputLength: tran }).length;
    } catch (err) {
      if (err instanceof RangeError) return tran + 1; // ERR_BUFFER_TOO_LARGE — vượt trần còn lại
      // Luồng deflate hỏng/cụt: bộ giải nén thuần JS của SheetJS dễ dãi hơn zlib (không kiểm
      // khoảng cách lùi vượt cửa sổ…) nên một luồng zlib từ chối vẫn có thể bung lớn ở SheetJS.
      throw new LoiFileZipHong("luồng nén hỏng");
    }
  };
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

const SENTINEL_32 = 0xffffffff;

/** Số 64-bit little-endian → Number. Vượt 2^53 mất độ chính xác nhưng vẫn "rất lớn" — đủ để so với trần. */
const u64 = (b: Uint8Array, o: number) => u32(b, o) + u32(b, o + 4) * 2 ** 32;

/** Trường 32-bit nào của mục đang mang giá trị 0xFFFFFFFF/0xFFFF ⇒ giá trị thật nằm trong extra ZIP64. */
type TruongCanZip64 = { usz: boolean; csz: boolean; offset: boolean; dia: boolean };

type GiaTriZip64 = { usz?: number; csz?: number; offset?: number };

/**
 * Đọc extra field ZIP64 (0x0001) của một mục. Theo đặc tả APPNOTE 4.5.3 chỉ những trường có bản
 * 32-bit = 0xFFFFFFFF (0xFFFF với số đĩa) mới có mặt, đúng thứ tự: uncompressed size, compressed
 * size, local header offset, disk start. Trả null nếu không có extra ZIP64.
 *
 * Mục cụt/vượt biên, extra ZIP64 thiếu trường được yêu cầu, hay số đĩa ≠ 0 ⇒ ném `LoiFileZipHong`
 * (từ chối thay vì đoán).
 */
function docExtraZip64(b: Uint8Array, batDau: number, doDai: number, can: TruongCanZip64): GiaTriZip64 | null {
  const ketThuc = batDau + doDai;
  let o = batDau;
  while (o + 4 <= ketThuc) {
    const id = u16(b, o);
    const len = u16(b, o + 2);
    const duLieu = o + 4;
    if (duLieu + len > ketThuc) throw new LoiFileZipHong("extra field ZIP64 vượt biên");
    if (id === EXTRA_ZIP64) {
      let p = duLieu;
      const can8 = (): number => {
        if (p + 8 > duLieu + len) throw new LoiFileZipHong("extra field ZIP64 thiếu trường");
        const v = u64(b, p);
        p += 8;
        return v;
      };
      const kq: GiaTriZip64 = {};
      if (can.usz) kq.usz = can8();
      if (can.csz) kq.csz = can8();
      if (can.offset) kq.offset = can8();
      if (can.dia) {
        if (p + 4 > duLieu + len) throw new LoiFileZipHong("extra field ZIP64 thiếu trường");
        if (u32(b, p) !== 0) throw new LoiFileZipHong("ZIP nhiều phần");
      }
      return kq;
    }
    o = duLieu + len;
  }
  return null;
}

/**
 * Ném nếu ZIP vượt trần giải nén hoặc có cấu trúc không đọc được an toàn. Gọi với bytes bắt đầu
 * bằng "PK"; file không phải ZIP (CSV) thì caller đừng gọi.
 */
export function kiemZipTruocKhiDoc(b: Uint8Array): void {
  // Tìm EOCD Y HỆT SheetJS: quét lùi từ cuối, lấy chữ ký XUẤT HIỆN SAU CÙNG. Chọn khác SheetJS là
  // soi một thư mục trong khi SheetJS giải nén thư mục khác.
  let eocd = -1;
  for (let i = b.length - 4; i >= 0; i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0 || eocd + 22 > b.length || u32(b, eocd) !== SIG_EOCD) {
    throw new LoiFileZipHong("không thấy mục lục cuối file");
  }
  if (eocd >= 20 && u32(b, eocd - 20) === SIG_ZIP64_LOCATOR) throw new LoiFileZipHong("ZIP64 không được hỗ trợ");

  const soDia = u16(b, eocd + 4);
  const diaCd = u16(b, eocd + 6);
  const soMucDiaNay = u16(b, eocd + 8); // SheetJS duyệt theo ô này
  const soMucTong = u16(b, eocd + 10);
  const cdSize = u32(b, eocd + 12);
  const cdOffset = u32(b, eocd + 16);
  if (soMucDiaNay === 0xffff || soMucTong === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new LoiFileZipHong("ZIP64 không được hỗ trợ");
  }
  if (soDia !== 0 || diaCd !== 0 || soMucDiaNay !== soMucTong) throw new LoiFileZipHong("ZIP nhiều phần");
  if (soMucTong > TRAN_SO_MUC_ZIP) {
    throw new LoiFileGiaiNenQuaLon(
      `File có ${soMucTong.toLocaleString("vi-VN")} mục nén, vượt trần ${TRAN_SO_MUC_ZIP.toLocaleString("vi-VN")} — từ chối để khỏi treo máy chủ.`,
    );
  }
  if (cdOffset + cdSize > eocd) throw new LoiFileZipHong("mục lục trỏ ra ngoài file");

  const giaiNenThu = layGiaiNenThu();
  let tongKhaiBao = 0;
  let tongThat = 0;
  let o = cdOffset;
  for (let i = 0; i < soMucTong; i++) {
    if (o + 46 > eocd || u32(b, o) !== SIG_CD) throw new LoiFileZipHong("mục lục hỏng");
    const cdCsz32 = u32(b, o + 20);
    const cdUsz32 = u32(b, o + 24);
    const tenLen = u16(b, o + 28);
    const extraLen = u16(b, o + 30);
    const ghiChuLen = u16(b, o + 32);
    const diaBatDau = u16(b, o + 34);
    const localOffset32 = u32(b, o + 42);
    const ketThucMuc = o + 46 + tenLen + extraLen + ghiChuLen;
    if (ketThucMuc > eocd) throw new LoiFileZipHong("mục lục hỏng");
    // Mục mang giá trị 64-bit trong extra ZIP64: dùng số 64-bit THẬT để so trần (không từ chối oan
    // file thật thà); extra thiếu/cụt/vượt biên mà trường 32-bit đã là 0xFFFFFFFF ⇒ từ chối.
    const cdZ64 = docExtraZip64(b, o + 46 + tenLen, extraLen, {
      usz: cdUsz32 === SENTINEL_32,
      csz: cdCsz32 === SENTINEL_32,
      offset: localOffset32 === SENTINEL_32,
      dia: diaBatDau === 0xffff,
    });
    if (diaBatDau !== 0 && diaBatDau !== 0xffff) throw new LoiFileZipHong("ZIP nhiều phần");
    if (cdZ64 === null && (cdCsz32 === SENTINEL_32 || cdUsz32 === SENTINEL_32 || localOffset32 === SENTINEL_32 || diaBatDau === 0xffff)) {
      throw new LoiFileZipHong("ZIP64 thiếu extra field");
    }
    const cdUsz = cdZ64?.usz ?? cdUsz32;
    const localOffset = cdZ64?.offset ?? localOffset32;

    // Local header — nơi SheetJS THẬT SỰ lấy kích thước để cấp buffer.
    const l = localOffset;
    if (l + 30 > b.length || u32(b, l) !== SIG_LOCAL) throw new LoiFileZipHong("mục nén trỏ sai chỗ");
    const phuongPhap = u16(b, l + 8);
    const localCsz32 = u32(b, l + 18);
    const localUsz32 = u32(b, l + 22);
    const localTenLen = u16(b, l + 26);
    const localExtraLen = u16(b, l + 28);
    const batDauDuLieu = l + 30 + localTenLen + localExtraLen;
    if (batDauDuLieu > b.length) throw new LoiFileZipHong("mục nén cụt");
    // Local header ZIP64: đọc theo đúng trường nào đang là 0xFFFFFFFF (uncompressed trước, compressed sau).
    const lZ64 = docExtraZip64(b, l + 30 + localTenLen, localExtraLen, {
      usz: localUsz32 === SENTINEL_32,
      csz: localCsz32 === SENTINEL_32,
      offset: false,
      dia: false,
    });
    if (lZ64 === null && (localCsz32 === SENTINEL_32 || localUsz32 === SENTINEL_32)) {
      throw new LoiFileZipHong("ZIP64 thiếu extra field");
    }
    const localUsz = lZ64?.usz ?? localUsz32;

    tongKhaiBao += Math.max(cdUsz, localUsz);
    if (tongKhaiBao > TRAN_GIAI_NEN_ZIP_BYTES) throw loiQuaLon(tongKhaiBao);

    // Chỉ deflate (8) mới khuếch đại; stored (0) bị chặn bởi chính số byte file. Phương pháp khác
    // thì SheetJS tự ném "Unsupported ZIP Compression method" — không cần soi.
    if (phuongPhap === 8 && giaiNenThu) {
      // Giải nén từ đầu dữ liệu tới hết luồng — đúng như SheetJS (nó KHÔNG cắt theo `csz`).
      // `maxOutputLength` phải ≥ 1 (zlib ném RangeError với 0) — chạm trần đúng byte thì mục kế
      // tiếp được thử với trần 1, có byte nào là vượt.
      const conLai = Math.max(1, TRAN_GIAI_NEN_ZIP_BYTES - tongThat);
      tongThat += giaiNenThu(b.subarray(batDauDuLieu), conLai);
      if (tongThat > TRAN_GIAI_NEN_ZIP_BYTES) throw loiQuaLon(Math.max(tongThat, TRAN_GIAI_NEN_ZIP_BYTES + 1));
    }
    o = ketThucMuc;
  }
}

function loiQuaLon(soByte: number): LoiFileGiaiNenQuaLon {
  const mb = Math.ceil(soByte / MB).toLocaleString("vi-VN");
  return new LoiFileGiaiNenQuaLon(
    `File giải nén ra hơn ${mb} MB, vượt trần ${TRAN_GIAI_NEN_ZIP_BYTES / MB} MB — từ chối để khỏi treo máy chủ. ` +
      `File xuất thật chỉ vài MB; kiểm tra lại đúng file chưa.`,
  );
}
