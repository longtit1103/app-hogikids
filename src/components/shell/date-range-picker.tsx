"use client";

import { DATE_RANGE_PRESETS, DateRangePresetTabs } from "./date-range-preset-tabs";
import { useDateRange } from "./date-range-provider";

/**
 * Global date-range picker: today/7d/this-month/last-month presets + a
 * "Tùy chọn" popover for a manual range. Renders on the routes flagged by
 * `DateRangeProvider.isApplicableRoute` (Dashboard, Tài chính, Kênh*, Báo cáo)
 * and null everywhere else — visibility lives in the provider so this
 * component never has to duplicate the route list. UI tab/popover nằm ở
 * `DateRangePresetTabs` (dùng chung với bộ lọc Đơn hàng).
 */
export function DateRangePicker() {
  const { preset, range, isApplicableRoute, selectPreset, applyCustomRange } = useDateRange();

  if (!isApplicableRoute) {
    return null;
  }

  return (
    <DateRangePresetTabs
      presets={DATE_RANGE_PRESETS}
      activePreset={preset}
      range={range}
      onSelectPreset={selectPreset}
      onApplyCustomRange={applyCustomRange}
    />
  );
}
