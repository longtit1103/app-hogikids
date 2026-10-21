import { describe, expect, it } from "vitest";

import { parseAdsFile } from "@/lib/import/ads-csv";

/**
 * Cổng của cửa FILE ads tay (unit thuần, không DB):
 *  - Số tiền < 0 ⇒ dòng lỗi (nhập tay đã bắt > 0); số tiền đúng 0đ ⇒ bỏ lặng lẽ + đếm `skippedZero`
 *    (chiến dịch tạm dừng là chuyện thường của file xuất). Dòng 0đ/âm lọt vào sổ thì ngày đó coi như
 *    "đã ghi bằng file" ⇒ chặn mọi dòng ADS_API thật; số âm còn giảm chi phí.
 *  - File Meta KHÔNG chia theo ngày (chỉ có `Reporting starts/ends` của cả kỳ) ⇒ từ chối cả file:
 *    nhận vào là gộp cả kỳ về ngày đầu, chế độ ghi đè còn đếm đôi các ngày còn lại.
 *  - Alias cột theo THỨ TỰ ƯU TIÊN: file có cả "Day" lẫn "Reporting starts" phải lấy "Day".
 */
function csv(header: string, dong: string[]): ArrayBuffer {
  return new TextEncoder().encode([header, ...dong].join("\n")).buffer as ArrayBuffer;
}

describe("parseAdsFile — số tiền không âm, 0đ bỏ lặng lẽ", () => {
  it("số âm ⇒ dòng lỗi; 0đ ⇒ KHÔNG lỗi, chỉ đếm skippedZero; dòng dương cùng file vẫn nhận", () => {
    const { rows, errors, skippedZero } = parseAdsFile(
      csv("Date,Campaign name,Cost", ["2026-07-01,A,0", "2026-07-02,B,-50000", "2026-07-03,C,120000.00"]),
      "TIKTOK",
    );
    expect(errors).toEqual([{ line: 3, reason: "Số tiền phải lớn hơn 0 (đọc được: -50000)" }]);
    expect(skippedZero).toBe(1);
    // "120000.00" là 120.000 đồng, KHÔNG phải 12.000.000.
    expect(rows.map((r) => r.amount)).toEqual([120000]);
  });

  it("số lẻ nhỏ làm tròn về 0 (\"0.40\") cũng bỏ lặng lẽ như 0đ", () => {
    const { rows, errors, skippedZero } = parseAdsFile(csv("Date,Campaign name,Cost", ["2026-07-01,A,0.40"]), "TIKTOK");
    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(0);
    expect(skippedZero).toBe(1);
  });

  it("file không có dòng 0đ ⇒ skippedZero = 0", () => {
    const { skippedZero } = parseAdsFile(csv("Date,Campaign name,Cost", ["2026-07-01,A,1000"]), "TIKTOK");
    expect(skippedZero).toBe(0);
  });
});

describe("parseAdsFile — file Meta phải chia theo ngày", () => {
  const HEADER = "Reporting starts,Reporting ends,Campaign name,Amount spent (VND)";

  it("Reporting starts ≠ Reporting ends ⇒ từ chối CẢ file kèm hướng dẫn xuất theo ngày", () => {
    const { rows, errors } = parseAdsFile(
      csv(HEADER, ["2026-10-01,2026-10-01,A,100000", "2026-10-01,2026-10-20,B,2000000"]),
      "META",
    );
    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].line).toBe(3);
    expect(errors[0].reason).toContain("không chia theo ngày");
    expect(errors[0].reason).toContain("01/10/2026 → 20/10/2026");
    expect(errors[0].reason).toContain("Ngày");
  });

  it("ô Reporting ends trống/không đọc được ⇒ cũng từ chối (không kiểm được là theo ngày)", () => {
    const { rows, errors } = parseAdsFile(csv(HEADER, ["2026-10-01,,A,100000"]), "META");
    expect(rows).toHaveLength(0);
    expect(errors[0].reason).toContain("không chia theo ngày");
  });

  it("starts == ends từng dòng ⇒ nhận bình thường", () => {
    const { rows, errors } = parseAdsFile(
      csv(HEADER, ["2026-10-01,2026-10-01,A,100000", "2026-10-02,2026-10-02,A,110000"]),
      "META",
    );
    expect(errors).toHaveLength(0);
    expect(rows.map((r) => r.amount)).toEqual([100000, 110000]);
  });

  it("có cột Day ⇒ lấy Day (ưu tiên alias) dù Reporting starts/ends là cả kỳ — không từ chối oan", () => {
    // Bản xuất Meta có breakdown theo ngày vẫn kèm 2 cột kỳ báo cáo đứng TRƯỚC cột Day.
    const { rows, errors } = parseAdsFile(
      csv("Reporting starts,Reporting ends,Day,Campaign name,Amount spent (VND)", [
        "2026-10-01,2026-10-20,2026-10-05,A,100000",
        "2026-10-01,2026-10-20,2026-10-06,A,110000",
      ]),
      "META",
    );
    expect(errors).toHaveLength(0);
    expect(rows.map((r) => r.date.toISOString())).toEqual([
      new Date("2026-10-05T00:00:00+07:00").toISOString(),
      new Date("2026-10-06T00:00:00+07:00").toISOString(),
    ]);
  });

  it("chỉ có Reporting starts, không có Reporting ends ⇒ nhận (không có gì để đối chiếu)", () => {
    const { rows, errors } = parseAdsFile(
      csv("Reporting starts,Campaign name,Amount spent (VND)", ["2026-10-01,A,100000"]),
      "META",
    );
    expect(errors).toHaveLength(0);
    expect(rows).toHaveLength(1);
  });
});
