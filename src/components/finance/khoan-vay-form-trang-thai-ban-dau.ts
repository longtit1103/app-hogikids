import { addMonths, format } from "date-fns";

import type { KhoanVayRow } from "@/lib/so-quy/khoan-vay-queries";

import { NGAY, type KhoanVayFormState } from "./khoan-vay-form-fields";

/**
 * Trạng thái khởi tạo của form khoản vay (Thêm/Sửa) — tách khỏi `khoan-vay-form-modal.tsx` để file
 * đó dưới 200 dòng. Thuần suy diễn từ `KhoanVayRow`, không cần React/state.
 */
export function trangThaiBanDau(loan: KhoanVayRow | undefined): KhoanVayFormState {
  const homNay = format(new Date(), NGAY);
  if (!loan) {
    return {
      name: "",
      lender: "",
      cheDo: "moi",
      soTienGiaiNgan: 0,
      ngayGiaiNgan: homNay,
      duNoMoSo: 0,
      startDate: homNay,
      thauChiTruocMoSo: false,
      coLich: true,
      laiSuat: "",
      termMonths: "",
      firstDueDate: format(addMonths(new Date(), 1), NGAY),
      note: "",
      laiTheoNam: false,
      laiCoDinh: 0,
      tienGuiMoiKy: 0,
    };
  }
  const ngayNen = format(loan.startDate, NGAY);
  const thauChi = loan.kind === "OVERDRAFT";
  const gocCuoiKy = loan.kind === "BULLET";
  return {
    name: loan.name,
    lender: loan.lender,
    // BULLET hiện chỉ khai được ở chế độ "khoản mới" (xem `khoan-vay-form-goc-cuoi-ky-fields.tsx`)
    // — một bản ghi lỡ có `duNoMoSo > 0` (mang sang, tạo ngoài UI này) vẫn hiện đúng số 0/ngày nền,
    // KHÔNG rơi vào nhánh "mang-sang" vì form đó không có ô nào cho loại vay này.
    cheDo: gocCuoiKy ? "goc-cuoi-ky" : thauChi ? "thau-chi" : loan.duNoMoSo > 0 ? "mang-sang" : "moi",
    soTienGiaiNgan: loan.giaiNgan,
    ngayGiaiNgan: ngayNen,
    duNoMoSo: loan.duNoMoSo,
    startDate: ngayNen,
    // Thấu chi mang sang = không có LOAN_IN, `duNoMoSo` là dư nợ khai lúc mở sổ.
    thauChiTruocMoSo: thauChi && loan.duNoMoSo > 0,
    // Thấu chi chỉ cần `firstDueDate` (không có `termMonths`) — xem `coLich()` ở `lich-tra-no.ts`.
    // BULLET không đọc field này (luôn coi như bật, xem `coLichThucTe` ở form-modal).
    coLich: loan.firstDueDate !== null && (thauChi || loan.termMonths !== null),
    laiSuat: loan.annualRateBp ? (loan.annualRateBp / 100).toLocaleString("vi-VN") : "",
    termMonths: loan.termMonths === null ? "" : String(loan.termMonths),
    firstDueDate: loan.firstDueDate === null ? format(addMonths(loan.startDate, 1), NGAY) : format(loan.firstDueDate, NGAY),
    note: loan.note,
    // NULL = đang khai theo %/năm như cũ (xem `KhoanVayLich.laiCoDinhMoiKy`).
    laiTheoNam: gocCuoiKy ? loan.laiCoDinhMoiKy === null : false,
    laiCoDinh: loan.laiCoDinhMoiKy ?? 0,
    tienGuiMoiKy: loan.tienGuiBatBuocMoiKy,
  };
}
