"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { addMonths, format } from "date-fns";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { suaKhoanVay, taoKhoanVay } from "@/lib/actions/khoan-vay";
import { formatAmountInput, parseAmountInput } from "@/lib/format-amount-input";
import type { KhoanVayRow } from "@/lib/so-quy/khoan-vay-queries";

import { KhoanVayFormFields, NGAY, ngayVn, O, parseLaiSuat, type KhoanVayFormState } from "./khoan-vay-form-fields";
import { mongMuoiKeTiep } from "./khoan-vay-form-thau-chi-fields";
import { trangThaiBanDau } from "./khoan-vay-form-trang-thai-ban-dau";

/**
 * Modal Thêm/Sửa khoản vay (spec §5.3). Hai chế độ khai: khoản mới (số tiền + ngày giải ngân ⇒ action sinh đúng 1 dòng `LOAN_IN`) và khoản đã có từ trước ngày mở sổ (chỉ dư nợ mang sang, TUYỆT ĐỐI không sinh dòng tiền — tiền đó đã nằm trong số dư mở sổ).
 *
 * Chế độ khoá NGAY khi mở form Sửa: đổi "mới" → "mang sang" xoá dòng LOAN_IN — một dòng tiền THẬT — mà không hỏi câu nào. Đã ghi kỳ trả (hoặc đã trả gốc) thì khoá thêm số tiền + ngày nền vì sửa là viết lại quá khứ đã vào Lãi/Lỗ — `suaKhoanVay` chặn cả hai, ô disabled chỉ nói trước lý do. `trangThaiBanDau` tách sang file riêng.
 */

