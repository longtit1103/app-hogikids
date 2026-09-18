"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { addMonths, format } from "date-fns";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { suaSoTietKiem, taoSoTietKiem } from "@/lib/actions/so-tiet-kiem";
import { formatAmountInput, parseAmountInput } from "@/lib/format-amount-input";
import type { KhoanVayRow } from "@/lib/so-quy/khoan-vay-queries";
import type { SoTietKiemRow } from "@/lib/tiet-kiem/so-tiet-kiem-queries";

import { NGAY, ngayVn, O, parseLaiSuat } from "./khoan-vay-form-fields";

/**
 * Modal Thêm/Sửa sổ tiết kiệm (spec mục 11). Khác `khoan-vay-form-modal.tsx`: KHÔNG có radio chế độ
 * (sổ tiết kiệm chỉ một luồng tạo — hồ sơ + dòng gửi cùng lúc, spec §7.1) nên gộp một file, không tách
 * `-fields.tsx` riêng như khoản vay.
 *
 * Sửa `principal`/`startDate` của sổ ĐANG GỬI kéo theo sửa dòng `SAVINGS_OUT` (spec §7.3) — quỹ các
 * tháng đã qua đổi theo vì quỹ là HÀM của dòng tiền, không snapshot. Nhịp xác nhận hai lượt bấm giống
 * `cash-movement-form-modal.tsx` (`hoiTruocD0`): lượt Lưu đầu tiên chỉ hiện cảnh báo, lượt thứ hai mới
 * thật sự gửi — tránh `window.confirm` (bị trình duyệt chặn/nuốt, không dịch được câu tiếng Việt).
 */

type SoTietKiemFormState = {
  name: string;
  bank: string;
  principal: number;
  startDate: string;
  termMonths: string;
  maturityDate: string;
  laiSuat: string;
  loanId: string;
  note: string;
};

/** Auto-fill NGÀY ĐÁO HẠN = ngày gửi + kỳ hạn (spec §5.1) — rỗng khi input chưa đủ để tính, không bịa
 *  ngày. Export riêng để kiểm bằng số literal (`tests/so-tiet-kiem-form-modal-ngay-dao-han.test.ts`). */
export function ngayDaoHanMacDinh(startDate: string, termMonths: string): string {
  if (!startDate || !termMonths) return "";
  const soKy = Number(termMonths);
  if (!Number.isFinite(soKy) || soKy < 1) return "";
  const ngay = new Date(`${startDate}T00:00:00`);
  if (Number.isNaN(ngay.getTime())) return "";
  return format(addMonths(ngay, soKy), NGAY);
}

function trangThaiBanDau(so: SoTietKiemRow | undefined): SoTietKiemFormState {
  if (so) {
    return {
      name: so.name,
      bank: so.bank,
      principal: so.principal,
      startDate: format(so.startDate, NGAY),
      termMonths: String(so.termMonths),
      maturityDate: format(so.maturityDate, NGAY),
      laiSuat: so.annualRateBp ? (so.annualRateBp / 100).toLocaleString("vi-VN") : "",
      loanId: so.loan?.id ?? "",
      note: so.note,
    };
  }
  return {
    name: "",
    bank: "",
    principal: 0,
    startDate: format(new Date(), NGAY),
    termMonths: "",
    maturityDate: "",
    laiSuat: "",
    loanId: "",
    note: "",
  };
}

