"use client";

import { addMonths } from "date-fns";

import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

import { DOI_NGAY_KY_DAU_HINT, KHOA_CHE_DO_HINT, O, type KhoanVayFormState } from "./khoan-vay-form-fields";

/**
 * Nhánh THẤU CHI của form khoản vay — tách khỏi `khoan-vay-form-fields.tsx` để file kia dưới 200
 * dòng (spec thấu chi §6). Khác vay kỳ hạn ở hai chỗ: KHÔNG có "Kỳ hạn", và lịch chỉ thu LÃI (gốc
 * trả trọn lúc tất toán — hộp riêng `thau-chi-tat-toan-dialog.tsx`).
 *
 * Số tiền/ngày rút dùng LẠI đúng hai cặp field `soTienGiaiNgan`+`ngayGiaiNgan` (chưa mở sổ trước đó)
 * / `duNoMoSo`+`startDate` (đã rút từ trước ngày mở sổ) — cùng field server nhận cho `cheDo`
 * "moi"/"mang-sang", chỉ đổi NHÃN hiển thị theo công tắc `thauChiTruocMoSo`. Tách field riêng cho
 * thấu chi sẽ phải dạy action thêm một cặp tên, trong khi ý nghĩa dòng tiền giống hệt.
 */

/** Mùng 10 kế tiếp sau ngày rút: ngày rút < 10 ⇒ mùng 10 cùng tháng; ngược lại mùng 10 tháng sau. */
export function mongMuoiKeTiep(ngayRut: Date): Date {
  const thang = ngayRut.getDate() < 10 ? ngayRut : addMonths(ngayRut, 1);
  return new Date(thang.getFullYear(), thang.getMonth(), 10);
}

type Props = {
  f: KhoanVayFormState;
  setF: React.Dispatch<React.SetStateAction<KhoanVayFormState>>;
  loi: Record<string, string>;
  khoa: { disabled?: boolean; title?: string };
  /** Công tắc "Đã rút trước ngày mở sổ" CHÍNH LÀ chế độ (`moi` / `mang-sang`) mà server khoá vĩnh
   *  viễn sau khi tạo — khoá nó cùng luật với nhóm radio, không để lượt Sửa thành ngõ cụt. */
  khoaCheDo: boolean;
  ngayToiDa: string;
  doiNgayNen: (giaTri: string, khoa: "ngayGiaiNgan" | "startDate") => void;
  doiTien: (khoa: "soTienGiaiNgan" | "duNoMoSo", raw: string) => void;
  hienTien: (n: number) => string;
  /** Số kỳ lãi đã tới hạn nếu lưu ngay bây giờ — tính sẵn ở component cha (dùng chung công thức). */
  soKyCho: number;
  /** Đã duyệt ít nhất 1 kỳ — ưu tiên cảnh báo này thay vì câu "sẽ có N kỳ chờ duyệt". */
  daDuyetKy: boolean;
  /** Cảnh báo D0 (tính sẵn ở component cha) — chỉ có nghĩa ở nhánh CHƯA rút trước mở sổ (cặp
   *  `ngayGiaiNgan` đang dùng), nhánh `thauChiTruocMoSo` (`startDate`) không đọc field này. */
  canhBaoD0?: React.ReactNode;
};

export function KhoanVayFormThauChiFields({
  f,
  setF,
  loi,
  khoa,
  khoaCheDo,
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
      <div className="flex flex-col gap-1" title={khoaCheDo ? KHOA_CHE_DO_HINT : undefined}>
        <label className="flex items-center gap-2 text-sm text-ink">
          <Switch
            disabled={khoaCheDo}
            checked={f.thauChiTruocMoSo}
            onCheckedChange={(v) => setF((p) => ({ ...p, thauChiTruocMoSo: v }))}
          />
          Đã rút trước ngày mở sổ
        </label>
        {f.thauChiTruocMoSo && (
          <p className="text-xs text-muted-foreground">
            tiền này đã nằm trong số dư nhập quỹ, app không cộng thêm
          </p>
        )}
      </div>

      {f.thauChiTruocMoSo ? (
        <>
          <O label="Dư nợ thấu chi lúc mở sổ" error={loi.duNoMoSo}>
            <Input
              inputMode="numeric"
              {...khoa}
              value={hienTien(f.duNoMoSo)}
              onChange={(e) => doiTien("duNoMoSo", e.target.value)}
              placeholder="0"
              className="text-right"
            />
          </O>
          <O
            label="Ngày rút (để tính lãi)"
            error={loi.startDate}
            hint="app tính lãi TỪ ngày này — ngân hàng đã thu lãi tới đâu thì khai tới đó (thường là ngày mở sổ), đừng khai ngày rút thật nếu lãi cũ đã trả"
          >
            <Input
              type="date"
              max={ngayToiDa}
              {...khoa}
              value={f.startDate}
              onChange={(e) => doiNgayNen(e.target.value, "startDate")}
            />
          </O>
        </>
      ) : (
        <>
          <O label="Số tiền rút thấu chi" error={loi.soTienGiaiNgan}>
            <Input
              inputMode="numeric"
              {...khoa}
              value={hienTien(f.soTienGiaiNgan)}
              onChange={(e) => doiTien("soTienGiaiNgan", e.target.value)}
              placeholder="0"
              className="text-right"
            />
          </O>
          <O label="Ngày rút" error={loi.ngayGiaiNgan}>
            <Input
              type="date"
              max={ngayToiDa}
              {...khoa}
              value={f.ngayGiaiNgan}
              onChange={(e) => doiNgayNen(e.target.value, "ngayGiaiNgan")}
            />
          </O>
          {canhBaoD0}
        </>
      )}

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

      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-2 text-sm text-ink">
          <Switch checked={f.coLich} onCheckedChange={(v) => setF((p) => ({ ...p, coLich: v }))} />
          Ngân hàng thu lãi hàng tháng
        </label>
        {!f.coLich && <p className="text-xs text-muted-foreground">Chỉ thu lãi lúc tất toán</p>}
      </div>

      {f.coLich && (
        <O
          label="Ngày thu lãi kỳ đầu"
          error={loi.firstDueDate}
          hint={
            daDuyetKy
              ? `${DOI_NGAY_KY_DAU_HINT}.`
              : soKyCho > 0
                ? `Sẽ có ${soKyCho} kỳ lãi chờ duyệt.`
                : undefined
          }
        >
          <Input
            type="date"
            value={f.firstDueDate}
            onChange={(e) => setF((p) => ({ ...p, firstDueDate: e.target.value }))}
          />
        </O>
      )}
    </>
  );
}
