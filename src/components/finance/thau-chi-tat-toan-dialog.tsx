"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { addDays, format, startOfDay } from "date-fns";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { tatToanThauChi } from "@/lib/actions/tat-toan-thau-chi";
import { formatVnd } from "@/lib/format";
import { formatAmountInput, parseAmountInput } from "@/lib/format-amount-input";
import { deXuatTatToan } from "@/lib/so-quy/lai-thau-chi";
import type { KhoanVayRow } from "@/lib/so-quy/khoan-vay-queries";
import type { KhoanVayLich } from "@/lib/so-quy/lich-tra-no";

import { NGAY, ngayVn } from "./khoan-vay-form-fields";

/**
 * Hộp "Tất toán" DÀNH RIÊNG cho thấu chi (`kind = OVERDRAFT`, spec thấu chi §5–§6) — khác nút Tất
 * toán của vay kỳ hạn (`khoan-vay-row-actions.tsx`, đòi dư nợ đã về 0 và không ghi đồng nào): ở đây
 * tất toán LÀ một lượt ghi tiền — lãi chưa thu + TOÀN BỘ gốc còn lại, trong một transaction
 * (`tatToanThauChi`).
 *
 * Gốc KHÔNG sửa được: server luôn lấy trọn dư nợ còn lại tại `ngayTatToan`, client chỉ dựng lại
 * `KhoanVayLich` THUẦN từ `KhoanVayRow` để hiện trước số đó (không gọi server). Lãi vẫn sửa được —
 * ngân hàng có thể tính khác vài trăm đồng đề xuất (bất biến §9 spec thấu chi).
 */
function lichCuaRow(loan: KhoanVayRow): KhoanVayLich {
  return {
    kind: loan.kind,
    startDate: loan.startDate,
    firstDueDate: loan.firstDueDate,
    termMonths: loan.termMonths,
    annualRateBp: loan.annualRateBp,
    duNoMoSo: loan.duNoMoSo,
    giaiNgan: loan.giaiNgan,
    giaiNganNgay: loan.giaiNganNgay,
    // Thấu chi (kind = OVERDRAFT) không dùng hai field này (`deXuatKy` chỉ đọc `laiCoDinhMoiKy` ở
    // nhánh BULLET, `tienGuiBatBuocMoiKy` không ảnh hưởng `deXuatTatToan`) — pass-through cho đủ kiểu.
    laiCoDinhMoiKy: loan.laiCoDinhMoiKy,
    tienGuiBatBuocMoiKy: loan.tienGuiBatBuocMoiKy,
  };
}

export function ThauChiTatToanDialog({
  loan,
  open,
  onOpenChange,
}: {
  loan: KhoanVayRow;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const router = useRouter();
  const homNay = format(new Date(), NGAY);
  const [ngay, setNgay] = useState(homNay);
  const [goc, setGoc] = useState(0);
  const [lai, setLai] = useState(0);
  const [de, setDe] = useState<{ tuNgay: Date; soNgay: number } | null>(null);
  const [dangChay, setDangChay] = useState(false);

  /**
   * Ngày tất toán phải SAU con dấu kỳ lãi đã thu — `tatToanThauChi` fencing đúng luật đó. Nói ra ở
   * hộp (min + hint + nút mờ) thay vì để chủ shop bấm rồi mới nhận câu lỗi: hộp vẫn hiện đủ gốc/lãi
   * nên trông như một lượt ghi hợp lệ.
   */
  const conDau = loan.lastDueHandled === null ? null : startOfDay(loan.lastDueHandled);
  const ngayToiThieu = conDau === null ? undefined : format(addDays(conDau, 1), NGAY);
  const ngaySomQua = conDau !== null && Boolean(ngay) && startOfDay(ngayVn(ngay)) <= conDau;

  /** Tính lại Gốc/Lãi ở CLIENT (thuần, không gọi server) mỗi khi đổi ngày tất toán. */
  function tinhLai(ngayMoi: string) {
    if (!ngayMoi) return;
    const dx = deXuatTatToan(lichCuaRow(loan), loan.traGoc, loan.lastDueHandled, ngayVn(ngayMoi));
    setGoc(dx.goc);
    setLai(dx.lai);
    setDe({ tuNgay: dx.tuNgay, soNgay: dx.soNgay });
  }

  useEffect(() => {
    if (!open) return;
    const homNayMoi = format(new Date(), NGAY);
    setNgay(homNayMoi);
    tinhLai(homNayMoi);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loan.id]);

  async function xacNhan() {
    setDangChay(true);
    try {
      const res = await tatToanThauChi({
        loanId: loan.id,
        ngayTatToan: ngayVn(ngay),
        lai,
        // Ảnh chụp con dấu lúc tính đề xuất: tab này mở từ trước một lượt duyệt kỳ lãi ở nơi khác
        // thì `lai` đang tính trùng ngày — server từ chối thay vì ghi đè lên Sổ chi phí.
        conDauDaThay: loan.lastDueHandled,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(
        `Đã tất toán ${loan.name}: lãi ${formatVnd(res.data.lai)} + gốc ${formatVnd(res.data.goc)}`
      );
      onOpenChange(false);
      router.refresh();
    } catch {
      toast.error("Lưu thất bại — kiểm tra kết nối");
    } finally {
      setDangChay(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Tất toán {loan.name}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Ngày tất toán
            <Input
              type="date"
              min={ngayToiThieu}
              max={homNay}
              value={ngay}
              onChange={(e) => {
                setNgay(e.target.value);
                tinhLai(e.target.value);
              }}
            />
          </label>
          {ngaySomQua && conDau !== null && (
            <p className="text-xs text-error">
              Kỳ lãi ngày {format(conDau, "dd/MM/yyyy")} đã thu — chọn ngày sau ngày đó.
            </p>
          )}

          {/* Gốc CHỈ ĐỌC — chủ shop không tự ý giảm gốc phải trả, server tính lại y hệt khi ghi. */}
          <div className="flex flex-col gap-1">
            <p className="text-xs text-muted-foreground">Gốc (dư nợ còn lại)</p>
            <p className="text-right font-serif text-ink tabular-nums">{formatVnd(goc)}</p>
          </div>

          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {/* Mốc tính lãi in ra để chủ shop soi được: hộp mở từ ảnh chụp cũ (kỳ lãi vừa duyệt ở
                tab khác) sẽ hiện mốc SAI, nhìn là biết phải tải lại trang. */}
            {de === null
              ? "Lãi"
              : `Lãi — từ ${format(de.tuNgay, "dd/MM/yyyy")}, ${de.soNgay} ngày`}
            <Input
              inputMode="numeric"
              aria-label="Lãi"
              value={formatAmountInput(lai)}
              onChange={(e) => setLai(parseAmountInput(e.target.value))}
              className="text-right"
            />
          </label>
        </div>

        <p className="text-sm text-ink">
          Ghi lãi {formatVnd(lai)} vào Sổ chi phí + trả gốc {formatVnd(goc)} — khoản sẽ đóng. Chỉ bấm
          khi đã chuyển tiền cho ngân hàng.
        </p>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Huỷ
          </Button>
          <Button type="button" disabled={dangChay || ngaySomQua || !ngay} onClick={xacNhan}>
            {dangChay ? "Đang ghi…" : "Đã chuyển tiền — tất toán"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
