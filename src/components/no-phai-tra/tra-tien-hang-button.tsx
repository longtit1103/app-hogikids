"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { PhieuConNo } from "@/lib/no-phai-tra/phieu-nhap-no-queries";

import { TraTienHangFormModal } from "./tra-tien-hang-form-modal";

/** Nút "Trả tiền hàng" của khối phiếu nợ — server component cha không giữ được state mở modal. */
export function TraTienHangButton({
  phieu,
  vanTay,
  mocM,
}: {
  phieu: readonly PhieuConNo[];
  vanTay: string;
  mocM: string;
}) {
  const [open, setOpen] = useState(false);
  const coPhieuConNo = phieu.some((p) => !p.daHuy && p.conNo > 0);
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={!coPhieuConNo}
        title={coPhieuConNo ? undefined : "Không có phiếu nào còn nợ"}
        onClick={() => setOpen(true)}
      >
        Trả tiền hàng
      </Button>
      <TraTienHangFormModal open={open} onOpenChange={setOpen} phieu={phieu} vanTay={vanTay} mocM={mocM} />
    </>
  );
}