export function SoTietKiemFormModal({
  open,
  onOpenChange,
  so,
  loans,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Có = chế độ sửa. */
  so?: SoTietKiemRow;
  /** Khoản vay nguồn (tuỳ chọn, spec §6.3) — CHỈ hiện khoản chưa tất toán, trừ khoản sổ đang gắn. */
  loans: KhoanVayRow[];
}) {
  const router = useRouter();
  const isEdit = Boolean(so);
  const [f, setF] = useState<SoTietKiemFormState>(() => trangThaiBanDau(so));
  // Sổ MỚI: ngày đáo hạn tự điền theo ngày gửi + kỳ hạn cho tới khi chủ shop tự gõ vào ô đó (cờ này
  // bật). Sổ SỬA: giữ ngày đã lưu, KHÔNG auto-fill đè lên số ngân hàng đã chốt thật — coi như đã
  // "chạm" ngay từ đầu.
  const [maturityTouched, setMaturityTouched] = useState(isEdit);
  const [loi, setLoi] = useState<Record<string, string>>({});
  const [xacNhanDoiTien, setXacNhanDoiTien] = useState(false);
  const [saving, setSaving] = useState(false);

  function moLai(o: boolean) {
    if (o) {
      setF(trangThaiBanDau(so));
      setMaturityTouched(isEdit);
      setLoi({});
      setXacNhanDoiTien(false);
    }
    onOpenChange(o);
  }

  /** Đổi ngày gửi/kỳ hạn: tính lại ngày đáo hạn đề xuất — CHỈ khi chủ shop chưa tự sửa ô đó
   *  (`maturityTouched` false), tránh ghi đè ngày họ vừa gõ tay theo giấy ngân hàng thật. */
  function doiNen(khoa: "startDate" | "termMonths", giaTri: string) {
    setF((p) => {
      const next = { ...p, [khoa]: giaTri };
      if (!maturityTouched) {
        const mac = ngayDaoHanMacDinh(next.startDate, next.termMonths);
        if (mac) next.maturityDate = mac;
      }
      return next;
    });
  }

  const loansConHieuLuc = loans.filter((l) => l.closedAt === null || l.id === f.loanId);
  const doiNenTang =
    isEdit && so !== undefined && (f.principal !== so.principal || f.startDate !== format(so.startDate, NGAY));
  const canSave =
    f.name.trim().length > 0 &&
    f.principal > 0 &&
    Boolean(f.startDate) &&
    Number(f.termMonths) >= 1 &&
    Boolean(f.maturityDate) &&
    parseLaiSuat(f.laiSuat) !== null &&
    !saving;

  async function luu() {
    setLoi({});
    const annualRateBp = parseLaiSuat(f.laiSuat);
    if (annualRateBp === null) {
      setLoi({ annualRateBp: "Lãi suất không hợp lệ (ví dụ 5,2)" });
      return;
    }
    if (doiNenTang && !xacNhanDoiTien) {
      setXacNhanDoiTien(true);
      return;
    }
    setSaving(true);
    const input = {
      ...(so ? { id: so.id } : {}),
      name: f.name,
      bank: f.bank,
      principal: f.principal,
      startDate: ngayVn(f.startDate),
      termMonths: Number(f.termMonths),
      maturityDate: ngayVn(f.maturityDate),
      annualRateBp,
      // "" ⇒ null: schema dùng z.string().cuid() cho loanId — gửi "" làm nó từ chối dù ý là "không chọn".
      loanId: f.loanId || null,
      note: f.note,
    };
    try {
      const res = so ? await suaSoTietKiem(input) : await taoSoTietKiem(input);
      if (!res.ok) {
        if (res.field) setLoi({ [res.field]: res.error });
        else toast.error(res.error);
        return;
      }
      toast.success(isEdit ? "Đã cập nhật sổ tiết kiệm" : `Đã thêm sổ tiết kiệm ${f.name}`);
      moLai(false);
      router.refresh();
    } catch {
      toast.error("Lưu thất bại — kiểm tra kết nối");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={moLai}>
      <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Sửa sổ tiết kiệm" : "Thêm sổ tiết kiệm"}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <O label="Tên sổ" error={loi.name}>
            <Input value={f.name} maxLength={60} onChange={(e) => setF((p) => ({ ...p, name: e.target.value }))} />
          </O>
          <O label="Ngân hàng" error={loi.bank}>
            <Input value={f.bank} maxLength={60} onChange={(e) => setF((p) => ({ ...p, bank: e.target.value }))} />
          </O>
          <O label="Số tiền gửi" error={loi.principal}>
            <Input
              inputMode="numeric"
              value={formatAmountInput(f.principal)}
              onChange={(e) => setF((p) => ({ ...p, principal: parseAmountInput(e.target.value) }))}
              placeholder="0"
              className="text-right"
            />
          </O>
          <O label="Ngày gửi" error={loi.startDate}>
            <Input
              type="date"
              max={format(new Date(), NGAY)}
              value={f.startDate}
              onChange={(e) => doiNen("startDate", e.target.value)}
            />
          </O>
          <O label="Kỳ hạn (tháng)" error={loi.termMonths}>
            <Input
              inputMode="numeric"
              value={f.termMonths}
              onChange={(e) => doiNen("termMonths", e.target.value.replace(/\D/g, ""))}
            />
          </O>
          <O
            label="Ngày đáo hạn"
            error={loi.maturityDate}
            hint="tự điền từ ngày gửi + kỳ hạn — sửa được nếu ngân hàng chốt ngày khác"
          >
            <Input
              type="date"
              value={f.maturityDate}
              onChange={(e) => {
                setMaturityTouched(true);
                setF((p) => ({ ...p, maturityDate: e.target.value }));
              }}
            />
          </O>
          <O
            label="Lãi %/năm"
            error={loi.annualRateBp}
            hint={f.laiSuat.trim() === "" ? "Để trống = 0%/năm" : undefined}
          >
            <Input
              inputMode="decimal"
              placeholder="5.2"
              value={f.laiSuat}
              onChange={(e) => setF((p) => ({ ...p, laiSuat: e.target.value }))}
            />
          </O>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Khoản vay nguồn (tuỳ chọn)</label>
            <Select
              value={f.loanId || "khong"}
              onValueChange={(v) => setF((p) => ({ ...p, loanId: v === "khong" ? "" : String(v) }))}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Không chọn" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="khong">— Không chọn —</SelectItem>
                {loansConHieuLuc.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              chỉ để so lãi vay-để-gửi, KHÔNG mang tiền — bỏ trống nếu tiền gửi không phải tiền vay
            </p>
            {loi.loanId && <p className="text-xs text-error">{loi.loanId}</p>}
          </div>

          <O label="Ghi chú" error={loi.note}>
            <textarea
              value={f.note}
              maxLength={500}
              rows={3}
              onChange={(e) => setF((p) => ({ ...p, note: e.target.value }))}
              className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </O>

          {xacNhanDoiTien && (
            <p className="rounded-lg bg-amber-50 px-2 py-1.5 text-xs text-amber-700">
              Đổi số tiền hoặc ngày gửi làm số dư quỹ các tháng đã qua đổi theo (quỹ tính lại từ dòng
              tiền, không snapshot). Bấm Lưu lần nữa để xác nhận.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => moLai(false)}>
            Hủy
          </Button>
          <Button type="button" disabled={!canSave} onClick={luu}>
            {saving ? "Đang lưu…" : xacNhanDoiTien ? "Xác nhận lưu" : "Lưu"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
