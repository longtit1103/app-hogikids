"use client";

import { useState } from "react";
import { format } from "date-fns";
import { Pencil, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  CASH_MOVEMENT_KIND_META,
  isCashMovementKind,
  isInflow,
  isKindNoPhaiTraGhiTay,
  KIND_CUTOVER,
  kindGanSoQuy,
  signedAmount,
} from "@/lib/cash-movements/cash-movement-kinds";
import type { CashMovementRow, CashMovementRowCoBan } from "@/lib/cash-movements/cash-movement-queries";
import { formatVnd } from "@/lib/format";
import type { LuaChonDongTienNo } from "@/lib/no-phai-tra/lua-chon-dong-tien-no";
import type { KhoanVayRow } from "@/lib/so-quy/khoan-vay-queries";
import type { SoTietKiemRow } from "@/lib/tiet-kiem/so-tiet-kiem-queries";

import { CashMovementDeleteDialog } from "./cash-movement-delete-dialog";
import { CashMovementFormModal } from "./cash-movement-form-modal";

type DongBang = CashMovementRow | CashMovementRowCoBan;

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
  choPhepSua = false,
  choPhepSuaDongSoQuy = false,
  noPhaiTra = null,
  choPhepSuaDieuChinh = false,
}: {
  /** Bản cơ bản (không tên/id khoản vay, sổ) khi người xem thiếu `tai-chinh-so-quy:xem`. */
  rows: readonly (CashMovementRow | CashMovementRowCoBan)[];
  loans: KhoanVayRow[];
  /** Sổ tiết kiệm cho ô chọn ở form ghi tay khi loại dòng là `SAVINGS_OUT`/`SAVINGS_IN`. */
  soTietKiem: SoTietKiemRow[];
  /** Ngày mở sổ quỹ — sửa một dòng lùi về trước D0 cũng phải hỏi lại (modal lo). */
  d0: Date | null;
  /** Có quyền sửa khối này? `false` ⇒ ẩn nút ghi/sửa (server vẫn chặn ở cổng action). */
  choPhepSua?: boolean;
  /**
   * Có `tai-chinh-so-quy:sua`? Dòng gắn khoản vay / sổ tiết kiệm thuộc khối Sổ quỹ — thiếu ⇒ dòng đó
   * không có nút sửa/xoá (server vẫn chặn ở action).
   */
  choPhepSuaDongSoQuy?: boolean;
  /** Đã bật theo dõi nợ ⇒ mốc M + hồ sơ chọn được (form sửa dòng nợ phải trả cần). Null ⇒ dòng nợ không có nút. */
  noPhaiTra?: LuaChonDongTienNo | null;
  /** Chủ shop? Dòng điều chỉnh mở sổ nợ (`CUTOVER_*`) CHỈ chủ shop sửa số/mô tả, không xoá (spec §5.8). */
  choPhepSuaDieuChinh?: boolean;
}) {
  const [editingRow, setEditingRow] = useState<DongBang | null>(null);
  const [deletingRow, setDeletingRow] = useState<DongBang | null>(null);

  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Tháng này chưa ghi khoản tiền nào. {choPhepSua ? 'Bấm "+ Nhập quỹ" khi có góp vốn, vay vốn, trả nợ gốc hay bán trực tiếp.' : ""}
      </p>
    );
  }

  /**
   * Dòng gốc vay / gửi-rút sổ tiết kiệm hiện luôn TÊN khoản dưới badge — một cột "Loại" trần không
   * nói được nợ của ai, tiền nằm ở sổ nào. Hai tên không bao giờ cùng có (CHECK loại trừ ở DB).
   */
  function kindBadge(row: DongBang) {
    const tenKhoan = "loanName" in row ? (row.loanName ?? row.savingsName ?? row.tenHoSoNo) : null;
    return (
      <div className="flex flex-col items-start gap-0.5">
        <Badge variant={row.kind !== "ADS_TOPUP" && isInflow(row.kind) ? "secondary" : "outline"}>
          {CASH_MOVEMENT_KIND_META[row.kind].label}
        </Badge>
        {tenKhoan && <span className="text-xs text-muted-foreground">{tenKhoan}</span>}
      </div>
    );
  }

  function amountText(row: DongBang) {
    // `ADS_TOPUP`: chiều theo nguồn nạp (thẻ ⇒ không chạm quỹ) mà hàng bảng không mang `cardId` ⇒ hiện
    // số trần, KHÔNG gắn dấu đoán.
    // Bản đủ (quyền Sổ quỹ) có `cardId`: nạp từ ngân hàng là RA (−), nạp bằng thẻ không chạm quỹ (số trần).
    const soTien =
      row.kind === "ADS_TOPUP"
        ? "cardId" in row && row.cardId === null
          ? -row.amount
          : row.amount
        : signedAmount(row.kind, row.amount);
    return <span className="tabular-nums text-ink">{formatVnd(soTien)}</span>;
  }

  function rowActions(row: DongBang) {
    if (!choPhepSua) return null;
    // Điều chỉnh mở sổ nợ: CHỈ sửa số/mô tả (chủ shop), không xoá — một lần, cố định (spec §5.8).
    if ((KIND_CUTOVER as readonly string[]).includes(row.kind)) {
      if (!choPhepSuaDieuChinh) return null;
      return (
        <div className="flex items-center justify-end gap-3">
          <button type="button" aria-label="Sửa" onClick={() => setEditingRow(row)} className="text-muted-foreground hover:text-ink">
            <Pencil className="size-4" />
          </button>
        </div>
      );
    }
    // 4 loại nợ phải trả (trả thẻ, trả NCC, NCC hoàn, nạp ví): cần quyền Sổ quỹ + danh sách hồ sơ cho form.
    if (isKindNoPhaiTraGhiTay(row.kind)) {
      if (!choPhepSuaDongSoQuy || noPhaiTra === null) return null;
    } else {
      if (!isCashMovementKind(row.kind)) return null;
      if (kindGanSoQuy(row.kind) && !choPhepSuaDongSoQuy) return null;
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
    <div className="rounded-xl border border-hairline">
      {/* Desktop: bảng */}
      <Table className="hidden md:table">
        <TableHeader>
          <TableRow>
            <TableHead>Ngày</TableHead>
            <TableHead>Loại</TableHead>
            <TableHead>Ghi chú</TableHead>
            <TableHead className="text-right">Số tiền</TableHead>
            {choPhepSua && <TableHead className="text-right">Thao tác</TableHead>}
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
              {choPhepSua && <TableCell>{rowActions(row)}</TableCell>}
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
        choPhepLoaiSoQuy={choPhepSuaDongSoQuy}
        noPhaiTra={noPhaiTra}
      />
      <CashMovementDeleteDialog open={Boolean(deletingRow)} onOpenChange={(o) => !o && setDeletingRow(null)} row={deletingRow} />
    </div>
  );
}
