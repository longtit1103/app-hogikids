import { Badge } from "@/components/ui/badge";
import { formatVnd } from "@/lib/format";
import type { ExpenseSummary } from "@/lib/expenses/expense-queries";
import { cn } from "@/lib/utils";

/**
 * Dải 3 KPI đầu `/chi-phi` — thuần hiển thị (server component, không state).
 * Cả 3 số đều là chi phí nên chiều "tốt/xấu" giống nhau: tăng chi (▲) = xấu
 * (`text-error`), giảm chi (▼) = tốt (`text-success`) — khác quy ước doanh thu.
 */

function formatPctChange(current: number, previous: number): number {
  return ((current - previous) / previous) * 100;
}

/** So kỳ trước: badge "Mới" khi kỳ trước = 0, ngược lại mũi tên + % (làm tròn). */
function DeltaVsPrev({ current, previous }: { current: number; previous: number }) {
  if (previous === 0) {
    return <Badge variant="outline">Mới</Badge>;
  }

  const pctChange = formatPctChange(current, previous);
  if (pctChange === 0) {
    return <span className="text-xs text-muted-foreground">0% so kỳ trước</span>;
  }

  const isIncrease = pctChange > 0; // tăng chi
  return (
    <span className={cn("text-xs", isIncrease ? "text-error" : "text-success")}>
      {isIncrease ? "▲" : "▼"} {Math.round(Math.abs(pctChange))}% so kỳ trước
    </span>
  );
}

function KpiCard({
  label,
  value,
  children,
  caption,
}: {
  label: string;
  value: React.ReactNode;
  children?: React.ReactNode;
  caption?: string;
}) {
  return (
    <div className="rounded-xl bg-surface-card p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 font-serif text-2xl text-ink">{value}</p>
      {children && <div className="mt-1">{children}</div>}
      {caption && <p className="mt-1 text-xs text-muted-foreground">{caption}</p>}
    </div>
  );
}

export function ExpenseKpiCards({ summary }: { summary: ExpenseSummary }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <KpiCard label="Tổng chi phí kỳ này" value={formatVnd(summary.total)}>
        <DeltaVsPrev current={summary.total} previous={summary.totalPrev} />
      </KpiCard>

      <KpiCard
        label="Danh mục lớn nhất"
        value={summary.topCategory ? formatVnd(summary.topCategory.amount) : "—"}
      >
        {summary.topCategory && (
          <div className="flex items-center gap-2">
            <Badge className="bg-surface-cream-strong text-ink">{summary.topCategory.name}</Badge>
            <span className="text-xs text-muted-foreground">
              {Math.round(summary.topCategory.pct)}% trên tổng sổ
            </span>
          </div>
        )}
      </KpiCard>

      <KpiCard
        label="Chi phí Quảng cáo"
        value={formatVnd(summary.adsTotal)}
        caption="Số ads tự về mỗi đêm từ Meta/TikTok"
      >
        <DeltaVsPrev current={summary.adsTotal} previous={summary.adsTotalPrev} />
      </KpiCard>
    </div>
  );
}
