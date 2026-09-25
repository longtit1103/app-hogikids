"use client";

import { useState } from "react";
import { format } from "date-fns";
import { Pencil, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CASH_MOVEMENT_KIND_META, isInflow, signedAmount } from "@/lib/cash-movements/cash-movement-kinds";
import type { CashMovementRow } from "@/lib/cash-movements/cash-movement-queries";
import { formatVnd } from "@/lib/format";
import type { KhoanVayRow } from "@/lib/so-quy/khoan-vay-queries";
import type { SoTietKiemRow } from "@/lib/tiet-kiem/so-tiet-kiem-queries";

import { CashMovementDeleteDialog } from "./cash-movement-delete-dialog";
import { CashMovementFormModal } from "./cash-movement-form-modal";

/**
 * Bảng "khoản tiền khác" trong tháng đang xem — dòng VÀO badge đặc, dòng RA badge viền; số tiền CÓ DẤU
 * (`signedAmount`) để đọc một cột là thấy chiều. Desktop bảng, mobile card dọc (cùng khuôn expense-table).
 * Rỗng ⇒ một câu empty-state, KHÔNG ẩn khối (chủ shop phải thấy có chỗ ghi).
 */
export function CashMovementTable({
  rows,
  loans,
  soTietKiem,
  d0,
}: {
  rows: CashMovementRow[];
  loans: KhoanVayRow[];
  /** Sổ tiết kiệm cho ô chọn ở form ghi tay khi loại dòng là `SAVINGS_OUT`/`SAVINGS_IN`. */
  soTietKiem: SoTietKiemRow[];
  /** Ngày mở sổ quỹ — sửa một dòng lùi về trước D0 cũng phải hỏi lại (modal lo). */
  d0: Date | null;
}) {
  const [editingRow, setEditingRow] = useState<CashMovementRow | null>(null);
  const [deletingRow, setDeletingRow] = useState<CashMovementRow | null>(null);

  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Tháng này chưa ghi khoản tiền nào. Bấm &quot;+ Nhập quỹ&quot; khi có góp vốn, vay vốn, trả nợ gốc
        hay bán trực tiếp.
      </p>
    );
  }

  /**
   * Dòng gốc vay / gửi-rút sổ tiết kiệm hiện luôn TÊN khoản dưới badge — một cột "Loại" trần không
   * nói được nợ của ai, tiền nằm ở sổ nào. Hai tên không bao giờ cùng có (CHECK loại trừ ở DB).
   */
  function kindBadge(row: CashMovementRow) {
    const tenKhoan = row.loanName ?? row.savingsName;
    return (
      <div className="flex flex-col items-start gap-0.5">
        <Badge variant={isInflow(row.kind) ? "secondary" : "outline"}>{CASH_MOVEMENT_KIND_META[row.kind].label}</Badge>
        {tenKhoan && <span className="text-xs text-muted-foreground">{tenKhoan}</span>}
      </div>
    );
  }

  function amountText(row: CashMovementRow) {
    return <span className="tabular-nums text-ink">{formatVnd(signedAmount(row.kind, row.amount))}</span>;
  }

  function rowActions(row: CashMovementRow) {
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
    <div className="rounded-xl border border-hairline">
      {/* Desktop: bảng */}
      <Table className="hidden md:table">
        <TableHeader>
          <TableRow>
            <TableHead>Ngày</TableHead>
            <TableHead>Loại</TableHead>
            <TableHead>Ghi chú</TableHead>
            <TableHead className="text-right">Số tiền</TableHead>
            <TableHead className="text-right">Thao tác</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="text-sm">{format(row.date, "dd/MM/yyyy")}</TableCell>
              <TableCell>{kindBadge(row)}</TableCell>
              <TableCell className="max-w-[280px] truncate" title={row.description}>
                {row.description || "—"}
              </TableCell>
              <TableCell className="text-right text-sm">{amountText(row)}</TableCell>
              <TableCell>{rowActions(row)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {/* Mobile: card dọc */}
      <div className="flex flex-col gap-2 p-3 md:hidden">
        {rows.map((row) => (
          <div key={row.id} className="flex flex-col gap-1.5 rounded-lg border border-hairline p-3">
            <div className="flex items-center justify-between">
              {kindBadge(row)}
              <span className="text-sm font-medium">{amountText(row)}</span>
            </div>
            <p className="text-sm text-ink">{row.description || "—"}</p>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{format(row.date, "dd/MM/yyyy")}</span>
              {rowActions(row)}
            </div>
          </div>
        ))}
      </div>

      <CashMovementFormModal
        open={Boolean(editingRow)}
        onOpenChange={(o) => !o && setEditingRow(null)}
        row={editingRow ?? undefined}
        loans={loans}
        soTietKiem={soTietKiem}
        d0={d0}
      />
      <CashMovementDeleteDialog open={Boolean(deletingRow)} onOpenChange={(o) => !o && setDeletingRow(null)} row={deletingRow} />
    </div>
  );
}
