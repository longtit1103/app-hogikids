import Link from "next/link";

import { formatSoDem } from "@/lib/format";
import { daySoTrang } from "@/lib/orders/day-so-trang";
import { PAGE_SIZE } from "@/lib/page-size";
import { cn } from "@/lib/utils";

const NUT =
  "grid h-[34px] min-w-[34px] place-items-center rounded-lg border border-transparent px-1 text-[13px] max-[759px]:h-11 max-[759px]:min-w-11";

/**
 * Phân trang đánh số: trái "1–20 / 1.248 đơn", phải ‹ 1 … 4 5 6 … 63 ›. Mỗi nút là link thật (`hrefTrang`)
 * nên chia sẻ/F5 giữ đúng trang. Không có đơn nào thì không vẽ gì (khung rỗng đã báo).
 */
export function PhanTrangDonHang(props: {
  trang: number;
  tongDon: number;
  hrefTrang: (trang: number) => string;
}) {
  const { tongDon, hrefTrang } = props;
  if (tongDon <= 0) return null;

  const tongTrang = Math.max(1, Math.ceil(tongDon / PAGE_SIZE));
  const trang = Math.min(Math.max(1, props.trang), tongTrang);
  const tu = (trang - 1) * PAGE_SIZE + 1;
  const den = Math.min(tongDon, trang * PAGE_SIZE);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2.5 border-t border-[#ebebeb] px-4 py-2.5 text-[13px] text-tq-chu-phu">
      <span data-testid="phan-trang-tom-tat">
        {formatSoDem(tu)}–{formatSoDem(den)} / {formatSoDem(tongDon)} đơn
      </span>
      <nav aria-label="Phân trang" className="flex items-center gap-1">
        {trang <= 1 ? (
          <span className={cn(NUT, "text-[#b5b5b5]")} aria-label="Trang trước" aria-disabled="true">
            ‹
          </span>
        ) : (
          <Link href={hrefTrang(trang - 1)} aria-label="Trang trước" className={cn(NUT, "text-tq-chu hover:bg-[#f7f7f7]")}>
            ‹
          </Link>
        )}
        {daySoTrang(trang, tongTrang).map((p, i) =>
          p === "…" ? (
            <span key={`ba-cham-${i}`} className="px-1" aria-hidden="true">
              …
            </span>
          ) : (
            <Link
              key={p}
              href={hrefTrang(p)}
              aria-current={p === trang ? "page" : undefined}
              className={cn(
                NUT,
                p === trang ? "border-tq-chu-dam font-semibold text-tq-chu-dam" : "text-tq-chu hover:bg-[#f7f7f7]",
              )}
            >
              {p}
            </Link>
          ),
        )}
        {trang >= tongTrang ? (
          <span className={cn(NUT, "text-[#b5b5b5]")} aria-label="Trang sau" aria-disabled="true">
            ›
          </span>
        ) : (
          <Link href={hrefTrang(trang + 1)} aria-label="Trang sau" className={cn(NUT, "text-tq-chu hover:bg-[#f7f7f7]")}>
            ›
          </Link>
        )}
      </nav>
    </div>
  );
}
