import { describe, expect, it } from "vitest";

import { coCanhBaoToken, KEY_HAN_TOKEN, NGAY_GAP, NGAY_SAP_HET, tinhHanToken } from "@/lib/tokens/token-expiry";

const BAY_GIO = new Date("2026-07-25T10:00:00+07:00");
const epochSau = (ngay: number) => String(Math.floor(BAY_GIO.getTime() / 1000) + ngay * 86_400);

function mocHan(v: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(v));
}

describe("tinhHanToken", () => {
  it("token Meta còn xa hạn → ok, không làm phiền", () => {
    const ds = tinhHanToken(mocHan({ metaAdsTokenExpireAt: epochSau(49) }), BAY_GIO);
    const meta = ds.find((t) => t.ten.includes("quảng cáo Facebook"))!;
    expect(meta.conNgay).toBe(49);
    expect(meta.muc).toBe("ok");
    expect(meta.tuGiaHan).toBe(false);
  });

  it(`token phải làm tay còn dưới ${NGAY_SAP_HET} ngày → nhắc trước`, () => {
    const ds = tinhHanToken(mocHan({ metaAdsTokenExpireAt: epochSau(NGAY_SAP_HET - 1) }), BAY_GIO);
    expect(ds.find((t) => t.ten.includes("quảng cáo Facebook"))!.muc).toBe("sap-het");
  });

  it(`còn dưới ${NGAY_GAP} ngày → mức gấp`, () => {
    const ds = tinhHanToken(mocHan({ metaAdsTokenExpireAt: epochSau(NGAY_GAP - 1) }), BAY_GIO);
    expect(ds.find((t) => t.ten.includes("quảng cáo Facebook"))!.muc).toBe("gap");
  });

  it("đã qua hạn → hết hạn", () => {
    const ds = tinhHanToken(mocHan({ metaAdsTokenExpireAt: epochSau(-1) }), BAY_GIO);
    expect(ds.find((t) => t.ten.includes("quảng cáo Facebook"))!.muc).toBe("het-han");
  });

  it("token máy TỰ gia hạn sắp hết hạn → vẫn 'ok', không báo động giả", () => {
    // TikTok Shop access token sống 7 ngày và máy gia hạn trước 36h — còn 2 ngày là chuyện BÌNH THƯỜNG,
    // báo đỏ ở đây chỉ làm người đọc quen với cảnh báo rồi bỏ qua cảnh báo thật.
    const ds = tinhHanToken(mocHan({ tiktokShopAccessTokenExpireAt: epochSau(2) }), BAY_GIO);
    const tt = ds.find((t) => t.ten === "Token TikTok Shop")!;
    expect(tt.tuGiaHan).toBe(true);
    expect(tt.muc).toBe("ok");
  });

  it("token tự gia hạn mà ĐÃ hết hạn → vẫn kêu, vì nghĩa là cơ chế tự gia hạn hỏng", () => {
    const ds = tinhHanToken(mocHan({ tiktokShopAccessTokenExpireAt: epochSau(-1) }), BAY_GIO);
    expect(ds.find((t) => t.ten === "Token TikTok Shop")!.muc).toBe("het-han");
  });

  it("thiếu mốc → 'chưa biết', KHÔNG được coi là hết hạn", () => {
    const ds = tinhHanToken(mocHan({}), BAY_GIO);
    for (const t of ds) {
      expect(t.muc).toBe("chua-biet");
      expect(t.conNgay).toBeNull();
      expect(t.hetHanLuc).toBeNull();
    }
    expect(coCanhBaoToken(ds)).toBe(false);
  });

  it("giá trị rác trong Setting → 'chưa biết' chứ không vỡ", () => {
    const ds = tinhHanToken(mocHan({ metaAdsTokenExpireAt: "chưa điền", metaAdsDataAccessExpireAt: "0" }), BAY_GIO);
    expect(ds.find((t) => t.ten.includes("quảng cáo Facebook"))!.muc).toBe("chua-biet");
    expect(ds.find((t) => t.ten.includes("Quyền đọc dữ liệu"))!.muc).toBe("chua-biet");
  });

  it("coCanhBaoToken chỉ bật khi có cái thật sự cần chú ý", () => {
    const yen = tinhHanToken(mocHan({ metaAdsTokenExpireAt: epochSau(60) }), BAY_GIO);
    expect(coCanhBaoToken(yen)).toBe(false);
    const canLo = tinhHanToken(mocHan({ metaAdsTokenExpireAt: epochSau(5) }), BAY_GIO);
    expect(coCanhBaoToken(canLo)).toBe(true);
  });

  it("token phải làm tay đều có câu hướng dẫn; token tự gia hạn thì không cần", () => {
    const ds = tinhHanToken(mocHan({}), BAY_GIO);
    for (const t of ds) {
      if (t.tuGiaHan) expect(t.viecCanLam).toBeUndefined();
      else expect(t.viecCanLam?.length ?? 0).toBeGreaterThan(10);
    }
  });

  it("KEY_HAN_TOKEN chỉ chứa mốc hạn, KHÔNG chứa key token thô", () => {
    for (const k of KEY_HAN_TOKEN) expect(k).toMatch(/ExpireAt$/);
    expect(KEY_HAN_TOKEN).not.toContain("metaAdsAccessToken");
    expect(KEY_HAN_TOKEN).not.toContain("tiktokShopRefreshToken");
  });
});
