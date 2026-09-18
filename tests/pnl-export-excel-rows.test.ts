import { describe, expect, it } from "vitest";

import { buildPnlSheetRows } from "@/components/bao-cao/report-export-buttons";
import type { PnlBreakdown } from "@/lib/reports/pnl";

/**
 * Sheet Excel của bảng Lãi/Lỗ. File này đi RA NGOÀI app (gửi kế toán, đối chiếu
 * tay) nên nó phải tự đứng vững: không có tooltip để cứu, không bấm bung được.
 *
 * Hai rủi ro canh ở đây:
 *  - Xuất THIẾU dòng con vì trên màn đang thu gọn — người nhận cộng tay ra số khác.
 *  - Mất bậc cha–con (thụt lề) ⇒ 15 dòng phẳng như nhau, không biết dòng nào cộng
 *    vào dòng nào, dễ cộng trùng cả cha lẫn con.
 */

const EMPTY: PnlBreakdown = {
  revenue: 0,
  platformFee: 0,
  returnedOrderFee: 0,
  voucher: 0,
  netRevenue: 0,
  cogs: 0,
  grossProfit: 0,
  ads: 0,
  adsBySource: {},
  shipping: 0,
  packaging: 0,
  returnBom: 0,
  fixed: 0,
  interest: 0,
  financialIncome: 0,
  other: 0,
  netProfit: 0,
  orderCount: 0,
  returnBomOrderCount: 0,
  skuMissingCount: 0,
  skuUnknownLineCount: 0,
};

const THANG: PnlBreakdown = {
  ...EMPTY,
  revenue: 59_077_432,
  voucher: 7_902,
  platformFee: 14_792_857,
  netRevenue: 44_276_673,
  cogs: 20_000_000,
  grossProfit: 24_276_673,
  ads: 5_000_000,
  adsBySource: { META: 3_000_000, TIKTOK_ADS: 2_000_000 },
  fixed: 2_000_000,
  interest: 1_500_000,
  // File Excel đi RA NGOÀI app: fixture phải có thu nhập tài chính ≠ 0, nếu không sheet không
  // chứng minh được dòng nhóm "Chi phí vận hành" và mạch cộng dọc trong file vẫn đúng.
  financialIncome: 2_000_000,
  // 24.276.673 + 2.000.000 − 8.500.000 (ads + fixed + interest) = 17.776.673
  netProfit: 17_776_673,
};
const VOUCHER = { shopLineLevel: 14_223_568, marketplaceFunded: 3_835_735 };
const PHI = [
  { key: "platform_commission", label: "Hoa hồng nền tảng", amount: 10_000_000 },
  { key: "payment_fee", label: "Phí giao dịch", amount: 3_000_000 },
];

const sheetRows = (backfilledFee = 0) =>
  buildPnlSheetRows(THANG, EMPTY, PHI, [], VOUCHER, undefined, backfilledFee, 0)[0].rows as Record<
    string,
    string | number
  >[];

const nhan = (r: Record<string, string | number>) => String(r["Khoản mục"]);

