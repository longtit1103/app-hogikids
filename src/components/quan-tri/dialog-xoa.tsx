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
import { Input } from "@/components/ui/input";
import { xoaTaiKhoan } from "@/lib/actions/tai-khoan";

/** Xoá là không hoàn tác: phải gõ lại đúng email để xác nhận. */
export function DialogXoa({
  id,
  email,
  mo,
  onDong,
}: {
  id: string;
  email: string;
  mo: boolean;
  onDong: () => void;
}) {
  const router = useRouter();
  const [nhap, setNhap] = useState("");
  const [dangLam, batDau] = useTransition();
  const khop = nhap.trim().toLowerCase() === email.toLowerCase();

  function dong() {
    setNhap("");
    onDong();
  }

  function xacNhan() {
    batDau(async () => {
      try {
        const r = await xoaTaiKhoan(id);
        if (r.ok) {
          toast.success("Đã xoá tài khoản.");
          router.refresh();
          dong();
          return;
        }
        toast.error(r.error);
      } catch {
        toast.error("Không xoá được — kiểm tra kết nối rồi thử lại.");
      }
    });
  }

  return (
    <Dialog open={mo} onOpenChange={(m) => !m && dong()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Xoá tài khoản?</DialogTitle>
          <DialogDescription>
            Xoá vĩnh viễn, không hoàn tác được. Nhật ký thao tác cũ của người này vẫn được giữ. Gõ lại email{" "}
            <strong>{email}</strong> để xác nhận.
          </DialogDescription>
        </DialogHeader>
        <Input
          aria-label="Gõ lại email để xác nhận xoá"
          autoComplete="off"
          value={nhap}
          onChange={(e) => setNhap(e.target.value)}
        />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={dong}>
            Huỷ
          </Button>
          <Button type="button" variant="destructive" onClick={xacNhan} disabled={!khop || dangLam}>
            {dangLam ? "Đang xoá…" : "Xoá tài khoản"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
