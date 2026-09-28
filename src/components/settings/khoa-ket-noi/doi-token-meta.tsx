"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { doiVaLuuTokenMeta, type KetQuaDoiTokenMetaUi } from "@/lib/actions/settings-khoa-ket-noi";

/**
 * Khối "Thay token Meta" — thay cho việc chạy `scripts/meta-ads-lay-token.ts` trên máy dev.
 * Dán token TƯƠI từ Graph API Explorer, app tự đổi sang token dài hạn 60 ngày + lưu vào kho.
 */
export function DoiTokenMeta() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [doing, setDoing] = useState(false);
  const [ketQua, setKetQua] = useState<KetQuaDoiTokenMetaUi | null>(null);

  async function handleDoi() {
    if (token.trim() === "") return;
    setDoing(true);
    setKetQua(null);
    try {
      const res = await doiVaLuuTokenMeta(token.trim());
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Đã đổi và lưu token Meta — đồng bộ đêm dùng được ngay");
      setToken("");
      setKetQua(res.data);
      router.refresh();
    } catch {
      toast.error("Đổi token thất bại — kiểm tra kết nối mạng");
    } finally {
      setDoing(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-muted/50 p-3">
      <p className="text-sm font-medium text-ink">Thay token (~60 ngày một lần)</p>
      <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
        <li>
          Mở{" "}
          <a
            className="text-primary underline underline-offset-2"
            href="https://developers.facebook.com/tools/explorer/"
            target="_blank"
            rel="noreferrer"
          >
            Graph API Explorer
          </a>{" "}
          (đăng nhập Facebook của shop).
        </li>
        <li>Chọn đúng ứng dụng của shop, bấm “Generate Access Token” và cho phép quyền đọc quảng cáo (ads_read).</li>
        <li>Copy token vừa hiện ra, dán vào ô dưới rồi bấm “Đổi &amp; lưu token”.</li>
      </ol>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          placeholder="Dán token tươi từ Graph API Explorer vào đây"
          onChange={(e) => setToken(e.target.value)}
        />
        <Button type="button" className="shrink-0" disabled={token.trim() === "" || doing} onClick={handleDoi}>
          {doing ? "Đang đổi…" : "Đổi & lưu token"}
        </Button>
      </div>
      {ketQua && (
        <p className="text-xs text-success">
          ✓ Token mới hết hạn {ketQua.hetHan}
          {ketQua.conNgay !== null ? ` (còn ${ketQua.conNgay} ngày)` : ""} • quyền đọc dữ liệu đến {ketQua.dataAccessHetHan}.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Token tự sinh chỉ sống 1–2 giờ; app sẽ đổi nó thành token 60 ngày rồi mới lưu. Facebook không cho tự gia hạn —
        tới hạn phải lấy token tươi (người thật bấm), app sẽ nhắc ở bảng hạn token phía trên.
      </p>
    </div>
  );
}
