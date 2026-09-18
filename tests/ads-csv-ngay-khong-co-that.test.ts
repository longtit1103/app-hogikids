import * as XLSX from "xlsx";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseAdsFile } from "@/lib/import/ads-csv";

/**
 * Ô ngày KHÔNG CÓ THẬT trong file chi tiêu ads phải thành DÒNG LỖI, tuyệt đối không được tự quy đổi.
 *
 * Vì sao phải có test này: `new Date("2026-02-31T00:00:00+07:00")` KHÔNG trả Invalid Date mà lặng lẽ
 * cho ra 03/03/2026. Không kiểm tay thì một ô gõ sai sẽ ghi chi tiêu quảng cáo sang tháng khác —
 * sai kỳ P&L mà không có lấy một cảnh báo.
 */
function csv(dong: string[]): ArrayBuffer {
  const noiDung = ["Ngày,Tên chiến dịch,Số tiền đã chi tiêu (VND)", ...dong].join("\n");
  return new TextEncoder().encode(noiDung).buffer as ArrayBuffer;
}

describe("parseAdsFile — ngày không có thật", () => {
  it("31/02 → dòng lỗi, KHÔNG tự nhảy sang 03/03", () => {
    const { rows, errors } = parseAdsFile(csv(["2026-02-31,Chiến dịch A,100000"]), "META");

    expect(rows).toHaveLength(0);
    expect(errors).toEqual([{ line: 2, reason: "Thiếu hoặc sai định dạng ngày" }]);
  });

  it("29/02 của năm KHÔNG nhuận → dòng lỗi (2026 không nhuận)", () => {
    const { rows, errors } = parseAdsFile(csv(["29/02/2026,Chiến dịch B,50000"]), "META");

    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  // Năm nhuận QUÁ KHỨ: từ khi có cổng biên trên ("không nhận ngày tương lai"), mọi fixture ngày
  // PHẢI nằm ở quá khứ — đặt năm tương lai là test tự đỏ theo thời gian. Ca 2028 (nhuận NHƯNG
  // tương lai) đã chuyển thành ca lỗi ở describe "ngày ngoài biên" dưới.
  it("29/02 của năm NHUẬN vẫn hợp lệ — không được siết nhầm thành lỗi", () => {
    const { rows, errors } = parseAdsFile(csv(["2024-02-29,Chiến dịch C,70000"]), "META");

    expect(errors).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].date.toISOString()).toBe(new Date("2024-02-29T00:00:00+07:00").toISOString());
  });

  it("31/04 (tháng 30 ngày) → dòng lỗi; dòng hợp lệ cùng file VẪN được nhận", () => {
    const { rows, errors } = parseAdsFile(
      csv(["2026-04-31,Sai ngày,10000", "2026-04-30,Đúng ngày,20000"]),
      "META",
    );

    expect(errors).toEqual([{ line: 2, reason: "Thiếu hoặc sai định dạng ngày" }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(20000);
  });

  it("tháng 13 / ngày 00 → dòng lỗi", () => {
    const { errors } = parseAdsFile(
      csv(["2026-13-01,Tháng 13,10000", "2026-05-00,Ngày 0,10000"]),
      "META",
    );

    expect(errors).toHaveLength(2);
  });
});

/**
 * Ô ngày CÓ THẬT trên lịch nhưng ở một năm vô lý cũng phải thành DÒNG LỖI.
 *
 * Vì sao: ô ngày lẫn số nhỏ đọc theo serial Excel ra 1899/1900 (đo: serial 1 → 31/12/1899,
 * serial 45 → 14/02/1900), serial lớn ra năm 2721. Cả hai đều là ngày "có thật" nên cổng
 * `laNgayCoThat` cho qua, rồi `createMany` ghi thẳng `Expense` source IMPORT ở năm đó —
 * tiền vào sổ mà KHÔNG range báo cáo nào phủ, và chủ shop không có dòng lỗi nào để sửa file.
 */
describe("parseAdsFile — ngày ngoài biên [2000-01-01, hôm nay VN]", () => {
  function xlsx(oNgay: string | number): ArrayBuffer {
    const ws = XLSX.utils.aoa_to_sheet([
      ["Ngày", "Tên chiến dịch", "Số tiền đã chi tiêu (VND)"],
      [oNgay, "Chiến dịch serial", 100000],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serial Excel = 1 → dòng lỗi, KHÔNG ghi 31/12/1899", () => {
    const { rows, errors } = parseAdsFile(xlsx(1), "META");

    expect(rows).toHaveLength(0);
    expect(errors).toEqual([{ line: 2, reason: "Thiếu hoặc sai định dạng ngày" }]);
  });

  it("serial Excel = 45 (ô ngày lẫn số nhỏ) → dòng lỗi", () => {
    const { rows, errors } = parseAdsFile(xlsx(45), "META");

    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it("serial Excel = 300000 (năm 2721) → dòng lỗi", () => {
    const { rows, errors } = parseAdsFile(xlsx(300000), "META");

    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  // Năm 5-6 chữ số: so chuỗi ĐƠN THUẦN cho kết quả NGƯỢC ("20107-01-29" đứng giữa "2000-01-01" và
  // "2026-09-18"), nên cổng phải kiểm KHUÔN khoá trước. Dải lọt đo thật là 6.610.891–6.705.853 và
  // 72.354.541–73.304.171 — đúng tầm số tiền VND, tức ca "số tiền lạc sang cột ngày".
  it.each([
    [6_610_891, "20000-01-01"],
    [6_650_000, "20107-01-29"],
    [73_000_000, "201767-03-17"],
  ])("serial Excel = %d (năm %s, 5-6 chữ số) → dòng lỗi, KHÔNG ném RangeError", (serial) => {
    const { rows, errors } = parseAdsFile(xlsx(serial), "META");

    expect(rows).toHaveLength(0);
    expect(errors).toEqual([{ line: 2, reason: "Thiếu hoặc sai định dạng ngày" }]);
  });

  it("ISO 1999-12-31 → dòng lỗi; đúng mốc 2000-01-01 → hợp lệ (biên dưới lấy cả mốc)", () => {
    expect(parseAdsFile(csv(["1999-12-31,Trước mốc,10000"]), "META").errors).toHaveLength(1);

    const { rows, errors } = parseAdsFile(csv(["2000-01-01,Đúng mốc,10000"]), "META");
    expect(errors).toHaveLength(0);
    expect(rows[0].date.toISOString()).toBe(new Date("2000-01-01T00:00:00+07:00").toISOString());
  });

  it("dd/mm/yyyy 31/12/1999 → dòng lỗi", () => {
    const { rows, errors } = parseAdsFile(csv(["31/12/1999,Định dạng VN,10000"]), "META");

    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it("29/02/2028 — nhuận nhưng TƯƠNG LAI → dòng lỗi", () => {
    // Ghim đồng hồ: không ghim thì ca này tự đỏ từ 29/02/2028 ở một file không ai vừa sửa —
    // đúng luật "mọi fixture ngày phải ở quá khứ SO VỚI mốc đã ghim".
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-18T07:00:00.000Z"));

    const { rows, errors } = parseAdsFile(csv(["2028-02-29,Nhuận tương lai,70000"]), "META");

    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it("ngày MAI (giờ VN) → dòng lỗi; HÔM NAY → hợp lệ", () => {
    // Ghim 18/09/2026 14:00 giờ VN = 07:00Z. Biên trên phải đọc theo ngày VN, không theo UTC.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-18T07:00:00.000Z"));

    expect(parseAdsFile(csv(["2026-09-19,Ngày mai,10000"]), "META").errors).toHaveLength(1);

    const { rows, errors } = parseAdsFile(csv(["2026-09-18,Hôm nay,10000"]), "META");
    expect(errors).toHaveLength(0);
    expect(rows).toHaveLength(1);
  });

  it("serial Excel 46000 (09/12/2025, quá khứ) vẫn hợp lệ — không siết oan", () => {
    const { rows, errors } = parseAdsFile(xlsx(46000), "META");

    expect(errors).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].date.toISOString()).toBe(new Date("2025-12-09T00:00:00+07:00").toISOString());
  });

  it("dòng ngoài biên KHÔNG chặn cả file — dòng hợp lệ cùng file vẫn vào rows", () => {
    const { rows, errors } = parseAdsFile(
      csv(["1900-01-05,Năm vô lý,10000", "2026-07-01,Đúng ngày,20000"]),
      "META",
    );

    expect(errors).toEqual([{ line: 2, reason: "Thiếu hoặc sai định dạng ngày" }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(20000);
  });
});
