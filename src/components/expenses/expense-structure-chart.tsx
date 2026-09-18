"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BarChart3, PieChart as PieChartIcon } from "lucide-react";
import { Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, XAxis, YAxis } from "recharts";

import { formatVnd } from "@/lib/format";
import type { CategoryBreakdownItem } from "@/lib/expenses/expense-queries";
import { cn } from "@/lib/utils";

const CHART_MODE_STORAGE_KEY = "hogikids_chi_phi_chart_mode";

type ChartMode = "donut" | "bar";

/**
 * Màu ổn định theo `categoryId` — 8 danh mục hệ thống (seed.ts) không có cột
 * màu riêng trong schema nên khai HEX trực tiếp ở đây: 7 màu đầu đồng bộ token
 * `globals.css` (ghi chú cạnh mỗi dòng), riêng `interest` là màu riêng chưa có
 * token. Dùng HEX thay vì `var(--chart-*)` vì
 * SVG `fill` là attribute (không phải style) — CSS custom property không
 * đảm bảo resolve nhất quán khi gán qua attribute trên mọi trình duyệt.
 */
const CATEGORY_COLORS: Record<string, string> = {
  purchase: "#cc785c", // --primary / --chart-1 (coral thương hiệu)
  ads: "#5db8a6", // --accent-teal / --chart-2
  shipping: "#e8a55a", // --accent-amber / --chart-3
  packaging: "#5db872", // --success / --chart-4
  return_bom: "#d4a017", // --warning / --chart-5
  fixed: "#c64545", // --error
  interest: "#7a5c99", // tím trầm — chưa có token globals.css, chọn khác 7 màu hiện có
  other: "#6c6a64", // --muted (text)
};
const FALLBACK_CATEGORY_COLOR = "#a9583e"; // --primary-active — danh mục tùy chỉnh ngoài 8 id hệ thống

function colorForCategory(categoryId: string): string {
  return CATEGORY_COLORS[categoryId] ?? FALLBACK_CATEGORY_COLOR;
}

function ModeToggleButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex size-8 items-center justify-center rounded-full border border-hairline transition-colors",
        active ? "bg-surface-cream-strong" : "bg-canvas hover:bg-surface-soft"
      )}
    >
      {children}
    </button>
  );
}

export function ExpenseStructureChart({
  breakdown,
  platformFeeEst,
  showPlatformFee,
  activeCategoryId,
}: {
  breakdown: CategoryBreakdownItem[];
  platformFeeEst: number;
  showPlatformFee: boolean;
  activeCategoryId?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [mode, setMode] = useState<ChartMode>("donut");

  // Đọc lựa chọn Donut/Bar đã nhớ trong phiên (chỉ ở client — tránh mismatch
  // hydration nên đặt trong effect thay vì initializer).
  useEffect(() => {
    const stored = window.sessionStorage.getItem(CHART_MODE_STORAGE_KEY);
    if (stored === "donut" || stored === "bar") {
      setMode(stored);
    }
  }, []);

  function selectMode(next: ChartMode) {
    setMode(next);
    window.sessionStorage.setItem(CHART_MODE_STORAGE_KEY, next);
  }

  function toggleCategoryFilter(categoryId: string) {
    const params = new URLSearchParams(searchParams);
    if (activeCategoryId === categoryId) {
      params.delete("danh_muc");
    } else {
      params.set("danh_muc", categoryId);
    }
    // Đổi bộ lọc danh mục → về trang 1 (giống toolbar bảng): tránh đứng ở trang
    // ≥2 rồi lọc còn ít dòng khiến trang hiện tại rỗng.
    params.delete("trang");
    const qs = params.toString();
    router.replace(qs ? `?${qs}` : "?", { scroll: false });
  }

  // `breakdown` đã được sắp giảm dần theo amount ở expense-queries.ts
  // (getExpenseSummary) — không sort lại ở đây để không lặp logic.
  const total = breakdown.reduce((sum, item) => sum + item.amount, 0);

  return (
    <div className="rounded-xl border border-hairline bg-canvas p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-serif text-lg text-ink">Cơ cấu chi phí theo danh mục</h3>
        <div className="flex gap-1">
          <ModeToggleButton active={mode === "donut"} label="Xem dạng donut" onClick={() => selectMode("donut")}>
            <PieChartIcon className="size-4" />
          </ModeToggleButton>
          <ModeToggleButton active={mode === "bar"} label="Xem dạng cột" onClick={() => selectMode("bar")}>
            <BarChart3 className="size-4" />
          </ModeToggleButton>
        </div>
      </div>

      <div className="relative mt-4 h-64 w-full">
        {mode === "donut" ? (
          <>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={breakdown}
                  dataKey="amount"
                  nameKey="name"
                  innerRadius="60%"
                  outerRadius="90%"
                  paddingAngle={breakdown.length > 1 ? 2 : 0}
                  stroke="none"
                >
                  {breakdown.map((item) => (
                    <Cell key={item.categoryId} fill={colorForCategory(item.categoryId)} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <p className="text-xs text-muted-foreground">Tổng sổ</p>
              <p className="font-serif text-xl text-ink">{formatVnd(total)}</p>
            </div>
          </>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={breakdown} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 4 }}>
              <XAxis type="number" hide />
              <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
              <Bar dataKey="amount" radius={[0, 4, 4, 0]} barSize={18}>
                {breakdown.map((item) => (
                  <Cell key={item.categoryId} fill={colorForCategory(item.categoryId)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="mt-4 flex flex-col gap-1">
        {breakdown.map((item) => {
          const isActive = activeCategoryId === item.categoryId;
          return (
            <button
              key={item.categoryId}
              type="button"
              onClick={() => toggleCategoryFilter(item.categoryId)}
              className={cn(
                "flex items-center justify-between gap-2 rounded-lg border px-2 py-1.5 text-left text-sm transition-colors",
                isActive ? "border-primary bg-surface-soft" : "border-transparent hover:bg-surface-soft"
              )}
            >
              <span className="flex items-center gap-2 text-ink">
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: colorForCategory(item.categoryId) }}
                />
                {item.name}
              </span>
              <span className="flex items-center gap-2">
                <span className="text-ink">{formatVnd(item.amount)}</span>
                <span className="text-muted-foreground">{Math.round(item.pct)}%</span>
              </span>
            </button>
          );
        })}
      </div>

      {showPlatformFee && (
        <>
          <div className="my-3 border-t border-hairline" />
          <p
            className="text-xs text-muted-foreground"
            title="Phí sàn thực tế Pancake trả về trên từng đơn hợp lệ — không ghi vào sổ chi phí, xem chi tiết ở Báo cáo P&L"
          >
            🔗 Phí sàn (từ đơn thực tế): {formatVnd(platformFeeEst)}
          </p>
        </>
      )}
    </div>
  );
}
