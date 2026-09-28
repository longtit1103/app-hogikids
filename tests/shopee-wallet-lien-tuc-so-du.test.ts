import { describe, expect, it } from "vitest";

import { thongDiepGaySoDu, timGaySoDuVi } from "@/lib/import/shopee-wallet-lien-tuc-so-du";
import type { ParsedWalletRow } from "@/lib/import/shopee-wallet-xlsx";

/**
 * Cổng liên-tục-số-dư — SỐ LẤY TỪ CẶP FILE THẬT kỳ 01–31/05/2026 (xuất 2 lần ngày
 * 13/08: một lần "Tất cả", một lần lọc chỉ "Doanh Thu Đơn Hàng"). File thật chứa PII
 * nên không commit (gitignore `/*.xlsx`); hai bảng số dưới đây chép nguyên giá trị
 * amount/runningBalance/txnTime từ chúng — đây là điểm khác cốt tử với fixture "viết
 * tay cho qua test": chuỗi số dư này là thứ Shopee THẬT phát ra, gãy ở đúng chỗ file
 * thật gãy. Bài học phantom-guard của PR #73.
 */

const dong = (txnTime: string, type: ParsedWalletRow["type"], amount: number, runningBalance: number): ParsedWalletRow => ({
  txnTime,
  type,
  orderCode: type === "WITHDRAWAL" ? null : "DONTEST",
  amount,
  status: "Giao dịch thành công",
  runningBalance,
});

/** FILE A — "Tất cả" (9 dòng, thứ tự MỚI→CŨ y như file Shopee in). */
const FILE_A_MOI_TRUOC: ParsedWalletRow[] = [
  dong("2026-05-18T15:11:20+07:00", "REVENUE", 160055, 142018),
  dong("2026-05-18T00:53:10+07:00", "ADJUSTMENT", -172007, -18037),
  dong("2026-05-17T17:39:33+07:00", "REVENUE", 153970, 153970),
  dong("2026-05-05T19:36:02+07:00", "WITHDRAWAL", -2097069, 0),
  dong("2026-05-05T19:22:51+07:00", "REVENUE", 763889, 2097069),
  dong("2026-05-03T01:02:10+07:00", "REVENUE", -1620, 1333180),
  dong("2026-05-02T16:13:08+07:00", "REVENUE", 170387, 1334800),
  dong("2026-05-01T19:09:07+07:00", "REVENUE", 170387, 1164413),
  dong("2026-05-01T11:32:09+07:00", "REVENUE", 170387, 994026),
];

/** FILE B — cùng kỳ nhưng lọc chỉ "Doanh Thu Đơn Hàng" (7 dòng): mất WITHDRAWAL + ADJUSTMENT. */
const FILE_B_LOC: ParsedWalletRow[] = FILE_A_MOI_TRUOC.filter((r) => r.type === "REVENUE");

describe("timGaySoDuVi — cổng bắt file ví xuất thiếu dòng", () => {
  it("file ĐỦ (số thật file A): chuỗi liền mạch, không chặn", () => {
    const r = timGaySoDuVi(FILE_A_MOI_TRUOC, true);
    expect(r.gay).toEqual([]);
    expect(r.boQuaViSao).toBeNull();
  });

  it("file LỌC (số thật file B): đứt đúng 2 chỗ — vị trí WITHDRAWAL và ADJUSTMENT biến mất", () => {
    const r = timGaySoDuVi(FILE_B_LOC, true);
    expect(r.gay).toHaveLength(2);
    // Chỗ đứt 1: giữa REVENUE 05/05 19:22 (soDu 2.097.069) và REVENUE 17/05 (soDu 153.970)
    expect(r.gay[0]).toContain("2026-05-05T19:22:51+07:00");
    expect(r.gay[0]).toContain("2026-05-17T17:39:33+07:00");
    // Chỗ đứt 2: giữa REVENUE 17/05 và REVENUE 18/05 15:11 (mất ADJUSTMENT 18/05 00:53)
    expect(r.gay[1]).toContain("2026-05-18T15:11:20+07:00");
    expect(r.boQuaViSao).toBeNull();
  });

  it("chiều CŨ→MŨI (đảo file A): vẫn liền mạch — guard không phụ thuộc chiều in", () => {
    const r = timGaySoDuVi([...FILE_A_MOI_TRUOC].reverse(), true);
    expect(r.gay).toEqual([]);
  });

  it("chiều CŨ→MỚI của file LỌC: vẫn bắt đủ 2 chỗ đứt", () => {
    const r = timGaySoDuVi([...FILE_B_LOC].reverse(), true);
    expect(r.gay).toHaveLength(2);
  });

  it("nhóm CÙNG GIÂY: thứ tự nội bộ nhóm không xác định — chỉ so biên nhóm, không chặn oan", () => {
    // 2 dòng cùng giây, tổng nhóm +300, số dư biên khớp: 1000 → 1300.
    const rows: ParsedWalletRow[] = [
      dong("2026-06-02T10:00:00+07:00", "REVENUE", 200, 1300), // dòng ĐẦU file = giao dịch muộn nhất trong nhóm
      dong("2026-06-02T10:00:00+07:00", "REVENUE", 100, 1100),
      dong("2026-06-01T09:00:00+07:00", "REVENUE", 1000, 1000),
    ];
    expect(timGaySoDuVi(rows, true).gay).toEqual([]);
  });

  it("thiếu cột số dư → RÚT LUI kèm lý do, không chặn (runningBalance toàn 0 là số GIẢ)", () => {
    const r = timGaySoDuVi(FILE_B_LOC, false);
    expect(r.gay).toEqual([]);
    expect(r.boQuaViSao).toContain("Số dư");
  });

  it("có trạng thái giao dịch lạ → RÚT LUI (chưa rõ có đổi số dư không), nêu đúng trạng thái", () => {
    const rows = [...FILE_A_MOI_TRUOC];
    rows[3] = { ...rows[3], status: "Đang xử lý" };
    const r = timGaySoDuVi(rows, true);
    expect(r.gay).toEqual([]);
    expect(r.boQuaViSao).toContain("Đang xử lý");
  });

  it("file không theo thứ tự thời gian → RÚT LUI (nhóm liền kề không còn mô tả ledger)", () => {
    const rows = [FILE_A_MOI_TRUOC[3], FILE_A_MOI_TRUOC[0], FILE_A_MOI_TRUOC[6]];
    const r = timGaySoDuVi(rows, true);
    expect(r.gay).toEqual([]);
    expect(r.boQuaViSao).toContain("thứ tự");
  });

  it("0–1 nhóm: không có biên để so → không chặn, không rút lui", () => {
    expect(timGaySoDuVi([], true)).toEqual({ gay: [], boQuaViSao: null });
    expect(timGaySoDuVi([FILE_A_MOI_TRUOC[0]], true).gay).toEqual([]);
    // 2 dòng cùng giây = 1 nhóm
    const cungGiay = [
      dong("2026-06-02T10:00:00+07:00", "REVENUE", 200, 700),
      dong("2026-06-02T10:00:00+07:00", "REVENUE", 100, 500),
    ];
    expect(timGaySoDuVi(cungGiay, true).gay).toEqual([]);
  });

  it("thông điệp chặn nói rõ nguyên nhân + cách sửa", () => {
    const msg = thongDiepGaySoDu(timGaySoDuVi(FILE_B_LOC, true).gay);
    expect(msg).toContain("Loại giao dịch = TẤT CẢ");
    expect(msg).toContain("đứt 2 chỗ");
  });
});
