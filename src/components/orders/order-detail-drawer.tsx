"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { format } from "date-fns";

import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatVnd } from "@/lib/format";
import { usesRealPlatformFee } from "@/lib/channels/real-fee-channels";
import { buildOrderProfitLines, buildSettlementLines } from "@/lib/orders/order-detail-lines";
import { calcOrderCogs } from "@/lib/orders/order-profit";
import {
  formatPlatformFeeRatio,
  isProvisionalPlatformFee,
  PROVISIONAL_FEE_TITLE,
  returnedOrderFeeDisplay,
} from "@/lib/orders/provisional-fee";
import type { OrderDetail } from "@/lib/queries/orders";
import { OrderProfitTree } from "./order-profit-tree";
import { OrderReturnedPanel } from "./order-returned-panel";
import { OrderStatusBadge } from "./order-status-badge";

/**
 * Drawer chi tiết đơn (đọc-only) + khối tính lãi đơn theo giá vốn HIỆN HÀNH. Mở qua `?don=<id>`.
 *
 * Hai khối số dưới bảng SKU:
 *  1. "Lãi đơn" (mọi đơn hợp lệ) hoặc khối hoàn/hủy (giữ nguyên như cũ) — app TỰ TÍNH,
 *     cây `buildOrderProfitLines` render y hệt cách bảng Lãi/Lỗ làm (`pnl-tab.tsx`).
 *  2. "Sàn quyết toán" (`buildSettlementLines`) — số SÀN thật trả về, CHỈ hiện khi có
 *     (`order.quyetToan !== null`, hiện tại chỉ TikTok đã quyết toán). Đặt CẠNH khối (1)
 *     để đối chiếu, TUYỆT ĐỐI không trộn vào phép tính của (1) — bất biến #7.
 */
