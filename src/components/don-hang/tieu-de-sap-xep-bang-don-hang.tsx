"use client";

import { ariaSortCot, sapXepKhiBamCot, type CotSapXepDonHang } from "@/components/don-hang/sap-xep-cot-don-hang";
import type { KieuSapXepDonHang } from "@/lib/orders/don-hang-kieu-du-lieu";
import { cn } from "@/lib/utils";

// Tiêu đề dính khi cuộn.
export const TH =
  "sticky top-0 z-[2] border-y border-[#ebebeb] bg-[#f7f7f7] px-3 py-[9px] text-left align-top text-[11px] font-normal text-tq-chu-phu max-[1439px]:px-2.5";

/** Tiêu đề cột bấm được để sắp xếp: `aria-sort` + mũi tên ▲▼ (↕ mờ khi cột chưa sắp). */
export function TieuDeSapXep(props: {
  cot: CotSapXepDonHang;
  nhan: string;
  sx: KieuSapXepDonHang;
  soPhai?: boolean;
  onSapXep: (sx: KieuSapXepDonHang) => void;
}) {
  const { cot, nhan, sx, soPhai, onSapXep } = props;
  const huong = ariaSortCot(cot, sx);
  return (
    <th scope="col" aria-sort={huong} className={cn(TH, soPhai && "text-right")}>
      <button
        type="button"
        data-testid={`sap-xep-cot-${cot}`}
        onClick={() => onSapXep(sapXepKhiBamCot(cot, sx))}
        className={cn(
          "inline-flex items-center gap-1 whitespace-nowrap hover:text-tq-chu-dam",
          huong && "font-semibold text-tq-chu-dam",
        )}
      >
        {nhan}
        <span aria-hidden="true" className={cn("text-[11px]", !huong && "opacity-35")}>
          {huong === "ascending" ? "▲" : huong === "descending" ? "▼" : "↕"}
        </span>
      </button>
    </th>
  );
}
