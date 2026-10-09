"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

import { TheTinDungFormModal } from "./the-tin-dung-form-modal";

/** Nút "+ Thêm thẻ" ở đầu khối Thẻ tín dụng (server component cha không giữ được state modal). */
export function TheTinDungAddButton({ mocM }: { mocM: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
        + Thêm thẻ
      </Button>
      <TheTinDungFormModal open={open} onOpenChange={setOpen} mocM={mocM} />
    </>
  );
}
