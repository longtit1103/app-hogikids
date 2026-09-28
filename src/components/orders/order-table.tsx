import Link from "next/link";
import { format } from "date-fns";

import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatVnd } from "@/lib/format";
import {
  formatPlatformFeeRatio,
  isProvisionalPlatformFee,
  PROVISIONAL_FEE_TITLE,
  returnedOrderFeeDisplay,
} from "@/lib/orders/provisional-fee";
import type { OrderListRow } from "@/lib/queries/orders";
import { cn } from "@/lib/utils";
import { OrderStatusBadge } from "./order-status-badge";

const PAGE_SIZE = 20;

function hrefWith(sp: Record<string, string | undefined>, overrides: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  const merged = { ...sp, ...overrides };
  for (const [k, v] of Object.entries(merged)) if (v) params.set(k, v);
  const qs = params.toString();
  return qs ? `/don-hang?${qs}` : "/don-hang";
}

export function OrderTable({
  rows,
  total,
  page,
  sp,
}: {
  rows: OrderListRow[];
  total: number;
  page: number;
  sp: Record<string, string | undefined>;
}) {
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);
  // "Tạm tính" đơn hoàn/hủy chỉ hiện trong cửa sổ đối soát (tuổi đơn) → cần mốc hiện tại.
  const now = new Date();

  return (
    <div className="rounded-xl border border-hairline">
      {/* Desktop: bảng */}
      <Table className="hidden md:table">
        <TableHeader>
          <TableRow>
            <TableHead>Mã</TableHead>
            <TableHead title="Mã đơn hàng bên sàn (Shopee/TikTok) — để đối chiếu với seller center">Mã sàn</TableHead>
            <TableHead>Ngày tạo</TableHead>
            <TableHead>Cập nhật</TableHead>
            <TableHead>Kênh</TableHead>
            <TableHead>Khách</TableHead>
            <TableHead>SP</TableHead>
            <TableHead className="text-right">Tổng tiền</TableHead>
            <TableHead className="text-right">Phí sàn</TableHead>
            <TableHead className="text-right">Voucher</TableHead>
            <TableHead>Trạng thái</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((o) => {
            // Đơn hoàn/hủy marketplace: hiện SỐ THỰC returnedFee (đã vào P&L) thay
            // vì platformFeeEst tạm; đơn hợp lệ/kênh ước tính % giữ nguyên cột cũ.
            const returned = returnedOrderFeeDisplay(o, now);
            const fee = returned.show ? returned.fee : o.platformFeeEst;
            const provisionalFee = returned.show ? returned.provisional : isProvisionalPlatformFee(o);
            const feeRatio = formatPlatformFeeRatio(fee, o.itemsTotal);
            return (
              <TableRow key={o.id} className="cursor-pointer">
                <TableCell>
                  <Link href={hrefWith(sp, { don: o.id })} className="font-mono text-sm text-primary hover:underline">
                    {o.code}
                  </Link>
                </TableCell>
                {/* Mã đơn BÊN SÀN — `select-all` để 1 click chọn trọn mã, dán sang seller center đối chiếu.
                    "—" = đơn không có mã sàn thật (đơn bù từ mirror kho / kênh ngoài sàn). */}
                <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                  {o.maSan ? <span className="select-all">{o.maSan}</span> : "—"}
                </TableCell>
                <TableCell className="text-sm">{format(o.orderedAt, "dd/MM HH:mm")}</TableCell>
                {/* Thời điểm đơn VÀO trạng thái hiện tại (Pancake status_history) — "—" khi thiếu dữ liệu. */}
                <TableCell className="text-sm">
                  {o.statusChangedAt ? format(o.statusChangedAt, "dd/MM HH:mm") : "—"}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="gap-1.5">
                    <span className="size-2 rounded-full" style={{ backgroundColor: o.channelColor }} />
                    {o.channelName}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{o.customerName ?? "Khách sàn"}</TableCell>
                <TableCell className="text-sm">{o.itemCount} sp</TableCell>
                <TableCell className="text-right text-sm tabular-nums">{formatVnd(o.itemsTotal)}</TableCell>
                {/* Phí sàn + Voucher là khoản BỊ TRỪ — hiện số âm, cùng quy ước dấu với bảng P&L và dải tổng trên. */}
                <TableCell className="text-right text-sm tabular-nums">
                  <span className="inline-flex items-center justify-end gap-1.5">
                    {provisionalFee && (
                      <Badge variant="outline" className="border-warning/40 text-warning" title={PROVISIONAL_FEE_TITLE}>
                        tạm tính
                      </Badge>
                    )}
                    {formatVnd(-fee)}
                    {feeRatio && <span className="text-xs text-muted-foreground">· {feeRatio}</span>}
                  </span>
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">{formatVnd(-o.discount)}</TableCell>
                <TableCell>
                  <OrderStatusBadge status={o.status} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {/* Mobile: card dọc */}
      <div className="flex flex-col gap-2 p-3 md:hidden">
        {rows.map((o) => {
          // Đơn hoàn/hủy marketplace: hiện SỐ THỰC returnedFee (đã vào P&L) thay vì
          // platformFeeEst tạm; đơn hợp lệ/kênh ước tính % giữ nguyên cột cũ.
          const returned = returnedOrderFeeDisplay(o, now);
          const fee = returned.show ? returned.fee : o.platformFeeEst;
          const provisionalFee = returned.show ? returned.provisional : isProvisionalPlatformFee(o);
          const feeRatio = formatPlatformFeeRatio(fee, o.itemsTotal);
          return (
          <Link
            key={o.id}
            href={hrefWith(sp, { don: o.id })}
            className="flex flex-col gap-1 rounded-lg border border-hairline p-3"
          >
            <div className="flex items-center justify-between">
              <span className="font-mono text-sm text-primary">{o.code}</span>
              <OrderStatusBadge status={o.status} />
            </div>
            {/* Mã đơn bên sàn — chỉ hiện khi có, card không cần dòng "—" thừa. */}
            {o.maSan && <span className="font-mono text-xs text-muted-foreground">Mã sàn {o.maSan}</span>}
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>
                {format(o.orderedAt, "dd/MM HH:mm")}
                {o.statusChangedAt && <> · cập nhật {format(o.statusChangedAt, "dd/MM HH:mm")}</>}
              </span>
              <span className="tabular-nums">{formatVnd(o.itemsTotal)}</span>
            </div>
            {/* Chỉ hiện khi khác 0 — đơn không có phí/voucher thì thêm dòng này chỉ làm rối card.
                Đơn hoàn/hủy (returned.show=true) LUÔN hiện khối phí kể cả fee=0, để nhãn "tạm
                tính" xuất hiện khi sàn chưa đối soát — khớp hành vi cột desktop. */}
            {(returned.show || fee !== 0 || o.discount !== 0) && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {(returned.show || fee !== 0) && (
                  <span className="inline-flex items-center gap-1 tabular-nums">
                    Phí sàn {formatVnd(-fee)}
                    {feeRatio && <span>· {feeRatio}</span>}
                    {provisionalFee && (
                      <Badge variant="outline" className="border-warning/40 text-warning" title={PROVISIONAL_FEE_TITLE}>
                        tạm tính
                      </Badge>
                    )}
                  </span>
                )}
                {o.discount !== 0 && <span className="tabular-nums">Voucher {formatVnd(-o.discount)}</span>}
              </div>
            )}
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <span className="size-2 rounded-full" style={{ backgroundColor: o.channelColor }} />
              {o.channelName} · {o.customerName ?? "Khách sàn"} · {o.itemCount} sp
            </div>
          </Link>
          );
        })}
      </div>

      <div className="flex items-center justify-between border-t border-hairline px-4 py-3 text-sm text-muted-foreground">
        <span>
          Hiển thị {from}–{to} / {total}
        </span>
        <div className="flex items-center gap-1">
          <Link
            href={hrefWith(sp, { trang: String(Math.max(1, page - 1)) })}
            aria-disabled={page <= 1}
            className={cn("rounded-md px-2 py-1 hover:bg-surface-soft", page <= 1 && "pointer-events-none opacity-40")}
          >
            ‹
          </Link>
          <Link
            href={hrefWith(sp, { trang: String(Math.min(totalPages, page + 1)) })}
            aria-disabled={page >= totalPages}
            className={cn(
              "rounded-md px-2 py-1 hover:bg-surface-soft",
              page >= totalPages && "pointer-events-none opacity-40",
            )}
          >
            ›
          </Link>
        </div>
      </div>
    </div>
  );
}
