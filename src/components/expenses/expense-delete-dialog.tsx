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
