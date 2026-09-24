import { afterEach, describe, expect, it, vi } from "vitest";

import { chuanBiDongAdsHoacBoQua, prepareAdsExpenseRow } from "@/lib/ingest/ads-expense-row";

/**
 * Unit test THUẦN (không DB) ghim CÔNG THỨC CHUNG của một dòng chi tiêu quảng cáo — dùng cho cả
 * `/api/ingest/ads` lẫn lượt dựng lại từ kho thô.
 *
 * `refId` là khoá idempotent ĐANG SỐNG trên prod: đổi format là mọi dòng chi phí quảng cáo cũ thành
 * mồ côi và đêm sau ingest đẻ bản sao — chi phí đếm 2 lần. Nên ghim bằng chuỗi viết tay, không suy
 * lại từ chính hàm đang kiểm.
 */
const row = (extra: Record<string, unknown> = {}) => ({
  date: "2026-07-01",
  campaignId: "C1",
  campaignName: "Chiến dịch 1",
  spendExVat: 130_000,
  vatRate: 0.1,
  ...extra,
});

describe("prepareAdsExpenseRow", () => {
  it("Meta → khoá trần `META:<ngày>:<campaign>`", () => {
    expect(prepareAdsExpenseRow("META", row()).refId).toBe("META:2026-07-01:C1");
  });

  it("TikTok GMV Max (và dòng không khai loại) → khoá TRẦN, giữ nguyên refId prod cũ", () => {
    expect(prepareAdsExpenseRow("TIKTOK_ADS", row({ adType: "gmv_max" })).refId).toBe("TIKTOK_ADS:2026-07-01:C1");
    expect(prepareAdsExpenseRow("TIKTOK_ADS", row()).refId).toBe("TIKTOK_ADS:2026-07-01:C1");
  });

  it("TikTok auction → khoá mang infix `auction:` (2 loại chiến dịch = 2 khoản chi)", () => {
    expect(prepareAdsExpenseRow("TIKTOK_ADS", row({ adType: "auction" })).refId).toBe(
      "TIKTOK_ADS:auction:2026-07-01:C1"
    );
  });

  it("amount = làm tròn (chi tiêu chưa thuế × (1 + VAT)) trên TỪNG dòng", () => {
    expect(prepareAdsExpenseRow("META", row()).amount).toBe(143_000);
    expect(prepareAdsExpenseRow("META", row({ spendExVat: 81_617 })).amount).toBe(89_779);
    expect(prepareAdsExpenseRow("META", row({ vatRate: 0 })).amount).toBe(130_000);
  });

  it("ngày neo 00:00 giờ VN", () => {
    expect(prepareAdsExpenseRow("META", row()).date.toISOString()).toBe("2026-06-30T17:00:00.000Z");
  });

  it("thiếu tên chiến dịch → mô tả rơi về mã chiến dịch (không để dòng chi phí trống tên)", () => {
    expect(prepareAdsExpenseRow("META", row({ campaignName: "" })).description).toBe("C1");
  });

  /**
   * Cửa MÁY phải đi CÙNG biên ngày với cửa FILE (`ads-csv.ts`): `[2000-01-01, hôm nay giờ VN]`.
   * Ngày hỏng lọt vào là `Expense` nằm ở năm không range báo cáo nào phủ — tiền vào sổ mà không ai thấy.
   */
  describe("biên ngày [2000-01-01, hôm nay giờ VN]", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("mép dưới 2000-01-01 → nhận", () => {
      expect(prepareAdsExpenseRow("META", row({ date: "2000-01-01" })).dateKey).toBe("2000-01-01");
    });

    // Đồng hồ ghim CHUỖI HẰNG (không suy từ `khoaNgayVnHomNay()`) — mù với lỗi "quên +7h" nếu suy
    // ngược lại từ chính hàm đang bảo vệ. UTC 17:30Z hôm trước = 00:30 giờ VN hôm sau.
    it("mép trên HÔM NAY giờ VN — đồng hồ ghim 2026-09-23T17:30:00Z (00:30 giờ VN 24/09) → 2026-09-24 nhận", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-23T17:30:00.000Z"));
      expect(prepareAdsExpenseRow("META", row({ date: "2026-09-24" })).dateKey).toBe("2026-09-24");
    });

    it.each([
      ["1970-01-01 (epoch 0 — phép tính ngày hỏng kinh điển)", "1970-01-01"],
      ["1999-12-31 (sát mép dưới)", "1999-12-31"],
      ["2126-08-19 (năm tương lai xa)", "2126-08-19"],
      ["năm 5 chữ số — so chuỗi sẽ cho lọt nếu không kiểm khuôn", "20107-01-29"],
    ])("%s → THROW, không trả dòng nào để ghi", (_nhan, date) => {
      expect(() => prepareAdsExpenseRow("META", row({ date }))).toThrow(/ngoài khoảng/);
    });

    it("NGÀY MAI giờ VN — đồng hồ ghim 2026-09-23T17:30:00Z (hôm nay VN = 2026-09-24) → 2026-09-25 THROW", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-23T17:30:00.000Z"));
      expect(() => prepareAdsExpenseRow("TIKTOK_ADS", row({ date: "2026-09-25" }))).toThrow(/ngoài khoảng/);
    });
  });

  describe("chuanBiDongAdsHoacBoQua — bỏ ĐÚNG dòng hỏng, không ném, chỉ cảnh báo", () => {
    it("dòng hợp lệ → trả object đã chuẩn bị, KHÔNG đẩy cảnh báo nào", () => {
      const warnings: string[] = [];
      const r = chuanBiDongAdsHoacBoQua("META", row(), warnings);
      expect(r).not.toBeNull();
      expect(r!.refId).toBe("META:2026-07-01:C1");
      expect(warnings).toHaveLength(0);
    });

    it("dòng ngày ngoài biên (1970-01-01) → trả null, KHÔNG ném, đúng 1 cảnh báo nêu rõ ngày + lý do", () => {
      const warnings: string[] = [];
      const r = chuanBiDongAdsHoacBoQua("META", row({ date: "1970-01-01" }), warnings);
      expect(r).toBeNull();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("1970-01-01");
      expect(warnings[0]).toMatch(/ngoài khoảng/);
    });
  });
});
