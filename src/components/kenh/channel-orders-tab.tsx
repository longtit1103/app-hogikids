"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { OrderStatus } from "@prisma/client";
import { format } from "date-fns";

import { OrderStatusBadge } from "@/components/orders/order-status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatVnd } from "@/lib/format";
import { ORDER_STATUS_META } from "@/lib/orders/order-status-meta";
import type { OrderListRow } from "@/lib/queries/orders";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 20;

const STATUS_OPTIONS = (Object.entries(ORDER_STATUS_META) as [OrderStatus, { slug: string; label: string }][]).map(
  ([status, meta]) => ({ status, ...meta })
);

/**
 * Tab "Đơn hàng" (mặc định) của `/kenh/:id` — bảng đơn READ-ONLY thuộc đúng
 * kênh trong kỳ toàn cục. Search/status filter cập nhật `?q=`/`?trang_thai=`
 * (CÙNG slug phase 3 — `ORDER_STATUS_META`) trên URL của TRANG kênh (không
 * phải `/don-hang`) → page.tsx refetch `getOrderListPage`. Giữ nguyên
 * `tu`/`den`/`so_sanh`/`tab` khi đổi filter, chỉ reset `trang`.
 */
export function ChannelOrdersTab({
  rows,
  total,
  page,
  channelId,
  channelName,
}: {
  rows: OrderListRow[];
  total: number;
  page: number;
  channelId: string;
  channelName: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [q, setQ] = useState(searchParams.get("q") ?? "");

  const selectedSlugs = (searchParams.get("trang_thai") ?? "").split(",").filter(Boolean);

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
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  function toggleStatus(slug: string) {
    const next = selectedSlugs.includes(slug) ? selectedSlugs.filter((s) => s !== slug) : [...selectedSlugs, slug];
    setParams({ trang_thai: next.length ? next.join(",") : undefined });
  }

  function pageHref(nextPage: number): string {
    const params = new URLSearchParams(searchParams);
    params.set("trang", String(nextPage));
    return `${pathname}?${params.toString()}`;
  }

  const statusLabel =
    selectedSlugs.length === 0
      ? "Trạng thái"
      : selectedSlugs.length === 1
        ? (STATUS_OPTIONS.find((s) => s.slug === selectedSlugs[0])?.label ?? "Trạng thái")
        : `${STATUS_OPTIONS.find((s) => s.slug === selectedSlugs[0])?.label} +${selectedSlugs.length - 1}`;

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);
  const triggerClass = cn(buttonVariants({ variant: "outline", size: "sm" }));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Tìm mã đơn, tên khách…"
          className="w-full max-w-xs"
        />
        <Popover>
          <PopoverTrigger className={triggerClass}>{statusLabel}</PopoverTrigger>
          <PopoverContent className="w-56">
            <div className="flex flex-col gap-1">
              {STATUS_OPTIONS.map((s) => (
                <label key={s.status} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-soft">
                  <Checkbox checked={selectedSlugs.includes(s.slug)} onCheckedChange={() => toggleStatus(s.slug)} />
                  {s.label}
                </label>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {rows.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">Chưa có đơn nào của {channelName} trong kỳ</p>
      ) : (
        <div className="rounded-xl border border-hairline">
          {/* Desktop: bảng */}
          <Table className="hidden md:table">
            <TableHeader>
              <TableRow>
                <TableHead>Mã</TableHead>
                <TableHead>Ngày</TableHead>
                <TableHead>Khách</TableHead>
                <TableHead>SP</TableHead>
                <TableHead>Trạng thái</TableHead>
                <TableHead className="text-right">Tổng tiền</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((o) => (
                <TableRow key={o.id}>
                  <TableCell>
                    <Link href={`/don-hang?kenh=${channelId}&don=${o.id}`} className="font-mono text-sm text-primary hover:underline">
                      {o.code}
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm">{format(o.orderedAt, "dd/MM HH:mm")}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{o.customerName ?? "Khách sàn"}</TableCell>
                  <TableCell className="text-sm">{o.itemCount} sp</TableCell>
                  <TableCell>
                    <OrderStatusBadge status={o.status} />
                  </TableCell>
                  <TableCell className="text-right text-sm">{formatVnd(o.itemsTotal)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {/* Mobile: card dọc */}
          <div className="flex flex-col gap-2 p-3 md:hidden">
            {rows.map((o) => (
              <div key={o.id} className="flex flex-col gap-1 rounded-lg border border-hairline p-3">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-sm text-primary">{o.code}</span>
                  <OrderStatusBadge status={o.status} />
                </div>
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>{format(o.orderedAt, "dd/MM HH:mm")}</span>
                  <span>{formatVnd(o.itemsTotal)}</span>
                </div>
                <div className="text-sm text-muted-foreground">{o.customerName ?? "Khách sàn"} · {o.itemCount} sp</div>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between border-t border-hairline px-4 py-3 text-sm text-muted-foreground">
            <span>
              Hiển thị {from}–{to} / {total}
            </span>
            <div className="flex items-center gap-1">
              <Link
                href={pageHref(Math.max(1, page - 1))}
                aria-disabled={page <= 1}
                className={cn("rounded-md px-2 py-1 hover:bg-surface-soft", page <= 1 && "pointer-events-none opacity-40")}
              >
                ‹
              </Link>
              <Link
                href={pageHref(Math.min(totalPages, page + 1))}
                aria-disabled={page >= totalPages}
                className={cn("rounded-md px-2 py-1 hover:bg-surface-soft", page >= totalPages && "pointer-events-none opacity-40")}
              >
                ›
              </Link>
            </div>
          </div>
        </div>
      )}

      <Link href={`/don-hang?kenh=${channelId}`} className="text-sm text-primary hover:underline">
        Mở màn Đơn hàng →
      </Link>
    </div>
  );
}
