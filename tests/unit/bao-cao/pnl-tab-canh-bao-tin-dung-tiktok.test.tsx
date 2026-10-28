// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/tai-chinh",
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
// Hai khối đầu bảng không liên quan tới phép đo vị trí chú thích — thay bằng rỗng để khỏi kéo provider/action.
vi.mock("@/components/bao-cao/pnl-month-picker", () => ({ PnlMonthPicker: () => null }));
vi.mock("@/components/shell/sync-now-button", () => ({ SyncNowButton: () => null }));

import { PnlTab } from "@/components/bao-cao/pnl-tab";
import type { PnlBreakdown } from "@/lib/reports/pnl";

/**
 * Tab Lãi/Lỗ: ảnh chụp tín dụng TikTok tặng ngừng về ⇒ chú thích ngay dưới dòng "Tín dụng TikTok tặng"; kỳ không có
 * dòng tín dụng (P&L không trừ gì vì ảnh chụp ngừng về) ⇒ dưới dòng "TikTok Ads". Không bao giờ nuốt mất cảnh báo.
 */

const CAU = "Ảnh chụp tín dụng TikTok chưa về từ 17/11 — Lãi/Lỗ có thể đang tính thừa chi phí ads (kiểm workflow n8n / quyền finance BC)";

const KY: PnlBreakdown = {
  revenue: 10_000_000,
  platformFee: 1_000_000,
  returnedOrderFee: 0,
  voucher: 0,
  netRevenue: 9_000_000,
  cogs: 4_000_000,
  grossProfit: 5_000_000,
  ads: 800_000,
  adsBySource: { TIKTOK_ADS: 800_000 },
  adsTinDungTang: 200_000,
  shipping: 0,
  packaging: 0,
  returnBom: 0,
  fixed: 0,
  interest: 0,
  financialIncome: 0,
  other: 0,
  otherCategoryIds: [],
  netProfit: 4_200_000,
  orderCount: 10,
  returnBomOrderCount: 0,
  skuMissingCount: 0,
  skuUnknownLineCount: 0,
};

function mo(monthPnl: PnlBreakdown, canhBao: string | null) {
  render(
    <PnlTab monthPnl={monthPnl} prevMonthPnl={monthPnl} month={new Date(2026, 10, 1)} canhBaoTinDungTiktok={canhBao} />,
  );
}

/** Chữ của hàng ngay SAU hàng có nhãn `nhan`. */
function hangSau(nhan: string): string {
  const hang = screen.getAllByRole("row");
  const i = hang.findIndex((h) => (h.textContent ?? "").includes(nhan));
  expect(i, `phải có hàng "${nhan}"`).toBeGreaterThanOrEqual(0);
  return hang[i + 1]?.textContent ?? "";
}

afterEach(cleanup);

describe("PnlTab — cảnh báo ảnh chụp tín dụng TikTok ngừng về", () => {
  it("kỳ có tín dụng ⇒ chú thích ngay dưới dòng 'Tín dụng TikTok tặng'", () => {
    mo(KY, CAU);
    expect(screen.getAllByTestId("pnl-canh-bao-tin-dung-tiktok")).toHaveLength(1);
    expect(hangSau("Tín dụng TikTok tặng (trả thay)")).toBe(CAU);
  });

  it("kỳ không có dòng tín dụng ⇒ chú thích dưới dòng TikTok Ads", () => {
    mo({ ...KY, ads: 1_000_000, adsTinDungTang: 0, adsBySource: { TIKTOK_ADS: 1_000_000 }, netProfit: 4_000_000 }, CAU);
    expect(screen.queryByText("Tín dụng TikTok tặng (trả thay)")).toBeNull();
    expect(screen.getAllByTestId("pnl-canh-bao-tin-dung-tiktok")).toHaveLength(1);
    expect(hangSau("TikTok Ads")).toBe(CAU);
  });

  it("không có cảnh báo ⇒ không hiện gì", () => {
    mo(KY, null);
    expect(screen.queryByTestId("pnl-canh-bao-tin-dung-tiktok")).toBeNull();
  });
});
