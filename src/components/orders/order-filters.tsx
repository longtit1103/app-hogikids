"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { OrderStatus } from "@prisma/client";

import { buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ORDER_STATUS_META, slugToStatus } from "@/lib/orders/order-status-meta";
import { cn } from "@/lib/utils";

type ChannelOption = { id: string; name: string; color: string };

const STATUS_OPTIONS = (Object.entries(ORDER_STATUS_META) as [OrderStatus, { slug: string; label: string }][]).map(
  ([status, meta]) => ({ status, ...meta }),
);

// Lọc ngày CỐ Ý không nằm ở đây mà ở topbar (OrdersTopbarDateFilter) — cùng dòng
// nút "Đồng bộ ngay", đồng bộ vị trí với picker toàn cục Dashboard/Tài chính.
export function OrderFilters({ channels }: { channels: ChannelOption[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [q, setQ] = useState(searchParams.get("q") ?? "");

  const selectedChannels = (searchParams.get("kenh") ?? "").split(",").filter(Boolean);
  const selectedStatuses = slugToStatus(searchParams.get("trang_thai") ?? "");
  // Lọc ngày ở topbar; "Xóa lọc" vẫn xoá cả ngày (clearAll wipe hết param) nên
  // nút hiện khi có bất kỳ lọc nào, kể cả ngày.
  const hasDateFilter = Boolean(searchParams.get("ngay_tu") && searchParams.get("ngay_den"));
  const hasAnyFilter = Boolean(q || selectedChannels.length || selectedStatuses.length || hasDateFilter);

  useEffect(() => {
    const initial = searchParams.get("q") ?? "";
    if (q === initial) return;
    const handle = setTimeout(() => setParams({ q: q || undefined }), 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  function setParams(updates: Record<string, string | undefined>) {
    const params = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(updates)) {
      if (v) params.set(k, v);
      else params.delete(k);
    }
    params.delete("trang");
    router.replace(`${pathname}?${params.toString()}`);
  }

  function toggleChannel(id: string) {
    const next = selectedChannels.includes(id) ? selectedChannels.filter((c) => c !== id) : [...selectedChannels, id];
    setParams({ kenh: next.length ? next.join(",") : undefined });
  }

  function toggleStatus(status: OrderStatus) {
    const slug = ORDER_STATUS_META[status].slug;
    const current = searchParams.get("trang_thai")?.split(",").filter(Boolean) ?? [];
    const next = current.includes(slug) ? current.filter((s) => s !== slug) : [...current, slug];
    setParams({ trang_thai: next.length ? next.join(",") : undefined });
  }

  function clearAll() {
    setQ("");
    router.replace(pathname);
  }

  const channelLabel =
    selectedChannels.length === 0
      ? "Kênh"
      : selectedChannels.length === 1
        ? `Kênh: ${channels.find((c) => c.id === selectedChannels[0])?.name ?? selectedChannels[0]}`
        : `Kênh: ${channels.find((c) => c.id === selectedChannels[0])?.name ?? selectedChannels[0]} +${selectedChannels.length - 1}`;

  const statusLabel =
    selectedStatuses.length === 0
      ? "Trạng thái"
      : selectedStatuses.length === 1
        ? ORDER_STATUS_META[selectedStatuses[0]].label
        : `${ORDER_STATUS_META[selectedStatuses[0]].label} +${selectedStatuses.length - 1}`;

  const triggerClass = cn(buttonVariants({ variant: "outline", size: "sm" }));

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Tìm mã đơn, mã sàn, tên khách…"
        className="w-full max-w-xs"
      />

      <Popover>
        <PopoverTrigger className={triggerClass}>{channelLabel}</PopoverTrigger>
        <PopoverContent className="w-56">
          <div className="flex flex-col gap-1">
            {channels.map((c) => (
              <label
                key={c.id}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-soft"
              >
                <Checkbox checked={selectedChannels.includes(c.id)} onCheckedChange={() => toggleChannel(c.id)} />
                <span className="size-2 rounded-full" style={{ backgroundColor: c.color }} />
                {c.name}
              </label>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger className={triggerClass}>{statusLabel}</PopoverTrigger>
        <PopoverContent className="w-56">
          <div className="flex flex-col gap-1">
            {STATUS_OPTIONS.map((s) => (
              <label
                key={s.status}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-soft"
              >
                <Checkbox checked={selectedStatuses.includes(s.status)} onCheckedChange={() => toggleStatus(s.status)} />
                {s.label}
              </label>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      {hasAnyFilter && (
        <button type="button" onClick={clearAll} className="text-sm text-primary hover:underline">
          Xóa lọc
        </button>
      )}
    </div>
  );
}
