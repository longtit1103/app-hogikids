"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { khoiPhucBanGhi, xoaVinhVienBanGhi } from "@/lib/actions/thung-rac";
import type { ThungRacRow } from "@/lib/thung-rac/thung-rac-queries";

type HopThoai = "khoiPhuc" | "xoaVinhVien" | null;

/**
 * 2 nút thao tác một dòng thùng rác: Khôi phục (mờ khi `khoiPhucDuoc=false`) · Xoá vĩnh viễn (LUÔN
 * bật — kể cả khi không khôi phục được, chủ shop vẫn cần dọn hẳn một dòng rác không dùng được nữa).
 *
 * `row.nhan` đã là câu tiếng Việt đầy đủ (việc — tiền — ngày, xem `chup-anh-ban-ghi.ts`) nên hộp
 * thoại xác nhận dùng THẲNG nó, không tự ghép lại số tiền/ngày — tránh hai nơi hiển thị lệch nhau.
 */
export function ThungRacRowActions({
  row,
  khoiPhucDuoc,
}: {
  row: ThungRacRow;
  khoiPhucDuoc: boolean;
}) {
  const router = useRouter();
  const [hopThoai, setHopThoai] = useState<HopThoai>(null);
  const [dangChay, setDangChay] = useState(false);

  async function xacNhanKhoiPhuc() {
    setDangChay(true);
    try {
      const res = await khoiPhucBanGhi(row.id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      // `res.data` = câu cảnh báo về thứ app CỐ Ý không làm (sổ tiết kiệm nay trỏ khoản vay khác).
      // Bám vào toast thành công chứ không nuốt: chủ shop phải biết cụm vừa dựng lại thiếu gì.
      toast.success("Đã khôi phục", res.data === null ? undefined : { description: res.data });
      setHopThoai(null);
      router.refresh();
    } catch {
      toast.error("Lưu thất bại — kiểm tra kết nối");
    } finally {
      setDangChay(false);
    }
  }

  async function xacNhanXoaVinhVien() {
    setDangChay(true);
    try {
      const res = await xoaVinhVienBanGhi(row.id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Đã xoá vĩnh viễn");
      setHopThoai(null);
      router.refresh();
    } catch {
      toast.error("Lưu thất bại — kiểm tra kết nối");
    } finally {
      setDangChay(false);
    }
  }

  return (
    <>
      <div className="flex items-center justify-end gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!khoiPhucDuoc}
          onClick={() => setHopThoai("khoiPhuc")}
        >
          Khôi phục
        </Button>
        <Button type="button" variant="destructive" size="sm" onClick={() => setHopThoai("xoaVinhVien")}>
          Xoá vĩnh viễn
        </Button>
      </div>

      <Dialog open={hopThoai !== null} onOpenChange={(o) => !o && setHopThoai(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{hopThoai === "khoiPhuc" ? "Khôi phục" : "Xoá vĩnh viễn"}</DialogTitle>
          </DialogHeader>

          {hopThoai === "khoiPhuc" && (
            <p className="text-sm text-ink">
              {`Dựng lại "${row.nhan}"? Số dư quỹ / Lãi lỗ sẽ tính lại kèm mục này.`}
            </p>
          )}
          {hopThoai === "xoaVinhVien" && (
            <p className="text-sm text-ink">
              {`Xoá vĩnh viễn "${row.nhan}"? Đây mới là lần xoá KHÔNG hoàn tác được — hết cách lấy lại.`}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setHopThoai(null)}>
              Huỷ
            </Button>
            {hopThoai === "khoiPhuc" && (
              <Button type="button" disabled={dangChay} onClick={xacNhanKhoiPhuc}>
                {dangChay ? "Đang khôi phục…" : "Khôi phục"}
              </Button>
            )}
            {hopThoai === "xoaVinhVien" && (
              <Button type="button" variant="destructive" disabled={dangChay} onClick={xacNhanXoaVinhVien}>
                {dangChay ? "Đang xoá…" : "Xoá vĩnh viễn"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
