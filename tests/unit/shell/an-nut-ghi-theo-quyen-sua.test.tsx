import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Component client dùng hook điều hướng — ở môi trường node không có router thật.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, replace: () => {}, push: () => {} }),
  usePathname: () => "/tai-chinh",
  useSearchParams: () => new URLSearchParams(),
}));

import { KpiCards, type KpiCardsDuLieu } from "@/components/dashboard/kpi-cards";
import { ExpenseTable } from "@/components/expenses/expense-table";
import { CashMovementAddButton } from "@/components/finance/cash-movement-add-button";
import { SoDuChotThangButton } from "@/components/finance/so-du-chot-thang-button";
import { SoDuChotThangCard } from "@/components/finance/so-du-chot-thang-card";
import { SoQuyCard } from "@/components/finance/so-quy-card";
import { DuyetChiPhiNhapHang } from "@/components/nhap-hang/duyet-chi-phi-nhap-hang";
import { SyncNowButton } from "@/components/shell/sync-now-button";
import type { ExpenseRow } from "@/lib/expenses/expense-queries";
import type { PnlBreakdown } from "@/lib/reports/pnl";
import type { PnlChe } from "@/lib/reports/pnl-che";
import type { DoiChieuSoDuChot } from "@/lib/so-quy/doi-chieu-so-du-chot";
import type { SoQuyThangDayDu } from "@/lib/so-quy/so-quy-queries";

/**
 * Nút GHI chỉ hiện khi server truyền cờ quyền `:sua` (hoặc quyền xem đích của link). Cổng thật nằm ở
 * action/trang — đây là lưới UI: thiếu cờ ⇒ MẶC ĐỊNH ẩn (không bao giờ "mở khi quên truyền").
 */

/** Duyệt cây phần tử React (không render) tìm mọi phần tử có `type` cho trước. */
function timPhanTu(nut: ReactNode, type: unknown): ReactElement[] {
  if (Array.isArray(nut)) return nut.flatMap((n) => timPhanTu(n, type));
  if (!isValidElement(nut)) return [];
  const self = nut.type === type ? [nut] : [];
  return [...self, ...timPhanTu((nut.props as { children?: ReactNode }).children, type)];
}

describe("SyncNowButton — chỉ khi có cai-dat:sua", () => {
  it("thiếu cờ hoặc false ⇒ null; true ⇒ dựng nút", () => {
    expect(SyncNowButton()).toBeNull();
    expect(SyncNowButton({ choPhepDongBo: false, trongTopbar: true })).toBeNull();
    const nut = SyncNowButton({ choPhepDongBo: true });
    expect(isValidElement(nut)).toBe(true);
  });
});

describe("SoQuyCard chưa mở sổ — nút + Nhập quỹ", () => {
  const chuaMoSo = { d0: null } as unknown as SoQuyThangDayDu;
  const props = { soQuy: chuaMoSo, isCurrentMonth: true, soKhoanVayCoKyCho: 0, loans: [], tietKiem: null };

  it("thiếu cờ ⇒ không nút ghi, không mời bấm", () => {
    const cay = SoQuyCard(props);
    expect(timPhanTu(cay, CashMovementAddButton)).toHaveLength(0);
    expect(renderToStaticMarkup(cay)).not.toContain("Nhập quỹ");
  });

  it("choPhepNhapQuy ⇒ có nút", () => {
    expect(timPhanTu(SoQuyCard({ ...props, choPhepNhapQuy: true }), CashMovementAddButton)).toHaveLength(1);
  });
});

describe("SoDuChotThangCard — nút Chốt/Sửa/Xoá theo tai-chinh-dong-tien:sua", () => {
  const chuaChot: DoiChieuSoDuChot = {
    thang: new Date(2026, 8, 1),
    khaDung: "ok",
    chot: null,
    cuoiKy: 1_000_000,
    quyHomNay: 1_000_000,
    cauTruc: { duNoThauChi: 0, tienDangGui: 0 },
    soChot: null,
    chenhLechTho: null,
    chenhLech: null,
    thangTruocChuaChot: null,
  };

  it("thiếu cờ ⇒ không nút; true ⇒ có nút", () => {
    expect(timPhanTu(SoDuChotThangCard({ doiChieu: chuaChot, isCurrentMonth: false }), SoDuChotThangButton)).toHaveLength(0);
    expect(
      timPhanTu(SoDuChotThangCard({ doiChieu: chuaChot, isCurrentMonth: false, choPhepSua: true }), SoDuChotThangButton),
    ).toHaveLength(1);
  });
});

