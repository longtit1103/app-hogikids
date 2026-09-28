"use client";

import { useState } from "react";

import { PnlLineLabel } from "@/components/bao-cao/pnl-line-label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatVnd } from "@/lib/format";
import { displayValue, type PnlLineItem } from "@/lib/reports/pnl-line-items";
import { expandableIds, visiblePnlItems } from "@/lib/reports/pnl-line-tree";
import { cn } from "@/lib/utils";

/**
 * Bảng cây khoản mục dùng CHUNG cho khối "Lãi đơn" (`buildOrderProfitLines`) và
 * khối "Sàn quyết toán" (`buildSettlementLines`) trong drawer chi tiết đơn —
 * cùng kiểu `PnlLineItem`, bắt chước ĐÚNG cách bảng Lãi/Lỗ (`pnl-tab.tsx`) thu/bung
 * để hai màn đọc giống hệt nhau, không phải học lại quy ước lần thứ hai.
 *
 * Mặc định BUNG HẾT (khác `pnl-tab.tsx` chỉ có 1 kỳ để đọc lướt, drawer đang xem
 * ĐÚNG 1 đơn nên bung hết ngay từ đầu tiết kiệm cú bấm nhất).
 */
function rowBandClass(item: PnlLineItem): string {
  if (item.kind === "total") return item.value < 0 ? "bg-surface-dark text-error" : "bg-surface-dark text-on-dark";
  if (item.kind === "subtotal") return "bg-surface-cream-strong text-ink";
  if (item.kind === "group") return "border-t-2 border-t-hairline bg-surface-soft text-ink";
  return "";
}

function rowTypeClass(item: PnlLineItem): string {
  if (item.kind === "total") return "font-serif text-base";
  if (item.kind === "group" || item.kind === "subtotal") return "font-medium";
  if (item.depth === 2) return "text-[13px] text-muted-foreground";
  if (item.depth === 1) return "text-[13px] text-body";
  return "";
}

export function OrderProfitTree({
  items: allItems,
  badges,
  amountNotes,
}: {
  items: PnlLineItem[];
  /** Badge phụ hiện cạnh nhãn của MỘT dòng cụ thể theo id (vd "tạm tính" ở "platformFee"). */
  badges?: Record<string, { label: string; title?: string }>;
  /** Chữ nhỏ hiện cạnh số tiền của MỘT dòng cụ thể theo id (vd tỉ lệ % phí sàn). */
  amountNotes?: Record<string, string>;
}) {
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

  const allCollapsed = [...parentsWithChildren].every((id) => collapsed.has(id));

  return (
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
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => {
            const amount = displayValue(item);
            const badge = badges?.[item.id];
            const note = amountNotes?.[item.id];
            return (
              <TableRow key={item.id} className={rowBandClass(item)}>
                <TableCell className={cn(rowTypeClass(item), "print:whitespace-normal")}>
                  <div className="flex items-center gap-1.5">
                    <PnlLineLabel
                      item={item}
                      expandable={parentsWithChildren.has(item.id)}
                      expanded={expanded.has(item.id)}
                      onToggle={() => toggle(item.id)}
                    />
                    {badge && (
                      <Badge variant="outline" title={badge.title}>
                        {badge.label}
                      </Badge>
                    )}
                  </div>
                </TableCell>
                {/* Dòng `aside` bọc ngoặc + màu phụ — CÙNG quy ước với bảng Lãi/Lỗ (`pnl-tab.tsx`):
                    nó nằm trong khối Doanh thu nhưng không góp vào tổng, cộng tay theo cột sẽ ra
                    thừa. Hai màn dùng chung `PnlLineItem` nên phải bày giống nhau, kẻo cùng một
                    dòng lại có hai cách đọc. */}
                <TableCell
                  className={cn("text-right tabular-nums", rowTypeClass(item), item.aside && "text-muted-foreground")}
                >
                  {item.aside ? `(${formatVnd(amount)})` : formatVnd(amount)}
                  {note && <span className="ml-1 text-xs text-muted-foreground">· {note}</span>}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
