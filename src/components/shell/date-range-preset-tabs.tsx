"use client";

import { useEffect, useRef, useState } from "react";
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
  dangCapNhat = false,
}: {
  presets: ReadonlyArray<PresetOption>;
  /** Preset đang chọn; "custom" = range tay; null = không lọc ngày (Đơn hàng: "tất cả thời gian"). */
  activePreset: RangePreset | "custom" | null;
  /** Range đang áp — prefill draft popover + nhãn "dd/MM – dd/MM" khi custom. */
  range: { from: Date; to: Date } | null;
  onSelectPreset: (preset: RangePreset) => void;
  onApplyCustomRange: (range: { from: Date; to: Date }) => void;
  /** Đang chờ server lưu lựa chọn + dựng lại số liệu — báo bận, nút đang chọn đổi khi server trả. */
  dangCapNhat?: boolean;
}) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState("");
  const [draftTo, setDraftTo] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  // Reset draft về range đang áp mỗi lần mở popover (kể cả mở programmatic) —
  // tách khỏi click handler của trigger. Phụ thuộc GIÁ TRỊ ngày, không phụ thuộc
  // tham chiếu `range`: layout dựng lại (lưu lựa chọn, điều hướng) tạo object mới
  // cùng ngày — reset theo tham chiếu là xoá mất nháp người dùng đang gõ dở.
  const draftTuGoc = range ? format(range.from, QUERY_DATE_FORMAT) : "";
  const draftDenGoc = range ? format(range.to, QUERY_DATE_FORMAT) : "";
  useEffect(() => {
    if (!popoverOpen) {
      return;
    }
    setDraftFrom(draftTuGoc);
    setDraftTo(draftDenGoc);
    setValidationError(null);
  }, [popoverOpen, draftTuGoc, draftDenGoc]);

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

  // Mép phải mờ dần = "còn nữa, vuốt ngang" (ảnh iPhone 26/09: thanh bị cắt ở chữ "T…" mà không
  // có dấu hiệu nào). Tắt khi đã cuộn hết để khỏi che nút cuối; không bao giờ chặn chạm. KHÔNG gắn
  // theo breakpoint: dưới xl (kể cả iPhone xoay ngang có sidebar) thanh vẫn cuộn — tự bật/tắt theo đo.
  const cuonRef = useRef<HTMLDivElement>(null);
  const [conBenPhai, setConBenPhai] = useState(false);
  useEffect(() => {
    const el = cuonRef.current;
    if (!el) return;
    const capNhat = () => setConBenPhai(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    capNhat();
    el.addEventListener("scroll", capNhat, { passive: true });
    // `ResizeObserver` thay cho nghe `resize` của window — bắt đúng khi BỀ RỘNG PHẦN TỬ đổi mà
    // không có sự kiện resize cửa sổ nào bắn (vd xoay ngang không luôn đồng bộ nhịp với `resize`,
    // nội dung dải tab đổi độ rộng do font/ngôn ngữ số). Đã quan sát cả thay đổi do window resize
    // (phần tử responsive theo viewport) nên không cần nghe thêm window riêng.
    const ro = new ResizeObserver(capNhat);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", capNhat);
      ro.disconnect();
    };
  }, []);

  return (
    <div className="relative">
      <div
        ref={cuonRef}
        role="group"
        aria-label="Chọn khoảng thời gian"
        aria-busy={dangCapNhat}
        className={`flex items-center gap-1 overflow-x-auto rounded-lg bg-surface-soft p-1 transition-opacity ${
          dangCapNhat ? "opacity-60" : ""
        }`}
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
      {conBenPhai && (
        <div
          aria-hidden="true"
          data-slot="mo-cuon-phai"
          className="pointer-events-none absolute inset-y-0 right-0 w-10 rounded-r-lg bg-linear-to-l from-surface-soft to-transparent"
        />
      )}
    </div>
  );
}
