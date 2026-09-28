"use client";

import { useState } from "react";

import { AdsImportModal } from "@/components/expenses/ads-import-modal";
import { Button } from "@/components/ui/button";

type AdsImportButtonProps = {
  channels: { id: string; name: string; color: string }[];
  label?: string;
  variant?: "default" | "outline" | "secondary" | "ghost" | "destructive" | "link";
  className?: string;
};

/**
 * Trigger nút "Import CSV ads" (header + empty-state `/chi-phi`) — mở
 * `AdsImportModal`. Mỗi instance tự quản `open` riêng (giống
 * `expense-add-button.tsx`) nên header và empty-state độc lập nhau.
 */
export function AdsImportButton({ channels, label = "Import CSV ads", variant = "secondary", className }: AdsImportButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button type="button" variant={variant} className={className} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <AdsImportModal open={open} onOpenChange={setOpen} channels={channels} />
    </>
  );
}
