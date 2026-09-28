"use client";

import { useEffect, useState } from "react";
import { format } from "date-fns";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { RangePreset } from "@/lib/date-range";

const QUERY_DATE_FORMAT = "yyyy-MM-dd";

export type PresetOption = { value: RangePreset; label: string };

/**
 * Bộ preset ngày CHUẨN dùng chung mọi nơi có dải tab (picker toàn cục
 * Dashboard/Tài chính/Kênh/Báo cáo + bộ lọc /don-hang). Một nguồn duy nhất để
 * các màn đồng bộ — thêm/bớt preset chỉ sửa ở đây.
 */
export const DATE_RANGE_PRESETS: ReadonlyArray<PresetOption> = [
  { value: "today", label: "Hôm nay" },
  { value: "yesterday", label: "Hôm qua" },
  { value: "7d", label: "7 ngày" },
  { value: "30d", label: "30 ngày" },
  { value: "this_month", label: "Tháng này" },
  { value: "last_month", label: "Tháng trước" },
];

function tabClassName(active: boolean): string {
  return cn(
    "rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors",
    active ? "bg-surface-card text-ink" : "text-muted-foreground hover:text-ink"
  );
}

/**
 * Dải tab chọn khoảng thời gian dùng CHUNG (picker toàn cục + bộ lọc Đơn hàng):
 * các preset + popover "Tùy chọn" nhập range tay (validate from ≤ to ≤ hôm nay).
 * Thuần hiển thị — nguồn state (provider `?range=` hay query `ngay_tu/ngay_den`)
 * do CHA quyết qua props/callback; component không tự đọc URL để không khoá vào
 * một khuôn param. Markup/label giữ đúng picker cũ (e2e bám role group + nhãn).
 */
export function DateRangePresetTabs({
  presets,
  activePreset,
  range,
  onSelectPreset,
  onApplyCustomRange,
}: {
  presets: ReadonlyArray<PresetOption>;
  /** Preset đang chọn; "custom" = range tay; null = không lọc ngày (Đơn hàng: "tất cả thời gian"). */
  activePreset: RangePreset | "custom" | null;
  /** Range đang áp — prefill draft popover + nhãn "dd/MM – dd/MM" khi custom. */
  range: { from: Date; to: Date } | null;
  onSelectPreset: (preset: RangePreset) => void;
  onApplyCustomRange: (range: { from: Date; to: Date }) => void;
}) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState("");
  const [draftTo, setDraftTo] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  // Reset draft về range đang áp mỗi lần mở popover (kể cả mở programmatic) —
  // tách khỏi click handler của trigger.
  useEffect(() => {
    if (!popoverOpen) {
      return;
    }
    setDraftFrom(range ? format(range.from, QUERY_DATE_FORMAT) : "");
    setDraftTo(range ? format(range.to, QUERY_DATE_FORMAT) : "");
    setValidationError(null);
  }, [popoverOpen, range]);

  const customLabel =
    activePreset === "custom" && range
      ? `${format(range.from, "dd/MM")} – ${format(range.to, "dd/MM")}`
      : "Tùy chọn";

  function handleApply() {
    if (!draftFrom || !draftTo) {
      return;
    }

    const from = new Date(`${draftFrom}T00:00:00`);
    const to = new Date(`${draftTo}T00:00:00`);
    const today = new Date();

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to || to > today) {
      setValidationError("Khoảng ngày không hợp lệ");
      return;
    }

    onApplyCustomRange({ from, to });
    setPopoverOpen(false);
  }

  return (
    <div
      role="group"
      aria-label="Chọn khoảng thời gian"
      className="flex items-center gap-1 overflow-x-auto rounded-lg bg-surface-soft p-1"
    >
      {presets.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onSelectPreset(option.value)}
          className={tabClassName(activePreset === option.value)}
        >
          {option.label}
        </button>
      ))}

      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger className={tabClassName(activePreset === "custom")}>
          {customLabel}
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="date-range-from">
              Từ ngày
            </label>
            <Input
              id="date-range-from"
              type="date"
              value={draftFrom}
              max={draftTo || undefined}
              onChange={(event) => setDraftFrom(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="date-range-to">
              Đến ngày
            </label>
            <Input
              id="date-range-to"
              type="date"
              value={draftTo}
              min={draftFrom || undefined}
              onChange={(event) => setDraftTo(event.target.value)}
            />
          </div>
          {validationError && (
            <p className="text-xs text-error" role="alert">
              {validationError}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => setPopoverOpen(false)}>
              Hủy
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!draftFrom || !draftTo}
              onClick={handleApply}
            >
              Áp dụng
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