describe("buildPnlSheetRows — sheet Excel bảng Lãi/Lỗ", () => {
  it("xuất ĐỦ dòng con kể cả khi màn hình đang thu gọn", () => {
    const labels = sheetRows().map((r) => nhan(r).trim());
    for (const phai of [
      "Giá niêm yết",
      "Giảm giá sản phẩm",
      "Voucher shop tạo",
      "Hoa hồng nền tảng",
      "Phí giao dịch",
      "Meta",
      "Lãi vay",
      "Chi phí vận hành",
    ]) {
      expect(labels).toContain(phai);
    }
  });

  it("thụt lề theo bậc cây: con lùi 1 nấc, cháu lùi 2 nấc", () => {
    const rows = sheetRows();
    const doLui = (label: string) => {
      const r = rows.find((x) => nhan(x).trim() === label)!;
      return nhan(r).length - nhan(r).trimStart().length;
    };
    expect(doLui("Doanh thu")).toBe(0);
    expect(doLui("Giảm giá do người bán")).toBe(2);
    expect(doLui("Voucher shop tạo")).toBe(4);
  });

  it("Σ dòng con = dòng nhóm trên chính số đã xuất ra file", () => {
    const rows = sheetRows();
    const tien = (label: string) => Number(rows.find((x) => nhan(x).trim() === label)!["Số tiền (VND)"]);
    expect(tien("Giá niêm yết") + tien("Giảm giá do người bán")).toBe(tien("Doanh thu"));
    // Fixture cố tình khai thiếu chi tiết phí ⇒ phần hụt phải nằm ở dòng "Pancake
    // chưa trả chi tiết", cộng đủ ba dòng mới bằng dòng cha. Bỏ dòng gánh phần hụt
    // ra khỏi phép cộng là đúng lúc file Excel không còn tự cộng đúng.
    expect(
      tien("Hoa hồng nền tảng") + tien("Phí giao dịch") + tien("Pancake chưa trả chi tiết")
    ).toBe(tien("Phí sàn"));
  });

  it("mạch chính cộng dọc ra đúng dòng dưới", () => {
    const rows = sheetRows();
    const tien = (label: string) => Number(rows.find((x) => nhan(x).trim() === label)!["Số tiền (VND)"]);
    expect(tien("Doanh thu") + tien("Phí sàn")).toBe(tien("Thực nhận từ sàn"));
    expect(tien("Thực nhận từ sàn") + tien("COGS")).toBe(tien("LN gộp"));
    expect(tien("LN gộp") + tien("Thu nhập tài chính") + tien("Chi phí vận hành")).toBe(tien("LN ròng"));
    // Non-vacuity: bỏ dòng thu nhập ra thì phép cộng phải SAI — người nhận file cộng thiếu 1 dòng
    // là ra số khác, đúng cái sheet này phải chứng minh.
    expect(tien("LN gộp") + tien("Chi phí vận hành")).not.toBe(tien("LN ròng"));
  });

  it("khoản trừ mang dấu âm, khoản thu mang dấu dương", () => {
    const rows = sheetRows();
    const tien = (label: string) => Number(rows.find((x) => nhan(x).trim() === label)!["Số tiền (VND)"]);
    expect(tien("Phí sàn")).toBeLessThan(0);
    expect(tien("COGS")).toBeLessThan(0);
    expect(tien("Doanh thu")).toBeGreaterThan(0);
  });

  it("có phí đơn bù → xuất thành dòng riêng, không trộn vào 'Pancake chưa trả'", () => {
    const labels = sheetRows(1_000_000).map((r) => nhan(r).trim());
    expect(labels).toContain("Đơn bù — phí ước tính");
    expect(labels).toContain("Pancake chưa trả chi tiết");
  });

  it("dòng 'Doanh thu' luôn 100% — mẫu số cột % là chính dòng Doanh thu đang hiển thị", () => {
    // Voucher đặt 10% doanh thu để phép làm tròn 1 chữ số không che được lỗi: mẫu số cũ (doanh thu
    // gộp) làm chính dòng mang nhãn 'Doanh thu' hiện 90% ngay dưới tiêu đề cột '% Doanh thu' —
    // bảng tự mâu thuẫn, biên gộp/ròng cũng không cùng cơ sở với dòng đầu bảng.
    const thang: PnlBreakdown = { ...THANG, revenue: 50_000_000, voucher: 5_000_000 };
    const rows = buildPnlSheetRows(thang, EMPTY, PHI, [], VOUCHER, undefined, 0, 0)[0].rows as Record<
      string,
      string | number
    >[];
    const r = rows.find((x) => String(x["Khoản mục"]).trim() === "Doanh thu")!;
    expect(r["% Doanh thu"]).toBe(100);
  });

  it("dòng 'Sàn trợ giá thêm' mang ghi chú nói rõ nó NGOÀI phép cộng", () => {
    // Trên màn/PDF có chú thích in thẳng; file Excel không có tooltip nên thiếu cột này là người
    // nhận SUM các dòng con của Doanh thu sẽ cộng thừa đúng khoản sàn chịu — chính test này từng
    // phải tự loại dòng đó khỏi phép cộng ở ca 'Σ dòng con = dòng nhóm' mà không nói cho ai biết.
    const rows = sheetRows();
    const r = rows.find((x) => nhan(x).trim() === "Sàn trợ giá thêm")!;
    expect(String(r["Ghi chú"])).toMatch(/không cộng cũng không trừ/);
  });

  it("caveat 'Đơn bù — phí ước tính' sống sót trong file xuất", () => {
    const rows = sheetRows(1_000_000);
    const r = rows.find((x) => nhan(x).trim() === "Đơn bù — phí ước tính")!;
    expect(String(r["Ghi chú"])).toMatch(/ước/);
  });

  it("dòng 'Lãi vay' mang ghi chú nói rõ tiền GỐC không nằm ở đây", () => {
    // Người nhận file không có tooltip: thiếu câu này là dễ tưởng dòng Lãi vay đã gồm cả tiền
    // trả gốc, rồi trừ tiếp phần gốc ở sổ quỹ ⇒ tính lỗ oan đúng bằng khoản gốc.
    const rows = sheetRows();
    const r = rows.find((x) => nhan(x).trim() === "Lãi vay")!;
    expect(Number(r["Số tiền (VND)"])).toBe(-1_500_000);
    expect(String(r["Ghi chú"])).toContain("GỐC");
  });

  it("dòng có hint (không có note) cũng giữ được lời giải thích", () => {
    const rows = sheetRows();
    const r = rows.find((x) => nhan(x).trim() === "Pancake chưa trả chi tiết")!;
    expect(String(r["Ghi chú"])).toMatch(/chưa báo từng loại/);
  });

  it("dòng 'Thu nhập tài chính' xuất ra file, mang dấu DƯƠNG và ghi chú giải thích", () => {
    const rows = sheetRows();
    const r = rows.find((x) => nhan(x).trim() === "Thu nhập tài chính")!;
    expect(Number(r["Số tiền (VND)"])).toBe(2_000_000); // dương — là khoản thu, không phải chi
    expect(String(r["Ghi chú"])).toContain("tất toán");
  });

  it("dòng 'LN ròng' nói rõ kỳ này có gồm thu nhập tài chính (file không có tooltip)", () => {
    // Người nhận file không rê chuột được: thiếu câu này là đọc biên ròng như lãi từ bán hàng.
    const rows = sheetRows();
    const r = rows.find((x) => nhan(x).trim() === "LN ròng")!;
    expect(String(r["Ghi chú"])).toContain("thu nhập tài chính");
    expect(String(r["Ghi chú"])).toContain("2.000.000");
  });
});
