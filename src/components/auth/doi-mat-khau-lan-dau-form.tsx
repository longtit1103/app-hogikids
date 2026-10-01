"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { logout } from "@/lib/actions/auth";
import { doiMatKhauLanDau } from "@/lib/actions/doi-mat-khau-lan-dau";
import { MIN_MAT_KHAU_MOI } from "@/lib/mat-khau-moi-schema";

type LoiTruong = { newPassword?: string; confirmPassword?: string };

/** Màn đặt mật khẩu riêng ở lần đăng nhập đầu (hoặc sau khi chủ shop đặt lại mật khẩu). */
export function DoiMatKhauLanDauForm({ email }: { email: string }) {
  const router = useRouter();
  const [matKhau, setMatKhau] = useState("");
  const [nhapLai, setNhapLai] = useState("");
  const [loi, setLoi] = useState<LoiTruong>({});
  const [daDoi, setDaDoi] = useState(false);
  const [dangLam, batDau] = useTransition();

  function gui() {
    const fd = new FormData();
    fd.append("newPassword", matKhau);
    fd.append("confirmPassword", nhapLai);
    batDau(async () => {
      try {
        const r = await doiMatKhauLanDau(fd);
        if (r.ok) {
          router.replace("/");
          router.refresh();
          return;
        }
        toast.error(r.error);
        if (r.code === "TRANG_THAI_DA_DOI") {
          // Mật khẩu/phiên đã đổi ở nơi khác — ở lại đây không còn ý nghĩa, phải đăng nhập lại.
          setDaDoi(true);
          return;
        }
        if (r.field === "newPassword") setLoi({ newPassword: r.error });
        else if (r.field === "confirmPassword") setLoi({ confirmPassword: r.error });
        else setLoi({});
      } catch {
        toast.error("Không đổi được mật khẩu — kiểm tra kết nối rồi thử lại.");
      }
    });
  }

  async function dangXuat() {
    try {
      await logout();
    } finally {
      router.replace("/dang-nhap");
      router.refresh();
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-serif text-2xl text-ink">Đặt mật khẩu mới</h1>
        <p className="text-sm text-muted-foreground">
          Tài khoản <strong>{email}</strong> đang dùng mật khẩu tạm. Hãy đặt mật khẩu của riêng bạn để tiếp tục.
        </p>
      </div>

      {daDoi ? (
        <div className="flex flex-col gap-3" role="alert">
          <p className="rounded-lg bg-error/10 px-3 py-2 text-sm text-error">
            Phiên này không còn hiệu lực (mật khẩu đã được đổi hoặc đặt lại ở nơi khác).
          </p>
          <Link href="/dang-nhap" className="text-sm text-primary hover:underline">
            Đăng nhập lại
          </Link>
        </div>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            gui();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="mk-moi" className="text-sm font-medium text-ink">
              Mật khẩu mới
            </label>
            <Input
              id="mk-moi"
              name="newPassword"
              type="password"
              autoComplete="new-password"
              required
              value={matKhau}
              onChange={(e) => setMatKhau(e.target.value)}
              aria-invalid={loi.newPassword ? true : undefined}
            />
            <p className="text-xs text-muted-foreground">Ít nhất {MIN_MAT_KHAU_MOI} ký tự, có cả chữ và số.</p>
            {loi.newPassword && <p className="text-xs text-error">{loi.newPassword}</p>}
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="mk-nhap-lai" className="text-sm font-medium text-ink">
              Nhập lại mật khẩu mới
            </label>
            <Input
              id="mk-nhap-lai"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              value={nhapLai}
              onChange={(e) => setNhapLai(e.target.value)}
              aria-invalid={loi.confirmPassword ? true : undefined}
            />
            {loi.confirmPassword && <p className="text-xs text-error">{loi.confirmPassword}</p>}
          </div>
          <Button type="submit" className="h-10 w-full" disabled={dangLam || !matKhau || !nhapLai}>
            {dangLam ? "Đang lưu…" : "Đổi mật khẩu"}
          </Button>
        </form>
      )}

      <button type="button" onClick={dangXuat} className="self-start text-sm text-muted-foreground hover:text-ink hover:underline">
        Đăng xuất
      </button>
    </div>
  );
}
