"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { suaQuyenTaiKhoan } from "@/lib/actions/tai-khoan";
import type { Quyen } from "@/lib/quyen/danh-muc-quyen";

import { FormQuyen } from "./form-quyen";
import { loiToHopQuyen } from "./quyen-form-logic";

/** Mở/đóng do cha điều khiển; cha gắn `key={id}` để form khởi tạo lại theo từng tài khoản. */
export function ModalSuaQuyen({
  id,
  email,
  quyenHienTai,
  mo,
  onDong,
}: {
  id: string;
  email: string;
  quyenHienTai: readonly Quyen[];
  mo: boolean;
  onDong: () => void;
}) {
  const router = useRouter();
  const [quyen, setQuyen] = useState<Quyen[]>([...quyenHienTai]);
  const [loiMayChu, setLoiMayChu] = useState<string | null>(null);
  const [dangLuu, batDau] = useTransition();

  function luu() {
    batDau(async () => {
      try {
        const r = await suaQuyenTaiKhoan(id, quyen);
        if (r.ok) {
          toast.success("Đã lưu quyền.");
          router.refresh();
          onDong();
          return;
        }
        toast.error(r.error);
        setLoiMayChu(r.code === "TO_HOP_QUYEN_SAI" ? r.error : null);
      } catch {
        toast.error("Không lưu được quyền — kiểm tra kết nối rồi thử lại.");
      }
    });
  }

  return (
    <Dialog open={mo} onOpenChange={(m) => !m && onDong()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Sửa quyền</DialogTitle>
          <DialogDescription>{email}</DialogDescription>
        </DialogHeader>
        <FormQuyen giaTri={quyen} onChange={setQuyen} loiMayChu={loiMayChu} />
        <DialogFooter>
          <Button type="button" onClick={luu} disabled={dangLuu || loiToHopQuyen(quyen) !== null}>
            {dangLuu ? "Đang lưu…" : "Lưu quyền"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
