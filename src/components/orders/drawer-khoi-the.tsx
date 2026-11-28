import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Thẻ trắng chứa một khối của drawer đơn (tiêu đề + nội dung). Dùng chung để mọi khối cùng nền, bo góc,
 * bóng và nhịp chữ với trang chủ.
 */
export function DrawerKhoiThe({
  tieuDe,
  phu,
  children,
  className,
}: {
  tieuDe: string;
  /** Chữ nhỏ cạnh tiêu đề (vd "3 dòng · 5 cái"). */
  phu?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("min-w-0 rounded-xl bg-tq-the p-4 shadow-tq-the", className)}>
      <h3 className="mb-2.5 flex flex-wrap items-baseline gap-x-1.5 font-sans text-sm font-semibold tracking-normal text-tq-chu-dam">
        {tieuDe}
        {phu && <small className="text-[12px] font-normal text-tq-chu-phu">{phu}</small>}
      </h3>
      {children}
    </section>
  );
}
