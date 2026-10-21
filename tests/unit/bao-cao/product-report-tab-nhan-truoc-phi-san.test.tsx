// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/bao-cao",
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { ProductReportTab } from "@/components/bao-cao/product-report-tab";
import type { ProductReport } from "@/lib/reports/product-report";

/**
 * Tab Sản phẩm: lãi gộp theo SP CHƯA trừ phí sàn + voucher (khác "LN gộp" bảng Lãi/Lỗ). Nhãn cột phải
 * nói rõ điều đó và có chú thích giải thích chênh lệch — nếu không chủ shop chọn hàng theo biên cao ảo.
 */

const BANG_DAY_DU: ProductReport = {
  coQuyenGiaVon: true,
  rows: [
    {
      productId: "p1",
      name: "Váy lụa",
      imageUrl: null,
      soldQty: 2,
      revenue: 600_000,
      cogs: 200_000,
      grossProfit: 400_000,
      marginPct: 66.7,
      currentStock: 5,
      orderCount: 2,
      skus: [],
    },
  ],
};

const BANG_CHE: ProductReport = {
  coQuyenGiaVon: false,
  rows: [
    {
      productId: "p1",
      name: "Váy lụa",
      imageUrl: null,
      soldQty: 2,
      revenue: 600_000,
      currentStock: 5,
      orderCount: 2,
      skus: [],
    },
  ],
};

afterEach(cleanup);

describe("ProductReportTab — nhãn lãi gộp theo sản phẩm", () => {
  it("có giá vốn: tiêu đề cột ghi 'trước phí sàn & voucher' + chú thích so với bảng Lãi/Lỗ", () => {
    render(<ProductReportTab bang={BANG_DAY_DU} channels={[]} slowSellerMaxOrders={0} />);

    expect(screen.getByRole("columnheader", { name: /LN gộp trước phí sàn & voucher/ })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: /Biên % trước phí sàn & voucher/ })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: /^LN gộp$/ })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: /^Biên %$/ })).toBeNull();
    expect(screen.getByText(/CHƯA trừ phí sàn và voucher/)).toBeTruthy();
  });

  it("thiếu quyền giá vốn: không cột lãi, không chú thích về lãi", () => {
    render(<ProductReportTab bang={BANG_CHE} channels={[]} slowSellerMaxOrders={0} />);

    expect(screen.queryByRole("columnheader", { name: /LN gộp/ })).toBeNull();
    expect(screen.queryByText(/CHƯA trừ phí sàn và voucher/)).toBeNull();
  });
});
