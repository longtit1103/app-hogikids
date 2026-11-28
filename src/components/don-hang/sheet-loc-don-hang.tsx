"use client";

import { useState } from "react";
import { SlidersHorizontalIcon } from "lucide-react";

import {
  chipHienThi,
  demLocDangBat,
  luaChonSapXep,
  type DoiThamSoDonHang,
} from "@/components/don-hang/lua-chon-loc-don-hang";
import { Checkbox } from "@/components/ui/checkbox";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { BoLocDonHang, ChipLocDonHang, KieuSapXepDonHang } from "@/lib/orders/don-hang-kieu-du-lieu";
import { cn } from "@/lib/utils";

type Nhap = { kenh: string[]; loc: ChipLocDonHang[]; sx: KieuSapXepDonHang };

const NHAP_RONG: Nhap = { kenh: [], loc: [], sx: "moi" };

/**
 * Nút "Lọc" + bottom-sheet lọc cho màn dưới 760px (kênh, lọc nhanh, sắp xếp). Sheet sửa bản NHÁP cục bộ và chỉ
 * ghi URL một lần khi bấm "Áp dụng"; "Xóa" chỉ dọn nháp (kênh/chip/sắp xếp), không đụng kỳ hay tìm kiếm.
 */
export function SheetLocDonHang(props: {
  boLoc: BoLocDonHang;
  kenh: readonly { id: string; name: string; color: string }[];
  coQuyenGiaVon: boolean;
  dieuHuong: (doi: DoiThamSoDonHang) => void;
}) {
  const { boLoc, kenh, coQuyenGiaVon, dieuHuong } = props;
  const [mo, setMo] = useState(false);
  const [nhap, setNhap] = useState<Nhap>(NHAP_RONG);
  const soLoc = demLocDangBat(boLoc);

  function moSheet() {
    // Mỗi lần mở lấy lại trạng thái hiện tại từ URL, không giữ nháp bỏ dở lần trước.
    setNhap({ kenh: [...boLoc.channels], loc: [...boLoc.loc], sx: boLoc.sx });
    setMo(true);
  }

  function apDung() {
    dieuHuong({
      kenh: nhap.kenh.length > 0 ? nhap.kenh.join(",") : null,
      loc: nhap.loc.length > 0 ? nhap.loc.join(",") : null,
      sx: nhap.sx,
    });
    setMo(false);
  }

  const batTat = <T,>(ds: T[], v: T): T[] => (ds.includes(v) ? ds.filter((x) => x !== v) : [...ds, v]);

  return (
    <>
      <button
        type="button"
        onClick={moSheet}
        data-testid="nut-loc-sheet"
        className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-[#d4d4d4] bg-white px-3 text-[13px] font-medium text-tq-chu-dam hover:bg-[#f7f7f7] min-[760px]:hidden"
      >
        <SlidersHorizontalIcon className="size-4" aria-hidden="true" />
        Lọc
        {soLoc > 0 ? (
          <span className="rounded-full bg-tq-chu-dam px-[7px] py-px text-[11px] text-white" data-testid="so-loc-dang-bat">
            {soLoc}
          </span>
        ) : null}
      </button>

      <Sheet open={mo} onOpenChange={setMo}>
        <SheetContent side="bottom" className="max-h-[86vh] gap-0 rounded-t-2xl bg-white p-0 font-sans">
          <SheetHeader className="px-4 pt-3 pb-1">
            <SheetTitle className="font-sans text-base font-semibold tracking-normal text-tq-chu-dam">Lọc đơn</SheetTitle>
          </SheetHeader>

          <div className="overflow-y-auto px-4 pb-2">
            <h3 className="mt-3 mb-1.5 font-sans text-[12px] font-semibold tracking-normal text-tq-chu-phu">Kênh</h3>
            {kenh.map((k) => (
              <label key={k.id} className="flex min-h-11 cursor-pointer items-center gap-3 border-b border-[#f0f0f0] text-sm last:border-b-0">
                <Checkbox
                  checked={nhap.kenh.includes(k.id)}
                  onCheckedChange={() => setNhap((n) => ({ ...n, kenh: batTat(n.kenh, k.id) }))}
                />
                <i className="size-[9px] rounded-full" style={{ backgroundColor: k.color }} aria-hidden="true" />
                {k.name}
              </label>
            ))}

            <h3 className="mt-4 mb-1.5 font-sans text-[12px] font-semibold tracking-normal text-tq-chu-phu">Lọc nhanh</h3>
            <div className="flex flex-wrap gap-2">
              {chipHienThi(coQuyenGiaVon).map((c) => {
                const bat = nhap.loc.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={bat}
                    onClick={() => setNhap((n) => ({ ...n, loc: batTat(n.loc, c.id) }))}
                    className={cn(
                      "inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3.5 text-[13px]",
                      bat ? "border-tq-chu-dam bg-tq-chu-dam text-white" : "border-[#d4d4d4] bg-white text-tq-chu",
                    )}
                  >
                    {bat ? <span aria-hidden="true">✓</span> : null}
                    {c.nhan}
                  </button>
                );
              })}
            </div>

            <h3 className="mt-4 mb-1.5 font-sans text-[12px] font-semibold tracking-normal text-tq-chu-phu">Sắp xếp</h3>
            <div role="radiogroup" aria-label="Sắp xếp">
              {luaChonSapXep(coQuyenGiaVon).map((s) => (
                <label key={s.id} className="flex min-h-11 cursor-pointer items-center gap-3 border-b border-[#f0f0f0] text-sm last:border-b-0">
                  <input
                    type="radio"
                    name="sap-xep-don-hang"
                    checked={nhap.sx === s.id}
                    onChange={() => setNhap((n) => ({ ...n, sx: s.id }))}
                    className="size-[18px] accent-[#1a1a1a]"
                  />
                  {s.nhan}
                </label>
              ))}
            </div>
          </div>

          <SheetFooter className="grid grid-cols-[1fr_2fr] gap-2.5 border-t border-[#ebebeb] p-4">
            <button
              type="button"
              onClick={() => setNhap(NHAP_RONG)}
              className="min-h-[46px] rounded-lg border border-[#d4d4d4] bg-white text-[13px] font-medium text-tq-chu-dam"
            >
              Xóa
            </button>
            <button
              type="button"
              onClick={apDung}
              data-testid="ap-dung-loc"
              className="min-h-[46px] rounded-lg bg-tq-chu-dam text-[13px] font-medium text-white"
            >
              Áp dụng
            </button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}
