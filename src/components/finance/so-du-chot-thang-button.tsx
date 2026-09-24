"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { xoaSoDuChotThang } from "@/lib/actions/so-du-chot-thang";
import type { BanChot, KhoanCauTruc } from "@/lib/so-quy/doi-chieu-so-du-chot";

import { SoDuChotThangFormModal } from "./so-du-chot-thang-form-modal";

/**
 * Cụm nút của thẻ Chốt số dư: "Chốt số dư" (chưa có) hoặc "Sửa" + "Xoá" (đã có). Client wrapper vì
 * thẻ là server component (mẫu `cash-movement-add-button.tsx`). Xoá là xoá thẳng, cố ý không thùng
 * rác (3 con số, gõ lại 10 giây). Lỗi xoá luôn đi `toast.error` bất kể `field` — không có ô nào để tô.
 * `thangNhan` do server tính (TZ VN) — client KHÔNG parse lại ISO, kẻo in sai tháng theo TZ trình duyệt.
 */
export function SoDuChotThangButton({
  thangIso,
  thangNhan,
  chot,
  cauTruc,
}: {
  /** ISO của ngày đầu tháng — khoá gửi lên action (server tự `thangChot` lại). */
  thangIso: string;
  /** "MM/yyyy" đã format ở server. */
  thangNhan: string;
  chot: (BanChot & { note: string }) | null;
  cauTruc: KhoanCauTruc;
}) {
  const router = useRouter();
  const [openForm, setOpenForm] = useState(false);
  const [openXoa, setOpenXoa] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleXoa() {
    setDeleting(true);
    try {
      const res = await xoaSoDuChotThang({ thang: thangIso });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Đã xoá bản chốt tháng ${thangNhan}`);
      setOpenXoa(false);
      router.refresh();
    } catch {
      toast.error("Xoá thất bại — kiểm tra kết nối");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <div className="flex gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => setOpenForm(true)}>
          {chot ? "Sửa" : "Chốt số dư"}
        </Button>
        {chot && (
          <Button type="button" variant="outline" size="sm" onClick={() => setOpenXoa(true)}>
            Xoá
          </Button>
        )}
      </div>

      <SoDuChotThangFormModal
        open={openForm}
        onOpenChange={setOpenForm}
        thangIso={thangIso}
        thangNhan={thangNhan}
        chot={chot}
        cauTruc={cauTruc}
      />

      <Dialog open={openXoa} onOpenChange={setOpenXoa}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Xoá bản chốt tháng {thangNhan}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-ink">Xoá số dư đã chốt của tháng này? Sổ quỹ không đổi — chỉ mất phép so.</p>
          <p className="text-sm text-muted-foreground">Không qua thùng rác; cần thì chốt lại.</p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpenXoa(false)}>
              Hủy
            </Button>
            <Button type="button" variant="destructive" disabled={deleting} onClick={handleXoa}>
              {deleting ? "Đang xoá…" : "Xoá"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
