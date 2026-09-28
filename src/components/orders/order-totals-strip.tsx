import { endOfMonth, format, startOfMonth } from "date-fns";
import type { OrderStatus } from "@prisma/client";

import { formatVnd } from "@/lib/format";
import { ORDER_STATUS_META } from "@/lib/orders/order-status-meta";
import { formatPlatformFeeRatio } from "@/lib/orders/provisional-fee";
import type { OrderListTotals } from "@/lib/queries/orders";
import { cn } from "@/lib/utils";

/**
 * Trạng thái được P&L coi là "đơn hợp lệ" (bất biến: loại RETURNED + CANCELLED).
 * Chỉ dùng để nói cho user biết dải tổng đang có khớp bảng P&L hay không —
 * KHÔNG tham gia tính tiền (tiền do query trả, P&L do `pnl.ts` tính).
 */
const PNL_VALID_STATUSES: OrderStatus[] = ["PENDING", "SHIPPING", "COMPLETED"];

export function isExactlyPnlValid(statuses: OrderStatus[]): boolean {
  return (
    statuses.length === PNL_VALID_STATUSES.length && PNL_VALID_STATUSES.every((s) => statuses.includes(s))
  );
}

/**
 * P&L chỉ tồn tại theo THÁNG dương lịch trọn vẹn (`/tai-chinh` luôn tính
 * `startOfMonth`–`endOfMonth`) — không có kỳ nửa tháng nào để đối chiếu. Nếu
 * không kiểm điều này, bấm preset "7 ngày"/"Hôm nay" ở bộ lọc Đơn hàng (giữ
 * nguyên `trang_thai` hợp lệ từ lượt drill trước) vẫn khiến caption khẳng định
 * "khớp bảng Lỗ lãi" trong khi P&L không hề có con số cho kỳ đó — trấn an sai.
 */
export function isFullCalendarMonth(range: { from: Date; to: Date }): boolean {
  return range.from.getTime() === startOfMonth(range.from).getTime() && range.to.getTime() === endOfMonth(range.from).getTime();
}

function Tile({
  label,
  amount,
  emphasis,
  note,
}: {
  label: string;
  amount: number;
  emphasis?: boolean;
  /** Chú thích phụ dưới số (vd tỉ lệ % phí sàn trên doanh thu). */
  note?: string | null;
}) {
  return (
    <div className={cn("flex flex-col gap-1 rounded-lg p-3", emphasis ? "bg-surface-cream-strong" : "bg-surface-card")}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("tabular-nums", emphasis ? "text-base text-ink" : "text-sm text-ink")}>
        {formatVnd(amount)}
        {note && <span className="ml-1.5 text-xs text-muted-foreground">· {note}</span>}
      </span>
    </div>
  );
}

/**
 * Dải tổng ĐẶT TRÊN bảng đơn — 4 số của TOÀN BỘ đơn khớp bộ lọc (không phải
 * trang đang xem), để đối chiếu thẳng với 3 dòng đầu bảng P&L
 * (`/tai-chinh?tab=loi-lo`) và dòng subtotal "Thực nhận từ sàn".
 *
 * Quy ước dấu GIỐNG bảng P&L (`pnl-tab.tsx` + `displayValue()`): khoản bị trừ
 * hiện nhãn tiền tố "− " VÀ số âm; dòng dẫn xuất hiện tiền tố "= ".
 * Cột "Phí sàn"/"Voucher" trong bảng cũng hiện số âm để không lệch quy ước.
 *
 * Caption nói rõ số đang cộng trên TẬP NÀO: đổi bộ lọc là số khác đi và không
 * còn khớp P&L nữa — phải nói ra, không để người đọc tự suy.
 */
export function OrderTotalsStrip({
  totals,
  orderCount,
  range,
  statuses,
  channelNames,
  q,
}: {
  totals: OrderListTotals;
  orderCount: number;
  /** Kỳ đang lọc; `null` = URL không có `ngay_tu`/`ngay_den` → cộng mọi thời gian. */
  range: { from: Date; to: Date } | null;
  statuses: OrderStatus[];
  /** Tên kênh đang lọc; rỗng = tất cả kênh. */
  channelNames: string[];
  q?: string;
}) {
  const netFromPlatform = totals.itemsTotal - totals.platformFee - totals.discount;

  const periodText = range
    ? `${format(range.from, "dd/MM/yyyy")} – ${format(range.to, "dd/MM/yyyy")}`
    : "tất cả thời gian";
  const statusText = statuses.length
    ? statuses.map((s) => ORDER_STATUS_META[s].label).join(", ")
    : "tất cả trạng thái (gồm cả hoàn hàng, hủy/bom)";

  const matchesPnl =
    range !== null &&
    isFullCalendarMonth(range) &&
    isExactlyPnlValid(statuses) &&
    channelNames.length === 0 &&
    !q?.trim();

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-hairline bg-canvas p-4">
      <div className="flex flex-col gap-0.5">
        <p className="text-sm text-ink">
          Tổng trên <span className="tabular-nums">{orderCount}</span> đơn khớp bộ lọc
        </p>
        <p className="text-xs text-muted-foreground">
          Kỳ: {periodText} · Trạng thái: {statusText}
          {channelNames.length > 0 && ` · Kênh: ${channelNames.join(", ")}`}
          {q?.trim() && ` · Tìm: “${q.trim()}”`}
        </p>
        <p className="text-xs text-muted-foreground">
          {matchesPnl
            ? "Đúng tập “đơn hợp lệ” của P&L — số dưới đây khớp bảng Lỗ lãi cùng kỳ."
            : "Bộ lọc hiện tại khác tập “đơn hợp lệ” trong kỳ của P&L — số dưới đây KHÔNG khớp bảng Lỗ lãi."}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Tile label="Doanh thu gộp" amount={totals.itemsTotal} />
        <Tile
          label="− Phí sàn"
          amount={-totals.platformFee}
          note={formatPlatformFeeRatio(totals.platformFee, totals.itemsTotal)}
        />
        <Tile label="− Voucher" amount={-totals.discount} />
        <Tile label="= Thực nhận từ sàn" amount={netFromPlatform} emphasis />
      </div>
    </section>
  );
}
