"use client";

import { XIcon } from "lucide-react";

import { DOI_XOA_LOC, dungChipDangAp, type DoiThamSoDonHang } from "@/components/don-hang/lua-chon-loc-don-hang";
import type { BoLocDonHang } from "@/lib/orders/don-hang-kieu-du-lieu";

/**
 * Hàng chip "đang áp" dưới thanh lọc — CHỈ hiện khi có lọc ngoài kỳ. Mỗi chip có ✕ bỏ riêng nó;
 * "Xóa lọc" bỏ tìm/kênh/chip/trạng thái và về trang 1, giữ kỳ và sắp xếp.
 */
export function HangChipDangApDonHang(props: {
  boLoc: BoLocDonHang;
  kenh: readonly { id: string; name: string }[];
  dieuHuong: (doi: DoiThamSoDonHang) => void;
}) {
  const chip = dungChipDangAp(props.boLoc, props.kenh);
  if (chip.length === 0) return null;

  return (
    <div data-testid="chip-dang-ap" className="flex flex-wrap items-center gap-1.5 px-4 pb-3">
      {chip.map((c) => (
        <span
          key={c.khoa}
          className="inline-flex min-h-[30px] items-center gap-1 rounded-lg bg-tq-nen pr-1 pl-2.5 text-[12px] text-tq-chu max-[767px]:min-h-11"
        >
          {c.nhan}
          <button
            type="button"
            aria-label={`Bỏ ${c.nhan}`}
            onClick={() => props.dieuHuong(c.doi)}
            className="grid size-[26px] place-items-center rounded-md text-tq-chu-phu hover:bg-[#e3e3e3] max-[767px]:size-11"
          >
            <XIcon className="size-3.5" aria-hidden="true" />
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={() => props.dieuHuong(DOI_XOA_LOC)}
        data-testid="xoa-loc"
        className="min-h-[30px] px-1.5 text-[12px] text-[#1d4f91] underline underline-offset-2 max-[767px]:min-h-11"
      >
        Xóa lọc
      </button>
    </div>
  );
}
