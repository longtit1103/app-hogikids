import Link from "next/link";

import { formatVnd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { DrawerKhoiThe } from "./drawer-khoi-the";

/**
 * Sản phẩm trong đơn. MỘT cấu trúc DOM cho mọi khổ màn (không nhân đôi bảng + khối xếp, để mỗi ô số chỉ
 * xuất hiện một lần): từ 640px là lưới 6 cột SKU · Tên · SL · Đơn giá · Giá vốn · Lãi dòng; dưới 640px
 * mỗi dòng xếp dọc — tên + (lãi hoặc thành tiền) ở trên, SKU · SL × giá · vốn ở dưới.
 *
 * Lãi dòng giữ công thức cũ: `unitPrice×SL − lineDiscount − costPrice×SL`. Dòng chưa có giá vốn
 * (null/0) hoặc đơn hoàn/hủy ⇒ "—" (không có lãi để nói). Không quyền giá vốn: bỏ hẳn hai cột cuối.
 */
export type DongSanPhamDrawer = {
  sku: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  lineDiscount: number;
  /** Chỉ đọc khi `coGiaVon`; nhánh che không mang trường này. */
  costPrice?: number | null;
};

const COT_RONG = "sm:grid-cols-[84px_minmax(0,1fr)_34px_96px_96px_96px]";
const COT_HEP = "sm:grid-cols-[84px_minmax(0,1fr)_34px_96px]";

function laiCuaDong(d: DongSanPhamDrawer): number | null {
  if (!d.costPrice) return null; // null (không khớp SP) hoặc 0 (chưa khai) ⇒ không có lãi để nói
  return d.unitPrice * d.quantity - d.lineDiscount - d.costPrice * d.quantity;
}

function GiaVonDong({ d }: { d: DongSanPhamDrawer }) {
  if (d.costPrice === null || d.costPrice === undefined) {
    // KHÔNG khớp biến thể nào hoặc dòng không rõ SKU: màn Sản phẩm không có gì để sửa — nhập giá cho
    // một biến thể trùng tên cũng KHÔNG đổi COGS của dòng này. Cảnh báo TĨNH, không link giả.
    return (
      <span
        className="text-warning"
        title="Dòng hàng không khớp biến thể nào trong app — nhập giá vốn không sửa được COGS của dòng này"
      >
        ⚠ không khớp SP
      </span>
    );
  }
  if (d.costPrice === 0 && d.sku) {
    return (
      <Link
        // Dẫn thẳng tới ĐÚNG SKU đang xem, không qua bộ lọc: đơn HOÀN/HỦY bị chính định nghĩa "đã bán"
        // loại khỏi bộ lọc hẹp, nên link theo bộ lọc sẽ mở ra danh sách KHÔNG có dòng người ta vừa bấm.
        href={`/san-pham?q=${encodeURIComponent(d.sku)}`}
        className="text-warning underline underline-offset-2"
      >
        ⚠ chưa có giá vốn
      </Link>
    );
  }
  return <>{formatVnd(d.costPrice)}</>;
}

export function DrawerSanPhamTrongDon({
  items,
  coGiaVon,
  daLoai,
}: {
  items: DongSanPhamDrawer[];
  coGiaVon: boolean;
  daLoai: boolean;
}) {
  const tongCai = items.reduce((s, d) => s + d.quantity, 0);
  const cot = coGiaVon ? COT_RONG : COT_HEP;

  return (
    <DrawerKhoiThe tieuDe="Sản phẩm trong đơn" phu={`${items.length} dòng · ${tongCai} cái`}>
      <div role="table" aria-label="Sản phẩm trong đơn" className="text-[13px]">
        <div
          role="row"
          className={cn("hidden gap-x-1.5 border-b border-border px-1.5 pb-2 text-[11px] text-tq-chu-phu sm:grid", cot)}
        >
          <span role="columnheader">SKU</span>
          <span role="columnheader">Tên</span>
          <span role="columnheader" className="text-right">SL</span>
          <span role="columnheader" className="text-right">Đơn giá</span>
          {coGiaVon && <span role="columnheader" className="text-right">Giá vốn</span>}
          {coGiaVon && <span role="columnheader" className="text-right">Lãi dòng</span>}
        </div>

        {items.map((d, i) => {
          const lai = coGiaVon && !daLoai ? laiCuaDong(d) : null;
          const thanhTien = d.unitPrice * d.quantity - d.lineDiscount;
          const giamMoiCai = d.quantity > 0 && d.lineDiscount > 0 ? formatVnd(d.lineDiscount / d.quantity) : null;
          return (
            <div
              key={i}
              role="row"
              className={cn(
                "grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-0.5 border-b border-border/60 px-1.5 py-2.5 last:border-b-0 sm:items-start sm:gap-x-1.5",
                cot,
              )}
            >
              <span role="cell" className="col-start-1 row-start-1 min-w-0 sm:col-start-2">
                {d.productName}
              </span>
              {/* Ô lãi/thành tiền nằm cạnh tên trên điện thoại; từ 640px quay về cột cuối. */}
              {coGiaVon ? (
                <span
                  role="cell"
                  data-testid="line-profit"
                  className={cn(
                    "col-start-2 row-start-1 text-right font-semibold tabular-nums whitespace-nowrap sm:col-start-6 sm:font-normal",
                    lai !== null && lai < 0 && "text-tq-xau-chu",
                    lai === null && "text-tq-chu-phu",
                  )}
                >
                  {lai === null ? "—" : formatVnd(lai)}
                </span>
              ) : (
                <span
                  role="cell"
                  className="col-start-2 row-start-1 text-right font-semibold tabular-nums whitespace-nowrap sm:hidden"
                >
                  {formatVnd(thanhTien)}
                </span>
              )}
              {/* Dòng phụ: một hàng chữ nhỏ trên điện thoại, tách thành các cột từ 640px (`sm:contents`). */}
              <div
                role="presentation"
                className="col-span-2 row-start-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-tq-chu-phu sm:contents sm:text-[13px] sm:text-foreground"
              >
                <span role="cell" className="tabular-nums break-all sm:col-start-1 sm:row-start-1 sm:text-[12px] sm:text-tq-chu-phu">
                  {d.sku}
                </span>
                <span role="cell" className="-mr-2 tabular-nums sm:col-start-3 sm:row-start-1 sm:mr-0 sm:text-right">
                  {d.quantity}
                  <span className="sm:hidden"> ×</span>
                </span>
                <span role="cell" className="tabular-nums sm:col-start-4 sm:row-start-1 sm:text-right">
                  {formatVnd(d.unitPrice)}
                  {giamMoiCai && (
                    <span className="ml-1 text-[12px] text-tq-chu-phu sm:ml-0 sm:block">giảm {giamMoiCai}/cái</span>
                  )}
                </span>
                {coGiaVon && (
                  <span
                    role="cell"
                    className="tabular-nums sm:col-start-5 sm:row-start-1 sm:text-right"
                  >
                    <span className="sm:hidden">vốn </span>
                    <GiaVonDong d={d} />
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {coGiaVon && (
        <p className="mt-2.5 text-[12px] text-tq-chu-phu">
          Lãi dòng = tiền hàng dòng − giá vốn (giá vốn hiện hành), chưa trừ voucher và phí sàn.
        </p>
      )}
    </DrawerKhoiThe>
  );
}
