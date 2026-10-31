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
import { cauLenhCatTayPhien } from "@/lib/backup/huong-dan-cat-tay-phien-khac-role";
import { BackupButton } from "./backup-button";

/**
 * Một phiên DB đang giữ khoá ghi chung — hình khớp `phienDangGiu` của 409 ở `/api/restore`.
 * `catDuoc` = phiên CÙNG role app (nút cắt dùng được); `false` = role khác, chỉ superuser cắt được.
 */
type PhienDangGiu = {
  pid: number;
  applicationName: string;
  backendStart: string;
  mode: string;
  usename: string;
  catDuoc: boolean;
};

/** Lấy `phienDangGiu` từ thân 409; phần tử sai hình bị bỏ (không tin thân phản hồi tuyệt đối). */
function docPhienDangGiu(body: unknown): PhienDangGiu[] {
  const ds = (body as { phienDangGiu?: unknown } | null)?.phienDangGiu;
  if (!Array.isArray(ds)) return [];
  return ds.filter(
    (p): p is PhienDangGiu =>
      typeof p === "object" &&
      p !== null &&
      Number.isInteger((p as PhienDangGiu).pid) &&
      typeof (p as PhienDangGiu).applicationName === "string" &&
      typeof (p as PhienDangGiu).backendStart === "string" &&
      typeof (p as PhienDangGiu).mode === "string" &&
      typeof (p as PhienDangGiu).usename === "string" &&
      typeof (p as PhienDangGiu).catDuoc === "boolean",
  );
}

function gioBatDau(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "không rõ" : d.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
}

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
 * - 400 (file sai), 409 (đang bận: lượt phục hồi khác / lượt đồng bộ đang chạy) và 422 (dump đời
 *   trước bản phân quyền — phải phục hồi trên host) → DB nguyên vẹn, toast nói rõ điều đó và KHÔNG
 *   gợi ý bản lùi; 500 → gợi ý khôi phục thủ công.
 * - 409 kèm `phienDangGiu` (script ngoài app còn giữ khoá ghi chung): tách hai nhóm. Phiên CÙNG role
 *   app: nút "Cắt phiên" (hai lần bấm) → POST /api/restore/cat-phien; cắt xong chủ shop bấm "Phục hồi"
 *   lại. Phiên role KHÁC: không nút (app không có quyền cắt) — hiện role + câu lệnh superuser cắt tay.
 *   Route cắt báo "role khác" ⇒ GIỮ dòng, chuyển sang nhóm cắt tay; chỉ "không còn chặn" mới gỡ dòng.
 */