export function KhoanVayFormModal({
  open,
  onOpenChange,
  loan,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Có = chế độ sửa. */
  loan?: KhoanVayRow;
}) {
  const router = useRouter();
  const isEdit = Boolean(loan);
  const [f, setF] = useState<KhoanVayFormState>(() => trangThaiBanDau(loan));
  const [loi, setLoi] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setF(trangThaiBanDau(loan));
    setLoi({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loan?.id]);

  const laThauChi = f.cheDo === "thau-chi";
  // Gốc-cuối-kỳ chỉ có MỘT chế độ (khuôn "moi") — xem `khoan-vay-form-goc-cuoi-ky-fields.tsx`.
  const laGocCuoiKy = f.cheDo === "goc-cuoi-ky";
  // "moi" thật, thấu chi chưa rút trước ngày mở sổ, HOẶC gốc-cuối-kỳ — cả ba dùng cặp field
  // `soTienGiaiNgan`+`ngayGiaiNgan`; ngược lại dùng `duNoMoSo`+`startDate`.
  const dungCheDoMoi = f.cheDo === "moi" || laGocCuoiKy || (laThauChi && !f.thauChiTruocMoSo);
  // BULLET LUÔN có lịch (`Loan_lich_theo_loai`) — không dựa vào `f.coLich`, tránh cờ sót từ lượt trước.
  const coLichThucTe = laGocCuoiKy || f.coLich;

  // Khoản MỚI: kỳ đầu bám ngày giải ngân (+1 tháng). Thấu chi/gốc-cuối-kỳ: mùng 10 kế tiếp (khớp ca
  // thật 12/05 → 10/06). Ghi đè mỗi khi ngày rút đổi — giữ kỳ đầu cũ đẻ kỳ 1 dài bất thường = sai tiền.
  function doiNgayNen(giaTri: string, khoa: "ngayGiaiNgan" | "startDate") {
    setF((p) => {
      if (isEdit || !giaTri) return { ...p, [khoa]: giaTri };
      const ngay = new Date(`${giaTri}T00:00:00`);
      const firstDueDate =
        p.cheDo === "thau-chi" || p.cheDo === "goc-cuoi-ky"
          ? format(mongMuoiKeTiep(ngay), NGAY)
          : format(addMonths(ngay, 1), NGAY);
      return { ...p, [khoa]: giaTri, firstDueDate };
    });
  }

  /**
   * Đổi RADIO chế độ cũng phải tính lại "Ngày trả/thu kỳ đầu": thấu chi và gốc-cuối-kỳ theo mùng 10
   * kế tiếp, hai chế độ kia theo "+1 tháng". Chỉ `setF({cheDo})` mà không đụng ô ngày sẽ giữ nguyên
   * ngày "+1 tháng" — lệch hẳn lịch ngân hàng, và lãi tính theo ngày/kỳ nên lệch ngày là lệch tiền.
   */
  function doiCheDo(giaTri: KhoanVayFormState["cheDo"]) {
    setF((p) => {
      const dungMoi = giaTri === "moi" || giaTri === "goc-cuoi-ky" || (giaTri === "thau-chi" && !p.thauChiTruocMoSo);
      const nen = dungMoi ? p.ngayGiaiNgan : p.startDate;
      // Rời khỏi gốc-cuối-kỳ: xoá 3 ô riêng của nó — ô đã ẩn khỏi mắt nhưng số gõ dở (vd tiền gửi)
      // vẫn còn trong state, gửi kèm payload của loại vay KHÁC nếu không dọn ở đây.
      const b = giaTri === "goc-cuoi-ky" ? {} : { laiTheoNam: false, laiCoDinh: 0, tienGuiMoiKy: 0 };
      if (isEdit || !nen) return { ...p, ...b, cheDo: giaTri };
      const ngay = new Date(`${nen}T00:00:00`);
      if (Number.isNaN(ngay.getTime())) return { ...p, ...b, cheDo: giaTri };
      const firstDueDate =
        giaTri === "thau-chi" || giaTri === "goc-cuoi-ky"
          ? format(mongMuoiKeTiep(ngay), NGAY)
          : format(addMonths(ngay, 1), NGAY);
      return { ...p, ...b, cheDo: giaTri, firstDueDate };
    });
  }

  const ngayNen = dungCheDoMoi ? f.ngayGiaiNgan : f.startDate;
  // Ô nền khoá khi khoản đã có vết trả nợ — action từ chối y hệt, đây chỉ là lời báo trước.
  const khoaNen = Boolean(loan && (loan.lastDueHandled !== null || loan.coTraGoc));
  // Cảnh báo riêng ở ô "Ngày trả kỳ đầu" — hẹp hơn `khoaNen`, chỉ xét con dấu, không đụng `coTraGoc`.
  const daDuyetKy = Boolean(loan && loan.lastDueHandled !== null);
  const canSave =
    f.name.trim().length > 0 &&
    Boolean(ngayNen) &&
    (dungCheDoMoi ? f.soTienGiaiNgan > 0 : f.duNoMoSo > 0) &&
    // Thấu chi không có `termMonths` — vay kỳ hạn/gốc-cuối-kỳ mới đòi số kỳ > 0.
    (!coLichThucTe || (Boolean(f.firstDueDate) && (laThauChi || Number(f.termMonths) > 0))) &&
    !saving;

  async function luu() {
    setLoi({});
    const annualRateBp = parseLaiSuat(f.laiSuat);
    if (annualRateBp === null) {
      setLoi({ annualRateBp: "Lãi suất không hợp lệ (ví dụ 10.5)" });
      return;
    }
    setSaving(true);
    const input = {
      name: f.name,
      lender: f.lender,
      annualRateBp,
      kind: laThauChi ? ("OVERDRAFT" as const) : laGocCuoiKy ? ("BULLET" as const) : ("TERM" as const),
      coLich: coLichThucTe,
      // Thấu chi: `termMonths` LUÔN null (không có lịch trả gốc, xem `khoanVaySchema`).
      termMonths: laThauChi ? null : coLichThucTe ? Number(f.termMonths) : null,
      firstDueDate: coLichThucTe ? ngayVn(f.firstDueDate) : null,
      // Server từ chối nhận số này cho loại KHÁC BULLET (`superRefine`), nên chỉ gửi khi thật sự là
      // gốc-cuối-kỳ — `null` mọi trường hợp còn lại là "tính theo %/năm như cũ".
      laiCoDinhMoiKy: laGocCuoiKy && !f.laiTheoNam ? f.laiCoDinh : null,
      // Cùng luật với `laiCoDinhMoiKy`: server TỪ CHỐI số này ở loại khác BULLET. Gửi 0 cho loại
      // khác thay vì giá trị đang có trong state — ô nhập không hiện ở các loại đó, nên một số sót
      // lại (bản ghi cũ ghi thẳng DB) sẽ khoá cứng nút Lưu bằng một lỗi không ô nào sáng lên.
      tienGuiBatBuocMoiKy: laGocCuoiKy ? f.tienGuiMoiKy : 0,
      note: f.note,
      // Server chỉ biết "moi"/"mang-sang" — thấu chi ánh xạ theo công tắc "Đã rút trước ngày mở sổ".
      cheDo: dungCheDoMoi ? ("moi" as const) : ("mang-sang" as const),
      ...(dungCheDoMoi
        ? { soTienGiaiNgan: f.soTienGiaiNgan, ngayGiaiNgan: ngayVn(f.ngayGiaiNgan) }
        : { duNoMoSo: f.duNoMoSo, startDate: ngayVn(f.startDate) }),
    };
    try {
      const res = loan ? await suaKhoanVay(loan.id, input) : await taoKhoanVay(input);
      if (!res.ok) {
        if (res.field) setLoi({ [res.field]: res.error });
        else toast.error(res.error);
        return;
      }
      toast.success(isEdit ? "Đã cập nhật khoản vay" : `Đã thêm khoản vay ${f.name}`);
      onOpenChange(false);
      router.refresh();
    } catch {
      toast.error("Lưu thất bại — kiểm tra kết nối");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Sửa khoản vay" : "Thêm khoản vay"}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <O label="Tên khoản vay" error={loi.name}>
            <Input value={f.name} maxLength={60} onChange={(e) => setF((p) => ({ ...p, name: e.target.value }))} />
          </O>
          <O label="Ngân hàng / người cho vay" error={loi.lender}>
            <Input value={f.lender} maxLength={60} onChange={(e) => setF((p) => ({ ...p, lender: e.target.value }))} />
          </O>

          <KhoanVayFormFields
            f={f}
            setF={setF}
            loi={loi}
            khoaNen={khoaNen}
            khoaCheDo={isEdit}
            daDuyetKy={daDuyetKy}
            ngayNen={ngayNen}
            doiCheDo={doiCheDo}
            doiNgayNen={doiNgayNen}
            doiTien={(khoa, raw) => setF((p) => ({ ...p, [khoa]: parseAmountInput(raw) }))}
            hienTien={formatAmountInput}
          />
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Hủy
          </Button>
          <Button type="button" disabled={!canSave} onClick={luu}>
            {saving ? "Đang lưu…" : "Lưu"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
