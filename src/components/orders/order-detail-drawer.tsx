"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useRef } from "react";

import { Sheet, SheetContent } from "@/components/ui/sheet";
import type { OrderDetailTheoQuyen } from "@/lib/queries/orders";
import type { DieuHuongDon } from "./drawer-dau-don";
import { DrawerNoiDung } from "./drawer-noi-dung";

/**
 * Drawer chi tiết đơn (đọc-only), mở qua `?don=<id>`: vỏ `Sheet` phải 640px (điện thoại phủ toàn màn)
 * + nút đóng. Ruột ở `drawer-noi-dung.tsx`: đầu (mã, trạng thái, kênh, ‹ i/N ›), 3 ô số, dòng thời gian
 * trạng thái, sản phẩm, "Tiền của đơn", "Sàn quyết toán".
 *
 * Che giá vốn: người thiếu `gia-von-loi-nhuan:xem` nhận `order.coQuyenGiaVon === false` (server không gửi
 * giá vốn) ⇒ không ô Lãi, không cột Giá vốn/Lãi dòng, cây dừng ở "Tiền sau voucher và phí sàn".
 *
 * Dòng thời gian trạng thái đi kèm `order.thongTinPhu` (server đã chắt từ `Order.raw`, `raw` không ra
 * client). `dieuHuong` (cụm ‹ i / N ›) do trang tính theo bộ lọc đang xem; thiếu ⇒ ẩn cụm. `now` = mốc
 * server dùng cho danh sách — nhãn "tạm tính" của drawer tính theo đúng mốc đó, không theo giờ máy khách.
 */
export function OrderDetailDrawer({
  order,
  dieuHuong = null,
  now,
}: {
  order: OrderDetailTheoQuyen | null;
  dieuHuong?: DieuHuongDon | null;
  now: Date;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Focus đầu vào nút ✕: mặc định hộp thoại focus phần tử đầu tiên (nút sao chép) — vòng focus hiện
  // ngay cạnh mã đơn trông như lỗi, và Esc/✕ là thao tác đầu tiên hay dùng nhất.
  const refNutDong = useRef<HTMLButtonElement>(null);

  /** Đóng = bỏ `don` khỏi URL, giữ mọi tham số khác (bộ lọc, trang). */
  function dong() {
    const params = new URLSearchParams(searchParams);
    params.delete("don");
    router.replace(params.size ? `${pathname}?${params.toString()}` : pathname);
  }

  if (!order) return null;

  return (
    <Sheet
      open
      onOpenChange={(mo) => {
        if (!mo) dong();
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        initialFocus={refNutDong}
        // Drawer nằm trong cổng (portal) ngoài khung trang ⇒ tự đặt `font-sans` (Inter) như trang.
        className="gap-0 bg-tq-nen p-0 font-sans data-[side=right]:w-full data-[side=right]:sm:max-w-[640px]"
      >
        <DrawerNoiDung order={order} thongTinPhu={order.thongTinPhu} dieuHuong={dieuHuong} now={now} onDong={dong} refNutDong={refNutDong} />
      </SheetContent>
    </Sheet>
  );
}
