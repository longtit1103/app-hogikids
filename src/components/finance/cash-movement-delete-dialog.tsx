"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { deleteCashMovement } from "@/lib/actions/cash-movements";
import { CASH_MOVEMENT_KIND_META } from "@/lib/cash-movements/cash-movement-kinds";
import type { CashMovementRow } from "@/lib/cash-movements/cash-movement-queries";
import { formatVnd } from "@/lib/format";

export type CashMovementDeleteDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: CashMovementRow | null;
};

/** Xoá 1 khoản tiền khác — xoá cứng, không có nhánh định kỳ (mẫu `expense-delete-dialog.tsx` rút gọn). */
export function CashMovementDeleteDialog({ open, onOpenChange, row }: CashMovementDeleteDialogProps) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);

  if (!row) return null;
  const label = CASH_MOVEMENT_KIND_META[row.kind].label;
  // Dòng do duyệt kỳ sinh ra: con dấu `lastDueHandled` KHÔNG lùi khi xoá dòng, nên phải nói thẳng
  // — nếu không chủ shop xoá rồi ngồi đợi kỳ hiện lại.
  const doDuyetKySinh = row.loanId !== null && row.description.startsWith("Trả gốc ");

  async function handleDelete() {
    if (!row) return;
    setDeleting(true);
    try {
      const res = await deleteCashMovement(row.id);
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
          <DialogTitle>Xóa khoản tiền</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-ink">
          {`Xóa ${label} ${formatVnd(row.amount)}${row.description ? ` '${row.description}'` : ""}?`}
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
