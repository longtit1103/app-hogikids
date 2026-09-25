"use client";

import { format } from "date-fns";

import { Input } from "@/components/ui/input";
import { soKyChoTheoLich } from "@/lib/so-quy/lich-tra-no";
import { ngayTruocMoSo } from "@/lib/so-quy/ngay-truoc-mo-so";

import { KhoanVayFormGocCuoiKyFields } from "./khoan-vay-form-goc-cuoi-ky-fields";
import { KhoanVayFormTermFields } from "./khoan-vay-form-term-fields";
import { KhoanVayFormThauChiFields } from "./khoan-vay-form-thau-chi-fields";

/** Ruột form khoản vay — tách khỏi `khoan-vay-form-modal.tsx` cho cả hai file dưới 200 dòng. Thuần hiển thị; MỌI luật tiền (trần 2 tỷ, dư nợ, lịch kỳ) vẫn ở action. */

export const NGAY = "yyyy-MM-dd";

/** Neo +07:00 như mọi form ghi tay khác — server parse cùng một cách với Expense/CashMovement. */
export function ngayVn(s: string): Date {
  return new Date(`${s}T00:00:00+07:00`);
}

/** Ô date đang gõ dở ⇒ `Invalid Date`; mọi phép so với nó ra `false`, đếm kỳ sẽ ra số bịa. */
function ngayHopLe(s: string): boolean {
  return s !== "" && !Number.isNaN(ngayVn(s).getTime());
}

/** Lãi %/năm → basis point (10,5% = 1050); nhận cả "," lẫn ".". `null` = gõ sai (vd "10,5%"), caller
 *  PHẢI báo lỗi tại ô — trả 0 im lặng là khoản vay lãi 0%, mỗi kỳ đề xuất lãi 0 mà không ai thấy sai. */
export function parseLaiSuat(raw: string): number | null {
  const s = raw.trim().replace(",", ".");
  if (s === "") return 0;
  const so = Number(s);
  return Number.isFinite(so) ? Math.round(so * 100) : null;
}

/**
 * Cặp field "ngày nền" đang dùng: TRUE ⇒ `soTienGiaiNgan`+`ngayGiaiNgan` (chế độ mới thật, thấu chi
 * CHƯA rút trước ngày mở sổ, hoặc gốc-cuối-kỳ — cả ba LUÔN sinh đúng 1 dòng `LOAN_IN`); FALSE ⇒
 * `duNoMoSo`+`startDate` (mang sang / thấu chi đã rút trước mở sổ — KHÔNG sinh dòng tiền, nên
 * `startDate` trước D0 là BÌNH THƯỜNG). Export dùng CHUNG giữa `khoan-vay-form-modal.tsx` (gate hỏi
 * lại khi ghi trước D0) và file này (đặt đúng cảnh báo cạnh ô ngày) — hai nơi tính khác nhau là
 * modal hỏi một đằng, cảnh báo hiện một nẻo.
 */
export function dungCapGiaiNgan(cheDo: KhoanVayFormState["cheDo"], thauChiTruocMoSo: boolean): boolean {
  return cheDo === "moi" || cheDo === "goc-cuoi-ky" || (cheDo === "thau-chi" && !thauChiTruocMoSo);
}

export type KhoanVayFormState = {
  name: string;
  lender: string;
  cheDo: "moi" | "mang-sang" | "thau-chi" | "goc-cuoi-ky";
  soTienGiaiNgan: number;
  ngayGiaiNgan: string;
  duNoMoSo: number;
  startDate: string;
  /** `cheDo === "thau-chi"`: đã rút TRƯỚC ngày mở sổ ⇒ dùng cặp `duNoMoSo`+`startDate` thay vì `soTienGiaiNgan`+`ngayGiaiNgan`. */
  thauChiTruocMoSo: boolean;
  /** TERM/OVERDRAFT. `cheDo === "goc-cuoi-ky"` KHÔNG dùng cờ này — BULLET LUÔN có lịch. */
  coLich: boolean;
  laiSuat: string; // chuỗi thô người dùng gõ (vd "10,5") — đổi sang basis point lúc gửi
  termMonths: string;
  firstDueDate: string;
  note: string;
  /** `cheDo === "goc-cuoi-ky"`: dùng lãi suất %/năm thay vì số cố định trên giấy ngân hàng. Mặc
   *  định false — khai đúng số ngân hàng thu, app không tính lại từ %/năm. */
  laiTheoNam: boolean;
  /** Lãi CỐ ĐỊNH mỗi kỳ (chỉ áp dụng khi `laiTheoNam === false`) — `Loan.laiCoDinhMoiKy`. */
  laiCoDinh: number;
  /** Tiền gửi tiết kiệm bắt buộc mỗi kỳ — DÒNG TIỀN thuần, không phải chi phí; mọi loại vay dùng
   *  chung field này (`Loan.tienGuiBatBuocMoiKy`), nhưng hiện chỉ có form gốc-cuối-kỳ cho khai. */
  tienGuiMoiKy: number;
};

