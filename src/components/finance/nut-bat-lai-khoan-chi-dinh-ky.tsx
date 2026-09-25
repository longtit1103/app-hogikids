"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { batLaiDinhKy } from "@/lib/actions/expenses";
import { formatVnd } from "@/lib/format";

export type NutBatLaiKhoanChiDinhKyProps = {
  recurringId: string;
  description: string;
  amount: number;
  dayOfMonth: number;
  /**
   * Nhãn "MM/yyyy" của tháng này và tháng sau — server tính theo giờ VN rồi truyền xuống; client KHÔNG
   * tự format `new Date()` (máy người bấm có thể khác múi giờ).
   */
  thangNay: string;
  thangSau: string;
};

/** Mã lỗi server khi đang có mẫu khác cùng danh mục + kênh chạy — phải xác nhận lần hai mới bật. */
const MA_TRUNG = "DINH_KY_TRUNG_MAU_DANG_CHAY";

/**
 * Nút "Bật lại" cho MỘT mẫu chi định kỳ đã dừng + hộp xác nhận: chọn bắt đầu từ tháng này hay tháng
 * sau, nói rõ KHÔNG ghi bù các tháng đã dừng. Server từ chối khi đã có mẫu cùng danh mục đang chạy
 * (bật là trừ 2 lần mỗi tháng) — hộp hiện nguyên câu cảnh báo của server và đổi nút thành "Vẫn bật lại".
 */
export function NutBatLaiKhoanChiDinhKy({
  recurringId,
  description,
  amount,
  dayOfMonth,
  thangNay,
  thangSau,
}: NutBatLaiKhoanChiDinhKyProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [dangBat, setDangBat] = useState(false);
  const [tuThangSau, setTuThangSau] = useState(false);
  const [canhBaoTrung, setCanhBaoTrung] = useState<string | null>(null);

  function doiTrangThaiHop(mo: boolean) {
    setOpen(mo);
    if (mo) {
      setTuThangSau(false);
      setCanhBaoTrung(null);
    }
  }

  async function xacNhan() {
    setDangBat(true);
    try {
      const res = await batLaiDinhKy(recurringId, { tuThangSau, xacNhanTrung: canhBaoTrung !== null });
      if (!res.ok) {
        if (res.code === MA_TRUNG) setCanhBaoTrung(res.error);
        else toast.error(res.error);
        return;
      }
      toast.success(`Đã bật lại — sinh chi phí từ tháng ${res.data.tuThang}`);
      setOpen(false);
      router.refresh();
    } catch {
      toast.error("Lưu thất bại — kiểm tra kết nối");
    } finally {
      setDangBat(false);
    }
  }

  const thangBatDau = tuThangSau ? thangSau : thangNay;

  return (
    <>
      <Button type="button" variant="outline" size="xs" onClick={() => doiTrangThaiHop(true)}>
        Bật lại
      </Button>
      <Dialog open={open} onOpenChange={doiTrangThaiHop}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Bật lại khoản chi định kỳ</DialogTitle>
          </DialogHeader>

          <p className="text-sm text-ink">
            {`Bật lại '${description}' — ${formatVnd(amount)}, ngày ${dayOfMonth} hằng tháng?`}
          </p>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm text-ink">Bắt đầu từ:</legend>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="radio"
                name={`bat-lai-tu-thang-${recurringId}`}
                checked={!tuThangSau}
                onChange={() => setTuThangSau(false)}
              />
              Tháng này ({thangNay})
            </label>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="radio"
                name={`bat-lai-tu-thang-${recurringId}`}
                checked={tuThangSau}
                onChange={() => setTuThangSau(true)}
              />
              Tháng sau ({thangSau}) — tháng này đã trả hoặc đã ghi tay khoản này
            </label>
          </fieldset>

          <p className="text-sm text-muted-foreground" data-testid="bat-lai-dinh-ky-giai-thich">
            App sẽ sinh chi phí từ tháng {thangBatDau} trở đi
            {tuThangSau ? "" : ` (tháng này ghi khi tới ngày ${dayOfMonth}, nếu chưa có dòng của khoản này)`}.{" "}
            <strong>Không</strong> ghi bù các tháng đã dừng.
          </p>

          {canhBaoTrung && (
            <p className="text-sm text-warning" data-testid="bat-lai-dinh-ky-canh-bao-trung">
              {canhBaoTrung}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => doiTrangThaiHop(false)}>
              Hủy
            </Button>
            <Button
              type="button"
              variant={canhBaoTrung ? "destructive" : "default"}
              disabled={dangBat}
              onClick={xacNhan}
            >
              {dangBat ? "Đang bật…" : canhBaoTrung ? "Vẫn bật lại" : "Bật lại"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
