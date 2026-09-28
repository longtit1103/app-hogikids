import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  khoaNgayVnHomNay,
  laNgayChiTieuAdsHopLy,
  NGAY_CHI_TIEU_ADS_SOM_NHAT,
} from "@/lib/ingest/ngay-chi-tieu-ads-hop-ly";

/**
 * Unit test THUẦN (không DB) ghim đúng công thức "+7h rồi cắt ngày" của biên ngày chi tiêu ads.
 *
 * Ghim đồng hồ bằng `vi.setSystemTime` thay vì đọc `new Date()` thật lúc test chạy — mục đích DUY
 * NHẤT: bắt lỗi kinh điển "quên +7h" (implement bằng UTC thay vì giờ VN). Giá trị kỳ vọng viết CHUỖI
 * HẰNG tay, không suy lại từ `khoaNgayVnHomNay()` — suy từ chính hàm đang kiểm là tự vá lỗi của nó,
 * ca đỏ sẽ không bao giờ bật dù implementation sai.
 */
describe("khoaNgayVnHomNay + laNgayChiTieuAdsHopLy", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("biên nửa đêm VN (UTC+7, không DST)", () => {
    it('23:59:59.999 giờ VN (UTC "2026-09-23T16:59:59.999Z") → vẫn thuộc ngày 2026-09-23', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-23T16:59:59.999Z"));
      expect(khoaNgayVnHomNay()).toBe("2026-09-23");
      expect(laNgayChiTieuAdsHopLy("2026-09-23")).toBe(true);
      expect(laNgayChiTieuAdsHopLy("2026-09-24")).toBe(false);
    });

    it('00:00:00.000 giờ VN (UTC "2026-09-23T17:00:00.000Z") → đã sang ngày 2026-09-24', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-23T17:00:00.000Z"));
      expect(khoaNgayVnHomNay()).toBe("2026-09-24");
      expect(laNgayChiTieuAdsHopLy("2026-09-24")).toBe(true);
    });

    it('00:30:00 giờ VN (UTC "2026-09-23T17:30:00.000Z") → vẫn 2026-09-24, không lùi lại ngày cũ', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-23T17:30:00.000Z"));
      expect(khoaNgayVnHomNay()).toBe("2026-09-24");
      expect(laNgayChiTieuAdsHopLy("2026-09-24")).toBe(true);
    });
  });

  describe("biên dưới NGAY_CHI_TIEU_ADS_SOM_NHAT", () => {
    beforeEach(() => {
      // Giữa ngày VN, không chạm mép nửa đêm ở trên — chỉ để "hôm nay" chắc chắn sau 2000-01-01.
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-23T05:00:00.000Z"));
    });

    it('hằng số biên dưới = "2000-01-01"', () => {
      expect(NGAY_CHI_TIEU_ADS_SOM_NHAT).toBe("2000-01-01");
    });

    it("2000-01-01 (đúng mép) → hợp lệ", () => {
      expect(laNgayChiTieuAdsHopLy("2000-01-01")).toBe(true);
    });

    it("1999-12-31 (trước mép 1 ngày) → không hợp lệ", () => {
      expect(laNgayChiTieuAdsHopLy("1999-12-31")).toBe(false);
    });
  });

  describe("kiểm khuôn YYYY-MM-DD TRƯỚC khi so chuỗi", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-23T05:00:00.000Z"));
    });

    it('năm 5 chữ số "20107-01-29" → false dù so chuỗi sẽ lọt (ký tự thứ 3 "1" nằm giữa "0" và "2" của "2026-…")', () => {
      expect(laNgayChiTieuAdsHopLy("20107-01-29")).toBe(false);
    });

    it('thiếu số 0 đệm "2026-9-01" → false', () => {
      expect(laNgayChiTieuAdsHopLy("2026-9-01")).toBe(false);
    });

    it("chuỗi rỗng → false", () => {
      expect(laNgayChiTieuAdsHopLy("")).toBe(false);
    });
  });

  /**
   * Khuôn đúng mà ngày KHÔNG có thật: JS tự quy đổi `2026-02-30` → 02/03 nhưng `dateKey` vẫn "02-30"
   * (cổng "ngày đã ghi đè bằng file" so theo `dateKey` bỏ lỡ ⇒ đếm 2 lần); `2025-13-45` thành Invalid
   * Date và Prisma nổ giữa transaction, kéo đổ cả lô.
   */
  describe("ngày phải CÓ THẬT trên lịch", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-23T05:00:00.000Z"));
    });

    it.each([
      ["30/02 không có thật", "2026-02-30"],
      ["29/02 năm không nhuận", "2026-02-29"],
      ["tháng 13", "2025-13-45"],
      ["tháng 00", "2026-00-10"],
      ["ngày 00", "2026-03-00"],
      ["31/04", "2026-04-31"],
    ])("%s (%s) → false", (_nhan, khoa) => {
      expect(laNgayChiTieuAdsHopLy(khoa)).toBe(false);
    });

    it("29/02 năm NHUẬN (2024-02-29) → hợp lệ (không chặn oan)", () => {
      expect(laNgayChiTieuAdsHopLy("2024-02-29")).toBe(true);
    });
  });
});
