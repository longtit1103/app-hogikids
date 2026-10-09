import { describe, expect, it } from "vitest";

import {
  dieuKienChiPhiTruQuy,
  dieuKienViTiktokCongLai,
} from "@/lib/no-phai-tra/dieu-kien-chi-phi-tru-quy";
import type { NguCanhLoc } from "@/lib/no-phai-tra/the-cua-dong-chi";

/**
 * Phần THUẦN của bộ lọc "chi phí trừ quỹ": công tắc tắt (`mocM` null) phải trả ĐÚNG object cũ — đó là
 * bảo chứng "chưa bật thì quỹ y như hôm nay từng đồng" ở mức cấu trúc. Hành vi khi bật (NOT/OR, biên
 * ngày, null của `adsSource`) do test DB `dieu-kien-chi-phi-tru-quy.integration.test.ts` làm trọng tài —
 * so object Prisma chi tiết ở đây chỉ khoá cách viết, không khoá nghĩa.
 */
const vn = (ymd: string) => new Date(`${ymd}T00:00:00+07:00`);
const KHOANG = { gte: vn("2026-11-01"), lte: new Date("2026-11-30T16:59:59.999Z") };

describe("dieuKienChiPhiTruQuy / dieuKienViTiktokCongLai — công tắc tắt", () => {
  it("mocM null ⇒ y hệt bộ lọc cũ dù đã gắn thẻ", () => {
    const ctx: NguCanhLoc = {
      mocM: null,
      viAds: [],
      gan: [{ cardId: "A", nenTang: "META", tuNgay: vn("2026-10-01") }],
    };
    expect(dieuKienChiPhiTruQuy(ctx, KHOANG)).toEqual({ date: KHOANG });
    expect(dieuKienViTiktokCongLai(ctx, KHOANG)).toEqual({ orderCreateTime: KHOANG });
  });

  it("mocM null, không gắn ⇒ y hệt bộ lọc cũ; khoảng không chặn dưới giữ nguyên", () => {
    const ctx: NguCanhLoc = { mocM: null, gan: [], viAds: [] };
    const khongChanDuoi = { lte: KHOANG.lte };
    expect(dieuKienChiPhiTruQuy(ctx, khongChanDuoi)).toEqual({ date: khongChanDuoi });
    expect(dieuKienViTiktokCongLai(ctx, khongChanDuoi)).toEqual({ orderCreateTime: khongChanDuoi });
  });

  it("có M nhưng TIKTOK_ADS chưa gắn ⇒ ví cộng lại không cắt", () => {
    const ctx: NguCanhLoc = {
      mocM: vn("2026-11-01"),
      viAds: [],
      gan: [{ cardId: "A", nenTang: "META", tuNgay: vn("2026-11-01") }],
    };
    expect(dieuKienViTiktokCongLai(ctx, KHOANG)).toEqual({ orderCreateTime: KHOANG });
  });

  it("có M + gắn ⇒ không còn là bộ lọc cũ (bật thật sự đổi điều kiện)", () => {
    const ctx: NguCanhLoc = {
      mocM: vn("2026-11-01"),
      viAds: [],
      gan: [{ cardId: "B", nenTang: "TIKTOK_ADS", tuNgay: vn("2026-11-15") }],
    };
    expect(dieuKienChiPhiTruQuy(ctx, KHOANG)).not.toEqual({ date: KHOANG });
    // Ví cắt tại T_TIKTOK_ADS = max(M, 15/11) = 15/11 00:00 VN.
    expect(dieuKienViTiktokCongLai(ctx, KHOANG)).toEqual({
      AND: [{ orderCreateTime: KHOANG }, { orderCreateTime: { lt: vn("2026-11-15") } }],
    });
  });
});
