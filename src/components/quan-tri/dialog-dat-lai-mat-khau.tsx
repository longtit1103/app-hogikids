"use client";

import { useEffect, useRef, useState, useTransition } from "react";
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
import { datLaiMatKhau } from "@/lib/actions/tai-khoan";

import { MatKhauTamMotLan } from "./mat-khau-tam-mot-lan";

export function DialogDatLaiMatKhau({
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
  const [matKhauTam, setMatKhauTam] = useState<string | null>(null);
  const [dangLam, batDau] = useTransition();

  // Id lượt đặt lại: kết quả về sau khi dialog đã đóng/unmount bị bỏ, không giữ mật khẩu tạm.
  const luot = useRef(0);
  useEffect(() => {
    const hienTai = luot;
    return () => {
      hienTai.current += 1;
    };
  }, []);

  function dong() {
    // Đang chờ server: không đóng — server vẫn đặt lại, đóng lúc này mất mật khẩu tạm và nhân sự đã
    // bị đăng xuất mà chủ shop không có gì để đưa.
    if (dangLam) return;
    // Bỏ mật khẩu tạm khỏi state ngay khi đóng.
    const daDat = matKhauTam !== null;
    setMatKhauTam(null);
    onDong();
    if (daDat) router.refresh();
  }

  function xacNhan() {
    const luotNay = ++luot.current;
    batDau(async () => {
      try {
        const r = await datLaiMatKhau(id);
        if (luotNay !== luot.current) return;
        if (r.ok) {
          setMatKhauTam(r.data.matKhauTam);
          return;
        }
        toast.error(r.error);
      } catch {
        if (luotNay !== luot.current) return;
        toast.error("Không đặt lại được mật khẩu — kiểm tra kết nối rồi thử lại.");
      }
    });
  }

  return (
    <Dialog open={mo} onOpenChange={(m) => !m && dong()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{matKhauTam ? "Mật khẩu tạm — chỉ hiện một lần" : "Đặt lại mật khẩu?"}</DialogTitle>
          <DialogDescription>
            {matKhauTam
              ? "Đã đặt lại mật khẩu."
              : `${email} sẽ bị đăng xuất, mật khẩu cũ mất hiệu lực và phải đổi mật khẩu khi đăng nhập lại.`}
          </DialogDescription>
        </DialogHeader>
        {matKhauTam ? (
          <>
            <MatKhauTamMotLan email={email} matKhauTam={matKhauTam} />
            <DialogFooter>
              <Button type="button" onClick={dong}>
                Đã lưu, đóng
              </Button>
            </DialogFooter>
          </>
        ) : (
          <DialogFooter>
            <Button type="button" variant="outline" onClick={dong} disabled={dangLam}>
              Huỷ
            </Button>
            <Button type="button" onClick={xacNhan} disabled={dangLam}>
              {dangLam ? "Đang đặt lại…" : "Đặt lại mật khẩu"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
