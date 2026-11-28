"use client";

import { ChevronDownIcon, SearchIcon, XIcon } from "lucide-react";

import { SheetLocDonHang } from "@/components/don-hang/sheet-loc-don-hang";
import {
  chipHienThi,
  locSauKhiBatTat,
  luaChonSapXep,
  type DoiThamSoDonHang,
} from "@/components/don-hang/lua-chon-loc-don-hang";
import { useOTimKiemUrl } from "@/components/shell/use-o-tim-kiem-url";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { BoLocDonHang, KieuSapXepDonHang } from "@/lib/orders/don-hang-kieu-du-lieu";
import { cn } from "@/lib/utils";

export type KenhLoc = { id: string; name: string; color: string };

const LOP_CHIP =
  "inline-flex min-h-[34px] items-center gap-1.5 rounded-full border px-3 text-[13px] whitespace-nowrap";

/**
 * Thanh lọc: ô tìm (gõ trễ 300ms qua URL) · Kênh · chip nhanh · Sắp xếp; dưới 760px chỉ còn ô tìm + nút "Lọc"
 * mở bottom-sheet. Mọi thay đổi đi qua `dieuHuong` (ghi URL) — không giữ state lọc riêng. Người thiếu quyền giá
 * vốn không có chip Đơn lỗ/Thiếu giá vốn và hai kiểu sắp theo lãi.
 */
export function ThanhLocDonHang(props: {
  boLoc: BoLocDonHang;
  kenh: readonly KenhLoc[];
  coQuyenGiaVon: boolean;
  dieuHuong: (doi: DoiThamSoDonHang) => void;
}) {
  const { boLoc, kenh, coQuyenGiaVon, dieuHuong } = props;
  const { q, setQ } = useOTimKiemUrl({ scroll: false });

  const tenKenhDangChon = boLoc.channels.map((id) => kenh.find((k) => k.id === id)?.name ?? id);
  const nhanKenh = tenKenhDangChon.length > 0 ? `Kênh · ${tenKenhDangChon.join(", ")}` : "Kênh";

  function batTatKenh(id: string) {
    const moi = boLoc.channels.includes(id) ? boLoc.channels.filter((c) => c !== id) : [...boLoc.channels, id];
    dieuHuong({ kenh: moi.length > 0 ? moi.join(",") : null });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-3">
      <div className="relative flex min-w-0 flex-1 items-center min-[760px]:max-w-[420px] min-[760px]:flex-[1_0_320px]">
        <SearchIcon className="pointer-events-none absolute left-2.5 size-4 text-[#8a8a8a]" aria-hidden="true" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Tìm mã đơn, mã sàn, SKU, sản phẩm, khách bán tại shop…"
          title="Tìm theo mã đơn, mã sàn, SKU, tên sản phẩm; tên khách chỉ tìm được ở đơn bán tại shop"
          aria-label="Tìm đơn"
          autoComplete="off"
          data-testid="o-tim-don-hang"
          className="min-h-9 w-full rounded-lg border border-[#d4d4d4] bg-white pr-8 pl-8 text-[13px] text-tq-chu placeholder:text-[#767676] max-[759px]:min-h-11 [&::-webkit-search-cancel-button]:hidden"
        />
        {q !== "" ? (
          <button
            type="button"
            onClick={() => setQ("")}
            aria-label="Xóa ô tìm"
            className="absolute right-1 grid size-7 place-items-center rounded-md text-tq-chu-phu hover:bg-[#f0f0f0]"
          >
            <XIcon className="size-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {/* Từ 760px: lọc ngay trên thanh. Dưới 760px: gom hết vào bottom-sheet. */}
      <div className="hidden flex-wrap items-center gap-2 min-[760px]:flex">
        <Popover>
          <PopoverTrigger
            data-testid="nut-loc-kenh"
            aria-pressed={boLoc.channels.length > 0}
            className={cn(LOP_CHIP, "border-[#d4d4d4] bg-white text-tq-chu hover:bg-[#f7f7f7]")}
          >
            {nhanKenh}
            <ChevronDownIcon className="size-3.5" aria-hidden="true" />
          </PopoverTrigger>
          <PopoverContent align="start" className="w-56 gap-0 p-1.5 font-sans">
            {kenh.map((k) => (
              <label key={k.id} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] hover:bg-[#f7f7f7]">
                <Checkbox checked={boLoc.channels.includes(k.id)} onCheckedChange={() => batTatKenh(k.id)} />
                <i className="size-[9px] rounded-full" style={{ backgroundColor: k.color }} aria-hidden="true" />
                {k.name}
              </label>
            ))}
          </PopoverContent>
        </Popover>

        {chipHienThi(coQuyenGiaVon).map((c) => {
          const bat = boLoc.loc.includes(c.id);
          return (
            <button
              key={c.id}
              type="button"
              aria-pressed={bat}
              data-testid={`chip-loc-${c.id}`}
              onClick={() => dieuHuong({ loc: locSauKhiBatTat(boLoc.loc, c.id) })}
              className={cn(
                LOP_CHIP,
                bat
                  ? c.id === "lo"
                    ? "border-tq-xau-chu bg-tq-xau-chu text-white"
                    : "border-tq-chu-dam bg-tq-chu-dam text-white"
                  : c.id === "lo"
                    ? "border-[#f2b8ae] bg-white text-tq-chu hover:bg-[#f7f7f7]"
                    : "border-[#d4d4d4] bg-white text-tq-chu hover:bg-[#f7f7f7]",
              )}
            >
              {bat ? <span aria-hidden="true">✓</span> : null}
              {c.nhan}
            </button>
          );
        })}

        <label className="ml-auto flex items-center gap-1.5 text-[13px] text-tq-chu-phu">
          Sắp xếp
          <select
            value={boLoc.sx}
            data-testid="o-sap-xep"
            onChange={(e) => dieuHuong({ sx: e.target.value as KieuSapXepDonHang })}
            className="min-h-[34px] rounded-lg border border-[#d4d4d4] bg-white px-2 text-[13px] text-tq-chu-dam"
          >
            {luaChonSapXep(coQuyenGiaVon).map((s) => (
              <option key={s.id} value={s.id}>
                {s.nhan}
              </option>
            ))}
          </select>
        </label>
      </div>

      <SheetLocDonHang boLoc={boLoc} kenh={kenh} coQuyenGiaVon={coQuyenGiaVon} dieuHuong={dieuHuong} />
    </div>
  );
}
