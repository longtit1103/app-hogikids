import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChuaSyncEmptyState } from "@/components/dashboard/chua-sync-empty-state";
import { KpiCards, type KpiCardsDuLieu } from "@/components/dashboard/kpi-cards";
import { LowStockCard } from "@/components/dashboard/low-stock-card";
import { SyncStatusCard } from "@/components/dashboard/sync-status-card";
import { TopProductsCard } from "@/components/dashboard/top-products-card";
import { coTheVaoHref, hrefDuocPhep } from "@/components/shell/nav-config";
import type { Quyen } from "@/lib/quyen/danh-muc-quyen";
import type { PnlChe } from "@/lib/reports/pnl-che";
import type { ProductReportRowChe } from "@/lib/reports/product-report";

/**
 * Link trên Dashboard chỉ dựng khi người xem vào được trang đích (tập `hrefDuocPhep` do server tính).
 * Thiếu tập ⇒ mặc định KHÔNG link — không bao giờ "mở khi quên truyền".
 */

const che = {
  revenue: 1_000_000,
  voucher: 0,
  platformFee: 0,
  netRevenue: 900_000,
  ads: 0,
  orderCount: 3,
  returnBomOrderCount: 1,
} as PnlChe;
const du: KpiCardsDuLieu = { coQuyenGiaVon: false, today: che, thisMonth: che, lastMonthSameDays: che };

const ownerVaStaff = {
  xemDon: { role: "STAFF" as const, quyen: new Set<Quyen>(["tong-quan:xem", "don-hang:xem"]) },
  chiTongQuan: { role: "STAFF" as const, quyen: new Set<Quyen>(["tong-quan:xem"]) },
};

describe("coTheVaoHref", () => {
  it("so theo phần đường dẫn, bỏ ?query và #hash", () => {
    expect(coTheVaoHref(["/don-hang"], "/don-hang?trang_thai=huy_bom")).toBe(true);
    expect(coTheVaoHref(["/tai-chinh"], "/tai-chinh?tab=dong-tien#khoan-vay")).toBe(true);
    expect(coTheVaoHref(["/don-hang"], "/don-hang-khac")).toBe(false);
    expect(coTheVaoHref([], "/don-hang")).toBe(false);
  });
});

describe("KpiCards — thẻ Đơn hợp lệ / Tỷ lệ hoàn-bom", () => {
  it("thiếu don-hang:xem ⇒ không link /don-hang; có ⇒ link cả hai thẻ", () => {
    const hrefs = hrefDuocPhep(ownerVaStaff.chiTongQuan);
    const an = renderToStaticMarkup(<KpiCards du={du} hrefDuocPhep={hrefs} />);
    expect(an).toContain("Đơn hợp lệ hôm nay");
    expect(an).not.toContain('href="/don-hang');
    expect(renderToStaticMarkup(<KpiCards du={du} />)).not.toContain('href="/don-hang');

    const hien = renderToStaticMarkup(<KpiCards du={du} hrefDuocPhep={hrefDuocPhep(ownerVaStaff.xemDon)} />);
    expect(hien).toContain('href="/don-hang"');
    expect(hien).toContain("href=\"/don-hang?trang_thai=hoan_hang,huy_bom\"");
  });
});

describe("SyncStatusCard / ChuaSyncEmptyState — link Cài đặt", () => {
  it("thiếu cai-dat:xem ⇒ không link; chủ shop ⇒ có link", () => {
    const hrefsStaff = hrefDuocPhep(ownerVaStaff.xemDon);
    const hrefsChu = hrefDuocPhep({ role: "OWNER", quyen: new Set<Quyen>() });

    expect(renderToStaticMarkup(<SyncStatusCard rows={[]} hrefDuocPhep={hrefsStaff} />)).not.toContain("Cài đặt kết nối");
    expect(renderToStaticMarkup(<SyncStatusCard rows={[]} />)).not.toContain('href="/cai-dat"');
    expect(renderToStaticMarkup(<SyncStatusCard rows={[]} hrefDuocPhep={hrefsChu} />)).toContain('href="/cai-dat"');

    expect(renderToStaticMarkup(<ChuaSyncEmptyState hrefDuocPhep={hrefsStaff} />)).not.toContain('href="/cai-dat"');
    expect(renderToStaticMarkup(<ChuaSyncEmptyState hrefDuocPhep={hrefsChu} />)).toContain('href="/cai-dat"');
  });
});

describe("LowStockCard / TopProductsCard — link sang trang cần quyền riêng", () => {
  const rows = [{ variantId: "v1", sku: "SKU-1", productName: "Áo", label: "M", stock: 2 }];
  const sp: ProductReportRowChe[] = [
    { productId: "p1", name: "Áo", imageUrl: null, soldQty: 1, revenue: 10_000, currentStock: 1, orderCount: 1, skus: [] },
  ];

  it("tồn kho thấp: thiếu ton-kho:xem ⇒ không link; có ⇒ link", () => {
    const an = renderToStaticMarkup(<LowStockCard rows={rows} total={1} hrefDuocPhep={["/", "/don-hang"]} />);
    expect(an).toContain("SKU-1");
    expect(an).not.toContain("href=");
    expect(renderToStaticMarkup(<LowStockCard rows={rows} total={1} hrefDuocPhep={["/ton-kho"]} />)).toContain(
      'href="/ton-kho?loc=sap_het"',
    );
  });

  it("top sản phẩm: thiếu bao-cao:xem ⇒ không link; có ⇒ link dòng + link báo cáo", () => {
    const an = renderToStaticMarkup(<TopProductsCard products={sp} hrefDuocPhep={["/"]} />);
    expect(an).not.toContain("href=");
    expect(an).not.toContain("Xem báo cáo sản phẩm");
    const hien = renderToStaticMarkup(<TopProductsCard products={sp} hrefDuocPhep={["/bao-cao"]} />);
    expect(hien).toContain("sp=p1");
    expect(hien).toContain("Xem báo cáo sản phẩm");
  });
});
