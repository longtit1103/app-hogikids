"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { KhoanVayRow } from "@/lib/so-quy/khoan-vay-queries";
import type { SoTietKiemRow } from "@/lib/tiet-kiem/so-tiet-kiem-queries";

import { CashMovementFormModal } from "./cash-movement-form-modal";

/**
 * Nút "+ Nhập quỹ" — mở modal "Nhập quỹ / rút quỹ" (tab Dòng tiền). `cash-flow-tab` là server
 * component nên phần onClick + state modal tách ra client wrapper này (mẫu `shopee-import-button.tsx`).
 * `loans` đi kèm để ô chọn khoản vay có dữ liệu ngay khi chọn loại Vay vốn / Trả nợ gốc.
 */
export function CashMovementAddButton({
  loans,
  soTietKiem,
  d0,
}: {
  loans: KhoanVayRow[];
  /** Sổ tiết kiệm cho ô chọn ở form ghi tay khi loại dòng là `SAVINGS_OUT`/`SAVINGS_IN`. */
  soTietKiem: SoTietKiemRow[];
  /** Ngày mở sổ quỹ; null = chưa mở sổ (modal nói "đây là khoản đầu tiên"). */
  d0: Date | null;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
        + Nhập quỹ
      </Button>
      <CashMovementFormModal
        open={open}
        onOpenChange={setOpen}
        loans={loans}
        soTietKiem={soTietKiem}
        d0={d0}
      />
    </>
  );
}
