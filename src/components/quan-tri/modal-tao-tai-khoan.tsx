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
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { taoTaiKhoan } from "@/lib/actions/tai-khoan";
import type { Quyen } from "@/lib/quyen/danh-muc-quyen";

import { FormQuyen } from "./form-quyen";
import { MatKhauTamMotLan } from "./mat-khau-tam-mot-lan";
import { loiToHopQuyen } from "./quyen-form-logic";

type LoiTruong = { email?: string; tenHienThi?: string; quyen?: string };

export function ModalTaoTaiKhoan() {
  const router = useRouter();
  const [mo, setMo] = useState(false);
  const [email, setEmail] = useState("");
  const [ten, setTen] = useState("");
  const [quyen, setQuyen] = useState<Quyen[]>([]);
  const [loi, setLoi] = useState<LoiTruong>({});
  const [ketQua, setKetQua] = useState<{ email: string; matKhauTam: string } | null>(null);
  const [dangLuu, batDau] = useTransition();
  // Id lượt gửi: kết quả của lượt đã bị bỏ (modal đóng/unmount) KHÔNG được vào state — mật khẩu tạm
  // không được sống lâu hơn modal và hiện lại ở lần mở sau.
  const luot = useRef(0);
  useEffect(() => {
    const hienTai = luot;
    return () => {
      hienTai.current += 1;
    };
  }, []);

  function dong(moMoi: boolean) {
    // Đang chờ server: không cho đóng (Esc/overlay/nút X) — đóng lúc này làm mất mật khẩu tạm của
    // tài khoản ĐÃ được tạo. Xong lượt mới đóng được.
    if (!moMoi && dangLuu) return;
    setMo(moMoi);
    if (moMoi) return;
    luot.current += 1;
    // Bỏ mật khẩu tạm + form ngay khi đóng; làm mới bảng nếu đã tạo được tài khoản.
    const daTao = ketQua !== null;
    setKetQua(null);
    setEmail("");
    setTen("");
    setQuyen([]);
    setLoi({});
    if (daTao) router.refresh();
  }

  function gui() {
    const fd = new FormData();
    fd.append("email", email.trim());
    fd.append("tenHienThi", ten.trim());
    for (const q of quyen) fd.append("quyen", q);
    const luotNay = ++luot.current;
    batDau(async () => {
      try {
        const r = await taoTaiKhoan(fd);
        if (luotNay !== luot.current) {
          // Lượt đã bị bỏ: không giữ mật khẩu tạm; tài khoản đã tạo thì làm mới bảng cho khỏi lệch.
          if (r.ok) router.refresh();
          return;
        }
        if (r.ok) {
          setKetQua({ email: email.trim(), matKhauTam: r.data.matKhauTam });
          setLoi({});
          return;
        }
        toast.error(r.error);
        if (r.code === "EMAIL_DA_DUNG") setLoi({ email: r.error });
        else if (r.code === "TO_HOP_QUYEN_SAI") setLoi({ quyen: r.error });
        else if (r.field === "email") setLoi({ email: r.error });
        else if (r.field === "tenHienThi") setLoi({ tenHienThi: r.error });
        else setLoi({});
      } catch {
        if (luotNay !== luot.current) return;
        toast.error("Không tạo được tài khoản — kiểm tra kết nối rồi thử lại.");
      }
    });
  }

  const khongGui = dangLuu || !email.trim() || !ten.trim() || loiToHopQuyen(quyen) !== null;

  return (
    <Dialog open={mo} onOpenChange={dong}>
      <DialogTrigger render={<Button />}>Tạo tài khoản</DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{ketQua ? "Mật khẩu tạm — chỉ hiện một lần" : "Tạo tài khoản"}</DialogTitle>
          <DialogDescription>
            {ketQua ? "Tài khoản đã được tạo." : "Nhân sự chỉ thấy các mục bạn tick bên dưới."}
          </DialogDescription>
        </DialogHeader>

        {ketQua ? (
          <>
            <MatKhauTamMotLan email={ketQua.email} matKhauTam={ketQua.matKhauTam} />
            <DialogFooter>
              <Button type="button" onClick={() => dong(false)}>
                Đã lưu, đóng
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!khongGui) gui();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <label htmlFor="tk-email" className="text-sm font-medium text-ink">
                Email
              </label>
              <Input
                id="tk-email"
                type="email"
                autoComplete="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={loi.email ? true : undefined}
              />
              {loi.email && <p className="text-xs text-error">{loi.email}</p>}
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="tk-ten" className="text-sm font-medium text-ink">
                Tên hiển thị
              </label>
              <Input
                id="tk-ten"
                autoComplete="off"
                value={ten}
                onChange={(e) => setTen(e.target.value)}
                aria-invalid={loi.tenHienThi ? true : undefined}
              />
              {loi.tenHienThi && <p className="text-xs text-error">{loi.tenHienThi}</p>}
            </div>
            <FormQuyen giaTri={quyen} onChange={setQuyen} loiMayChu={loi.quyen} />
            <DialogFooter>
              <Button type="submit" disabled={khongGui}>
                {dangLuu ? "Đang tạo…" : "Tạo tài khoản"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
