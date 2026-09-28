import { format, parse } from "date-fns";

import { formatVnd } from "@/lib/format";

/**
 * Tooltip Recharts của `channel-trend-chart.tsx` — tách riêng vì đây là 1 mối
 * quan tâm tự chứa (đọc `payload`, format ngày + tiền), không thuộc bố cục
 * chart/legend/accordion chính.
 */

function fullDayLabel(dateStr: string): string {
  return format(parse(dateStr, "yyyy-MM-dd", new Date()), "dd/MM/yyyy");
}

/**
 * Props tối thiểu Recharts truyền vào `Tooltip content=` — khai lỏng (`unknown`)
 * thay vì import kiểu generic nội bộ của recharts (`TooltipContentProps` đổi
 * shape giữa các bản, ví dụ `dataKey` có thể là hàm accessor) — chỉ ép kiểu
 * đúng lúc dùng bên dưới, vì mọi giá trị ở đây LUÔN là number/string do chính
 * `buildPoints` (channel-trend-chart.tsx) sinh ra (không có accessor function
 * nào được truyền vào `dataKey`).
 */
type ChartTooltipPayloadItem = {
  dataKey?: unknown;
  name?: unknown;
  value?: unknown;
  color?: unknown;
};

/** Tổng = cộng đúng các đường ĐANG VẼ trong payload (kênh bị ẩn qua legend không tính vào tổng). */
export function ChannelTrendTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: readonly ChartTooltipPayloadItem[];
  label?: unknown;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const total = payload.reduce((sum, p) => sum + (typeof p.value === "number" ? p.value : 0), 0);

  return (
    <div className="rounded-lg border border-hairline bg-canvas p-2.5 text-xs shadow-sm">
      <p className="font-medium text-ink">{fullDayLabel(String(label))}</p>
      <div className="mt-1 flex flex-col gap-0.5">
        {payload.map((p) => (
          <div key={String(p.dataKey)} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-ink">
              <span className="size-2 rounded-full" style={{ backgroundColor: String(p.color) }} />
              {String(p.name)}
            </span>
            <span className="text-ink">{formatVnd(Number(p.value))}</span>
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-4 border-t border-hairline pt-1.5 font-medium text-ink">
        <span>Tổng</span>
        <span>{formatVnd(total)}</span>
      </div>
    </div>
  );
}
