import { LinkNeuDuocVao } from "@/components/dashboard/link-neu-duoc-vao";
import { LOP_VUNG_CUON_DANH_SACH, TheKhoi } from "@/components/trang-chu/the-khoi";
import { formatSoDem } from "@/lib/format";
import type { LowStockPreviewRow } from "@/lib/queries/variants";

const DICH_TON_THAP = "/ton-kho?loc=sap_het";

/**
 * Khối "Sắp hết hàng" trang chủ: các biến thể tồn ≤ ngưỡng (thấp nhất trước) + tổng số mã đang cảnh báo,
 * dữ liệu từ `getLowStockPreview()`. Giữ hành vi link của `LowStockCard`: mọi dòng → `/ton-kho?loc=sap_het`,
 * chỉ dựng link khi người xem vào được `/ton-kho`, không thì chữ tĩnh.
 */
export function SapHetHang({
  rows,
  total,
  hrefDuocPhep,
}: {
  rows: LowStockPreviewRow[];
  total: number;
  hrefDuocPhep: readonly string[];
}) {
  return (
    <TheKhoi tieuDe="Sắp hết hàng" phu={`${formatSoDem(total)} mã`} data-testid="khoi-sap-het-hang">
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-tq-chu-phu">Không có mã nào dưới ngưỡng.</p>
      ) : (
        <ul className={`flex flex-col ${LOP_VUNG_CUON_DANH_SACH}`} data-testid="danh-sach-sap-het">
          {rows.map((v) => (
            <li key={v.variantId}>
              <LinkNeuDuocVao
                href={DICH_TON_THAP}
                hrefDuocPhep={hrefDuocPhep}
                khoi
                className="flex items-start justify-between gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-tq-nen"
                classNameTinh="flex items-start justify-between gap-3 rounded-lg px-2 py-2"
              >
                <span className="min-w-0 flex-1 line-clamp-2 text-sm text-tq-chu">
                  {v.productName} · {v.label}
                </span>
                <span className="shrink-0 text-sm font-semibold tabular-nums text-tq-xau-chu">{formatSoDem(v.stock)}</span>
              </LinkNeuDuocVao>
            </li>
          ))}
        </ul>
      )}
    </TheKhoi>
  );
}
