import { LinkNeuDuocVao } from "@/components/dashboard/link-neu-duoc-vao";
import { LOP_VUNG_CUON_DANH_SACH, TheKhoi } from "@/components/trang-chu/the-khoi";
import { formatSoDem } from "@/lib/format";
import type { DongBanChay } from "@/lib/trang-chu/kieu-du-lieu-trang-chu";

/**
 * Khối "Bán chạy" trang chủ: top sản phẩm theo SỐ LƯỢNG bán trong kỳ (loader `taiDuLieuTrangChu` đã xếp theo `soLuong`, cột hiển thị cũng là số lượng).
 * Giữ hành vi link của `TopProductsCard`: dòng → tab Sản phẩm ở `/bao-cao` lọc đúng 1 SP, chỉ dựng link
 * khi người xem vào được `/bao-cao` (`hrefDuocPhep`), không thì chữ tĩnh.
 */
export function BanChay({ rows, hrefDuocPhep }: { rows: DongBanChay[]; hrefDuocPhep: readonly string[] }) {
  return (
    <TheKhoi tieuDe="Bán chạy" phu="theo số lượng bán" data-testid="khoi-ban-chay">
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-tq-chu-phu">Chưa bán được sản phẩm nào trong kỳ.</p>
      ) : (
        <ul className={`flex flex-col ${LOP_VUNG_CUON_DANH_SACH}`} data-testid="danh-sach-ban-chay">
          {rows.map((r) => (
            <li key={r.productId}>
              <LinkNeuDuocVao
                href={`/bao-cao?tab=san-pham&sp=${r.productId}`}
                hrefDuocPhep={hrefDuocPhep}
                khoi
                className="flex items-start justify-between gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-tq-nen"
                classNameTinh="flex items-start justify-between gap-3 rounded-lg px-2 py-2"
              >
                <span className="min-w-0 flex-1 line-clamp-2 text-sm text-tq-chu">{r.ten}</span>
                <span className="shrink-0 text-sm font-semibold tabular-nums text-tq-chu-dam">{formatSoDem(r.soLuong)}</span>
              </LinkNeuDuocVao>
            </li>
          ))}
        </ul>
      )}
    </TheKhoi>
  );
}
