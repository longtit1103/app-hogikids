"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { KhoanVayRow } from "@/lib/so-quy/khoan-vay-queries";

import { SoTietKiemFormModal } from "./so-tiet-kiem-form-modal";

/** Nút "+ Thêm sổ tiết kiệm" đầu khối Sổ tiết kiệm — `khoan-vay-section` là server component nên phần
 *  onClick + state modal tách ra client wrapper này (khuôn `khoan-vay-add-button.tsx`). */
export function SoTietKiemAddButton({ loans, d0 }: { loans: KhoanVayRow[]; d0: Date | null }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
        + Thêm sổ tiết kiệm
      </Button>
      <SoTietKiemFormModal open={open} onOpenChange={setOpen} loans={loans} d0={d0} />
    </>
  );
}