describe("DuyetChiPhiNhapHang — ghi phiếu nhập theo chi-phi:sua", () => {
  const deXuat = [
    {
      uuid: "u1",
      displayId: 7,
      ngay: new Date(2026, 8, 5),
      soTien: 500_000,
      soLuong: 3,
      soDongHang: 1,
      nhaCungCap: "NCC",
      ghiChu: null,
      refId: "PN:u1",
      lechLuoiKiem: false,
    },
  ];

  it("thiếu cờ ⇒ bảng chỉ đọc, không khối ảnh hưởng, không nút ghi", () => {
    const html = renderToStaticMarkup(<DuyetChiPhiNhapHang deXuat={deXuat} vanTay="v" quyHomNay={null} />);
    expect(html).toContain("#7");
    expect(html).not.toContain("Ảnh hưởng nếu ghi");
    expect(html).not.toContain("vào Sổ chi phí");
  });

  it("choPhepSua ⇒ có nút ghi", () => {
    const html = renderToStaticMarkup(
      <DuyetChiPhiNhapHang deXuat={deXuat} vanTay="v" quyHomNay={null} choPhepSua />,
    );
    expect(html).toContain("Ảnh hưởng nếu ghi");
    expect(html).toContain("vào Sổ chi phí");
  });
});

describe("ExpenseTable — Sửa/Xóa dòng theo chi-phi:sua", () => {
  const dong: ExpenseRow = {
    id: "e1",
    date: new Date(2026, 8, 5),
    categoryId: "c1",
    categoryName: "Vận hành",
    categoryIsHidden: false,
    adsSource: null,
    description: "Tiền điện",
    channelId: null,
    channelName: null,
    channelColor: null,
    amount: 200_000,
    source: "MANUAL",
    recurringId: null,
    refId: null,
  };
  const props = { rows: [dong], count: 1, totalAmount: 200_000, categories: [], channels: [] };

  it("thiếu cờ ⇒ không nút Sửa/Xóa; true ⇒ có", () => {
    const an = renderToStaticMarkup(<ExpenseTable {...props} />);
    expect(an).toContain("Tiền điện");
    expect(an).not.toContain('aria-label="Sửa"');
    expect(an).not.toContain('aria-label="Xóa"');
    const hien = renderToStaticMarkup(<ExpenseTable {...props} choPhepSua />);
    expect(hien).toContain('aria-label="Sửa"');
    expect(hien).toContain('aria-label="Xóa"');
  });
});

describe("KpiCards — thẻ doanh thu / LN ròng chỉ link Lãi/Lỗ khi xem được tab đó", () => {
  const che = {
    revenue: 1_000_000,
    voucher: 0,
    platformFee: 0,
    netRevenue: 900_000,
    ads: 0,
    orderCount: 3,
    returnBomOrderCount: 0,
  } as PnlChe;
  const duChe: KpiCardsDuLieu = { coQuyenGiaVon: false, today: che, thisMonth: che, lastMonthSameDays: che };

  it("nhánh che giá vốn ⇒ không link /tai-chinh?tab=loi-lo (kể cả khi lỡ truyền cờ)", () => {
    const html = renderToStaticMarkup(<KpiCards du={duChe} />);
    expect(html).toContain("Doanh thu gộp hôm nay");
    expect(html).not.toContain("tab=loi-lo");
    expect(renderToStaticMarkup(<KpiCards du={duChe} choPhepXemLoiLo />)).not.toContain("tab=loi-lo");
  });

  it("đủ giá vốn nhưng thiếu cờ xem Lãi/Lỗ ⇒ không link; có cờ ⇒ link", () => {
    const day = {
      ...che,
      netProfit: 100_000,
      financialIncome: 0,
      skuMissingCount: 0,
      skuUnknownLineCount: 0,
    } as unknown as PnlBreakdown;
    const duDay: KpiCardsDuLieu = { coQuyenGiaVon: true, today: day, thisMonth: day, lastMonthSameDays: day };
    expect(renderToStaticMarkup(<KpiCards du={duDay} />)).not.toContain("tab=loi-lo");
    expect(renderToStaticMarkup(<KpiCards du={duDay} choPhepXemLoiLo />)).toContain("tab=loi-lo");
  });
});
