"use client";

import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

import { DOI_NGAY_KY_DAU_HINT, O, type KhoanVayFormState } from "./khoan-vay-form-fields";

/**
 * Nhánh VAY TRẢ GỐC CUỐI KỲ (`cheDo === "goc-cuoi-ky"`, `LoanKind.BULLET`) — tách khỏi
 * `khoan-vay-form-fields.tsx` cùng lý do có `khoan-vay-form-thau-chi-fields.tsx`: giữ file cha dưới
 * 200 dòng. Khác vay kỳ hạn ở ba chỗ: LUÔN có lịch (không có công tắc "Trả theo lịch hàng tháng" —
 * `Loan_lich_theo_loai` đòi đủ kỳ hạn + ngày trả kỳ đầu cho BULLET), lãi mặc định khai CỐ ĐỊNH theo
 * số tiền hợp đồng (đổi sang %/năm bằng công tắc), và kèm khoản tiền gửi tiết kiệm bắt buộc mỗi kỳ.
 *
 * CHỈ hỗ trợ chế độ "khoản mới" (số tiền + ngày giải ngân) — chưa có ca thật nào cần khai một khoản
 * gốc-cuối-kỳ đã vay từ trước ngày mở sổ; thêm chế độ "mang sang" cho loại này khi có nhu cầu thật.
 */

type Props = {
  f: KhoanVayFormState;
  setF: React.Dispatch<React.SetStateAction<KhoanVayFormState>>;
  loi: Record<string, string>;
  khoa: { disabled?: boolean; title?: string };
  ngayToiDa: string;
  doiNgayNen: (giaTri: string, khoa: "ngayGiaiNgan" | "startDate") => void;
  doiTien: (khoa: "soTienGiaiNgan" | "duNoMoSo" | "laiCoDinh" | "tienGuiMoiKy", raw: string) => void;
  hienTien: (n: number) => string;
  /** Số kỳ lãi đã tới hạn nếu lưu ngay bây giờ — tính sẵn ở component cha (dùng chung công thức). */
  soKyCho: number;
  /** Đã duyệt ít nhất 1 kỳ — ưu tiên cảnh báo này thay vì câu "sẽ có N kỳ chờ duyệt". */
  daDuyetKy: boolean;
  /** Cảnh báo D0 (tính sẵn ở component cha) — gốc-cuối-kỳ LUÔN dùng cặp `ngayGiaiNgan`, không có
   *  nhánh "mang-sang" như hai loại kia (xem chú thích đầu file). */
  canhBaoD0?: React.ReactNode;
};

export function KhoanVayFormGocCuoiKyFields({
  f,
  setF,
  loi,
  khoa,
  ngayToiDa,
  doiNgayNen,
  doiTien,
  hienTien,
  soKyCho,
  daDuyetKy,
  canhBaoD0,
}: Props) {
  return (
    <>
      <O label="Số tiền giải ngân" error={loi.soTienGiaiNgan}>
        <Input
          inputMode="numeric"
          {...khoa}
          value={hienTien(f.soTienGiaiNgan)}
          onChange={(e) => doiTien("soTienGiaiNgan", e.target.value)}
          placeholder="0"
          className="text-right"
        />
      </O>
      <O label="Ngày giải ngân" error={loi.ngayGiaiNgan}>
        <Input
          type="date"
          max={ngayToiDa}
          {...khoa}
          value={f.ngayGiaiNgan}
          onChange={(e) => doiNgayNen(e.target.value, "ngayGiaiNgan")}
        />
      </O>
      {canhBaoD0}

      <O label="Kỳ hạn (số kỳ)" error={loi.termMonths}>
        <Input
          inputMode="numeric"
          value={f.termMonths}
          onChange={(e) => setF((p) => ({ ...p, termMonths: e.target.value.replace(/\D/g, "") }))}
        />
      </O>
      <O
        label="Ngày trả kỳ đầu"
        error={loi.firstDueDate}
        hint={
          daDuyetKy
            ? `${DOI_NGAY_KY_DAU_HINT} + tiền gửi.`
            : soKyCho > 0
              ? `Sẽ có ${soKyCho} kỳ chờ duyệt — duyệt lần lượt từng kỳ.`
              : "Kỳ 1…n−1 chỉ trả lãi; toàn bộ gốc dồn vào kỳ cuối."
        }
      >
        <Input
          type="date"
          value={f.firstDueDate}
          onChange={(e) => setF((p) => ({ ...p, firstDueDate: e.target.value }))}
        />
      </O>

      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-2 text-sm text-ink">
          <Switch checked={f.laiTheoNam} onCheckedChange={(v) => setF((p) => ({ ...p, laiTheoNam: v }))} />
          Tính theo lãi suất %/năm
        </label>
        <p className="text-xs text-muted-foreground">
          {f.laiTheoNam
            ? "App tự tính lãi mỗi kỳ theo dư nợ đầu kỳ × %/năm — có thể lệch vài chục nghìn so với ngân hàng."
            : "Mặc định: khai đúng số tiền ngân hàng thu mỗi kỳ, app không tính lại."}
        </p>
      </div>

      {f.laiTheoNam ? (
        <O
          label="Lãi %/năm"
          error={loi.annualRateBp}
          hint={f.laiSuat.trim() === "" ? "Để trống = 0%/năm" : undefined}
        >
          <Input
            inputMode="decimal"
            placeholder="10.5"
            value={f.laiSuat}
            onChange={(e) => setF((p) => ({ ...p, laiSuat: e.target.value }))}
          />
        </O>
      ) : (
        <O label="Lãi cố định mỗi kỳ" error={loi.laiCoDinhMoiKy}>
          <Input
            inputMode="numeric"
            value={hienTien(f.laiCoDinh)}
            onChange={(e) => doiTien("laiCoDinh", e.target.value)}
            placeholder="0"
            className="text-right"
          />
        </O>
      )}

      <O
        label="Tiền gửi tiết kiệm bắt buộc mỗi kỳ"
        error={loi.tienGuiBatBuocMoiKy}
        hint="tiền của anh, ngân hàng giữ hộ — không tính vào Lãi/Lỗ, hoàn lại thành một dòng thu riêng lúc tất toán (không cấn trừ vào Gốc)"
      >
        <Input
          inputMode="numeric"
          value={hienTien(f.tienGuiMoiKy)}
          onChange={(e) => doiTien("tienGuiMoiKy", e.target.value)}
          placeholder="0"
          className="text-right"
        />
      </O>
    </>
  );
}
