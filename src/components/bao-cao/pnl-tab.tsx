"use client";

import { useState } from "react";

import { PnlLineLabel } from "@/components/bao-cao/pnl-line-label";
import { PnlMonthPicker } from "@/components/bao-cao/pnl-month-picker";
import { SyncNowButton } from "@/components/shell/sync-now-button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatVnd } from "@/lib/format";
import {
  buildPnlLineItems,
  computePnlLineDelta,
  displayValue,
  isPnlMonthEmpty,
  type PnlLineDelta,
  type PnlLineItem,
} from "@/lib/reports/pnl-line-items";
import { pnlPercentBase } from "@/lib/reports/pnl-percent-base";
import { expandableIds, visiblePnlItems } from "@/lib/reports/pnl-line-tree";
import type { PnlBreakdown } from "@/lib/reports/pnl";
import { resolvePnlDrillHref } from "@/lib/reports/pnl-drill-href";
import type { PlatformFeeComponent } from "@/lib/reports/platform-fee-breakdown";
import type { VoucherBreakdown } from "@/lib/reports/voucher-breakdown";
import { cn } from "@/lib/utils";

function formatPct(n: number | null): string {
  if (n === null) return "—";
  return `${n.toLocaleString("vi-VN", { maximumFractionDigits: 1, minimumFractionDigits: 0 })}%`;
}

