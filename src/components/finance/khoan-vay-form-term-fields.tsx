"use client";

import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

import { DOI_NGAY_KY_DAU_HINT, O, type KhoanVayFormState } from "./khoan-vay-form-fields";

/**
 * Nhánh VAY KỲ HẠN (chế độ "moi"/"mang-sang") của form khoản vay — tách khỏi
 * `khoan-vay-form-fields.tsx` cùng lý do có `khoan-vay-form-thau-chi-fields.tsx`: giữ file cha dưới
 * 200 dòng. Đây là ruột form CŨ, chuyển nguyên xi (không đổi hành vi) khi thêm chế độ Thấu chi.
 */

type Props = {
  f: KhoanVayFormState;
  setF: React.Dispatch<React.SetStateAction<KhoanVayFormState>>;
  loi: Record<string, string>;
  khoa: { disabled?: boolean; title?: string };
  ngayToiDa: string;
  doiNgayNen: (giaTri: string, khoa: "ngayGiaiNgan" | "startDate") => void;
  doiTien: (khoa: "soTienGiaiNgan" | "duNoMoSo", raw: string) => void;
  hienTien: (n: number) => string;
  soKyCho: number;
  /** Đã duyệt ít nhất 1 kỳ — ưu tiên cảnh báo này thay vì câu "sẽ có N kỳ chờ duyệt". */
  daDuyetKy: boolean;
};

export function KhoanVayFormTermFields({
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
}: Props) {
  return (
    <>
      {f.cheDo === "moi" ? (
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
            {/* `max` = hôm nay: server chặn cứng ngày tương lai, đừng để chủ shop biết điều đó SAU
                khi điền hết form. Ô "Ngày trả kỳ đầu" KHÔNG max — kỳ đầu ở tương lai là bình thường. */}
            <Input
              type="date"
              max={ngayToiDa}
              {...khoa}
              value={f.ngayGiaiNgan}
              onChange={(e) => doiNgayNen(e.target.value, "ngayGiaiNgan")}
            />
          </O>
        </>
      ) : (
        <>
          <O label="Dư nợ còn lại" error={loi.duNoMoSo}>
            <Input
              inputMode="numeric"
              {...khoa}
              value={hienTien(f.duNoMoSo)}
              onChange={(e) => doiTien("duNoMoSo", e.target.value)}
              placeholder="0"
              className="text-right"
            />
          </O>
          <O label="Tính từ ngày" error={loi.startDate}>
            <Input
              type="date"
              max={ngayToiDa}
              {...khoa}
              value={f.startDate}
              onChange={(e) => doiNgayNen(e.target.value, "startDate")}
            />
          </O>
        </>
      )}

      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-2 text-sm text-ink">
          <Switch checked={f.coLich} onCheckedChange={(v) => setF((p) => ({ ...p, coLich: v }))} />
          Trả theo lịch hàng tháng
        </label>
        {!f.coLich && (
          <p className="text-xs text-muted-foreground">
            Không lịch = vay người thân, khi nào có thì trả; app không nhắc kỳ.
          </p>
        )}
      </div>

      {f.coLich && (
        <>
          <O
            label="Lãi %/năm"
            error={loi.annualRateBp}
            hint={
              f.laiSuat.trim() === "" ? "Để trống = 0%/năm, app sẽ không đề xuất tiền lãi" : undefined
            }
          >
            <Input
              inputMode="decimal"
              placeholder="10.5"
              value={f.laiSuat}
              onChange={(e) => setF((p) => ({ ...p, laiSuat: e.target.value }))}
            />
          </O>
          <O label="Kỳ hạn (số kỳ còn lại)" error={loi.termMonths}>
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
                ? `${DOI_NGAY_KY_DAU_HINT}.`
                : soKyCho > 0
                  ? `Sẽ có ${soKyCho} kỳ chờ duyệt — duyệt lần lượt từng kỳ.`
                  : undefined
            }
          >
            <Input
              type="date"
              value={f.firstDueDate}
              onChange={(e) => setF((p) => ({ ...p, firstDueDate: e.target.value }))}
            />
          </O>
        </>
      )}
    </>
  );
}
