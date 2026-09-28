"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { LayoutGrid, Table2 } from "lucide-react";

import { ChannelCardGrid } from "@/components/kenh/channel-card-grid";
import { ChannelCompareTable } from "@/components/kenh/channel-compare-table";
import { Switch } from "@/components/ui/switch";
import type { ChannelPnl } from "@/lib/reports/pnl";
import { cn } from "@/lib/utils";

const VIEW_MODE_STORAGE_KEY = "hogikids_kenh_view_mode";
type ViewMode = "card" | "table";

/**
 * Header "Kênh" + toggle "So với kỳ trước" + segmented Card⇄Bảng,
 * và vùng so sánh bên dưới (card grid mặc định hoặc bảng). Cả 2 control cùng
 * ảnh hưởng cách render vùng so sánh nên sở hữu state ở 1 component (khớp
 * pattern `expense-structure-chart.tsx`: toggle + nội dung trong cùng 1 file).
 *
 * `channels` = MỌI kênh ĐANG BẬT trong Cài đặt, đã zero-fill ở page.tsx —
 * kênh 0 hoạt động trong kỳ vẫn phải có thẻ 0 ₫ (không được biến mất như kết
 * quả thô của `computeChannelPnl`).
 */
export function ChannelComparisonSection({
  channels,
  prevChannels,
  feePctByChannel,
}: {
  channels: ChannelPnl[];
  prevChannels: ChannelPnl[];
  feePctByChannel: Record<string, number>;
}) {
  const [compareOn, setCompareOn] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>("card");

  // Đọc lựa chọn Card/Bảng đã nhớ trong phiên (chỉ ở client — tránh mismatch
  // hydration nên đặt trong effect thay vì initializer, giống expense-structure-chart.tsx).
  useEffect(() => {
    const stored = window.sessionStorage.getItem(VIEW_MODE_STORAGE_KEY);
    if (stored === "card" || stored === "table") {
      setViewMode(stored);
    }
  }, []);

  function selectViewMode(mode: ViewMode) {
    setViewMode(mode);
    window.sessionStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-serif text-2xl text-ink">Kênh</h1>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-ink">
            <Switch checked={compareOn} onCheckedChange={setCompareOn} />
            So với kỳ trước
          </label>
          <div className="flex gap-1 rounded-lg bg-surface-soft p-1">
            <button
              type="button"
              aria-pressed={viewMode === "card"}
              onClick={() => selectViewMode("card")}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                viewMode === "card" ? "bg-canvas text-ink shadow-sm" : "text-muted-foreground hover:text-ink"
              )}
            >
              <LayoutGrid className="size-4" /> Card
            </button>
            <button
              type="button"
              aria-pressed={viewMode === "table"}
              onClick={() => selectViewMode("table")}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                viewMode === "table" ? "bg-canvas text-ink shadow-sm" : "text-muted-foreground hover:text-ink"
              )}
            >
              <Table2 className="size-4" /> Bảng
            </button>
          </div>
        </div>
      </div>

      {channels.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-hairline bg-canvas px-6 py-16 text-center">
          <p className="font-serif text-lg text-ink">Chưa có kênh nào đang bật</p>
          <Link href="/cai-dat" className="text-sm text-primary hover:underline">
            Bật kênh trong Cài đặt
          </Link>
        </div>
      ) : (
        <>
          {viewMode === "card" ? (
            <ChannelCardGrid
              channels={channels}
              prevChannels={prevChannels}
              feePctByChannel={feePctByChannel}
              compareOn={compareOn}
            />
          ) : (
            <ChannelCompareTable channels={channels} />
          )}
          <p className="text-xs text-muted-foreground">
            LN kênh chỉ trừ chi phí gắn kênh — tổng các kênh ≠ LN ròng toàn shop
          </p>
        </>
      )}
    </div>
  );
}
