import { formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Huy hiệu % thay đổi so kỳ so sánh (spec trang chủ §4.2). `phanTram` null ⇒ kỳ trước 0 ("Mới", không chia 0).
 * `tangLaTot` false cho Chi phí: tăng là XẤU nên tô đỏ, giảm tô xanh.
 */
export function HuyHieuThayDoi(props: { phanTram: number | null; tangLaTot: boolean }) {
  const { phanTram, tangLaTot } = props;
  const co = "inline-flex items-center rounded-full px-2 py-0.5 text-[12px] font-medium tabular-nums";

  if (phanTram === null) {
    return <span className={cn(co, "border border-tq-ky-truoc text-tq-chu-phu")}>Mới</span>;
  }
  // Làm tròn cùng độ chính xác với `formatPercent` (1 chữ số): 0,04% hiện "0%" xám, không mũi tên.
  if (Math.round(Math.abs(phanTram) * 10) === 0) {
    return <span className={cn(co, "bg-tq-nen text-tq-chu-phu")}>0%</span>;
  }
  const tang = phanTram > 0;
  const tot = tang === tangLaTot;
  return (
    <span className={cn(co, tot ? "bg-tq-tot-nen text-tq-tot-chu" : "bg-tq-xau-nen text-tq-xau-chu")}>
      {tang ? "↗" : "↘"} {formatPercent(Math.abs(phanTram))}
    </span>
  );
}
