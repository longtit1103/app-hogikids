import * as XLSX from "xlsx";

import { kiemZipTruocKhiDoc, LoiFileTuChoi } from "./kiem-zip-truoc-khi-doc";

export { LoiFileGiaiNenQuaLon, LoiFileTuChoi, LoiFileZipHong } from "./kiem-zip-truoc-khi-doc";

/**
 * Helper dùng CHUNG cho các parser import file tay (.xlsx/.csv): đọc workbook →
 * mảng-các-mảng, parse số tiền VND → Int, chuẩn hoá tên cột (bỏ dấu).
 *
 * Tách ra đây để 3 parser (ads-csv, cost-excel, shopee-wallet) KHÔNG mỗi nơi một
 * bản đọc-sheet / parser-tiền riêng — trước đây `readSheetRows` + parser tiền nằm
 * private trong từng file, dễ trôi lệch nhau (bug tiền âm thầm khi 1 bản sửa).
 */

/**
 * Trần số dòng cho mọi file import đi qua `readSheetRows`.
 *
 * Vì sao cần dù Server Action đã bị `bodySizeLimit: 3mb` chặn: một file .xlsx ≤3MB **nén** vẫn bung
 * ra hàng triệu dòng (xlsx là ZIP). Trần byte không nói gì về số dòng sau khi giải nén.
 *
 * Con số lấy từ SỐ ĐO prod 22/09, không phải ước lượng: `RawShopeeWalletTxn` **77 dòng** tổng từ
 * trước tới nay, `Expense` **13.529 dòng** tích luỹ nhiều tháng. 200.000 là dư hơn 4 bậc độ lớn so
 * với file thật — nó chặn ca ác ý, KHÔNG cản việc chủ shop làm hằng tháng.
 */
export const MAX_SHEET_ROWS = 200_000;

/**
 * Ném khi workbook vượt `MAX_SHEET_ROWS`. Có kiểu riêng để caller phân biệt với "file hỏng"; là con
 * của `LoiFileTuChoi` nên caller chỉ cần bắt MỘT lớp cho mọi lý do từ chối (trần dòng, zip-bomb, ZIP lạ).
 */
export class LoiFileQuaNhieuDong extends LoiFileTuChoi {
  constructor(readonly soDong: number) {
    super(
      `File có ${soDong.toLocaleString("vi-VN")} dòng, vượt trần ${MAX_SHEET_ROWS.toLocaleString("vi-VN")} dòng — từ chối để khỏi treo máy chủ.`,
    );
    this.name = "LoiFileQuaNhieuDong";
  }
}

/**
 * Số dòng tối đa truyền cho `sheetRows` của `XLSX.read`. `+1` để phân biệt "đúng trần" với "vượt trần".
 * PHẢI truyền vào chính `XLSX.read` — xem lý do ở `readSheetRows`.
 */
export const TRAN_DOC_SHEET = MAX_SHEET_ROWS + 1;

/**
 * Ném nếu sheet vượt trần. Đọc `!fullref` trước: sheetjs CHỈ đặt khoá này khi `sheetRows` thật sự
 * cắt bớt, và nó giữ vùng THẬT — nhờ vậy báo được đúng số dòng mà không phải nạp hết file.
 */
export function kiemTranSoDong(sheet: XLSX.WorkSheet): void {
  const refThat = sheet["!fullref"] ?? sheet["!ref"];
  if (!refThat) return;
  const vung = XLSX.utils.decode_range(refThat);
  const soDong = vung.e.r - vung.s.r + 1;
  if (soDong > MAX_SHEET_ROWS) throw new LoiFileQuaNhieuDong(soDong);
}

/**
 * Giải mã bytes → chuỗi. Nhận diện BOM UTF-16 LE/BE; còn lại coi là UTF-8
 * (TextDecoder mặc định tự nuốt BOM UTF-8). File Ads Manager hay xuất UTF-16.
 */
function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Đọc workbook (sheet đầu) thành mảng-các-mảng (mỗi phần tử = 1 dòng, dạng thô).
 *  - .xlsx (chữ ký ZIP "PK") → đọc nhị phân, `cellDates` để ô ngày ra Date thật.
 *  - .csv/text → tự giải mã (BOM/UTF-16) rồi `raw:true` để GIỮ NGUYÊN chuỗi gốc
 *    ("2026-07-01" thay vì bị xlsx suy ra serial lệch múi giờ).
 *
 * KHÔNG tự dò dòng header — trả AOA thô, caller tự tìm header (file ví Shopee có
 * ~17 dòng preamble + block "Tóm tắt" TRƯỚC dòng header thật).
 */