/** Nhãn BỌC lấy ô nhập (không phải nhãn rời): bấm chữ là vào ô, e2e neo được bằng `getByLabel`. */
export function O({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        {label}
        {children}
      </label>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p className="text-xs text-error">{error}</p>}
    </div>
  );
}

/** ĐÚNG phạm vi bị khoá: tên / ngân hàng / lãi suất / kỳ hạn / ngày trả kỳ đầu / ghi chú vẫn sửa được. */
const KHOA_NEN_HINT = "Đã ghi kỳ trả — không sửa được ngày/số tiền giải ngân";
/** Dùng chung với công tắc "Đã rút trước ngày mở sổ" — công tắc đó CŨNG là một cách khai chế độ. */
export const KHOA_CHE_DO_HINT = "Không đổi chế độ sau khi tạo";
/** `deXuatKy` kẹp mốc kỳ bằng con dấu `lastDueHandled` (lich-tra-no.ts) — đổi "Ngày trả kỳ đầu" SAU khi đã duyệt kỳ có thể làm chính kỳ đó bị đề xuất lại. */
export const DOI_NGAY_KY_DAU_HINT =
  "Đã duyệt ít nhất 1 kỳ — đổi ngày này có thể làm kỳ đã duyệt bị đề xuất lại, ghi đôi lãi";
const CHE_DO = [
  ["moi", "Khoản vay mới"],
  ["mang-sang", "Khoản vay đã có từ trước ngày mở sổ"],
  ["thau-chi", "Thấu chi (lãi tính theo ngày)"],
  ["goc-cuoi-ky", "Vay trả gốc cuối kỳ (lãi cố định hàng tháng)"],
] as const;

type Props = {
  f: KhoanVayFormState;
  setF: React.Dispatch<React.SetStateAction<KhoanVayFormState>>;
  loi: Record<string, string>;
  /** Khoản đã có vết trả nợ ⇒ khoá phần nền (số tiền, ngày). */
  khoaNen: boolean;
  /** Chế độ (mới / mang sang) khoá VĨNH VIỄN sau khi tạo: đổi "mới" → "mang sang" xoá dòng LOAN_IN
   *  — một dòng tiền THẬT — mà không hỏi lại câu nào. `suaKhoanVay` cũng từ chối. */
  khoaCheDo: boolean;
  /** `loan.lastDueHandled !== null` — bật cảnh báo ở ô "Ngày trả kỳ đầu". */
  daDuyetKy: boolean;
  ngayNen: string;
  /** Đổi radio chế độ — KHÔNG phải `setF` trần: thấu chi có luật prefill ngày thu lãi riêng. */
  doiCheDo: (giaTri: KhoanVayFormState["cheDo"]) => void;
  doiNgayNen: (giaTri: string, khoa: "ngayGiaiNgan" | "startDate") => void;
  doiTien: (khoa: "soTienGiaiNgan" | "duNoMoSo" | "laiCoDinh" | "tienGuiMoiKy", raw: string) => void;
  hienTien: (n: number) => string;
  /** Ngày mở sổ quỹ (`soQuy.d0`); null = chưa mở sổ. */
  d0: Date | null;
  /** Đã bấm Lưu một lần trên ngày giải ngân sớm hơn D0 (state `hoiTruocD0` ở modal) — cùng với `d0`
   *  quyết định có in cảnh báo amber ngay dưới ô Ngày giải ngân/Ngày rút hay không. */
  hoiTruocD0: boolean;
};

