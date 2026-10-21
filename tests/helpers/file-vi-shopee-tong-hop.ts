import * as XLSX from "xlsx";

/**
 * Dựng file ví Shopee ("Transaction Report", `my_balance_transaction`) TỔNG HỢP khớp shape file thật:
 * preamble + block "Tóm tắt" (checksum) + dòng tiêu đề + dữ liệu. KHÔNG dùng file thật (chứa PII số
 * TK/khách, đã gitignore). Dòng dữ liệu theo thứ tự cột `HEADER_VI_SHOPEE` (truyền `header` khác để
 * dựng file thiếu cột).
 */

export const HEADER_VI_SHOPEE = [
  "Ngày",
  "Loại giao dịch",
  "Chi tiết",
  "Mã đơn hàng",
  "Dòng tiền",
  "Số tiền",
  "Trạng thái",
  "Số dư Ví sau giao dịch",
];

export type TomTatVi = { totalIn: number; totalOut: number; countIn: number; countOut: number };

export function dungFileViShopee(
  dataRows: (string | number)[][],
  summary: TomTatVi,
  header: string[] = HEADER_VI_SHOPEE,
): ArrayBuffer {
  const aoa: (string | number)[][] = [
    ["Báo cáo"],
    [],
    ["Tóm tắt", "", "", "", "$", "Đơn vị", "Số giao dịch"],
    ["Tổng tiền vào", "", "", "", summary.totalIn, "VND", summary.countIn],
    ["Tổng tiền ra", "", "", "", summary.totalOut, "VND", summary.countOut],
    [],
    ["Chi tiết giao dịch"],
    [],
    header,
    ...dataRows,
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Transaction Report");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

/** Tóm tắt tự tính từ dòng dữ liệu (cột "Dòng tiền" + "Số tiền" theo `HEADER_VI_SHOPEE`). */
export function tomTatTuDong(dataRows: (string | number)[][]): TomTatVi {
  const t: TomTatVi = { totalIn: 0, totalOut: 0, countIn: 0, countOut: 0 };
  for (const r of dataRows) {
    const tien = Math.abs(Number(r[5]));
    if (r[4] === "Tiền vào") {
      t.totalIn += tien;
      t.countIn++;
    } else {
      t.totalOut -= tien;
      t.countOut++;
    }
  }
  return t;
}