export function RestoreDialog({ shopName }: { shopName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [file, setFile] = useState<File | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [restoring, setRestoring] = useState(false);
  const [phienDangGiu, setPhienDangGiu] = useState<PhienDangGiu[]>([]);
  const [pidCho, setPidCho] = useState<number | null>(null); // đã bấm "Cắt phiên" lần 1, chờ xác nhận.
  const [pidDangCat, setPidDangCat] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Tách hai nhóm: chỉ phiên CÙNG role app có nút cắt; phiên role khác hiện câu lệnh cắt tay.
  const phienCatDuoc = phienDangGiu.filter((p) => p.catDuoc);
  const phienKhacRole = phienDangGiu.filter((p) => !p.catDuoc);

  function handleOpenChange(next: boolean) {
    if (restoring) return; // không cho đóng giữa lúc phục hồi.
    setOpen(next);
    if (!next) {
      setStep(1);
      setFile(null);
      setConfirmText("");
      setPhienDangGiu([]);
      setPidCho(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  const matches = confirmText === shopName;

  async function handleRestore() {
    if (!matches || !file) return;
    setRestoring(true);
    setPhienDangGiu([]);
    setPidCho(null);
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
        if (res.status === 409) setPhienDangGiu(docPhienDangGiu(body));
      } catch {
        // body không phải JSON — giữ message mặc định.
      }
      if (res.status === 400) {
        toast.error(`File không hợp lệ — dữ liệu hiện tại vẫn nguyên vẹn. ${message}`);
      } else if (res.status === 409) {
        // 409 = từ chối TRƯỚC khi đụng DB (đang có lượt phục hồi khác, hoặc đang có lượt đồng bộ
        // chạy). Câu "khôi phục thủ công/bản lùi" ở nhánh dưới sẽ làm chủ shop tưởng dữ liệu đã bị phá.
        toast.error(message);
      } else if (res.status === 422) {
        // 422 = dump đời trước bản phân quyền, route từ chối TRƯỚC khi giành khoá/chụp bản lùi ⇒ không
        // gì bị đụng. Tách khỏi nhánh 500: câu "khôi phục thủ công/bản lùi" ở đó xui chủ shop đi lùi
        // về `pre-restore-*.dump` trong khi dữ liệu còn nguyên. Câu server đã chỉ đường runbook.
        toast.error(`${message.replace(/[.\s]+$/, "")}. Dữ liệu hiện tại không bị đụng tới.`);
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

  /** Cắt một phiên giữ khoá: lần bấm đầu chỉ xin xác nhận, lần hai mới gọi route. */
  async function handleCatPhien({ pid, backendStart }: PhienDangGiu) {
    if (pidCho !== pid) {
      setPidCho(pid);
      return;
    }
    setPidDangCat(pid);
    try {
      const res = await fetch("/api/restore/cat-phien", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // `backendStart` để route từ chối khi pid trong danh sách cũ đã thuộc về phiên mới.
        body: JSON.stringify(backendStart ? { pid, backendStart } : { pid }),
      });
      if (res.ok) {
        toast.success(`Đã cắt phiên ${pid} — bấm "Phục hồi" lại.`);
        setPhienDangGiu((ds) => ds.filter((p) => p.pid !== pid));
        return;
      }
      let message = "Không cắt được phiên";
      let khacRole: { usename: string } | null = null;
      try {
        const body = (await res.json()) as { error?: string; khacRole?: unknown; usename?: unknown };
        if (body?.error) message = body.error;
        if (body?.khacRole === true) khacRole = { usename: typeof body.usename === "string" ? body.usename : "" };
      } catch {
        // body không phải JSON — giữ message mặc định.
      }
      toast.error(message);
      if (res.status !== 409) return;
      // Phiên role khác VẪN đang sống và chặn — giữ dòng, chuyển sang nhóm "cần superuser cắt tay".
      // Còn lại 409 = phiên không còn chặn (script đã tự thoát) → bỏ khỏi danh sách để khỏi bấm vô ích.
      const kr = khacRole;
      setPhienDangGiu((ds) =>
        kr
          ? ds.map((p) => (p.pid === pid ? { ...p, catDuoc: false, usename: kr.usename || p.usename } : p))
          : ds.filter((p) => p.pid !== pid),
      );
    } catch {
      toast.error("Không cắt được phiên — kiểm tra kết nối.");
    } finally {
      setPidDangCat(null);
      setPidCho(null);
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
                  khác cũng bị đăng xuất. Tài khoản nhân sự, quyền, trạng thái khoá và mật khẩu lùi về
                  đời backup — kiểm lại /quan-tri và đổi mật khẩu.
                </p>
              )}

              {phienCatDuoc.length > 0 && (
                <div className="flex flex-col gap-2 rounded-md border border-hairline p-3 text-xs">
                  <p className="text-ink">
                    <strong>Script ngoài app đang giữ khoá ghi dữ liệu</strong> — chờ nó chạy xong, hoặc cắt
                    phiên nếu đó là script bị treo (vd. máy ngủ). Cắt phiên dừng script ngay — giao dịch script
                    đang làm dở bị huỷ, phần đã lưu trước đó giữ nguyên.
                  </p>
                  <ul className="flex flex-col gap-1.5">
                    {phienCatDuoc.map((p) => (
                      <li key={p.pid} className="flex items-center justify-between gap-2">
                        <span className="text-muted-foreground">
                          pid {p.pid} · {p.applicationName || "không tên"} · từ {gioBatDau(p.backendStart)}
                        </span>
                        <Button
                          type="button"
                          size="sm"
                          variant={pidCho === p.pid ? "destructive" : "outline"}
                          disabled={restoring || pidDangCat !== null}
                          onClick={() => handleCatPhien(p)}
                        >
                          {pidDangCat === p.pid ? "Đang cắt…" : pidCho === p.pid ? "Bấm lại để cắt" : "Cắt phiên"}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {phienKhacRole.length > 0 && (
                <div className="flex flex-col gap-2 rounded-md border border-hairline p-3 text-xs">
                  <p className="text-ink">
                    <strong>Phiên của role khác đang giữ khoá</strong> — app không có quyền cắt các phiên này.
                    Chờ script xong, hoặc nhờ người quản trị DB cắt bằng tài khoản superuser:
                  </p>
                  <ul className="flex flex-col gap-1.5">
                    {phienKhacRole.map((p) => (
                      <li key={p.pid} className="flex flex-col gap-0.5">
                        <span className="text-muted-foreground">
                          pid {p.pid} · role {p.usename || "không rõ"} · {p.applicationName || "không tên"}
                        </span>
                        <code className="select-all text-ink">{cauLenhCatTayPhien(p.pid)}</code>
                      </li>
                    ))}
                  </ul>
                </div>
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