function DeltaCell({ delta }: { delta: PnlLineDelta }) {
  if (delta.kind === "new") {
    return (
      <TableCell className="text-right">
        <Badge variant="outline">Mới</Badge>
      </TableCell>
    );
  }
  if (delta.kind === "flat") {
    return <TableCell className="text-right text-muted-foreground">—</TableCell>;
  }
  const up = delta.pct > 0;
  return (
    <TableCell className={cn("text-right tabular-nums text-xs", up ? "text-success" : "text-error")}>
      {up ? "▲" : "▼"} {Math.abs(delta.pct).toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%
    </TableCell>
  );
}

/**
 * QUY ƯỚC ĐỌC BẢNG — một dòng thuộc bậc nào, đóng vai gì, nhìn là biết:
 *
 *   LN ròng (`total`)      nền tối, chữ serif to nhất  → kết quả cuối cùng
 *   mốc kết quả (`subtotal`) nền kem đậm, in đậm        → chặng của mạch tính dọc
 *   nhóm (`group`)          nền kem nhạt, in đậm        → tổng của một khối, bung được
 *   khoản lẻ (`line` bậc 0) nền trắng                   → nằm thẳng trên mạch chính
 *   con / cháu (bậc 1–2)    nền trắng, chữ nhỏ + xám dần → chi tiết, có vạch dọc dẫn về cha
 *
 * Ba mức nền đi từ đậm đến nhạt theo đúng thứ tự quan trọng, nên mắt bắt được
 * khung bảng trước rồi mới đọc chi tiết. Bậc con KHÔNG tô nền: tô nữa là bảng
 * thành cầu vồng, mất luôn tác dụng phân tầng.
 */
function rowBandClass(item: PnlLineItem, netProfitNegative: boolean): string {
  if (item.kind === "total") return netProfitNegative ? "bg-surface-dark text-error" : "bg-surface-dark text-on-dark";
  if (item.kind === "subtotal") return "bg-surface-cream-strong text-ink";
  // Nhóm mở đầu một khối ⇒ kẻ vạch trên đậm hơn để mắt thấy ranh giới khối ngay
  // cả khi khối đang bung dài; nền nhạt hơn mốc kết quả vì nó là "đầu khối", chưa
  // phải chặng kết quả của mạch tính.
  if (item.kind === "group") return "border-t-2 border-t-hairline bg-surface-soft text-ink";
  return "";
}

/** Cỡ chữ + độ đậm của cả DÒNG (nhãn lẫn số) — dùng chung để hai cột không lệch nhau. */
function rowTypeClass(item: PnlLineItem): string {
  if (item.kind === "total") return "font-serif text-lg";
  if (item.kind === "group" || item.kind === "subtotal") return "font-medium";
  if (item.depth === 2) return "text-[13px] text-muted-foreground";
  if (item.depth === 1) return "text-[13px] text-body";
  return "";
}

export function PnlTab({
  monthPnl,
  prevMonthPnl,
  month,
  gmv,
  feeComponents = [],
  prevFeeComponents = [],
  voucher,
  prevVoucher,
  backfilledFee = 0,
  prevBackfilledFee = 0,
}: {
  monthPnl: PnlBreakdown;
  prevMonthPnl: PnlBreakdown;
  month: Date;
  /** Doanh số (GMV) tham chiếu — tính riêng (sumGmv), không thuộc PnlBreakdown. */
  gmv?: number;
  /** Chi tiết phí sàn trong kỳ — sinh dòng con cho "Phí sàn". Vắng → bảng như cũ. */
  feeComponents?: PlatformFeeComponent[];
  /** Cùng thứ của tháng trước — để dòng con cũng so được với tháng trước. */
  prevFeeComponents?: PlatformFeeComponent[];
  /** Ba thành phần giảm giá cho khách — sinh dòng con cho "Voucher". */
  voucher?: VoucherBreakdown;
  prevVoucher?: VoucherBreakdown;
  /** Σ phí ước tính của đơn được bù — tách khỏi phần "Pancake chưa trả chi tiết". */
  backfilledFee?: number;
  prevBackfilledFee?: number;
}) {
  // Quy ước href drill-down nằm ở `pnl-drill-href.ts` — tóm tắt: đích nào đọc
  // range toàn cục (/tai-chinh, /bao-cao) thì được neo ĐÚNG tháng đang hiển thị
  // trên bảng, còn lại giữ nguyên. Không đọc range toàn cục ở đây nữa: bảng P&L
  // luôn theo tháng, mang range toàn cục sang sẽ lệch kỳ với số vừa bấm.
  const drillHref = (href: string) => resolvePnlDrillHref(href, month);

  const allItems = buildPnlLineItems(monthPnl, feeComponents, voucher, backfilledFee);
  const prevById = new Map(
    buildPnlLineItems(prevMonthPnl, prevFeeComponents, prevVoucher, prevBackfilledFee).map((i) => [i.id, i])
  );

  // Dòng cha nào có con thì mọc mũi tên. Mặc định BUNG HẾT: bảng tự kể ra tiền
  // đi đâu mà không phải bấm dò từng dòng — thu gọn thủ công vẫn còn đó cho ai
  // chỉ muốn nhìn mạch chính. Giữ ở state phía client, không đẩy vào URL: đây là
  // trạng thái xem tạm chứ không phải bộ lọc cần chia sẻ hay in ra.
  const parentsWithChildren = expandableIds(allItems);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const expanded = new Set([...parentsWithChildren].filter((id) => !collapsed.has(id)));
  const items = visiblePnlItems(allItems, expanded);

  function toggle(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  // So theo TỪNG id chứ không theo kích thước hai tập: đổi tháng làm danh sách
  // dòng con đổi theo (kỳ không có ads thì mất hẳn nhóm đó), `collapsed` còn giữ
  // id của kỳ trước nên đếm số lượng sẽ ra "đã thu gọn hết" trong khi trên màn
  // vẫn còn nhóm đang bung — nút hiện sai chữ và bấm một phát không ăn thua.
  const allCollapsed = [...parentsWithChildren].every((id) => collapsed.has(id));

  // Mẫu số DUY NHẤT toàn app (pnl-percent-base.ts) = dòng "Doanh thu" đầu bảng — dòng đầu luôn
  // 100%, badge và cột % không lệch cơ sở với bảng lẫn các màn khác (KPI, Xu hướng, so kênh).
  const pctBase = pnlPercentBase(monthPnl);
  const marginPct = pctBase ? (monthPnl.grossProfit / pctBase) * 100 : null;
  const netMarginPct = pctBase ? (monthPnl.netProfit / pctBase) * 100 : null;
  const adsToRevenuePct = pctBase ? (monthPnl.ads / pctBase) * 100 : null;

  if (isPnlMonthEmpty(monthPnl)) {
    return (
      <div className="flex flex-col gap-4">
        <PnlMonthPicker />
        <div className="flex flex-col items-center gap-3 rounded-xl border border-hairline bg-canvas px-6 py-16 text-center">
          <p className="text-sm text-muted-foreground">
            Chưa có dữ liệu tháng {month.getMonth() + 1}/{month.getFullYear()}
          </p>
          <SyncNowButton />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PnlMonthPicker />
        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary">Biên gộp {formatPct(marginPct)}</Badge>
          <Badge variant="secondary">Biên ròng {formatPct(netMarginPct)}</Badge>
          <Badge variant="secondary">Ads/Doanh thu {formatPct(adsToRevenuePct)}</Badge>
        </div>
      </div>

      {gmv !== undefined && (
        <p className="text-xs text-muted-foreground">
          Doanh số (GMV): <span className="tabular-nums text-ink">{formatVnd(gmv)}</span> — tổng đơn đặt, gồm cả đơn hủy/hoàn
        </p>
      )}

      <div className="overflow-x-auto rounded-xl border border-hairline">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <span className="inline-flex items-center gap-2">
                  Khoản mục
                  {parentsWithChildren.size > 0 && (
                    <button
                      type="button"
                      onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(parentsWithChildren))}
                      className="font-normal text-muted-foreground underline-offset-2 hover:text-ink hover:underline print:hidden"
                    >
                      {allCollapsed ? "Bung tất cả" : "Thu gọn tất cả"}
                    </button>
                  )}
                </span>
              </TableHead>
              <TableHead className="text-right">Số tiền</TableHead>
              <TableHead className="text-right">% / Doanh thu</TableHead>
              <TableHead className="text-right">So tháng trước</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => {
              const amount = displayValue(item);
              const pct = pctBase ? (amount / pctBase) * 100 : null;
              const prevItem = prevById.get(item.id);
              const delta = computePnlLineDelta(amount, prevItem ? displayValue(prevItem) : 0);
              // Dòng subtotal cũng bấm được nếu có href (vd "Doanh thu" drill sang Đơn hàng).
              const clickable = item.kind !== "total" && Boolean(item.href);

              return (
                <TableRow key={item.id} className={rowBandClass(item, monthPnl.netProfit < 0)}>
                  {/* `print:whitespace-normal`: bản in bổ sung chú thích vào cạnh nhãn
                      (xem PnlLineLabel), để nowrap thì dòng dài tràn khỏi khổ giấy. */}
                  <TableCell className={cn(rowTypeClass(item), "print:whitespace-normal")}>
                    <div className="flex items-center gap-1.5">
                      <PnlLineLabel
                        item={item}
                        expandable={parentsWithChildren.has(item.id)}
                        expanded={expanded.has(item.id)}
                        onToggle={() => toggle(item.id)}
                        href={clickable ? drillHref(item.href!) : undefined}
                      />
                      {item.id === "netProfit" && (
                        <Badge className="border-none bg-on-dark/15 text-on-dark">tạm tính</Badge>
                      )}
                    </div>
                  </TableCell>
                  {/* Dòng `aside` ("Sàn trợ giá thêm") nằm TRONG khối Doanh thu và vẽ y hệt anh em
                      cùng bậc, nhưng KHÔNG góp vào tổng nhóm — nhìn cột số mà cộng tay là ra thừa
                      đúng khoản sàn chịu. Số tiền bọc ngoặc + màu phụ theo quy ước kế toán quen
                      thuộc cho dòng ghi chú: mắt nhận ra ngay "số này không nằm trong mạch cộng
                      trừ" mà không phải đọc chú thích. Chỉ đổi CÁCH BÀY — bậc, vạch dọc, phép
                      tính và `summableChildren` giữ nguyên. */}
                  <TableCell
                    className={cn(
                      "text-right tabular-nums",
                      rowTypeClass(item),
                      item.aside && "text-muted-foreground",
                    )}
                  >
                    {item.aside ? `(${formatVnd(amount)})` : formatVnd(amount)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-xs opacity-80">{formatPct(pct)}</TableCell>
                  <DeltaCell delta={delta} />
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        <p>Phí sàn là số thực tế Pancake trả về trên đơn hợp lệ — chưa phải số đối soát cuối kỳ của sàn</p>
        <p>P&amp;L trừ COGS theo đơn bán, không trừ chi phí &quot;Nhập hàng&quot; (dòng tiền)</p>
      </div>
    </div>
  );
}
