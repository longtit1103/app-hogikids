"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { luuSoDuChotThang } from "@/lib/actions/so-du-chot-thang";
import { formatVnd } from "@/lib/format";
import { formatAmountInput, parseAmountInput, parseSignedAmountInput } from "@/lib/format-amount-input";
import type { BanChot, KhoanCauTruc } from "@/lib/so-quy/doi-chieu-so-du-chot";

/**
 * Modal "Chốt số dư cuối tháng" — 3 ô: số dư ngân hàng (CHO ÂM — thấu chi), tiền mặt, ghi chú.
 * Tháng là ẩn (tháng đang xem), không có ô để tô.
 *
 * Xử lý lỗi từ action: `field` thuộc đúng 3 ô trên form ⇒ tô ô; MỌI trường hợp khác (không field,
 * hoặc field là ô không render như `thang`) ⇒ `toast.error`. Không được để câu báo rơi vào khoá không
 * ai đọc — bài học S7 23/09: chủ shop bấm Lưu, bị từ chối, mà màn hình im lặng tuyệt đối.
 *
 * Cả hai ô bằng 0 là giá trị HỢP LỆ (tài khoản rỗng) nên không chặn — nhưng đó cũng là dấu vết của
 * "quên gõ ô bank" ⇒ hỏi lại một nhịp (bấm Lưu lần hai mới gửi), cùng khuôn `hoiTruocD0` ở form
 * khoản tiền: `window.confirm` bị trình duyệt chặn/nuốt và không dịch được.
 */

/** Ba khoá duy nhất có ô trên form — lỗi mang field ngoài tập này phải đi toast. */
const O_TREN_FORM = new Set(["soDuBank", "tienMat", "note"]);

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      {children}
      {error && <p className="text-xs text-error">{error}</p>}
    </div>
  );
}

/**
 * Hiện lại ô bank khi gõ: giữ dấu trừ đầu chuỗi kể cả khi chưa có chữ số nào ("-" đứng một mình),
 * nếu không dấu trừ bị nuốt ngay ký tự đầu và không bao giờ gõ được số âm. Số thì giao hẳn cho
 * `parseSignedAmountInput` (có test) — không tự cài lại phép kẹp/parse ở đây.
 */
function hienBank(raw: string): string {
  const dau = /^\s*[-−]/.test(raw) ? "-" : "";
  return dau + formatAmountInput(Math.abs(parseSignedAmountInput(raw)));
}

export function SoDuChotThangFormModal({
  open,
  onOpenChange,
  thangIso,
  thangNhan,
  chot,
  cauTruc,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  thangIso: string;
  /** "MM/yyyy" do server format (TZ VN). */
  thangNhan: string;
  /** Có = chế độ sửa (prefill). */
  chot: (BanChot & { note: string }) | null;
  /** Để dặn đúng số: đang thấu chi bao nhiêu, đang gửi bao nhiêu. */
  cauTruc: KhoanCauTruc;
}) {
  const router = useRouter();
  const [bankRaw, setBankRaw] = useState("");
  const [tienMat, setTienMat] = useState(0);
  const [note, setNote] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [hoiCaHaiKhong, setHoiCaHaiKhong] = useState(false);

  useEffect(() => {
    if (!open) return;
    setBankRaw(chot ? hienBank(String(chot.soDuBank)) : "");
    setTienMat(chot?.tienMat ?? 0);
    setNote(chot?.note ?? "");
    setFieldErrors({});
    setHoiCaHaiKhong(false);
  }, [open, chot]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const soDuBank = parseSignedAmountInput(bankRaw);
    if (soDuBank === 0 && tienMat === 0 && !hoiCaHaiKhong) {
      setHoiCaHaiKhong(true);
      return;
    }
    setFieldErrors({});
    setSaving(true);
    try {
      const res = await luuSoDuChotThang({ thang: thangIso, soDuBank, tienMat, note });
      if (!res.ok) {
        if (res.field && O_TREN_FORM.has(res.field)) setFieldErrors({ [res.field]: res.error });
        else toast.error(res.error);
        return;
      }
      toast.success(`Đã chốt số dư tháng ${thangNhan}`);
      onOpenChange(false);
      router.refresh();
    } catch {
      toast.error("Lưu thất bại — kiểm tra kết nối");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{chot ? "Sửa số dư đã chốt" : "Chốt số dư cuối tháng"} {thangNhan}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            Gõ đúng số trên app ngân hàng (tổng các tài khoản THANH TOÁN) và tiền mặt đếm được vào ngày
            cuối tháng. Thẻ so với &quot;Cuối kỳ&quot; của sổ quỹ — không sửa sổ, chỉ chỉ ra chỗ lệch.
          </p>
          {cauTruc.tienDangGui > 0 && (
            <p className="text-xs text-warning">
              KHÔNG cộng sổ tiết kiệm / tiền gửi bắt buộc ({formatVnd(cauTruc.tienDangGui)}) vào số dư —
              số đó đã trừ khỏi quỹ rồi; cộng vào là thẻ báo lệch giả đúng bằng số đó.
            </p>
          )}
          {cauTruc.duNoThauChi > 0 && (
            <p className="text-xs text-muted-foreground">
              Đang thấu chi {formatVnd(cauTruc.duNoThauChi)}: gõ số dư đúng như app (âm thì gõ âm), thẻ tự cộng
              dư nợ thấu chi vào khi so.
            </p>
          )}
          <Field id="chot-so-du-bank" label="Số dư ngân hàng" error={fieldErrors.soDuBank}>
            <Input
              id="chot-so-du-bank"
              inputMode="numeric"
              placeholder="0"
              value={bankRaw}
              onChange={(e) => setBankRaw(hienBank(e.target.value))}
            />
            <p className="text-xs text-muted-foreground">đang thấu chi thì gõ số âm, ví dụ -20.000.000</p>
            {/* Ads trả bằng thẻ tín dụng: sổ đã trừ ngay ngày chạy ads, tiền chỉ rời ngân hàng lúc trả sao kê. */}
            <p className="text-xs text-warning" data-testid="so-du-chot-nhac-the-tin-dung">
              Đang nợ thẻ tín dụng (quảng cáo chưa thanh toán sao kê)? Lấy số dư ngân hàng TRỪ dư nợ thẻ rồi
              mới gõ — sổ đã trừ chi phí quảng cáo ngay ngày chạy.
            </p>
          </Field>
          <Field id="chot-tien-mat" label="Tiền mặt" error={fieldErrors.tienMat}>
            <Input
              id="chot-tien-mat"
              inputMode="numeric"
              placeholder="0"
              value={formatAmountInput(tienMat)}
              onChange={(e) => setTienMat(parseAmountInput(e.target.value))}
            />
          </Field>
          <Field id="chot-ghi-chu" label="Ghi chú" error={fieldErrors.note}>
            <Input
              id="chot-ghi-chu"
              maxLength={200}
              placeholder="ví dụ: đã trừ 2 khoản chưa ghi"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          {hoiCaHaiKhong && (
            <p className="text-xs text-warning" data-testid="so-du-chot-hoi-ca-hai-khong">
              Cả số dư ngân hàng lẫn tiền mặt đang là 0 — đúng là tài khoản rỗng? Bấm Lưu lần nữa để xác nhận.
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Hủy
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Đang lưu…" : hoiCaHaiKhong ? "Lưu (xác nhận 0)" : "Lưu"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
