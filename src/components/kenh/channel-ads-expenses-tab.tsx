"use client";

import { useState } from "react";
import Link from "next/link";
import { format } from "date-fns";
import { Pencil, Trash2 } from "lucide-react";

import { ExpenseDeleteDialog } from "@/components/expenses/expense-delete-dialog";
import { ExpenseFormModal } from "@/components/expenses/expense-form-modal";
import { formatRoas } from "@/components/kenh/channel-format";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { adsSourceLabel } from "@/lib/ads-source-label";
import type { ExpenseRow } from "@/lib/expenses/expense-queries";
import { formatVnd } from "@/lib/format";

/** Route "Xem log" cho dòng ADS_API — GIỐNG HỆT `expense-table.tsx` (phase 4), không tự chế văn án khác. */
const ADS_LOG_HREF = "/cai-dat#ket-noi";

/** Badge nguồn ghi — copy NGUYÊN VĂN `expense-table.tsx` để nhãn khớp tuyệt đối phase 4 (không tự đổi chữ "Tự động"/"Nhập tay"). */
function sourceBadge(source: string) {
  switch (source) {
    case "ADS_API":
      return <Badge className="bg-surface-cream-strong text-ink">Ads API</Badge>;
    case "RECURRING":
      return <Badge variant="outline">Định kỳ</Badge>;
    case "IMPORT":
      return <Badge variant="outline">Import</Badge>;
    default:
      return null; // MANUAL — trống theo brief
  }
}

/**
 * Tab "Chi phí ads" của `/kenh/:id` — mọi khoản danh mục "ads" gắn ĐÚNG kênh
 * trong kỳ. Sửa/Xóa tái dùng nguyên `ExpenseFormModal`/`ExpenseDeleteDialog`
 * (phase 4) + khóa dòng ADS_API y hệt `expense-table.tsx` (text-link "Xem
 * log" thay ✎, 🗑 disabled cùng tooltip nguyên văn).
 */
export function ChannelAdsExpensesTab({
  rows,
  categories,
  channels,
  roas,
}: {
  rows: ExpenseRow[];
  categories: { id: string; name: string }[];
  channels: { id: string; name: string; color: string }[];
  roas: number | null;
}) {
  const [editingRow, setEditingRow] = useState<ExpenseRow | null>(null);
  const [deletingRow, setDeletingRow] = useState<ExpenseRow | null>(null);

  const totalAds = rows.reduce((sum, r) => sum + r.amount, 0);

  function renderRowActions(row: ExpenseRow) {
    if (row.source === "ADS_API") {
      return (
        <div className="flex items-center justify-end gap-3">
          <Link href={ADS_LOG_HREF} className="text-sm text-primary hover:underline">
            Xem log
          </Link>
          <button
            type="button"
            disabled
            title="Số ads tự về mỗi đêm từ Meta/TikTok — không xóa tay"
            className="cursor-not-allowed text-muted-foreground opacity-50"
          >
            <Trash2 className="size-4" />
          </button>
        </div>
      );
    }
    return (
      <div className="flex items-center justify-end gap-3">
        <button type="button" aria-label="Sửa" onClick={() => setEditingRow(row)} className="text-muted-foreground hover:text-ink">
          <Pencil className="size-4" />
        </button>
        <button type="button" aria-label="Xóa" onClick={() => setDeletingRow(row)} className="text-muted-foreground hover:text-error">
          <Trash2 className="size-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">Chưa có chi phí ads nào trong kỳ</p>
      ) : (
        <div className="rounded-xl border border-hairline">
          {/* Desktop: bảng */}
          <Table className="hidden md:table">
            <TableHeader>
              <TableRow>
                <TableHead>Ngày</TableHead>
                <TableHead>Nguồn ads</TableHead>
                <TableHead>Mô tả</TableHead>
                <TableHead className="text-right">Số tiền</TableHead>
                <TableHead>Nguồn ghi</TableHead>
                <TableHead className="text-right">Thao tác</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="text-sm">{format(row.date, "dd/MM/yyyy")}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{adsSourceLabel(row.adsSource)}</Badge>
                  </TableCell>
                  <TableCell className="max-w-[240px] truncate" title={row.description}>
                    {row.description || "—"}
                  </TableCell>
                  <TableCell className="text-right text-sm">{formatVnd(row.amount)}</TableCell>
                  <TableCell>{sourceBadge(row.source)}</TableCell>
                  <TableCell>{renderRowActions(row)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {/* Mobile: card dọc */}
          <div className="flex flex-col gap-2 p-3 md:hidden">
            {rows.map((row) => (
              <div key={row.id} className="flex flex-col gap-1.5 rounded-lg border border-hairline p-3">
                <div className="flex items-center justify-between">
                  <Badge variant="outline">{adsSourceLabel(row.adsSource)}</Badge>
                  <span className="text-sm font-medium text-ink">{formatVnd(row.amount)}</span>
                </div>
                <p className="text-sm text-ink">{row.description || "—"}</p>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{format(row.date, "dd/MM/yyyy")}</span>
                  {sourceBadge(row.source) ?? <span />}
                </div>
                <div className="flex justify-end">{renderRowActions(row)}</div>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-1 border-t border-hairline px-4 py-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <span>Tổng ads: {formatVnd(totalAds)}</span>
            <span>ROAS kỳ: {roas === null ? "—" : formatRoas(roas)}</span>
          </div>
        </div>
      )}

      <ExpenseFormModal
        open={Boolean(editingRow)}
        onOpenChange={(o) => !o && setEditingRow(null)}
        categories={categories}
        channels={channels}
        expense={editingRow ?? undefined}
      />
      <ExpenseDeleteDialog
        open={Boolean(deletingRow)}
        onOpenChange={(o) => !o && setDeletingRow(null)}
        expense={deletingRow}
      />
    </div>
  );
}
