import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Khung thẻ trắng dùng chung mọi khối trang chủ (spec trang chủ §6): nền `--tq-the`, bo 12px, bóng
 * `--shadow-tq-the`. `phu` = dòng chú thích nhỏ dưới tiêu đề; `hanhDong` = góc phải (vd link "Xem chi tiết").
 *
 * Các khối cùng một hàng CAO BẰNG NHAU (chủ shop chốt 01/11): thẻ giãn hết ô lưới (`h-full`, ô lưới tự
 * giãn theo khối cao nhất hàng) và là cột flex — dòng chú thích cuối khối đặt `mt-auto` để dính đáy thẻ,
 * nên đáy các thẻ cạnh nhau thẳng hàng. Trên điện thoại (một cột) `h-full` không đổi gì.
 */
/**
 * Vùng danh sách CUỘN của 3 khối dưới (Bán chạy, Lãi nhiều – nên đẩy, Sắp hết hàng) — chủ shop chốt 02/11: khối cao
 * cố định, dài quá thì vuốt/cuộn trong khối để xem dòng dưới. ~300px ≈ 5 dòng tên 2 dòng, dòng thứ 6 lộ một phần để
 * thấy là còn nữa. Tiêu đề cột và chú thích nằm NGOÀI vùng này nên luôn hiện.
 */
export const LOP_VUNG_CUON_DANH_SACH = "max-h-[300px] overflow-y-auto [scrollbar-width:thin]";

export function TheKhoi(props: {
  tieuDe: string;
  phu?: ReactNode;
  hanhDong?: ReactNode;
  className?: string;
  children: ReactNode;
  "data-testid"?: string;
}) {
  const { tieuDe, phu, hanhDong, className, children } = props;
  return (
    <section
      className={cn("flex h-full flex-col rounded-xl bg-tq-the p-4 shadow-tq-the sm:p-5", className)}
      data-testid={props["data-testid"]}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-sans text-sm font-semibold tracking-normal text-tq-chu-dam">{tieuDe}</h2>
          {phu ? <div className="mt-0.5 text-[12px] text-tq-chu-phu">{phu}</div> : null}
        </div>
        {hanhDong ? <div className="shrink-0 text-[12px]">{hanhDong}</div> : null}
      </div>
      {children}
    </section>
  );
}
