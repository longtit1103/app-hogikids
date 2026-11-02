import Link from "next/link";

import { coTheVaoHref } from "@/components/shell/nav-config";
import { TheKhoi } from "@/components/trang-chu/the-khoi";
import { formatSoDem, formatVnd, formatVndShort } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { TheoKenh as DuTheoKenh } from "@/lib/trang-chu/kieu-du-lieu-trang-chu";

const LUOI_DONG =
  "grid items-center gap-2.5 border-b border-black/[0.06] py-2.5 text-[13px] last:border-b-0";

/**
 * Khối "Theo kênh" (spec trang chủ §4.5): tên · thanh tỷ trọng doanh số · doanh số + số đơn · lợi nhuận kênh.
 * Nhánh che (`coQuyenGiaVon: false`) chỉ có doanh số + đơn — không cột, không chú thích lãi. Cả dòng link
 * `/kenh/<id>` khi người xem vào được `/kenh`.
 */
export function TheoKenh({ du, hrefDuocPhep }: { du: DuTheoKenh; hrefDuocPhep: readonly string[] }) {
  const duQuyen = du.coQuyenGiaVon;
  const vaoDuocKenh = coTheVaoHref(hrefDuocPhep, "/kenh");
  const tongDoanhSo = du.rows.reduce((s, r) => s + Math.max(0, r.doanhSo), 0);
  // 3 cột (tên · thanh · số) khi che, 4 cột khi đủ; điện thoại bỏ cột doanh số + đơn.
  const cot = duQuyen
    ? "grid-cols-[64px_1fr_72px] sm:grid-cols-[80px_1fr_118px_92px]"
    : "grid-cols-[64px_1fr_72px] sm:grid-cols-[80px_1fr_118px]";

  return (
    <TheKhoi
      tieuDe="Theo kênh"
      phu={duQuyen ? "doanh số · số đơn · lợi nhuận" : "doanh số · số đơn"}
      data-testid="khoi-theo-kenh"
    >
      {du.rows.length === 0 ? (
        <p className="py-3 text-[13px] text-tq-chu-phu">Chưa có đơn trong kỳ.</p>
      ) : (
        <div>
          {du.rows.map((r) => {
            const tyTrong = tongDoanhSo > 0 ? (Math.max(0, r.doanhSo) / tongDoanhSo) * 100 : 0;
            const noiDung = (
              <>
                <b className="truncate font-semibold text-tq-chu-dam">{r.ten}</b>
                <div className="h-2 overflow-hidden rounded-[5px] bg-tq-nen">
                  <i
                    className="block h-full rounded-[5px] bg-tq-doanh-so"
                    style={{ width: `${tyTrong}%` }}
                  />
                </div>
                <span className="hidden text-right tabular-nums text-tq-chu sm:block">
                  {formatVnd(r.doanhSo)} <span className="text-tq-chu-phu">· {formatSoDem(r.donHang)} đơn</span>
                </span>
                {/* Nhánh che: điện thoại không có cột lãi ⇒ doanh số rút gọn đứng ở cột phải (không để dòng trống số). */}
                {!duQuyen ? (
                  <span className="text-right tabular-nums text-tq-chu sm:hidden">{formatVndShort(r.doanhSo)}</span>
                ) : null}
                {duQuyen && "loiNhuan" in r ? (
                  <span
                    className={cn(
                      "text-right font-medium tabular-nums",
                      r.loiNhuan < 0 ? "text-tq-xau-chu" : "text-tq-loi-nhuan-chu",
                    )}
                  >
                    <span className="hidden sm:inline">{formatVnd(r.loiNhuan)}</span>
                    <span className="sm:hidden">{formatVndShort(r.loiNhuan)}</span>
                  </span>
                ) : null}
              </>
            );
            return vaoDuocKenh ? (
              <Link
                key={r.channelId}
                href={`/kenh/${r.channelId}`}
                className={cn(LUOI_DONG, cot, "hover:bg-tq-nen")}
              >
                {noiDung}
              </Link>
            ) : (
              <div key={r.channelId} className={cn(LUOI_DONG, cot)}>
                {noiDung}
              </div>
            );
          })}
        </div>
      )}
      {duQuyen && du.rows.length > 0 ? (
        <p className="mt-auto pt-3 text-[12px] text-tq-chu-phu">Lãi kênh chưa trừ chi phí cố định và lãi vay.</p>
      ) : null}
    </TheKhoi>
  );
}
