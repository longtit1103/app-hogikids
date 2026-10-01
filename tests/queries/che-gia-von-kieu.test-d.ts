import { describe, expectTypeOf, it } from "vitest";

import type { OrderDetailTheoQuyen } from "@/lib/queries/orders";
import type { ProductListPage } from "@/lib/queries/products";
import type { VariantExport, VariantListPage } from "@/lib/queries/variants";
import type { MonthlyTrend } from "@/lib/reports/monthly-trend";
import type { ChannelPnlChe, DailyPointChe, PnlChe } from "@/lib/reports/pnl-che";
import type { ProductReport } from "@/lib/reports/product-report";

/**
 * Lưới KIỂU (spec phân quyền §8.4): nhánh `coQuyenGiaVon: false` KHÔNG có trường giá vốn/lãi ở mức
 * kiểu — component đọc bừa là lỗi biên dịch. `tsc --noEmit` (gate bắt buộc) soát file này: mỗi
 * `@ts-expect-error` mà dòng dưới HẾT lỗi (có người thêm trường nhạy cảm vào kiểu che) ⇒ tsc đỏ.
 */

declare const variants: VariantListPage;
declare const variantExport: VariantExport;
declare const products: ProductListPage;
declare const order: OrderDetailTheoQuyen;
declare const productReport: ProductReport;
declare const trend: MonthlyTrend;
declare const pnlChe: PnlChe;
declare const kenhChe: ChannelPnlChe;
declare const ngayChe: DailyPointChe;

describe("kiểu DTO che giá vốn", () => {
  it("nhánh false không đọc được trường nhạy cảm; nhánh true đọc được", () => {
    if (!variants.coQuyenGiaVon) {
      // @ts-expect-error — dòng biến thể che không có costPrice
      void variants.rows[0].costPrice;
      // @ts-expect-error — KPI che không có giá trị tồn
      void variants.kpi.stockValue;
    } else {
      expectTypeOf(variants.rows[0].costPrice).toEqualTypeOf<number>();
    }

    if (!variantExport.coQuyenGiaVon) {
      // @ts-expect-error — file xuất che không có giá trị tồn
      void variantExport.rows[0].stockValue;
    }

    if (!products.coQuyenGiaVon) {
      // @ts-expect-error — biến thể che không có costPrice
      void products.products[0].variants[0].costPrice;
      // @ts-expect-error — sản phẩm che không có giá vốn chung
      void products.products[0].uniformCost;
    }

    if (!order.coQuyenGiaVon) {
      // @ts-expect-error — dòng hàng che không có giá vốn
      void order.items[0].costPrice;
    }

    if (!productReport.coQuyenGiaVon) {
      // @ts-expect-error — báo cáo sản phẩm che không có lãi gộp
      void productReport.rows[0].grossProfit;
      // @ts-expect-error — dòng SKU che không có COGS
      void productReport.rows[0].skus[0].cogs;
    }

    if (!trend.coQuyenGiaVon) {
      // @ts-expect-error — xu hướng che không có LN ròng
      void trend.rows[0].netProfit;
    }

    // @ts-expect-error — DTO P&L che không có COGS
    void pnlChe.cogs;
    // @ts-expect-error — DTO P&L che không có LN ròng
    void pnlChe.netProfit;
    // @ts-expect-error — kênh che không có LN ròng
    void kenhChe.netProfit;
    // @ts-expect-error — điểm ngày che không có LN ròng
    void ngayChe.netProfit;
  });
});
