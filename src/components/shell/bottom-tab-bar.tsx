"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { MoreHorizontal } from "lucide-react";

import { cn } from "@/lib/utils";

import { TAB_CHINH_ITEMS, isNavItemActive, laTrangTabChinh } from "./nav-config";

const O_TAB =
  "flex min-h-11 min-w-11 flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] font-medium";

/**
 * Thanh tab dưới đáy — CHỈ mobile (dưới md), thay nút ☰. 4 tab chính + "Thêm" mở lại ngăn kéo
 * sẵn có (lọc chỉ còn mục phụ — `Sidebar`). Tự đệm thanh home/cạnh; `z-40` nằm dưới Sheet `z-50`.
 */
export function BottomTabBar({
  lowStockWarning,
  moreOpen,
  onOpenMore,
}: {
  lowStockWarning: boolean;
  moreOpen: boolean;
  onOpenMore: () => void;
}) {
  const pathname = usePathname();
  // Tab vừa chạm, ghi kèm địa chỉ LÚC chạm: tô màu ngay chứ không đợi trang mới về (không có
  // phản hồi này thì cú chạm trông như không ăn). Địa chỉ đã đổi (tới nơi, hoặc đi nơi khác) ⇒
  // `tu !== pathname` ⇒ tự hết hiệu lực, không cần effect dọn.
  const [dangToi, setDangToi] = useState<{ href: string; tu: string } | null>(null);
  const hrefDangToi = dangToi !== null && dangToi.tu === pathname ? dangToi.href : null;
  const themActive = hrefDangToi === null && !laTrangTabChinh(pathname);

  return (
    <nav
      aria-label="Điều hướng chính"
      data-slot="bottom-tab-bar"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-hairline bg-canvas pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] md:hidden print:hidden"
    >
      {hrefDangToi !== null && (
        // Vạch chạy mảnh đầu màn cho quãng TRƯỚC khi màn đổi: khi chưa có bản tải sẵn, Next phải
        // chờ server trả tới khung chờ chung `(app)/loading.tsx` mới commit. Khung chờ commit là
        // địa chỉ đổi ⇒ vạch tự tắt, khung chờ phản hồi tiếp tới khi số liệu về — hai lớp nối nhau,
        // không chồng. Có bản tải sẵn đầy đủ (`prefetch` dưới) thì cả hai gần như không kịp hiện.
        <div
          role="progressbar"
          aria-label="Đang chuyển trang"
          data-slot="dang-chuyen-trang"
          className="fixed inset-x-0 top-[env(safe-area-inset-top)] z-50 h-0.5 bg-primary motion-safe:animate-pulse"
        />
      )}
      <ul className="flex">
        {TAB_CHINH_ITEMS.map((item) => {
          const thatSu = isNavItemActive(pathname, item.href);
          // Màu theo tab vừa chạm; `aria-current` theo trang THẬT (VoiceOver không báo trước).
          const active = hrefDangToi === null ? thatSu : hrefDangToi === item.href;
          const Icon = item.icon;
          const canhBao = item.href === "/ton-kho" && lowStockWarning;
          return (
            <li key={item.href} className="flex flex-1">
              <Link
                href={item.href}
                // Tải sẵn CẢ trang + số liệu. Mặc định (không khai `prefetch`) trang động chỉ được
                // tải sẵn tới khung chờ chung `(app)/loading.tsx` ⇒ bấm vẫn thấy khung rồi chờ số
                // liệu. Mỗi lượt chuyển tab phải đi qua Cloudflare Singapore (đo 27/09: 0,15–2,5
                // s/lượt, truy vấn DB chỉ 4–40 ms) ⇒ tải sẵn đầy đủ là cách bỏ hẳn lượt chờ.
                // Bản tải sẵn giữ 5 phút (`staleTimes.static` mặc định — chủ shop chốt); thao tác
                // ghi (`revalidatePath`) và nút đồng bộ (`router.refresh`) làm mới ngay.
                prefetch={true}
                aria-current={thatSu ? "page" : undefined}
                onClick={(e) => {
                  // Mở tab mới (giữ phím/chuột giữa) thì trang này không đổi — đừng tô nhầm.
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                  // Chạm lại ĐÚNG trang đang đứng (vd đang ở Sổ quỹ `/tai-chinh?tab=so-quy`, chạm "Tài
                  // chính"): pathname không đổi ⇒ trạng thái chờ không bao giờ hết hiệu lực ⇒ vạch kẹt.
                  if (pathname === item.href) return;
                  setDangToi({ href: item.href, tu: pathname });
                }}
                className={cn(O_TAB, active ? "text-primary" : "text-muted-foreground")}
              >
                <span className="relative">
                  <Icon aria-hidden="true" className="size-5" />
                  {canhBao && (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute -top-0.5 -right-0.5 size-2 rounded-full bg-warning"
                    />
                  )}
                </span>
                {item.label}
                {/* Cảnh báo không chỉ bằng chấm màu. */}
                {canhBao && <span className="sr-only"> — có hàng sắp hết</span>}
              </Link>
            </li>
          );
        })}
        <li className="flex flex-1">
          <button
            type="button"
            onClick={onOpenMore}
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            // KHÔNG aria-current: "Thêm" là nút mở ngăn kéo, không phải trang — gắn "page" thì
            // VoiceOver đọc "Thêm, trang hiện tại" khi đang ở Sản phẩm. Chỉ tô màu nhấn.
            className={cn(O_TAB, themActive ? "text-primary" : "text-muted-foreground")}
          >
            <MoreHorizontal aria-hidden="true" className="size-5" />
            Thêm
          </button>
        </li>
      </ul>
    </nav>
  );
}
