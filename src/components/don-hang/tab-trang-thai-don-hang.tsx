"use client";

import type { OrderStatus } from "@/generated/prisma/client";

import type { DemTrangThaiDonHang } from "@/lib/orders/don-hang-kieu-du-lieu";
import { formatSoDem } from "@/lib/format";
import { TRANG_THAI_HIEN_THI } from "@/lib/orders/trang-thai-don-hien-thi";
import { cn } from "@/lib/utils";

/**
 * Tab trạng thái có đếm (chọn một). Số đếm do truy vấn trả: mọi bộ lọc TRỪ chính trạng thái, "Tất cả" = Σ 5 số.
 * Chỉ sáng khi đúng MỘT trạng thái đang lọc (hoặc không lọc ⇒ "Tất cả"); ≥ 2 trạng thái (vd drill Lãi/Lỗ) ⇒
 * không tab nào sáng, hàng chip đang áp mới hiện chúng.
 */
export function TabTrangThaiDonHang(props: {
  dem: DemTrangThaiDonHang;
  dangLoc: readonly OrderStatus[];
  /** slug trạng thái, hoặc null = "Tất cả". */
  onChon: (slug: string | null) => void;
}) {
  const { dem, dangLoc, onChon } = props;
  const tatCa = TRANG_THAI_HIEN_THI.reduce((tong, t) => tong + dem[t.status], 0);
  const dangChonTatCa = dangLoc.length === 0;

  const lopTab = (chon: boolean) =>
    cn(
      "-mb-px inline-flex min-h-[46px] items-center gap-[7px] border-b-2 px-2.5 text-[13px] whitespace-nowrap max-[759px]:min-h-12",
      chon ? "border-tq-chu-dam font-semibold text-tq-chu-dam" : "border-transparent text-tq-chu-phu hover:text-tq-chu-dam",
    );
  const lopDem = (chon: boolean) =>
    cn(
      "rounded-full px-[7px] py-px text-[12px] font-medium",
      chon ? "bg-tq-chu-dam text-white" : "bg-tq-nen text-tq-chu-phu",
    );

  return (
    <div
      role="tablist"
      aria-label="Lọc theo trạng thái"
      className="flex gap-1 overflow-x-auto border-b border-[#ebebeb] px-2 [scrollbar-width:none]"
    >
      <button
        type="button"
        role="tab"
        aria-selected={dangChonTatCa}
        data-testid="tab-tat-ca"
        className={lopTab(dangChonTatCa)}
        onClick={() => onChon(null)}
      >
        Tất cả
        <span className={lopDem(dangChonTatCa)}>{formatSoDem(tatCa)}</span>
      </button>
      {TRANG_THAI_HIEN_THI.map((t) => {
        const chon = dangLoc.length === 1 && dangLoc[0] === t.status;
        return (
          <button
            key={t.status}
            type="button"
            role="tab"
            aria-selected={chon}
            data-testid={`tab-${t.slug}`}
            className={lopTab(chon)}
            onClick={() => onChon(t.slug)}
          >
            <i className="size-2 rounded-full" style={{ backgroundColor: t.mau }} aria-hidden="true" />
            {t.nhan}
            <span className={lopDem(chon)}>{formatSoDem(dem[t.status])}</span>
          </button>
        );
      })}
    </div>
  );
}
