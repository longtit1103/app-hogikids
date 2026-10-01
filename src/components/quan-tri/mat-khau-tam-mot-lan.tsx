"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

/**
 * Hiện mật khẩu tạm ĐÚNG MỘT LẦN. Giá trị chỉ sống trong props của modal cha (không localStorage, không
 * log); cha bỏ nó khi đóng. Sau khi đóng, server không còn cách nào trả lại — chỉ đặt lại được.
 */
export function MatKhauTamMotLan({ email, matKhauTam }: { email: string; matKhauTam: string }) {
  const [daCopy, setDaCopy] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(matKhauTam);
      setDaCopy(true);
    } catch {
      toast.error("Không sao chép được — hãy bôi đen và sao chép thủ công.");
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="mat-khau-tam-mot-lan">
      <p className="text-sm text-ink">
        Mật khẩu tạm của <strong>{email}</strong> — <strong>chỉ hiện một lần</strong>. Đóng hộp thoại này là không xem
        lại được (chỉ có thể đặt lại mật khẩu mới).
      </p>
      <div className="flex items-center gap-2">
        <code
          data-testid="mat-khau-tam-gia-tri"
          className="flex-1 rounded-lg border border-hairline bg-surface-soft px-3 py-2 font-mono text-sm break-all select-all"
        >
          {matKhauTam}
        </code>
        <Button type="button" variant="outline" onClick={copy}>
          {daCopy ? "Đã chép" : "Sao chép"}
        </Button>
      </div>
      <p className="rounded-lg bg-surface-soft px-3 py-2 text-xs text-muted-foreground">
        Gửi mật khẩu này cho nhân sự qua kênh riêng. Họ phải đổi mật khẩu ở lần đăng nhập đầu. Nhớ thêm email vào
        policy Cloudflare Access — không thì họ không mở được app.
      </p>
    </div>
  );
}
