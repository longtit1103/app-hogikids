"use client";

import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { suaSoTienTruocMoc } from "@/lib/actions/sua-tien-truoc-moc";
import { formatNgayVn } from "@/lib/dinh-dang-ngay-gio-vn";
import type { ExpenseRow } from "@/lib/expenses/expense-queries";
import { formatVnd } from "@/lib/format";
import { parseAmountInput } from "@/lib/format-amount-input";
import type { KetQuaSuaTienTruocMoc } from "@/lib/no-phai-tra/sua-tien-truoc-moc";

const TRAN_LY_DO = 120; // khớp trần server (`lyDo` trim 1..120)

export type SuaTienTruocMocModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Dòng đang sửa — `amount` của nó là `amountCuDaThay` gửi lên (server từ chối nếu DB đã khác). */
  expense: ExpenseRow | null;
  /** Mốc M (ngày bật theo dõi nợ phải trả) — dùng để ghi ngày điều chỉnh trong toast. */
  mocM: Date | null;
};

/** Câu toast thành công: nêu có/không ghi bù, chiều + số bù. */
export function cauThanhCongSuaTien(kq: KetQuaSuaTienTruocMoc, mocM: Date | null): string {
  if (!kq.coBu || kq.soTienBu === undefined) {
    return "Đã sửa số tiền — dòng trước ngày mở sổ quỹ nên không ghi điều chỉnh, chỉ Lãi/Lỗ đổi.";
  }
  const huong = kq.chieu === "OUT" ? "ra" : "vào";
  const ngay = mocM === null ? "" : ` ngày ${formatNgayVn(mocM, "dd/MM")}`;
  return `Đã sửa số tiền — đã thêm điều chỉnh mở sổ ${huong} ${formatVnd(kq.soTienBu)}${ngay}.`;
}

function Field({ id, label, error, children }: { id: string; label: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      {children}
      {error && (
        <p className="text-xs text-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Lối "Sửa số tiền trước mốc": đổi số tiền một chi phí ngày < M sau khi đã bật theo dõi nợ phải trả. Server là nơi
 * quyết định bù hay không (phụ thuộc ngày mở sổ quỹ, UI không biết) — câu giải thích nói "nếu dòng này nằm trong
 * sổ quỹ". Chỉ chủ shop thấy lối vào; action vẫn tự chặn mọi vai khác.
 */
export function SuaTienTruocMocModal({ open, onOpenChange, expense, mocM }: SuaTienTruocMocModalProps) {
  const router = useRouter();
  const idSoTien = useId();
  const idLyDo = useId();
  const [amountMoi, setAmountMoi] = useState(0);
  const [lyDo, setLyDo] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // Mở modal (hoặc đổi dòng) ⇒ xoá trạng thái cũ, điền sẵn số hiện tại để người dùng sửa từ đó.
  useEffect(() => {
    if (!open) return;
    setAmountMoi(expense?.amount ?? 0);
    setLyDo("");
    setFieldErrors({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, expense?.id]);

  if (!expense) return null;

  const khongDoi = amountMoi === expense.amount;
  const hopLe = amountMoi > 0 && !khongDoi && lyDo.trim() !== "" && !saving;

  async function handleSave() {
    if (!expense || !hopLe) return;
    setFieldErrors({});
    setSaving(true);
    try {
      const res = await suaSoTienTruocMoc(expense.id, {
        amountMoi,
        amountCuDaThay: expense.amount,
        lyDo: lyDo.trim(),
      });
      if (!res.ok) {
        if (res.field) setFieldErrors({ [res.field]: res.error });
        else toast.error(res.error);
        return;
      }
      toast.success(cauThanhCongSuaTien(res.data, mocM));
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
          <DialogTitle>Sửa số tiền (trước ngày bật)</DialogTitle>
        </DialogHeader>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" data-testid="sua-tien-thong-tin-dong">
          <dt className="text-muted-foreground">Ngày</dt>
          <dd className="text-ink">{formatNgayVn(expense.date, "dd/MM/yyyy")}</dd>
          <dt className="text-muted-foreground">Danh mục</dt>
          <dd className="text-ink">{expense.categoryName}</dd>
          <dt className="text-muted-foreground">Mô tả</dt>
          <dd className="text-ink">{expense.description || "—"}</dd>
          <dt className="text-muted-foreground">Số tiền hiện tại</dt>
          <dd className="text-ink" data-testid="sua-tien-so-hien-tai">
            {formatVnd(expense.amount)}
          </dd>
        </dl>

        {fieldErrors.amountCuDaThay && (
          <p className="text-sm text-error" role="alert">
            {fieldErrors.amountCuDaThay}
          </p>
        )}

        <Field id={idSoTien} label="Số tiền mới" error={fieldErrors.amountMoi}>
          <div className="relative">
            <Input
              id={idSoTien}
              inputMode="numeric"
              value={amountMoi ? new Intl.NumberFormat("vi-VN").format(amountMoi) : ""}
              onChange={(e) => setAmountMoi(parseAmountInput(e.target.value))}
              placeholder="0"
              className="pr-8 text-right"
            />
            <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-sm text-muted-foreground">
              ₫
            </span>
          </div>
        </Field>

        <Field id={idLyDo} label="Lý do sửa" error={fieldErrors.lyDo}>
          <Input
            id={idLyDo}
            value={lyDo}
            maxLength={TRAN_LY_DO}
            onChange={(e) => setLyDo(e.target.value)}
            placeholder="Vd: khai nhầm số tiền"
          />
        </Field>

        <p className="text-sm text-muted-foreground" data-testid="sua-tien-giai-thich">
          Nếu dòng này nằm trong sổ quỹ, app tự ghi một dòng điều chỉnh mở sổ đúng bằng chênh lệch để số dư từ ngày bật
          không đổi; chỉ Lãi/Lỗ tháng cũ thay đổi.
        </p>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Hủy
          </Button>
          <Button type="button" disabled={!hopLe} onClick={handleSave}>
            {saving ? "Đang lưu…" : "Lưu"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
