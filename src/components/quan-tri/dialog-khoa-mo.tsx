"use client";

import { useTransition } from "react";
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
import { khoaTaiKhoan, moKhoaTaiKhoan } from "@/lib/actions/tai-khoan";

export function DialogKhoaMo({
  id,
  email,
  dangHoatDong,
  mo,
  onDong,
}: {
  id: string;
  email: string;
  /** true ⇒ hộp thoại KHOÁ; false ⇒ MỞ KHOÁ. */
  dangHoatDong: boolean;
  mo: boolean;
  onDong: () => void;
}) {
  const router = useRouter();
  const [dangLam, batDau] = useTransition();

  function xacNhan() {
    batDau(async () => {
      try {
        const r = await (dangHoatDong ? khoaTaiKhoan(id) : moKhoaTaiKhoan(id));
        if (r.ok) {
          toast.success(dangHoatDong ? "Đã khoá tài khoản." : "Đã mở khoá tài khoản.");
          router.refresh();
          onDong();
          return;
        }
        toast.error(r.error);
      } catch {
        toast.error("Không thực hiện được — kiểm tra kết nối rồi thử lại.");
      }
    });
  }

  return (
    <Dialog open={mo} onOpenChange={(m) => !m && onDong()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{dangHoatDong ? "Khoá tài khoản?" : "Mở khoá tài khoản?"}</DialogTitle>
          <DialogDescription>
            {dangHoatDong
              ? `${email} sẽ bị đăng xuất ngay và không đăng nhập lại được cho tới khi bạn mở khoá.`
              : `${email} sẽ đăng nhập lại được bằng mật khẩu hiện có.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onDong}>
            Huỷ
          </Button>
          <Button type="button" onClick={xacNhan} disabled={dangLam}>
            {dangLam ? "Đang xử lý…" : dangHoatDong ? "Khoá" : "Mở khoá"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
