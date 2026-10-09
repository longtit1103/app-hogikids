"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { xoaPhieu } from "@/lib/actions/phieu-nhap-no";

/**
 * Nút "Xoá" một hồ sơ phiếu nợ ghi nhận nhầm (`xoaPhieu`) ở hàng của khối "Nợ tiền hàng nhà cung cấp".
 * Nơi gọi CHỈ render nút khi `lyDoKhongXoaPhieu` = null (phiếu không còn dòng trả/hoàn nào) — server vẫn
 * kiểm lại sau khoá phiếu và ném đúng câu đó. Hộp xác nhận nói rõ hồ sơ vào thùng rác (khôi phục được).
 */
export function XoaPhieuNoButton({ phieuNhapId, maPhieu }: { phieuNhapId: string; maPhieu: string }) {
  const router = useRouter();
  const [mo, setMo] = useState(false);
  const [dangChay, setDangChay] = useState(false);

  async function xoa() {
    setDangChay(true);
    try {
      const res = await xoaPhieu({ phieuNhapId });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Đã xoá phiếu ${maPhieu} khỏi sổ nợ`);
      setMo(false);
      router.refresh();
    } catch {
      toast.error("Thao tác thất bại — kiểm tra kết nối");
    } finally {
      setDangChay(false);
    }
  }

  return (
    <>
      <Button type="button" variant="ghost" size="sm" aria-label={`Xoá phiếu ${maPhieu}`} onClick={() => setMo(true)}>
        Xoá
      </Button>
      <Dialog open={mo} onOpenChange={setMo}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Xoá phiếu khỏi sổ nợ</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-ink">
            Xoá hồ sơ phiếu {maPhieu} ghi nhận nhầm? Phiếu chưa có lần trả/hoàn nào; hồ sơ vào thùng rác, khôi phục
            được.
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setMo(false)}>
              Huỷ
            </Button>
            <Button type="button" variant="destructive" disabled={dangChay} onClick={xoa}>
              {dangChay ? "Đang xoá…" : "Xoá"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