export function KhoanVayFormFields({ f, setF, loi, khoaNen, khoaCheDo, daDuyetKy, ngayNen, doiCheDo, doiNgayNen, doiTien, hienTien, d0, hoiTruocD0 }: Props) {
  const homNay = new Date();
  const ngayToiDa = format(homNay, NGAY);
  // Một chỗ khai "ô nền bị khoá" cho cả 4 ô — chép `disabled`/`title` bốn lần là để chúng lệch nhau.
  const khoa = khoaNen ? { disabled: true, title: KHOA_NEN_HINT } : {};
  const thauChi = f.cheDo === "thau-chi";
  const gocCuoiKy = f.cheDo === "goc-cuoi-ky";
  // Chỉ hiện SAU lượt bấm Lưu đầu (khuôn `cash-movement-form-modal.tsx`) — không proactive ngay lúc
  // gõ ngày, tránh doạ chủ shop trước khi họ bấm Lưu. Đặt cạnh ĐÚNG ô ngày đang dùng làm "ngày nền"
  // (`dungCapGiaiNgan`) — modal đã đảm bảo `hoiTruocD0` chỉ true khi đang ở cặp field đó.
  const canhBaoD0 =
    hoiTruocD0 && d0 !== null ? (
      <p className="rounded-lg bg-amber-50 px-2 py-1.5 text-xs text-amber-700">
        Ngày giải ngân sớm hơn ngày mở sổ ({format(d0, "dd/MM/yyyy")}). Quỹ sẽ tính lại từ ngày mới;
        dòng số dư mở sổ có thể phải sửa lại.
        {(f.cheDo === "moi" || f.cheDo === "thau-chi") &&
          ` Khoản đã có trước ngày mở sổ thì chọn cách khai "đã có từ trước" — tiền đó đã nằm trong số dư mở sổ, ghi giải ngân nữa là đếm hai lần.`}
      </p>
    ) : null;
  // BULLET không có công tắc "coLich" riêng (LUÔN có lịch, `Loan_lich_theo_loai`) — coi như đã bật.
  const coLichHieuLuc = gocCuoiKy || f.coLich;
  // Số kỳ đã tới hạn của lịch đang khai, để chủ shop biết TRƯỚC. Thấu chi không có `termMonths`.
  const soKyCho =
    coLichHieuLuc && ngayHopLe(ngayNen) && ngayHopLe(f.firstDueDate) && (thauChi || Number(f.termMonths) > 0)
      ? soKyChoTheoLich(
          thauChi ? "OVERDRAFT" : gocCuoiKy ? "BULLET" : "TERM",
          ngayVn(ngayNen),
          ngayVn(f.firstDueDate),
          thauChi ? null : Number(f.termMonths),
          homNay
        )
      : 0;

  return (
    <>
      <div className="flex flex-col gap-2" title={khoaCheDo ? KHOA_CHE_DO_HINT : undefined}>
        {CHE_DO.map(([giaTri, nhan]) => (
          <label key={giaTri} className="flex items-center gap-2 text-sm text-ink">
            <input
              type="radio"
              name="che-do-khoan-vay"
              disabled={khoaCheDo}
              checked={f.cheDo === giaTri}
              onChange={() => doiCheDo(giaTri)}
            />
            {nhan}
          </label>
        ))}
      </div>

      {gocCuoiKy ? (
        <KhoanVayFormGocCuoiKyFields
          f={f}
          setF={setF}
          loi={loi}
          khoa={khoa}
          ngayToiDa={ngayToiDa}
          doiNgayNen={doiNgayNen}
          doiTien={doiTien}
          hienTien={hienTien}
          soKyCho={soKyCho}
          daDuyetKy={daDuyetKy}
          canhBaoD0={canhBaoD0}
        />
      ) : thauChi ? (
        <KhoanVayFormThauChiFields
          f={f}
          setF={setF}
          loi={loi}
          khoa={khoa}
          khoaCheDo={khoaCheDo}
          ngayToiDa={ngayToiDa}
          doiNgayNen={doiNgayNen}
          doiTien={doiTien}
          hienTien={hienTien}
          soKyCho={soKyCho}
          daDuyetKy={daDuyetKy}
          canhBaoD0={canhBaoD0}
        />
      ) : (
        <KhoanVayFormTermFields
          f={f}
          setF={setF}
          loi={loi}
          khoa={khoa}
          ngayToiDa={ngayToiDa}
          doiNgayNen={doiNgayNen}
          doiTien={doiTien}
          hienTien={hienTien}
          soKyCho={soKyCho}
          daDuyetKy={daDuyetKy}
          canhBaoD0={canhBaoD0}
        />
      )}

      <O label="Ghi chú" error={loi.note} hint="ghi chú ngắn; dòng 'Bỏ qua kỳ' do app tự nối, giữ nguyên">
        <textarea
          value={f.note}
          maxLength={2000}
          rows={3}
          onChange={(e) => setF((p) => ({ ...p, note: e.target.value }))}
          className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      </O>
    </>
  );
}