export function readSheetRows(buf: ArrayBuffer): (string | number | Date)[][] {
  const bytes = new Uint8Array(buf);
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b; // "PK" → .xlsx
  // Zip-bomb: soi kích thước giải nén TRƯỚC `XLSX.read` — cùng lý do "kiểm sau là kiểm muộn" như
  // `sheetRows` dưới đây, chỉ khác tầng (byte giải nén thay vì số dòng). Xem `kiem-zip-truoc-khi-doc.ts`.
  if (isZip) kiemZipTruocKhiDoc(bytes);
  // 🔴 Trần phải ép NGAY TRONG `XLSX.read` bằng `sheetRows`, KHÔNG phải kiểm sau.
  // `XLSX.read` dựng TOÀN BỘ object ô trước khi trả về, nên mọi phép kiểm đặt sau nó đều là kiểm
  // MUỘN: thiệt hại bộ nhớ/CPU đã xảy ra rồi. Bản vá đầu của đợt này mắc đúng lỗi đó — kiểm `!ref`
  // sau `XLSX.read` — nên vô hiệu với chính ca tấn công cần chặn.
  // Đo thật 22/09 (xlsx 0.20.3, file 300.000 dòng): `sheetRows` cắt đúng, và `!fullref` vẫn báo
  // vùng THẬT (`A1:B300001`) trong khi `!ref` là vùng đã cắt (`A1:B200001`) ⇒ vẫn báo được số dòng
  // thật cho người dùng mà không phải nạp hết.
  const wb = isZip
    ? XLSX.read(buf, { type: "array", cellDates: true, sheetRows: TRAN_DOC_SHEET })
    : XLSX.read(decodeText(bytes), { type: "string", raw: true, sheetRows: TRAN_DOC_SHEET });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];
  kiemTranSoDong(sheet);

  const aoa = XLSX.utils.sheet_to_json<(string | number | Date)[]>(sheet, { header: 1, defval: "" });

  // ⚠️ Nhánh CSV KHÔNG đặt `!fullref` khi bị cắt (đo thật 22/09) ⇒ nếu chỉ dựa vào khối trên thì một
  // CSV quá dài sẽ bị CẮT CÂM: nhập thiếu tiền mà không ai biết — tệ hơn hẳn việc từ chối thẳng.
  // Chạm đúng trần nghĩa là còn dòng phía sau bị bỏ ⇒ từ chối.
  if (aoa.length >= TRAN_DOC_SHEET) throw new LoiFileQuaNhieuDong(aoa.length);

  return aoa;
}

/** Phần nguyên: chữ số liền, hoặc nhóm nghìn ĐÚNG 3 chữ số bằng MỘT loại dấu (`.` hoặc `,`). */
const SO_NGUYEN_TRON = /^\d+$/;
const NHOM_NGHIN_CHAM = /^\d{1,3}(?:\.\d{3})+$/;
const NHOM_NGHIN_PHAY = /^\d{1,3}(?:,\d{3})+$/;
/** Đuôi thập phân 1–2 chữ số sau `.`/`,` — nhóm nghìn luôn 3 chữ số nên đuôi này KHÔNG mập mờ. */
const DUOI_THAP_PHAN = /^(.*)([.,])(\d{1,2})$/;

/**
 * Ô số tiền VND → Int (đồng) hoặc null. GIỮ dấu âm.
 *  - number → Math.round (an toàn ô số thực; xlsx đôi khi trả number).
 *  - chuỗi → bỏ ₫/đ + khoảng trắng, rồi đọc theo luật:
 *    · đuôi `[.,]` + 1–2 chữ số = PHẦN THẬP PHÂN ⇒ làm tròn (nửa xa số 0). Phần nguyên phía trước
 *      phải là chữ số liền hoặc nhóm nghìn bằng dấu KIA (`"1,234.50"`, `"1.234,50"`, `"120000.00"`).
 *    · không có đuôi đó: chữ số liền, hoặc nhóm nghìn đúng 3 chữ số bằng MỘT loại dấu
 *      (`"1.234.567"`, `"1,234,567"`, `"120.000"`) ⇒ số nguyên.
 *    · còn lại (dấu thập phân trùng dấu nghìn, nhóm lệch 3, trộn dấu, 3+ chữ số lẻ…) ⇒ null —
 *      dòng lỗi cho chủ shop sửa file, KHÔNG tự đoán.
 *
 * Vì sao không còn "xoá hết `.` `,`": file TikTok/Meta xuất `Cost = "120000.00"` (CSV đọc `raw:true`
 * giữ nguyên chuỗi) bị đọc thành 12.000.000 — chi phí ads phồng ×100. Ví Shopee cũng không cứu được
 * bằng checksum: khối "Tóm tắt" parse bằng CHÍNH hàm này nên sai cùng hệ số mà vẫn "khớp".
 */
export function parseVnInt(val: unknown): number | null {
  if (val === null || val === undefined || val === "") return null;
  if (typeof val === "number") return Number.isFinite(val) ? Math.round(val) : null;
  let s = String(val).replace(/₫/g, "").replace(/đ/gi, "").replace(/\s/g, "");
  let dau = 1;
  if (s.startsWith("-")) {
    dau = -1;
    s = s.slice(1);
  }
  if (s === "") return null;

  const thapPhan = DUOI_THAP_PHAN.exec(s);
  if (thapPhan) {
    const [, phanNguyen, dauLe, phanLe] = thapPhan;
    const nhomHopLe = dauLe === "." ? NHOM_NGHIN_PHAY : NHOM_NGHIN_CHAM; // dấu nghìn phải KHÁC dấu lẻ
    if (!SO_NGUYEN_TRON.test(phanNguyen) && !nhomHopLe.test(phanNguyen)) return null;
    const giaTri = Number(`${phanNguyen.replace(/[.,]/g, "")}.${phanLe}`);
    return dau * Math.round(giaTri) || 0; // `|| 0`: không trả -0 cho "-0.4"
  }
  if (SO_NGUYEN_TRON.test(s) || NHOM_NGHIN_CHAM.test(s) || NHOM_NGHIN_PHAY.test(s)) {
    return dau * Number.parseInt(s.replace(/[.,]/g, ""), 10) || 0;
  }
  return null;
}

/** Bỏ dấu tiếng Việt + hạ chữ thường + gộp khoảng trắng — so tên cột không phân biệt dấu/hoa-thường. */
export function normHeader(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
