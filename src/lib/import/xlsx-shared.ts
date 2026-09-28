import * as XLSX from "xlsx";

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

/** Ném khi workbook vượt `MAX_SHEET_ROWS`. Có kiểu riêng để caller phân biệt với "file hỏng". */
export class LoiFileQuaNhieuDong extends Error {
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

/**
 * Ô số tiền VND → Int (đồng) hoặc null. GIỮ dấu âm.
 *  - number → Math.round (an toàn ô số thực; xlsx đôi khi trả number).
 *  - chuỗi → bỏ ₫/đ + dấu ngăn nghìn (`.` `,`) + khoảng trắng rồi parseInt.
 *
 * VND không có phần lẻ trong các file import (ads/giá vốn/ví Shopee) nên `.` `,`
 * đều là dấu ngăn nghìn. Không parse được số nguyên → null.
 */
export function parseVnInt(val: unknown): number | null {
  if (val === null || val === undefined || val === "") return null;
  if (typeof val === "number") return Number.isFinite(val) ? Math.round(val) : null;
  const s = String(val)
    .replace(/₫/g, "")
    .replace(/đ/gi, "")
    .replace(/[.,\s]/g, "")
    .trim();
  if (s === "" || !/^-?\d+$/.test(s)) return null;
  return Number.parseInt(s, 10);
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
