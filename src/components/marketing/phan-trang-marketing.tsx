import Link from "next/link";

import { cn } from "@/lib/utils";

/**
 * Thanh phân trang DÙNG CHUNG cho các bảng ở `/marketing` (video · sản phẩm · phiên live).
 *
 * Server component THUẦN: page.tsx đã có sẵn `sp` (searchParams đã resolve) nên KHÔNG cần
 * `useSearchParams`/`usePathname` (khác `product-group-table.tsx`, component CLIENT vì nằm
 * trong bảng có sort tương tác). Chỉ đổi `trang`, GIỮ NGUYÊN mọi tham số khác đang có trên URL
 * (tab, kỳ, bộ lọc…) — không viết lại bộ phân trang thứ hai, chỉ dựng href từ `docSoTrang` +
 * `veTrangCuoiNeuVuot` mà `@/lib/pagination` đã cung cấp cho phần cắt trang ở server.
 */

export const DONG_MOI_TRANG_MARKETING = 20;

function hrefTrang(sp: Record<string, string | undefined>, trang: number, thamSo: string): string {
  const params = new URLSearchParams();
  for (const [khoa, giaTri] of Object.entries(sp)) {
    if (khoa !== thamSo && giaTri !== undefined && giaTri !== "") params.set(khoa, giaTri);
  }
  // Trang 1 là mặc định ⇒ giữ URL sạch, không gắn `?<thamSo>=1` thừa.
  if (trang > 1) params.set(thamSo, String(trang));
  const qs = params.toString();
  return qs ? `/marketing?${qs}` : "/marketing";
}

export function PhanTrangMarketing({
  sp,
  trang,
  tong,
  donVi,
  thamSo = "trang",
}: {
  sp: Record<string, string | undefined>;
  trang: number;
  tong: number;
  /** "video" | "sản phẩm" | "phiên live" — điền vào câu "N {donVi}". */
  donVi: string;
  /** Tên tham số querystring giữ số trang — mặc định "trang". Bảng Video/Phiên live ở tab Nội dung
   *  truyền RIÊNG "trangvideo"/"tranglive" (xem `ThamSoTrang.thamSo` ở `@/lib/pagination`) — hai bảng
   *  dài khác hẳn nhau, dùng chung một tham số khiến bảng ngắn rơi vào trang rỗng theo bảng dài. */
  thamSo?: string;
}) {
  const tongTrang = Math.max(1, Math.ceil(tong / DONG_MOI_TRANG_MARKETING));
  // Chỉ 1 trang (hoặc rỗng) ⇒ không có gì để điều hướng, nhưng vẫn cần dòng đếm tổng cho người
  // đọc biết bảng có bao nhiêu dòng (đặc biệt khi = 0, phân biệt "trống" với "app đang tải sai").
  if (tongTrang <= 1) {
    return <p className="mt-2 text-xs text-muted-foreground">{tong} {donVi}</p>;
  }

  return (
    <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <p>
        {tong} {donVi} · Trang {trang}/{tongTrang}
      </p>
      <div className="flex items-center gap-1">
        <Link
          href={hrefTrang(sp, Math.max(1, trang - 1), thamSo)}
          aria-label="Trang trước"
          aria-disabled={trang <= 1}
          className={cn(
            "rounded-md border border-hairline px-2 py-1 hover:bg-surface-soft",
            trang <= 1 && "pointer-events-none opacity-40"
          )}
        >
          ‹
        </Link>
        <Link
          href={hrefTrang(sp, Math.min(tongTrang, trang + 1), thamSo)}
          aria-label="Trang sau"
          aria-disabled={trang >= tongTrang}
          className={cn(
            "rounded-md border border-hairline px-2 py-1 hover:bg-surface-soft",
            trang >= tongTrang && "pointer-events-none opacity-40"
          )}
        >
          ›
        </Link>
      </div>
    </div>
  );
}
