import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";

import { parseShopeeWalletFile } from "@/lib/import/shopee-wallet-xlsx";

/**
 * Unit parser file ví Shopee ("Transaction Report"). Dựng workbook TỔNG HỢP khớp
 * SHAPE file thật (preamble + block "Tóm tắt" + header ở dòng ~17) — KHÔNG dùng
 * file thật (chứa PII số TK/khách, đã gitignore). Kiểm các bất biến red-team:
 *  - [F2] ép dấu theo cột "Dòng tiền", KHÔNG tin dấu sẵn ở "Số tiền".
 *  - Rút Tiền mã đơn "-" → orderCode null.
 *  - checksum `computed` (bucket theo Dòng tiền) khớp block "Tóm tắt".
 */

const HEADER = [
  "Ngày",
  "Loại giao dịch",
  "Chi tiết",
  "Mã đơn hàng",
  "Dòng tiền",
  "Số tiền",
  "Trạng thái",
  "Số dư Ví sau giao dịch",
];

type Summary = { totalIn: number; totalOut: number; countIn: number; countOut: number };

/** Dựng ArrayBuffer .xlsx khớp cấu trúc file ví thật (preamble + tóm tắt + header + data). */
function buildWallet(dataRows: (string | number)[][], summary: Summary): ArrayBuffer {
  const aoa: (string | number)[][] = [
    ["Báo cáo"],
    [],
    ["Thông tin tài khoản"],
    ["Tên đăng nhập (Người bán)", "hogikids"],
    ["Từ", "2026-04-19"],
    ["Đến", "2026-07-19"],
    [],
    ["Tóm tắt", "", "", "", "$", "Đơn vị", "Số giao dịch"],
    ["Tổng tiền vào", "", "", "", summary.totalIn, "VND", summary.countIn],
    ["Tổng tiền ra", "", "", "", summary.totalOut, "VND", summary.countOut],
    [],
    ["Chi tiết giao dịch"],
    [],
    HEADER,
    ...dataRows,
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Transaction Report");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

// 5 dòng: 2 Tiền vào (REVENUE + OTHER) · 3 Tiền ra (REVENUE âm, ADJUSTMENT, WITHDRAWAL).
const DATA: (string | number)[][] = [
  ["2026-06-26 10:26:33", "Doanh Thu Đơn Hàng", "Doanh Thu Đơn #A", "260620HR6W3JSW", "Tiền vào", "503310", "Giao dịch thành công", "645328"],
  // [F2] Doanh Thu nhưng "Tiền ra" — Số tiền để DƯƠNG "1620" cố ý; dấu PHẢI lấy từ Dòng tiền → âm.
  ["2026-06-20 09:00:00", "Doanh Thu Đơn Hàng", "Điều chỉnh phí", "260619ABCDEF12", "Tiền ra", "1620", "Giao dịch thành công", "141708"],
  ["2026-05-18 00:53:10", "Điều chỉnh", "Điều chỉnh Đơn 260422", "260422F7SFCQ3W", "Tiền ra", "-172007", "Giao dịch thành công", "-18037"],
  ["2026-05-05 19:36:02", "Rút Tiền", "Rút Tiền", "-", "Tiền ra", "-2097069", "Giao dịch thành công", "0"],
  ["2026-05-01 12:00:00", "Loại Lạ Chưa Biết", "abc", "ORDERX", "Tiền vào", "1000", "Giao dịch thành công", "1000"],
];

const SUMMARY: Summary = { totalIn: 504310, totalOut: -2270696, countIn: 2, countOut: 3 };

describe("parseShopeeWalletFile", () => {
  it("parse đủ 5 dòng, map loại + txnTime ISO neo +07", () => {
    const r = parseShopeeWalletFile(buildWallet(DATA, SUMMARY));
    expect(r.errors).toHaveLength(0);
    expect(r.rows).toHaveLength(5);
    expect(r.rows[0].type).toBe("REVENUE");
    expect(r.rows[0].txnTime).toBe("2026-06-26T10:26:33+07:00");
    expect(r.rows[0].amount).toBe(503310);
    expect(r.rows[0].orderCode).toBe("260620HR6W3JSW");
    expect(r.rows[2].type).toBe("ADJUSTMENT");
    expect(r.rows[2].amount).toBe(-172007);
  });

  it("[F2] ép dấu theo Dòng tiền — Doanh Thu 'Tiền ra' Số tiền dương → amount ÂM", () => {
    const r = parseShopeeWalletFile(buildWallet(DATA, SUMMARY));
    const revOut = r.rows[1];
    expect(revOut.type).toBe("REVENUE");
    expect(revOut.amount).toBe(-1620); // Số tiền file là "1620" (dương) nhưng Dòng tiền "Tiền ra"
  });

  it("Rút Tiền mã đơn '-' → orderCode null; type WITHDRAWAL; amount âm", () => {
    const r = parseShopeeWalletFile(buildWallet(DATA, SUMMARY));
    const w = r.rows[3];
    expect(w.type).toBe("WITHDRAWAL");
    expect(w.orderCode).toBeNull();
    expect(w.amount).toBe(-2097069);
  });

  it("loại lạ → OTHER + warning; vẫn vào rows (đếm vào checksum)", () => {
    const r = parseShopeeWalletFile(buildWallet(DATA, SUMMARY));
    expect(r.rows[4].type).toBe("OTHER");
    expect(r.warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("summary đọc từ block Tóm tắt + computed (bucket Dòng tiền) khớp", () => {
    const r = parseShopeeWalletFile(buildWallet(DATA, SUMMARY));
    expect(r.summary).toEqual(SUMMARY);
    expect(r.computed).toEqual(SUMMARY); // checksum sẽ PASS
  });

  it("dòng Dòng tiền không hợp lệ → error, KHÔNG vào rows và KHÔNG cộng vào Σ (checksum vẫn khớp ⇒ phải có cổng dòng lỗi)", () => {
    const bad = [...DATA, ["2026-04-30 08:00:00", "Doanh Thu Đơn Hàng", "x", "ORDBAD", "???", "5000", "ok", "1"]];
    const r = parseShopeeWalletFile(buildWallet(bad, SUMMARY));
    expect(r.rows).toHaveLength(5); // dòng lỗi bị loại
    expect(r.errors.length).toBeGreaterThanOrEqual(1);
    expect(r.computed).toEqual(SUMMARY); // dòng lỗi KHÔNG cộng vào → vẫn khớp summary cũ
  });

  it("2 dòng cùng khoá txnTime|type|đơn|tiền → duplicateKeys phát hiện (Silver sẽ gộp)", () => {
    // 2 ADJUSTMENT cùng giây, cùng mã đơn, cùng tiền — khác nhau chỉ ở runningBalance
    // (bị loại khỏi khoá) ⇒ Bronze/Silver gộp 1. Parser phải báo trùng để action chặn.
    const dup: (string | number)[][] = [
      ["2026-06-15 08:00:00", "Điều chỉnh", "x", "260601AAA", "Tiền ra", "-50000", "ok", "100000"],
      ["2026-06-15 08:00:00", "Điều chỉnh", "y", "260601AAA", "Tiền ra", "-50000", "ok", "50000"],
    ];
    const r = parseShopeeWalletFile(buildWallet(dup, { totalIn: 0, totalOut: -100000, countIn: 0, countOut: 2 }));
    expect(r.rows).toHaveLength(2);
    expect(r.duplicateKeys).toEqual(["2026-06-15T08:00:00+07:00|ADJUSTMENT|260601AAA|-50000"]);
  });

  it("khoá khác nhau → duplicateKeys rỗng (happy path)", () => {
    const r = parseShopeeWalletFile(buildWallet(DATA, SUMMARY));
    expect(r.duplicateKeys).toEqual([]);
  });

  it("ngày không tồn tại trên lịch (31/02) → dòng bị loại, KHÔNG cuộn sang 03/03", () => {
    // `new Date("2026-02-31T10:00:00+07:00")` KHÔNG NaN — V8 cuộn lịch ra 03/03/2026.
    // Tổng tiền không đổi nên checksum vẫn khớp: chỉ phân bổ theo tháng của "Tiền đã về" sai.
    const bad = [...DATA, ["2026-02-31 10:00:00", "Doanh Thu Đơn Hàng", "x", "ORDFEB31", "Tiền vào", "5000", "ok", "1"]];
    const r = parseShopeeWalletFile(buildWallet(bad, SUMMARY));
    expect(r.rows).toHaveLength(5);
    expect(r.rows.some((row) => row.orderCode === "ORDFEB31")).toBe(false);
    expect(r.errors.some((e) => e.reason.includes("'Ngày' không hợp lệ"))).toBe(true);
    expect(r.computed).toEqual(SUMMARY); // dòng lỗi không cộng vào Σ
  });

  it("29/02 năm KHÔNG nhuận bị loại, 29/02 năm nhuận vẫn qua", () => {
    const khongNhuan = [["2026-02-29 08:00:00", "Doanh Thu Đơn Hàng", "x", "ORD2026", "Tiền vào", "1000", "ok", "1"]];
    const r1 = parseShopeeWalletFile(buildWallet(khongNhuan, { totalIn: 1000, totalOut: 0, countIn: 1, countOut: 0 }));
    expect(r1.rows).toHaveLength(0);
    expect(r1.errors.some((e) => e.reason.includes("'Ngày' không hợp lệ"))).toBe(true);

    const nhuan = [["2024-02-29 08:00:00", "Doanh Thu Đơn Hàng", "x", "ORD2024", "Tiền vào", "1000", "ok", "1"]];
    const r2 = parseShopeeWalletFile(buildWallet(nhuan, { totalIn: 1000, totalOut: 0, countIn: 1, countOut: 0 }));
    expect(r2.errors).toHaveLength(0);
    expect(r2.rows[0].txnTime).toBe("2024-02-29T08:00:00+07:00");
  });

  it("ngày cuối tháng hợp lệ (30/04, 31/12) vẫn qua nguyên vẹn", () => {
    const hopLe = [
      ["2026-04-30 08:00:00", "Doanh Thu Đơn Hàng", "x", "ORDAPR30", "Tiền vào", "1000", "ok", "1"],
      ["2026-12-31 23:59:59", "Doanh Thu Đơn Hàng", "y", "ORDDEC31", "Tiền vào", "2000", "ok", "3000"],
    ];
    const r = parseShopeeWalletFile(buildWallet(hopLe, { totalIn: 3000, totalOut: 0, countIn: 2, countOut: 0 }));
    expect(r.errors).toHaveLength(0);
    expect(r.rows.map((row) => row.txnTime)).toEqual([
      "2026-04-30T08:00:00+07:00",
      "2026-12-31T23:59:59+07:00",
    ]);
  });

  it("ô ngày có hậu tố múi giờ (Z / offset khác) → LOẠI, không âm thầm neo lại +07:00", () => {
    // Regex không neo đuôi từng nuốt im lặng mọi hậu tố: "…T02:00:00Z" bị neo thành +07:00, tức
    // lệch 7 giờ và có thể rơi sang tháng khác trong card "Tiền đã về". Tổng tiền không đổi nên
    // cổng checksum vẫn khớp ⇒ hỏng câm. Đuôi lạ phải thành dòng lỗi để chủ shop nhìn thấy.
    const coDuoi = [
      ["2026-07-01T02:00:00Z", "Doanh Thu Đơn Hàng", "x", "ORDZ", "Tiền vào", "1000", "ok", "1000"],
      ["2026-07-02 02:00:00+09:00", "Doanh Thu Đơn Hàng", "y", "ORDOFF", "Tiền vào", "2000", "ok", "3000"],
      ["2026-07-03 02:00:00 rác", "Doanh Thu Đơn Hàng", "z", "ORDRAC", "Tiền vào", "3000", "ok", "6000"],
    ];
    const r = parseShopeeWalletFile(
      buildWallet(coDuoi, { totalIn: 6000, totalOut: 0, countIn: 3, countOut: 0 })
    );
    expect(r.rows).toHaveLength(0);
    expect(r.errors).toHaveLength(3);
    expect(r.errors.every((e) => e.reason.includes("'Ngày' không hợp lệ"))).toBe(true);
  });

  it("phần thập phân của giây vẫn qua (công cụ bảng tính hay thêm '.000')", () => {
    // Bỏ phần thập phân không đổi mốc thời gian — chặn ca này là từ chối oan file thật.
    const r = parseShopeeWalletFile(
      buildWallet(
        [["2026-07-01 02:00:00.000", "Doanh Thu Đơn Hàng", "x", "ORDMS", "Tiền vào", "1000", "ok", "1000"]],
        { totalIn: 1000, totalOut: 0, countIn: 1, countOut: 0 }
      )
    );
    expect(r.errors).toHaveLength(0);
    expect(r.rows[0].txnTime).toBe("2026-07-01T02:00:00+07:00");
  });

  it("file rỗng → error, không throw", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), "Transaction Report");
    const empty = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    const r = parseShopeeWalletFile(empty);
    expect(r.errors.length).toBeGreaterThanOrEqual(1);
    expect(r.rows).toHaveLength(0);
  });
});
