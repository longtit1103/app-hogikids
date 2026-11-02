import { LinkNeuDuocVao } from "@/components/dashboard/link-neu-duoc-vao";
import { coTheVaoHref } from "@/components/shell/nav-config";
import { LOP_VUNG_CUON_DANH_SACH, TheKhoi } from "@/components/trang-chu/the-khoi";
import { formatPercent, formatSoDem, formatVnd } from "@/lib/format";
import type { DongLaiSanPham } from "@/lib/trang-chu/xep-hang-lai-san-pham";

const DICH_BAO_CAO_SAN_PHAM = "/bao-cao?tab=san-pham";
const DICH_THIEU_GIA_VON = "/san-pham?loc=da_ban_thieu_gia_von";
const LUOI_COT =
  "grid grid-cols-[minmax(0,1fr)_5.5rem_3.5rem_3.5rem] items-center gap-2";

/**
 * Khối "Lãi nhiều – nên đẩy" (spec trang chủ §4.6): top sản phẩm CHA theo tổng lãi gộp kỳ, đã xếp và đã loại
 * sản phẩm thiếu giá vốn bởi `xepHangLaiSanPham`. Component chỉ trình bày; caller phải ẩn hẳn khối khi thiếu
 * quyền giá vốn (`laiNenDay === null`). Link dòng/“Xem tất cả” → tab Sản phẩm `/bao-cao` (cần quyền
 * `/bao-cao`); dòng đếm thiếu giá vốn → bộ lọc ở `/san-pham` (cần quyền `/san-pham`), không thì chữ tĩnh.
 */
export function LaiNhieuNenDay({
  du,
  hrefDuocPhep,
}: {
  du: { top: DongLaiSanPham[]; soThieuGiaVon: number };
  hrefDuocPhep: readonly string[];
}) {
  const { top, soThieuGiaVon } = du;
  const xemTatCa = coTheVaoHref(hrefDuocPhep, DICH_BAO_CAO_SAN_PHAM) ? (
    <LinkNeuDuocVao
      href={DICH_BAO_CAO_SAN_PHAM}
      hrefDuocPhep={hrefDuocPhep}
      className="text-primary hover:underline"
    >
      Xem tất cả
    </LinkNeuDuocVao>
  ) : undefined;

  return (
    <TheKhoi
      tieuDe="Lãi nhiều – nên đẩy"
      phu="xếp theo tổng lãi trong kỳ"
      hanhDong={xemTatCa}
      data-testid="khoi-lai-nhieu-nen-day"
    >
      {top.length === 0 ? (
        <p className="py-6 text-center text-sm text-tq-chu-phu">
          Chưa có sản phẩm đủ giá vốn để xếp hạng.
        </p>
      ) : (
        <div>
          <div className={`${LUOI_COT} px-2 pb-1 text-[11px] text-tq-chu-phu`}>
            <span>Sản phẩm</span>
            <span className="text-right">Lãi/cái</span>
            <span className="text-right">Biên</span>
            <span className="text-right">Tồn</span>
          </div>
          <ul className={`flex flex-col ${LOP_VUNG_CUON_DANH_SACH}`} data-testid="danh-sach-lai-nhieu">
            {top.map((r) => (
              <li key={r.productId}>
                <LinkNeuDuocVao
                  href={`${DICH_BAO_CAO_SAN_PHAM}&sp=${r.productId}`}
                  hrefDuocPhep={hrefDuocPhep}
                  khoi
                  className={`${LUOI_COT} rounded-lg px-2 py-2 transition-colors hover:bg-tq-nen`}
                  classNameTinh={`${LUOI_COT} rounded-lg px-2 py-2`}
                >
                  <span className="min-w-0">
                    <span className="block line-clamp-2 text-sm font-semibold text-tq-chu-dam">
                      {r.ten}
                    </span>
                    <span className="block truncate text-[12px] tabular-nums text-tq-chu-phu">
                      lãi {formatVnd(r.loiNhuan)} · {formatSoDem(r.soLuong)} cái
                    </span>
                  </span>
                  <span
                    className={`whitespace-nowrap text-right text-sm font-semibold tabular-nums ${
                      r.laiMoiCai !== null && r.laiMoiCai < 0
                        ? "text-tq-xau-chu"
                        : "text-tq-loi-nhuan-chu"
                    }`}
                  >
                    {r.laiMoiCai === null ? "—" : formatVnd(r.laiMoiCai)}
                  </span>
                  <span className="text-right text-sm tabular-nums text-tq-chu">
                    {r.bienLai === null ? "—" : formatPercent(r.bienLai)}
                  </span>
                  <span className="text-right text-sm tabular-nums text-tq-chu">
                    {r.tonThap ? (
                      <span
                        className="inline-block rounded-full bg-tq-xau-nen px-2 py-0.5 text-[12px] font-semibold text-tq-xau-chu"
                        title="Có size sắp hết — nhập thêm trước khi đẩy"
                      >
                        {formatSoDem(r.tonKho)}
                      </span>
                    ) : (
                      formatSoDem(r.tonKho)
                    )}
                  </span>
                </LinkNeuDuocVao>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Chú thích dính đáy thẻ để đáy các khối cùng hàng thẳng nhau. */}
      <div className="mt-auto">
        {soThieuGiaVon > 0 && (
          <p className="mt-3 text-[12px] text-tq-chu-phu">
            <LinkNeuDuocVao
              href={DICH_THIEU_GIA_VON}
              hrefDuocPhep={hrefDuocPhep}
              className="text-primary hover:underline"
            >
              {formatSoDem(soThieuGiaVon)} sản phẩm thiếu giá vốn chưa xếp hạng
            </LinkNeuDuocVao>
          </p>
        )}

        <p className="mt-3 text-[12px] text-tq-chu-phu">
          Lãi tính trước phí sàn, voucher, quảng cáo. Tồn đỏ = có size sắp hết.
        </p>
      </div>
    </TheKhoi>
  );
}