export function OrderDetailDrawer({ order }: { order: OrderDetail | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function close() {
    const params = new URLSearchParams(searchParams);
    params.delete("don");
    router.replace(params.size ? `${pathname}?${params.toString()}` : pathname);
  }

  if (!order) return null;

  const { cogs, missingCostCount } = calcOrderCogs(order.items);
  const excludedFromPnl = order.status === "RETURNED" || order.status === "CANCELLED";
  // Shopee/TikTok = phí sàn THẬT từ Pancake (`fee_marketplace`); kênh khác = ước tính % (Cài đặt).
  const realFee = usesRealPlatformFee(order.channelId);
  const provisionalFee = isProvisionalPlatformFee(order);
  const returnedFeeDisplay = returnedOrderFeeDisplay(order, new Date());

  // Cây "Lãi đơn" tính LUÔN cho mọi đơn (thuần, rẻ) — kể cả đơn hoàn/hủy: khối
  // settlement bên dưới cần "Thực nhận từ sàn" của app để tính dòng chênh lệch,
  // dù đơn hoàn/hủy không hiện cây này (đã có khối riêng, giữ nguyên như cũ).
  const profitLines = buildOrderProfitLines({
    itemsTotal: order.itemsTotal,
    discount: order.discount,
    platformFeeEst: order.platformFeeEst,
    cogs,
    items: order.items,
    feeComponents: order.feeComponents,
    marketplaceFunded: order.marketplaceFunded,
  });
  // Đơn hoàn/hủy KHÔNG có "thực nhận" (app cố tình loại khỏi P&L) nên không có gì
  // để so — truyền `null` để bỏ dòng chênh, thay vì đem trừ một số không tồn tại
  // rồi đỏ rực bằng đúng giá trị đơn ngay dưới dòng "đơn không tính vào P&L".
  const thucNhanApp = excludedFromPnl ? null : (profitLines.find((l) => l.id === "netRevenue")?.value ?? 0);
  const settlementLines = order.quyetToan ? buildSettlementLines(order.quyetToan, thucNhanApp) : null;

  const feeBadges = provisionalFee
    ? { platformFee: { label: "tạm tính", title: PROVISIONAL_FEE_TITLE } }
    : undefined;
  const feeRatio = formatPlatformFeeRatio(order.platformFeeEst, order.itemsTotal);
  const feeAmountNotes = feeRatio ? { platformFee: feeRatio } : undefined;

  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <SheetContent
        side="right"
        className="gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-[640px]"
      >
        <SheetHeader>
          <div className="flex items-center gap-2">
            <SheetTitle className="font-mono">{order.code}</SheetTitle>
            <OrderStatusBadge status={order.status} />
            <Badge variant="outline" className="gap-1.5">
              <span className="size-2 rounded-full" style={{ backgroundColor: order.channelColor }} />
              {order.channelName}
            </Badge>
          </div>
          {/* Mã đơn BÊN SÀN để đối chiếu với seller center — `select-all` cho 1 click chọn trọn mã. */}
          {order.maSan && (
            <p className="text-xs text-muted-foreground">
              Mã sàn <span className="font-mono select-all">{order.maSan}</span>
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            đặt {format(order.orderedAt, "dd/MM HH:mm")}
            {order.statusChangedAt && <> · cập nhật {format(order.statusChangedAt, "dd/MM HH:mm")}</>}
            {" "}· đồng bộ {format(order.syncedAt, "dd/MM HH:mm")}
          </p>
        </SheetHeader>

        <div className="flex flex-col gap-4 p-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead>Tên</TableHead>
                <TableHead className="text-right">SL</TableHead>
                <TableHead className="text-right">Đơn giá</TableHead>
                <TableHead className="text-right">Giá vốn hiện hành</TableHead>
                <TableHead className="text-right">Lãi gộp dòng</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {order.items.map((it, i) => {
                // Lãi dòng RÒNG (cùng cơ sở itemsTotal): doanh thu dòng sau giảm giá − giá vốn dòng.
                const lineProfit = it.unitPrice * it.quantity - it.lineDiscount - (it.costPrice ?? 0) * it.quantity;
                return (
                  <TableRow key={i}>
                    <TableCell className="font-mono text-sm">{it.sku}</TableCell>
                    <TableCell className="text-sm">{it.productName}</TableCell>
                    <TableCell className="text-right text-sm">{it.quantity}</TableCell>
                    <TableCell className="text-right text-sm">{formatVnd(it.unitPrice)}</TableCell>
                    <TableCell className="text-right text-sm">
                      {it.costPrice === 0 && it.sku ? (
                        <Link
                          // Dẫn thẳng tới ĐÚNG SKU đang xem, không qua bộ lọc: đơn HOÀN/HỦY bị
                          // chính định nghĩa "đã bán" loại khỏi bộ lọc hẹp, nên link theo bộ lọc
                          // sẽ mở ra danh sách KHÔNG có dòng người ta vừa bấm.
                          href={`/san-pham?q=${encodeURIComponent(it.sku)}`}
                          className="text-warning hover:underline"
                        >
                          ⚠ chưa có
                        </Link>
                      ) : it.costPrice === null ? (
                        // KHÔNG khớp biến thể nào (`variantId` null) hoặc dòng không rõ SKU: màn
                        // Sản phẩm không có gì để sửa — nhập giá cho một biến thể trùng tên cũng
                        // KHÔNG đổi COGS của dòng này. Cảnh báo TĨNH, không link giả.
                        <span
                          className="text-warning"
                          title="Dòng hàng không khớp biến thể nào trong app — nhập giá vốn không sửa được COGS của dòng này"
                        >
                          ⚠ không khớp SP
                        </span>
                      ) : (
                        formatVnd(it.costPrice)
                      )}
                    </TableCell>
                    <TableCell data-testid="line-profit" className="text-right text-sm">
                      {formatVnd(lineProfit)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          {excludedFromPnl ? (
            <OrderReturnedPanel order={order} returnedFeeDisplay={returnedFeeDisplay} />
          ) : (
            <div className="flex flex-col gap-2">
              <OrderProfitTree items={profitLines} badges={feeBadges} amountNotes={feeAmountNotes} />
              <p className="text-xs text-muted-foreground">
                {realFee
                  ? "Phí sàn là số THẬT sàn trả về (qua Pancake)."
                  : "Phí sàn ước tính theo % kênh (Cài đặt)."}
                {provisionalFee &&
                  " Sàn chưa đối soát xong — phí thật thường cao hơn (~27-36%), nên LÃI THẬT sẽ thấp hơn số đang hiện; tự cập nhật khi đơn được đồng bộ lại."}
                {" Chưa gồm chi phí chung (ads, vận chuyển, đóng gói…)."}
                {missingCostCount > 0 && ` ⚠ ${missingCostCount} dòng chưa có giá vốn — lãi đang tính thiếu.`}
              </p>
            </div>
          )}

          {settlementLines && (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">
                Số dưới đây là số SÀN thật sự trả về khi quyết toán — độc lập với số app tính ở trên, không cái nào sửa cái nào.
              </p>
              <OrderProfitTree items={settlementLines} />
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
