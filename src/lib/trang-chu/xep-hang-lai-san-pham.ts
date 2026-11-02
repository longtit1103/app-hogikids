import { UNMATCHED_PRODUCT_ID, type ProductReportRow } from "@/lib/reports/product-report";

/**
 * Khối "Lãi nhiều – nên đẩy" (spec trang chủ §4.6): xếp `productReport.rows` (đã gộp theo sản phẩm CHA)
 * theo `grossProfit` giảm dần. `grossProfit` ở đây là lãi TRƯỚC phí sàn, voucher, quảng cáo (định nghĩa
 * của `product-report.ts`) — nhãn khối phải ghi rõ điều đó.
 *
 * LOẠI khỏi xếp hạng, đếm vào `soThieuGiaVon`: nhóm "SKU không khớp" và mọi sản phẩm có SKU ĐÃ BÁN mà
 * giá vốn 0 — COGS 0 cho biên 100% ảo, sẽ chiếm đầu bảng trong khi lãi thật chưa biết.
 * LOẠI khỏi xếp hạng, KHÔNG đếm: sản phẩm lãi gộp ≤ 0 (lỗ hoặc hoà vốn) — khối tên "nên đẩy", không đẩy hàng
 * đang lỗ; giá vốn của chúng đã đủ nên không phải "thiếu giá vốn".
 */

export type DongLaiSanPham = {
  productId: string;
  ten: string;
  loiNhuan: number; // row.grossProfit (trước phí sàn, voucher, quảng cáo)
  soLuong: number; // row.soldQty
  laiMoiCai: number | null; // soldQty > 0 ? round(grossProfit / soldQty) : null
  bienLai: number | null; // row.marginPct
  tonKho: number; // row.currentStock (tổng mọi biến thể)
  tonThap: boolean; // productId ∈ sanPhamTonThap
};

const GIOI_HAN_MAC_DINH = 5;

function thieuGiaVon(row: ProductReportRow): boolean {
  return row.productId === UNMATCHED_PRODUCT_ID || row.skus.some((s) => s.soldQty > 0 && s.cogs === 0);
}

export function xepHangLaiSanPham(
  rows: readonly ProductReportRow[],
  sanPhamTonThap: ReadonlySet<string>,
  gioiHan: number = GIOI_HAN_MAC_DINH
): { top: DongLaiSanPham[]; soThieuGiaVon: number } {
  const duGiaVon = rows.filter((r) => !thieuGiaVon(r));
  const top = duGiaVon
    .filter((r) => r.grossProfit > 0)
    .sort((a, b) => b.grossProfit - a.grossProfit || (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0))
    .slice(0, gioiHan)
    .map(
      (r): DongLaiSanPham => ({
        productId: r.productId,
        ten: r.name,
        loiNhuan: r.grossProfit,
        soLuong: r.soldQty,
        laiMoiCai: r.soldQty > 0 ? Math.round(r.grossProfit / r.soldQty) : null,
        bienLai: r.marginPct,
        tonKho: r.currentStock,
        tonThap: sanPhamTonThap.has(r.productId),
      })
    );
  return { top, soThieuGiaVon: rows.length - duGiaVon.length };
}
