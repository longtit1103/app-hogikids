// @vitest-environment jsdom
/**
 * Khối "Khoản chi định kỳ": sau mốc bật theo dõi nợ phải trả, server từ chối bật lại mẫu "Nhập hàng"
 * (`DA_BAT_NO_PHAI_TRA`) — nút "Bật lại" của mẫu đó phải biến mất, thay bằng chú thích; mẫu danh mục khác
 * và trạng thái chưa bật giữ nguyên nút.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, replace: () => {}, push: () => {} }),
}));
vi.mock("@/lib/actions/expenses", () => ({ batLaiDinhKy: vi.fn() }));

import { KhoanChiDinhKySection } from "@/components/finance/khoan-chi-dinh-ky-section";
import type { RecurringExpenseRow } from "@/lib/expenses/expense-queries";

const MOC_M = new Date(2026, 9, 1); // 01/10/2026 (00:00 giờ VN của container)

/** Tên danh mục KHÁC hẳn id (như prod: id `purchase`, tên "Nhập hàng") — nhận diện phải theo id, không theo tên. */
const TEN_THEO_ID: Record<string, string> = { purchase: "Nhập hàng", fixed: "Cố định" };

function mauDaDung(categoryId: string): RecurringExpenseRow {
  return {
    id: `mau-${categoryId}`,
    description: `Mẫu ${categoryId}`,
    categoryId,
    categoryName: TEN_THEO_ID[categoryId] ?? categoryId,
    channelName: null,
    amount: 1_000_000,
    dayOfMonth: 5,
    active: false,
    activeFrom: null,
  };
}

afterEach(cleanup);

describe("KhoanChiDinhKySection — nút Bật lại mẫu Nhập hàng sau khi bật theo dõi nợ", () => {
  it("đã bật + purchase ⇒ KHÔNG nút, có chú thích kèm ngày M dd/MM/yyyy", () => {
    render(<KhoanChiDinhKySection items={[mauDaDung("purchase")]} choPhepSua mocNoPhaiTra={MOC_M} />);
    expect(screen.queryByRole("button", { name: "Bật lại" })).toBeNull();
    const ghiChu = screen.getByTestId("dinh-ky-nhap-hang-di-so-no");
    expect(ghiChu.textContent).toBe("Từ 01/10/2026 tiền hàng ghi qua sổ nợ phiếu nhập");
  });

  it("đã bật + fixed ⇒ vẫn có nút, không chú thích", () => {
    render(<KhoanChiDinhKySection items={[mauDaDung("fixed")]} choPhepSua mocNoPhaiTra={MOC_M} />);
    expect(screen.getAllByRole("button", { name: "Bật lại" })).toHaveLength(1);
    expect(screen.queryByTestId("dinh-ky-nhap-hang-di-so-no")).toBeNull();
  });

  it("chưa bật (M null hoặc không truyền) + purchase ⇒ có nút, không chú thích", () => {
    for (const moc of [null, undefined]) {
      render(<KhoanChiDinhKySection items={[mauDaDung("purchase")]} choPhepSua mocNoPhaiTra={moc} />);
      expect(screen.getAllByRole("button", { name: "Bật lại" })).toHaveLength(1);
      expect(screen.queryByTestId("dinh-ky-nhap-hang-di-so-no")).toBeNull();
      cleanup();
    }
  });

  it("không có quyền sửa ⇒ không nút cũng không chú thích (như cũ)", () => {
    render(<KhoanChiDinhKySection items={[mauDaDung("purchase")]} mocNoPhaiTra={MOC_M} />);
    expect(screen.queryByRole("button", { name: "Bật lại" })).toBeNull();
    expect(screen.queryByTestId("dinh-ky-nhap-hang-di-so-no")).toBeNull();
  });

  it("mẫu ĐANG CHẠY (fixed hoặc purchase) ⇒ không nút cũng không chú thích, kể cả đã bật", () => {
    const dangChay = ["fixed", "purchase"].map((c) => ({ ...mauDaDung(c), active: true }));
    render(<KhoanChiDinhKySection items={dangChay} choPhepSua mocNoPhaiTra={MOC_M} />);
    expect(screen.queryByRole("button", { name: "Bật lại" })).toBeNull();
    expect(screen.queryByTestId("dinh-ky-nhap-hang-di-so-no")).toBeNull();
  });
});
