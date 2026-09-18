"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { differenceInCalendarDays, format } from "date-fns";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { tatToanSoTietKiem } from "@/lib/actions/tat-toan-so-tiet-kiem";
import { formatAmountInput, parseAmountInput } from "@/lib/format-amount-input";
import { formatVnd } from "@/lib/format";
import type { SoTietKiemRow } from "@/lib/tiet-kiem/so-tiet-kiem-queries";

import { NGAY, O } from "./khoan-vay-form-fields";

/**
 * Thẻ nhắc đáo hạn (spec mục 11) — hiện khi sổ CHƯA tất toán và đã tới `maturityDate` (lọc ở
 * `so-tiet-kiem-section.tsx`, hàm `sosDenHan`). Ô lãi điền sẵn `laiDuKien`, sửa được theo giấy báo
 * ngân hàng thật (khuôn `ky-tra-no-card.tsx`, đơn giản hơn vì sổ tiết kiệm không có "gốc"/"tiền gửi"
 * tách rời như kỳ trả nợ khoản vay — chỉ MỘT số lãi).
 */

const NGAY_COI_LA_TRE = 7;

/** Quá hạn đáo hạn CHỪNG nào thì hiện badge "trễ" — khuôn `NGAY_COI_LA_TRE` ở `khoan-vay-table.tsx`. */
export function laDaoHanTre(maturityDate: Date, homNay: Date): boolean {
  return differenceInCalendarDays(homNay, maturityDate) > NGAY_COI_LA_TRE;
}

export function SoDaoHanCard({ so }: { so: SoTietKiemRow }) {
  const router = useRouter();
  const [lai, setLai] = useState(so.laiDuKien);
  const [ngayTatToan, setNgayTatToan] = useState(() => format(new Date(), NGAY));
  const [dangChay, setDangChay] = useState(false);
  const [moXacNhan, setMoXacNhan] = useState(false);
  const tre = laDaoHanTre(so.maturityDate, new Date());

  async function tatToan() {
    setDangChay(true);
    try {
      const res = await tatToanSoTietKiem({ id: so.id, ngayTatToan, lai });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setMoXacNhan(false);
      toast.success(`Đã tất toán ${so.name} — nhận ${formatVnd(so.principal)} + lãi ${formatVnd(lai)}`);
      router.refresh();
    } catch {
      toast.error("Lưu thất bại — kiểm tra kết nối");
    } finally {
      setDangChay(false);
    }
  }

  return (
    <div className="mt-3 rounded-xl border-l-4 border-warning bg-surface-card p-4">
      <p className="flex flex-wrap items-center gap-2 text-sm text-ink">
        <span>
          {so.name} — đáo hạn {format(so.maturityDate, "dd/MM/yyyy")} · gốc {formatVnd(so.principal)}
        </span>
        {tre && <Badge variant="outline">trễ</Badge>}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">lãi dồn tới nay ≈ {formatVnd(so.laiDonToiNay)}</p>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <O label="Ngày tất toán">
          <Input
            type="date"
            value={ngayTatToan}
            min={format(so.maturityDate, NGAY)}
            max={format(new Date(), NGAY)}
            onChange={(e) => setNgayTatToan(e.target.value)}
          />
        </O>
        <O label="Lãi thực nhận" hint="app điền sẵn lãi dự kiến — sửa theo đúng số giấy báo ngân hàng">
          <Input
            inputMode="numeric"
            value={formatAmountInput(lai)}
            onChange={(e) => setLai(parseAmountInput(e.target.value))}
            className="text-right"
          />
        </O>
      </div>

      {!ngayTatToan && (
        <p className="mt-2 text-xs text-error">Nhập ngày tất toán để bấm được nút bên dưới.</p>
      )}

      <div className="mt-3">
        <Dialog open={moXacNhan} onOpenChange={setMoXacNhan}>
          {/* Ô ngày xoá trống ⇒ `new Date("T00:00:00")` là Invalid Date và `format()` ném
              RangeError, React unmount cả cây ⇒ SẬP TRỌN tab Dòng tiền chỉ vì một ô để trống.
              Chặn ngay ở nút mở, và câu dưới nói rõ vì sao nút mờ. */}
          <DialogTrigger
            disabled={!ngayTatToan}
            render={<Button type="button">Tất toán</Button>}
          />
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Xác nhận tất toán sổ tiết kiệm</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-ink">
              Nhận lại gốc {formatVnd(so.principal)} + lãi {formatVnd(lai)} ={" "}
              {formatVnd(so.principal + lai)}, ghi ngày{" "}
              {ngayTatToan ? format(new Date(`${ngayTatToan}T00:00:00`), "dd/MM/yyyy") : "—"}. Chỉ bấm khi đã nhận tiền từ
              ngân hàng.
            </p>
            <DialogFooter>
              <DialogClose render={<Button variant="outline">Huỷ</Button>} />
              <Button type="button" disabled={dangChay} onClick={tatToan}>
                {dangChay ? "Đang ghi…" : "Xác nhận tất toán"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Chỉ bấm khi đã nhận tiền từ ngân hàng.</p>
    </div>
  );
}
