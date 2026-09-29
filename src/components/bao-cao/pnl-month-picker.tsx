"use client";

import { useState } from "react";
import { addMonths, endOfMonth, isSameMonth, startOfMonth, subMonths } from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { useDateRange } from "@/components/shell/date-range-provider";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const MONTH_LABELS = Array.from({ length: 12 }, (_, i) => `Th${i + 1}`);

/**
 * Điều hướng THÁNG cho tab P&L. KHÔNG có state tháng riêng — đọc/ghi thẳng lựa chọn toàn cục qua
 * `useDateRange()` (xem file header date-range-provider.tsx), nên đổi tháng ở đây cũng đổi bộ chọn
 * trên topbar và ngược lại — 1 nguồn thời gian duy nhất. Chọn tháng = chọn CÓ CHỦ Ý ⇒ lưu cookie
 * (#254); chọn đúng tháng HIỆN TẠI ⇒ lưu preset "Tháng này" (tự trôi sang tháng mới — chủ shop chốt
 * 29/09), tháng cũ ⇒ lưu cứng khoảng tháng đó.
 *
 * Tháng đang hiện chỉ đổi khi server trả (cùng lúc số liệu). Trong lúc chờ (`dangCapNhat`) mọi nút
 * đổi tháng bị khoá: bấm ‹ hai lần nhanh sẽ tính bước thứ hai từ tháng CŨ (chưa đổi) ⇒ chỉ lùi 1 tháng.
 */
export function PnlMonthPicker() {
  const { range, applyCustomRange, selectPreset, dangCapNhat } = useDateRange();
  const [open, setOpen] = useState(false);
  const [gridYear, setGridYear] = useState(() => range.to.getFullYear());

  const month = startOfMonth(range.to);
  const now = new Date();
  const isCurrentMonth = isSameMonth(month, now);

  // Range toàn cục không khớp trọn tháng (preset Hôm nay/7 ngày, hoặc custom
  // range không phải đúng 1 tháng đầy đủ) → P&L vẫn tính theo tháng CHỨA
  // range.to, caption báo rõ để chủ shop không hiểu nhầm số đang xem đúng
  // theo preset đang chọn ở topbar.
  const isNonMonthRange =
    range.from.getTime() !== startOfMonth(month).getTime() || range.to.getTime() !== endOfMonth(month).getTime();

  function goToMonth(target: Date) {
    if (dangCapNhat) return;
    if (isSameMonth(target, now)) selectPreset("this_month");
    else applyCustomRange({ from: startOfMonth(target), to: endOfMonth(target) });
    setOpen(false);
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1" aria-busy={dangCapNhat}>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Tháng trước"
          className="print:hidden"
          disabled={dangCapNhat}
          onClick={() => goToMonth(subMonths(month, 1))}
        >
          <ChevronLeft className="size-4" />
        </Button>

        <Popover
          open={open}
          onOpenChange={(o) => {
            setOpen(o);
            if (o) setGridYear(month.getFullYear());
          }}
        >
          <PopoverTrigger className="rounded-md px-2 py-1 font-serif text-lg text-ink hover:bg-surface-soft">
            {`Tháng ${month.getMonth() + 1}/${month.getFullYear()}`}
          </PopoverTrigger>
          <PopoverContent className="w-64">
            <div className="flex items-center justify-between px-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Năm trước"
                onClick={() => setGridYear((y) => y - 1)}
              >
                <ChevronLeft className="size-4" />
              </Button>
              <span className="text-sm font-medium text-ink">{gridYear}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Năm sau"
                disabled={gridYear >= now.getFullYear()}
                onClick={() => setGridYear((y) => y + 1)}
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
            <div className="mt-2 grid grid-cols-4 gap-1">
              {MONTH_LABELS.map((label, i) => {
                const candidate = new Date(gridYear, i, 1);
                const disabled = candidate > now || dangCapNhat;
                const active = isSameMonth(candidate, month);
                return (
                  <button
                    key={label}
                    type="button"
                    disabled={disabled}
                    onClick={() => goToMonth(candidate)}
                    className={cn(
                      "rounded-md px-2 py-1.5 text-sm transition-colors",
                      active ? "bg-primary text-on-primary" : "hover:bg-surface-soft",
                      disabled && "cursor-not-allowed opacity-40 hover:bg-transparent"
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Tháng sau"
          className="print:hidden"
          disabled={isCurrentMonth || dangCapNhat}
          onClick={() => goToMonth(addMonths(month, 1))}
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>

      {isNonMonthRange && (
        <p className="text-xs text-muted-foreground">
          P&amp;L luôn tính theo tháng — đang xem Tháng {month.getMonth() + 1}/{month.getFullYear()}
        </p>
      )}
    </div>
  );
}
