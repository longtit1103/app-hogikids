"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

import { KhoanVayFormModal } from "./khoan-vay-form-modal";

/**
 * Nút "+ Thêm khoản vay" ở đầu khối Khoản vay. `khoan-vay-section` là server component nên phần
 * onClick + state modal tách ra client wrapper này (mẫu `cash-movement-add-button.tsx`).
 */
export function KhoanVayAddButton({ d0 }: { d0: Date | null }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
        + Thêm khoản vay
      </Button>
      <KhoanVayFormModal open={open} onOpenChange={setOpen} d0={d0} />
    </>
  );
}
