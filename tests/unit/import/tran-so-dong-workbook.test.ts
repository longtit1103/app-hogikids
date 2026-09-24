import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";

import { LoiFileQuaNhieuDong, MAX_SHEET_ROWS, readSheetRows } from "@/lib/import/xlsx-shared";

/**
 * Trần số dòng cho mọi file import đi qua `readSheetRows`.
 *
 * Vì sao trần này tồn tại dù Server Action đã bị `bodySizeLimit: 3mb` chặn: một .xlsx ≤3MB **nén**
 * vẫn bung ra hàng triệu dòng (xlsx là ZIP). Trần byte không nói gì về số dòng sau giải nén.
 *
 * 🔴 Ca quan trọng nhất ở đây KHÔNG phải ca từ chối, mà là ca **CHẤP NHẬN** — chống vá quá tay.
 * Đo prod 22/09: `RawShopeeWalletTxn` 77 dòng tổng từ trước tới nay, `Expense` 13.529 dòng tích luỹ
 * nhiều tháng. Trần cắt nhầm = chủ shop không nhập được dữ liệu hằng tháng, tệ hơn hẳn lỗ đang vá.
 */

/** Dựng workbook `soDong` dòng × 2 cột, không materialize mảng khổng lồ ở phía test. */
function dungWorkbook(soDong: number): ArrayBuffer {
  const sheet: XLSX.WorkSheet = {
    "!ref": XLSX.utils.encode_range({ s: { c: 0, r: 0 }, e: { c: 1, r: soDong - 1 } }),
  };
  // Chỉ ghi vài ô thật — `!ref` mới là thứ `readSheetRows` kiểm, và đó chính là điều cần chốt:
  // phép kiểm phải đọc VÙNG KHAI BÁO, không phải đếm sau khi đã dựng mảng.
  sheet.A1 = { t: "s", v: "Ngày" };
  sheet.B1 = { t: "s", v: "Số tiền" };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Sheet1");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

describe("trần số dòng workbook", () => {
  it("CHẤP NHẬN file cỡ thật — chống vá quá tay", () => {
    // 20.000 dòng: lớn hơn ~260 lần file ví Shopee thật (77 dòng tổng lịch sử) và vẫn thừa cho
    // mọi kỳ ads. Nếu ca này đỏ thì trần đang cắt vào việc chủ shop làm hằng tháng.
    const aoa = readSheetRows(dungWorkbook(20_000));
    expect(aoa[0]).toEqual(["Ngày", "Số tiền"]);
  });

  it("CHẤP NHẬN đúng mốc trần (biên dưới)", () => {
    expect(() => readSheetRows(dungWorkbook(MAX_SHEET_ROWS))).not.toThrow();
  });

  it("TỪ CHỐI khi vượt trần, và nói đúng lý do", () => {
    let loi: unknown;
    try {
      readSheetRows(dungWorkbook(MAX_SHEET_ROWS + 1));
    } catch (e) {
      loi = e;
    }
    // Kiểu riêng, KHÔNG phải Error trần: caller dựa vào đây để phân biệt với "file hỏng" và báo
    // đúng lý do, kẻo chủ shop đi tải lại file lành lặn mãi không hiểu vì sao.
    expect(loi).toBeInstanceOf(LoiFileQuaNhieuDong);
    expect((loi as LoiFileQuaNhieuDong).message).toContain("vượt trần");
  });

  it("file có DỮ LIỆU THẬT vượt trần → từ chối, và báo ĐÚNG số dòng thật", () => {
    // 🔴 Ca này khác hẳn mấy ca trên: workbook có ô thật ở từng dòng, nên nó đi qua đúng đường mà
    // `sheetRows` phải cắt. Ca `!ref` đặt tay ở trên KHÔNG chứng minh được điều đó — `!ref` to mà
    // không có ô nào thì `XLSX.read` vốn đã rẻ.
    //
    // Bản vá đầu của đợt này kiểm `!ref` SAU `XLSX.read`, tức sau khi thư viện đã dựng xong toàn bộ
    // object ô ⇒ vô hiệu với chính ca bom nén. Nay trần được ép ngay trong `XLSX.read` qua
    // `sheetRows`, và `!fullref` vẫn cho biết số dòng THẬT để báo cho người dùng.
    const soDongThat = MAX_SHEET_ROWS + 5;
    const aoa: (string | number)[][] = [["Ngày", "Số tiền"]];
    for (let i = 0; i < soDongThat - 1; i++) aoa.push(["2026-09-22", 1000 + i]);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;

    let loi: unknown;
    try {
      readSheetRows(buf);
    } catch (e) {
      loi = e;
    }
    expect(loi).toBeInstanceOf(LoiFileQuaNhieuDong);
    // Báo số dòng THẬT chứ không phải số đã bị cắt — nhờ `!fullref`.
    expect((loi as LoiFileQuaNhieuDong).soDong).toBe(soDongThat);
  });

  it("CSV vượt trần → TỪ CHỐI, không cắt câm", () => {
    // ⚠️ Nhánh CSV KHÔNG đặt `!fullref` khi `sheetRows` cắt (đo thật 22/09) ⇒ nếu chỉ dựa vào
    // `!fullref` thì CSV quá dài bị CẮT ÂM THẦM: nhập thiếu tiền mà không ai biết — tệ hơn hẳn từ
    // chối thẳng. Đây là ca chốt cho hàng rào thứ hai (`aoa.length >= TRAN_DOC_SHEET`).
    const dong = ["Ngày,Số tiền"];
    for (let i = 0; i < MAX_SHEET_ROWS + 10; i++) dong.push(`2026-09-22,${1000 + i}`);
    const csv = new TextEncoder().encode(dong.join("\n"));

    expect(() => readSheetRows(csv.buffer as ArrayBuffer)).toThrow(LoiFileQuaNhieuDong);
  });

  it("CSV cỡ thật vẫn đọc đủ dòng — không cắt nhầm", () => {
    const dong = ["Ngày,Số tiền"];
    for (let i = 0; i < 5_000; i++) dong.push(`2026-09-22,${1000 + i}`);
    const csv = new TextEncoder().encode(dong.join("\n"));

    const aoa = readSheetRows(csv.buffer as ArrayBuffer);
    expect(aoa).toHaveLength(5_001); // header + 5.000 dòng, không thiếu dòng nào
  });

  it("sheet rỗng không ném — trả mảng rỗng như trước", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, {} as XLSX.WorkSheet, "Sheet1");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    expect(readSheetRows(buf)).toEqual([]);
  });
});
