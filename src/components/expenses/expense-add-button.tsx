"use client";

import { useState } from "react";

import { ExpenseFormModal, type ExpenseFormModalProps } from "@/components/expenses/expense-form-modal";
import { Button } from "@/components/ui/button";

type ExpenseAddButtonProps = {
  categories: { id: string; name: string }[];
  channels: { id: string; name: string; color: string }[];
  label?: string;
  variant?: "default" | "outline" | "secondary" | "ghost" | "destructive" | "link";
  className?: string;
  /** Thẻ cho ô "Trừ vào thẻ" (chỉ có sau khi bật theo dõi nợ phải trả). */
  theTinDung?: ExpenseFormModalProps["theTinDung"];
};

/**
 * Trigger nút "+ Thêm chi phí" (header + empty-state `/chi-phi`) — mở
 * `ExpenseFormModal` ở chế độ tạo mới. Mỗi instance tự quản `open` riêng nên
 * header và empty-state dùng chung component vẫn độc lập nhau.
 */
export function ExpenseAddButton({ categories, channels, label = "+ Thêm chi phí", variant, className, theTinDung }: ExpenseAddButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button type="button" variant={variant} className={className} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <ExpenseFormModal open={open} onOpenChange={setOpen} categories={categories} channels={channels} theTinDung={theTinDung} />
    </>
  );
}
