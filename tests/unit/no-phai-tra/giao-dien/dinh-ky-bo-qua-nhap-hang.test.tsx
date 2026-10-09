// @vitest-environment jsdom
/**
 * Khối "Khoản chi định kỳ" (tab Sổ chi phí): sau mốc bật theo dõi nợ phải trả, bộ sinh BỎ QUA lần phát
 * sinh của mẫu "Nhập hàng" (`boQuaNhapHang` của `ensureRecurringExpensesChiTiet`) — mẫu vẫn "Đang chạy"
 * nên phải có lời nhắc thấy được (khối gấp ⇒ mở sẵn), không thì chủ shop tưởng tiền hàng vẫn được trừ.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, replace: () => {}, push: () => {} }),
}));
vi.mock("@/lib/actions/expenses", () => ({ batLaiDinhKy: vi.fn() }));

import { KhoanChiDinhKySection } from "@/components/finance/khoan-chi-dinh-ky-section";
import type { RecurringExpenseRow } from "@/lib/expenses/expense-queries";

const MAU: RecurringExpenseRow = {
  id: "r1",
  description: "Nhập hàng NCC A",
  categoryName: "Nhập hàng",
  channelName: null,
  amount: 20_000_000,
  dayOfMonth: 5,
  active: true,
  activeFrom: null,
};

afterEach(cleanup);

describe("KhoanChiDinhKySection — nhắc mẫu Nhập hàng bị bỏ sau mốc bật nợ", () => {
  it("boQuaNhapHang = 2 ⇒ có câu nhắc kèm số lần, khối mở sẵn", () => {
    const { container } = render(<KhoanChiDinhKySection items={[MAU]} boQuaNhapHang={2} />);
    const nhac = screen.getByTestId("dinh-ky-bo-qua-nhap-hang");
    expect(nhac.textContent).toContain("Mẫu Nhập hàng không còn sinh sau ngày bật theo dõi nợ (bỏ qua 2 lần)");
    expect(container.querySelector("details")?.open).toBe(true);
  });

  it("0 hoặc không truyền ⇒ không câu nhắc, khối gấp như cũ", () => {
    for (const boQua of [0, undefined]) {
      const { container } = render(<KhoanChiDinhKySection items={[MAU]} boQuaNhapHang={boQua} />);
      expect(screen.queryByTestId("dinh-ky-bo-qua-nhap-hang")).toBeNull();
      expect(container.querySelector("details")?.open).toBe(false);
      cleanup();
    }
  });
});
