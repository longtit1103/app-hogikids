"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { deleteExpense } from "@/lib/actions/expenses";
import type { ExpenseRow } from "@/lib/expenses/expense-queries";
import { formatVnd } from "@/lib/format";

type DeleteMode = "only" | "stop_recurring";

export type ExpenseDeleteDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expense: ExpenseRow | null;
};

/**
 * Xóa 1 khoản chi. Khoản có `recurringId` (source RECURRING) hiện thêm 2
 * radio để chọn `deleteExpense` mode — khoản thường chỉ có 1 lựa chọn "only".
 */
export function ExpenseDeleteDialog({ open, onOpenChange, expense }: ExpenseDeleteDialogProps) {
  const router = useRouter();
  const [mode, setMode] = useState<DeleteMode>("only");
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (open) setMode("only");
  }, [open, expense?.id]);

  if (!expense) return null;

  const isRecurring = Boolean(expense.recurringId);
  // Lãi vay do duyệt kỳ trả nợ sinh ra: con dấu `lastDueHandled` KHÔNG lùi khi xoá dòng này.
  const doDuyetKySinh = expense.refId?.startsWith("LOAN:") ?? false;

  async function handleDelete() {
    if (!expense) return;
    setDeleting(true);
    try {
      const res = await deleteExpense(expense.id, mode);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Đã xóa");
      onOpenChange(false);
      router.refresh();
    } catch {
      toast.error("Lưu thất bại — kiểm tra kết nối");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Xóa khoản chi</DialogTitle>
        </DialogHeader>

        <p className="text-sm text-ink">
          {`Xóa khoản chi '${expense.description}' — ${formatVnd(expense.amount)}?`}
        </p>
        <p className="text-sm text-muted-foreground">
          Mục này sẽ chuyển vào{" "}
          <Link href="/tai-chinh/thung-rac" className="underline">
            Thùng rác
          </Link>{" "}
          — bạn khôi phục lại được.
        </p>

        {doDuyetKySinh && (
          <p className="text-sm text-muted-foreground">
            Dòng này do duyệt kỳ trả nợ sinh ra — xoá không mở lại kỳ; muốn ghi lại thì nhập tay.
          </p>
        )}

        {isRecurring && (
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="radio"
                name="delete-mode"
                checked={mode === "only"}
                onChange={() => setMode("only")}
              />
              Chỉ xóa khoản này
            </label>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="radio"
                name="delete-mode"
                checked={mode === "stop_recurring"}
                onChange={() => setMode("stop_recurring")}
              />
              Xóa và dừng lặp lại
            </label>
            {mode === "only" && (
              // `ensureRecurringExpenses` sinh lại dòng cho tháng đang render nếu mẫu còn `active`
              // (xem chú thích đầu `ensure-recurring-expenses.ts`) — "Chỉ xóa khoản này" không tắt mẫu
              // nên dòng tự quay lại ở lần mở trang sau. `ExpenseRow` (props dialog này) KHÔNG mang
              // theo `RecurringExpense.active` nên không lọc riêng theo mẫu còn bật hay đã dừng — hiện
              // cảnh báo mọi lần chọn "only" trên khoản định kỳ (không thêm prop/query mới chỉ cho ca này).
              <p className="text-sm text-warning" data-testid="expense-xoa-canh-bao-dinh-ky-quay-lai">
                Khoản định kỳ còn bật sẽ tự sinh lại dòng này ở lần mở trang sau. Muốn bỏ hẳn: chọn
                &quot;Xóa và dừng lặp lại&quot;. Chỉ muốn đổi số tiền tháng này: bấm Sửa thay vì xoá.
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Hủy
          </Button>
          <Button type="button" variant="destructive" disabled={deleting} onClick={handleDelete}>
            {deleting ? "Đang xóa…" : "Xóa"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
