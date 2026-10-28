"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

import { NhapSaoKeTheModal } from "./nhap-sao-ke-the-modal";

/**
 * Nút "Nhập sao kê PDF" ở đầu khối Thẻ tín dụng (server component cha không giữ được state modal). Cha CHỈ render khi
 * chủ shop + đã bật theo dõi nợ + có thẻ còn mở; cổng thật nằm ở server action.
 */
export function NhapSaoKeTheButton({ the }: { the: readonly { id: string; ten: string }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Nhập sao kê PDF
      </Button>
      <NhapSaoKeTheModal open={open} onOpenChange={setOpen} the={the} cardIdMacDinh={the[0]?.id ?? ""} />
    </>
  );
}
