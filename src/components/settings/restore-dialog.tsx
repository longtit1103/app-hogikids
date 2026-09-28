"use client";

import { useRef, useState } from "react";
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
import { BackupButton } from "./backup-button";

/**
 * "Phục hồi từ file" — confirm 2 bước như "Xóa toàn bộ".
 *
 * - Bước 1: chọn file (.dump / .sql.gz) + cảnh báo GHI ĐÈ toàn bộ dữ liệu. Cố ý KHÔNG hứa "thay
 *   sạch": role app không có quyền dựng lại schema nên đường này chỉ ghi đè theo object, object
 *   sinh sau lúc sao lưu còn sót — muốn thay sạch phải chạy `deploy/restore.sh` (xem runbook).
 *   (kể cả tài khoản đăng nhập & cài đặt) + nút phụ "Sao lưu ngay". DB hiện tại
 *   được tự sao lưu (pre-restore) trước khi phục hồi.
 * - Bước 2: gõ đúng tên shop hiện tại → "Phục hồi" (nền error) chỉ enabled khi
 *   khớp → POST /api/restore (FormData) + spinner.
 * - Thành công → toast + điều hướng /dang-nhap; route tự đẩy mốc phiên nên MỌI thiết bị phải đăng
 *   nhập lại, và mật khẩu là mật khẩu đời backup (phải đổi ngay).
 * - 400 (file sai) và 409 (đang bận: lượt phục hồi khác / lượt đồng bộ đang chạy) → DB nguyên vẹn;
 *   500 → gợi ý khôi phục thủ công.
 */
export function RestoreDialog({ shopName }: { shopName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [file, setFile] = useState<File | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [restoring, setRestoring] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleOpenChange(next: boolean) {
    if (restoring) return; // không cho đóng giữa lúc phục hồi.
    setOpen(next);
    if (!next) {
      setStep(1);
      setFile(null);
      setConfirmText("");
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  const matches = confirmText === shopName;

  async function handleRestore() {
    if (!matches || !file) return;
    setRestoring(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/restore", { method: "POST", body: formData });

      if (res.ok) {
        let canhBao: string | undefined;
        try {
          canhBao = ((await res.json()) as { canhBao?: string }).canhBao;
        } catch {
          // body không phải JSON — coi như không có cảnh báo.
        }
        if (canhBao) toast.warning(canhBao);
        else toast.success("Đã phục hồi từ bản backup — hãy đổi mật khẩu ngay");
        setOpen(false);
        router.push("/dang-nhap");
        return;
      }

      let message = "Phục hồi thất bại";
      try {
        const body = (await res.json()) as { error?: string };
        if (body?.error) message = body.error;
      } catch {
        // body không phải JSON — giữ message mặc định.
      }
      if (res.status === 400) {
        toast.error(`File không hợp lệ — dữ liệu hiện tại vẫn nguyên vẹn. ${message}`);
      } else if (res.status === 409) {
        // 409 = từ chối TRƯỚC khi đụng DB (đang có lượt phục hồi khác, hoặc đang có lượt đồng bộ
        // chạy). Câu "khôi phục thủ công/bản lùi" ở nhánh dưới sẽ làm chủ shop tưởng dữ liệu đã bị phá.
        toast.error(message);
      } else {
        toast.error(
          `${message} Khôi phục thủ công/bản lùi: xem hướng dẫn deploy.`,
        );
      }
    } catch {
      toast.error("Phục hồi thất bại — kiểm tra kết nối. Dữ liệu có thể chưa thay đổi.");
    } finally {
      setRestoring(false);
    }
  }

  return (
    <>
      <Button type="button" variant="outline" onClick={() => handleOpenChange(true)}>
        Phục hồi từ file
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-md">
          {step === 1 ? (
            <>
              <DialogHeader>
                <DialogTitle>Phục hồi từ file</DialogTitle>
                <DialogDescription>
                  Phục hồi <strong className="text-ink">GHI ĐÈ</strong> toàn bộ dữ liệu hiện tại bằng
                  nội dung file — kể cả tài khoản đăng nhập và cài đặt. Dữ liệu đang có được tự sao
                  lưu trước.
                </DialogDescription>
              </DialogHeader>

              <div className="flex flex-col gap-3 text-sm text-ink">
                <label className="flex flex-col gap-1.5">
                  <span className="text-muted-foreground">Chọn file backup</span>
                  <input
                    ref={inputRef}
                    type="file"
                    accept=".dump,.sql.gz,.gz"
                    aria-label="File backup"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    className="text-sm file:mr-3 file:rounded-md file:border file:border-hairline file:bg-surface file:px-3 file:py-1.5 file:text-sm file:text-ink"
                  />
                </label>
                <p className="text-xs text-muted-foreground">
                  Nhận bản <code>hogikids-*.dump</code> (1 DB, khuyến nghị) hoặc <code>.sql.gz</code>{" "}
                  1-DB. File &gt;~100MB vượt giới hạn Cloudflare → phục hồi qua{" "}
                  <code>deploy/restore.sh</code> trên minipc/Tailscale, KHÔNG qua trang public. File{" "}
                  <code>.tar.gz</code> backup-toàn-server sẽ bị từ chối.
                </p>
                <p className="text-xs text-muted-foreground">
                  <strong className="text-ink">Cách này ghi đè theo từng bảng.</strong> Nếu bản backup
                  cũ hơn một lần nâng cấp cấu trúc dữ liệu, vài bảng mới có thể còn sót lại sau khi
                  phục hồi. Muốn thay sạch hoàn toàn (hoặc file <code>.sql.gz</code> bị từ chối vì
                  thiếu quyền) thì chạy <code>deploy/restore.sh</code> trên máy chủ — xem hướng dẫn
                  triển khai.
                </p>
              </div>

              <DialogFooter className="sm:justify-between">
                <BackupButton variant="outline" />
                <div className="flex flex-col-reverse gap-2 sm:flex-row">
                  <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                    Hủy
                  </Button>
                  <Button type="button" disabled={!file} onClick={() => setStep(2)}>
                    Tiếp tục
                  </Button>
                </div>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Xác nhận phục hồi</DialogTitle>
                <DialogDescription>
                  Gõ đúng tên shop <strong className="text-ink">{shopName}</strong> để xác nhận thay
                  sạch dữ liệu bằng nội dung file.
                </DialogDescription>
              </DialogHeader>

              <Input
                autoFocus
                value={confirmText}
                placeholder={shopName}
                aria-label="Tên shop xác nhận"
                disabled={restoring}
                onChange={(e) => setConfirmText(e.target.value)}
              />
              {restoring ? (
                <p className="text-sm text-warning">Đang phục hồi… đừng tắt trình duyệt.</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Phục hồi lùi CẢ tài khoản đăng nhập về trạng thái trong file backup: bạn sẽ đăng nhập
                  lại bằng <strong className="text-ink">mật khẩu tại thời điểm bản backup</strong> (mật
                  khẩu đã đổi sau đó không còn dùng được, và mật khẩu cũ sống lại).{" "}
                  <strong className="text-ink">Đổi mật khẩu ngay sau khi phục hồi.</strong> Mọi thiết bị
                  khác cũng bị đăng xuất.
                </p>
              )}

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={restoring}
                  onClick={() => setStep(1)}
                >
                  Quay lại
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={!matches || restoring}
                  onClick={handleRestore}
                >
                  {restoring ? "Đang phục hồi…" : "Phục hồi"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
