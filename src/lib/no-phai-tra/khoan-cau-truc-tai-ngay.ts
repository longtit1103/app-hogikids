import type { KhoanCauTruc } from "@/lib/so-quy/doi-chieu-so-du-chot";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";

/**
 * Hai khoản cấu trúc (dư nợ thấu chi, tiền đang gửi) TẠI MỘT NGÀY bất kỳ — THUẦN, không DB.
 *
 * `tinhKhoanCauTruc` chỉ biết "hiện tại" (khoản chưa đóng); đối chiếu số dư chốt các tháng trước
 * cần trạng thái đúng vào cuối ngày M−1, nên ở đây dựng lại từ khoản vay + dòng tiền theo ngày.
 * "Cuối ngày" so theo khoá ngày VN: giao dịch 23:30 giờ VN ngày d tính vào d.
 */
export type KhoanVayTaiNgay = {
  id: string;
  kind: string;
  startDate: Date;
  closedAt: Date | null;
  duNoMoSo: number;
};

export type DongTienTaiNgay = {
  loanId: string | null;
  savingsId: string | null;
  kind: string;
  amount: number;
  date: Date;
};

export function khoanCauTrucTai(
  ngay: Date,
  loans: KhoanVayTaiNgay[],
  movements: DongTienTaiNgay[]
): KhoanCauTruc {
  const khoa = khoaNgayVn(ngay);
  const dongDenNgay = movements.filter((m) => khoaNgayVn(m.date) <= khoa);

  let duNoThauChi = 0;
  for (const l of loans) {
    if (l.kind !== "OVERDRAFT") continue;
    if (khoaNgayVn(l.startDate) > khoa) continue;
    if (l.closedAt !== null && khoaNgayVn(l.closedAt) <= khoa) continue;
    let duNo = l.duNoMoSo;
    for (const m of dongDenNgay) {
      if (m.loanId !== l.id) continue;
      if (m.kind === "LOAN_IN") duNo += m.amount;
      else if (m.kind === "LOAN_REPAY") duNo -= m.amount;
    }
    duNoThauChi += duNo;
  }

  let tienGui = 0;
  for (const m of dongDenNgay) {
    if (m.kind === "DEPOSIT_OUT" || m.kind === "SAVINGS_OUT") tienGui += m.amount;
    else if (m.kind === "DEPOSIT_IN" || m.kind === "SAVINGS_IN") tienGui -= m.amount;
  }

  // Kẹp trên TỔNG (không từng sổ): tiền gửi âm ở một sổ là dữ liệu lỗi, cổng ghi ở action đã chặn rút quá gốc.
  return { duNoThauChi, tienDangGui: Math.max(0, tienGui) };
}
