"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { xoaGanNenTang } from "@/lib/actions/the-tin-dung";
import type { MocGanThe } from "@/lib/no-phai-tra/the-tin-dung-queries";

import { nhanNenTang } from "./nen-tang-gan-the";
import { laMocSapApDung, mocGanHienThi, moTaKhoangHieuLuc, ngayVnHienThi } from "./trang-thai-moc-gan";

/**
 * Các mốc "nền tảng ads → thẻ" của một thẻ.
 * - CHƯA bật theo dõi nợ: hiện đủ lịch sử, mỗi dòng kèm KHOẢNG hiệu lực trung tính (đến ngày trước mốc kế của
 *   mọi thẻ cùng nền tảng); xoá được mọi mốc sau hộp xác nhận. Số liệu hiện tại chưa đổi, nhưng sau khi bật
 *   mốc quyết định ads từ ngày bật thuộc thẻ nào và không thêm lại được mốc ngày quá khứ ⇒ chỉ xoá mốc NHẦM.
 * - ĐÃ bật: chỉ mốc đang gánh + sắp áp dụng; mốc đã tới ngày là lịch sử gánh ads — chỉ đổi thẻ bằng cách thêm
 *   mốc mới (cờ `xoaDuoc` từ server quyết định nút xoá).
 */
export function MocGanNenTang({
  gan,
  choPhepSua,
  daBat,
  homNay = new Date(),
}: {
  gan: readonly MocGanThe[];
  choPhepSua: boolean;
  daBat: boolean;
  homNay?: Date;
}) {
  const router = useRouter();
  const [dangXoa, setDangXoa] = useState<string | null>(null);
  const [canXacNhan, setCanXacNhan] = useState<MocGanThe | null>(null);
  const hienThi = mocGanHienThi(gan, daBat, homNay);
  if (hienThi.length === 0) return <span className="text-muted-foreground">—</span>;

  async function xoa(g: MocGanThe) {
    setDangXoa(g.id);
    try {
      const res = await xoaGanNenTang(g.id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Đã xoá mốc gắn");
      setCanXacNhan(null);
      router.refresh();
    } catch {
      toast.error("Thao tác thất bại — kiểm tra kết nối");
    } finally {
      setDangXoa(null);
    }
  }

  return (
    <>
      <ul className="flex flex-col gap-0.5 text-xs">
        {hienThi.map((g) => (
          <li key={g.id} className="flex items-center gap-1.5" data-testid="moc-gan-dong">
            <span className="text-ink" data-testid="moc-gan-khoang">
              {nhanNenTang(g.nenTang)} {daBat ? `từ ${ngayVnHienThi(g.tuNgay)}` : moTaKhoangHieuLuc(g)}
            </span>
            {laMocSapApDung(g, homNay) && (
              <span className="text-muted-foreground" data-testid="moc-gan-nhan">
                (sắp áp dụng)
              </span>
            )}
            {choPhepSua && g.xoaDuoc && (
              <button
                type="button"
                disabled={dangXoa === g.id}
                // Đã bật: xoá thẳng như cũ (chỉ mốc tương lai). Chưa bật: hỏi lại vì xoá được cả mốc đã tới ngày.
                onClick={() => (daBat ? xoa(g) : setCanXacNhan(g))}
                className="text-muted-foreground underline underline-offset-2"
              >
                xoá
              </button>
            )}
          </li>
        ))}
      </ul>

      <Dialog open={canXacNhan !== null} onOpenChange={(o) => !o && setCanXacNhan(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Xoá mốc gắn</DialogTitle>
          </DialogHeader>
          {canXacNhan !== null && (
            <div className="space-y-2 text-sm text-ink" data-testid="moc-gan-xac-nhan-noi-dung">
              <p>
                Xoá mốc {nhanNenTang(canXacNhan.nenTang)} {moTaKhoangHieuLuc(canXacNhan)}?
              </p>
              <p>
                Chưa bật theo dõi nợ nên số liệu hiện tại chưa đổi. Sau khi bật, ads {nhanNenTang(canXacNhan.nenTang)}{" "}
                {canXacNhan.denNgay === null
                  ? `từ ${ngayVnHienThi(canXacNhan.tuNgay)} trở đi`
                  : `từ ${ngayVnHienThi(canXacNhan.tuNgay)} đến ${ngayVnHienThi(canXacNhan.denNgay)}`}{" "}
                sẽ tính theo mốc liền trước (nếu có), hoặc trừ thẳng vào quỹ nếu không còn mốc nào. Sau khi bật không thêm
                lại được mốc ngày đã qua.
              </p>
              <p className="font-medium">Chỉ xoá mốc nhập NHẦM; mốc đúng ngày thật phải giữ.</p>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setCanXacNhan(null)}>
              Huỷ
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={canXacNhan === null || dangXoa === canXacNhan.id}
              onClick={() => canXacNhan !== null && xoa(canXacNhan)}
            >
              {dangXoa !== null ? "Đang xoá…" : "Xoá"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
