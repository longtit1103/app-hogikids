import { describe, expect, it } from "vitest";

import { formatPlatformFeeRatio, isProvisionalPlatformFee, PROVISIONAL_FEE_MAX_RATIO } from "@/lib/orders/provisional-fee";

/**
 * Nhãn "phí sàn tạm tính": đơn marketplace (Shopee/TikTok) có phí < 10% doanh
 * thu → sàn chưa đối soát, lãi hiển thị đang cao hơn thực tế. Số liệu prod thật
 * 2026-07: đơn tạm ~5%, đơn đã đối soát ~27-36%.
 */
const base = { channelId: "tiktok", status: "COMPLETED" as const, itemsTotal: 345_000, platformFeeEst: 17_250 };

describe("isProvisionalPlatformFee", () => {
  it("gắn khi đơn TikTok phí đúng ~5% (dưới ngưỡng)", () => {
    expect(isProvisionalPlatformFee(base)).toBe(true);
  });

  it("gắn khi đơn Shopee phí thấp bất thường", () => {
    expect(isProvisionalPlatformFee({ ...base, channelId: "shopee", platformFeeEst: 20_000 })).toBe(true);
  });

  it("KHÔNG gắn khi phí đã đối soát (~27%)", () => {
    expect(isProvisionalPlatformFee({ ...base, platformFeeEst: 93_150 })).toBe(false);
  });

  it("ngưỡng đúng 10% coi là ĐÃ đủ (không tạm) — mốc là '< 10%'", () => {
    // 10% chẵn: 34_500 / 345_000 = 0.1 → không < 0.1 → false
    expect(isProvisionalPlatformFee({ ...base, platformFeeEst: 34_500 })).toBe(false);
    // ngay dưới mốc → true
    expect(isProvisionalPlatformFee({ ...base, platformFeeEst: 34_499 })).toBe(true);
  });

  it("KHÔNG gắn kênh không có phí thật (Facebook/Website) — dù phí 0", () => {
    expect(isProvisionalPlatformFee({ ...base, channelId: "facebook", platformFeeEst: 0 })).toBe(false);
    expect(isProvisionalPlatformFee({ ...base, channelId: "website", platformFeeEst: 0 })).toBe(false);
  });

  it("KHÔNG gắn đơn hoàn/hủy (không tính vào lãi nên không gây hiểu nhầm)", () => {
    expect(isProvisionalPlatformFee({ ...base, status: "RETURNED", platformFeeEst: 0 })).toBe(false);
    expect(isProvisionalPlatformFee({ ...base, status: "CANCELLED", platformFeeEst: 0 })).toBe(false);
  });

  it("gắn khi phí = 0 trên đơn marketplace hợp lệ (chưa có phí gì = chắc chắn chưa đối soát)", () => {
    expect(isProvisionalPlatformFee({ ...base, platformFeeEst: 0 })).toBe(true);
  });

  it("KHÔNG chia cho 0: itemsTotal = 0 → false", () => {
    expect(isProvisionalPlatformFee({ ...base, itemsTotal: 0, platformFeeEst: 0 })).toBe(false);
  });

  it("ngưỡng công khai giữ ở 10%", () => {
    expect(PROVISIONAL_FEE_MAX_RATIO).toBe(0.1);
  });
});

describe("formatPlatformFeeRatio", () => {
  it("format tỉ lệ với dấu phẩy thập phân VN, tối đa 1 số lẻ", () => {
    // 56415/209000 = 26.99% → làm tròn 27%
    expect(formatPlatformFeeRatio(56_415, 209_000)).toBe("27%");
    // 38000/720000 = 5.277...% → 5,3%
    expect(formatPlatformFeeRatio(38_000, 720_000)).toBe("5,3%");
  });

  it("trả null khi phí = 0 (không hiện '0%' gây rối)", () => {
    expect(formatPlatformFeeRatio(0, 345_000)).toBeNull();
  });

  it("trả null khi itemsTotal ≤ 0 (tránh chia 0)", () => {
    expect(formatPlatformFeeRatio(17_250, 0)).toBeNull();
    expect(formatPlatformFeeRatio(17_250, -100)).toBeNull();
  });

  it("phí đúng 5% ra '5%' (không '5,0%')", () => {
    expect(formatPlatformFeeRatio(17_250, 345_000)).toBe("5%");
  });
});
