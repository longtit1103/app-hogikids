import { type LoanKind } from "@prisma/client";
import { startOfDay } from "date-fns";

import { type CashMovementKind } from "@/lib/cash-movements/cash-movement-kinds";
import { prisma } from "@/lib/prisma";
import { deXuatTatToan } from "@/lib/so-quy/lai-thau-chi";
import {
  duNoTai,
  kyChoDuyet,
  type DeXuatKy,
  type KhoanVayLich,
  type TraGoc,
} from "@/lib/so-quy/lich-tra-no";

/**
 * Đọc bảng khoản vay + kỳ trả nợ chờ duyệt (spec §5.2). Dư nợ KHÔNG lưu cột riêng: luôn suy lại từ
 * `duNoMoSo + Σ LOAN_IN − Σ LOAN_REPAY` của chính các dòng `CashMovement` gắn `loanId` — không có
 * chỗ nào để số dư nợ lệch với sổ.
 *
 * Trục DÒNG TIỀN thuần: gốc vay/trả gốc và tiền gửi tiết kiệm bắt buộc KHÔNG BAO GIỜ vào Lãi/Lỗ
 * (lãi vay mới là chi phí, đi qua `Expense` danh mục `interest`).
 */

const KIND_GOC = ["LOAN_IN", "LOAN_REPAY"] as const;

/** Sổ tiết kiệm bắt buộc — CỐ Ý tách khỏi `KIND_GOC`, xem `tienGuiDangGiu` ở `vi-tu-du-no.ts`. */
const KIND_TIEN_GUI = ["DEPOSIT_OUT", "DEPOSIT_IN"] as const;

type DongGoc = { kind: CashMovementKind; amount: number; date: Date };

/** Gom dòng gốc theo khoản vay: 1 lượt đọc cho MỌI khoản (số khoản vay chỉ vài dòng). */
async function docDongGoc(): Promise<Map<string, DongGoc[]>> {
  const dong = await prisma.cashMovement.findMany({
    where: { loanId: { not: null }, kind: { in: [...KIND_GOC] } },
    select: { loanId: true, kind: true, amount: true, date: true },
  });
  const theoKhoan = new Map<string, DongGoc[]>();
  for (const d of dong) {
    if (d.loanId === null) continue;
    const cu = theoKhoan.get(d.loanId);
    if (cu) cu.push(d);
    else theoKhoan.set(d.loanId, [d]);
  }
  return theoKhoan;
}

/**
 * LOAN_IN = giải ngân (tối đa 1 dòng/khoản); LOAN_REPAY = các lần trả gốc. Giữ NGÀY của dòng LOAN_IN:
 * dư nợ đếm theo ngày dòng tiền, không theo `Loan.startDate` (chủ shop sửa được `startDate`).
 */
function tachDongGoc(dong: DongGoc[]): {
  giaiNgan: number;
  giaiNganNgay: Date | null;
  traGoc: TraGoc[];
} {
  let giaiNgan = 0;
  let giaiNganNgay: Date | null = null;
  const traGoc: TraGoc[] = [];
  for (const d of dong) {
    if (d.kind === "LOAN_IN") {
      giaiNgan += d.amount;
      // Hợp đồng là tối đa 1 LOAN_IN/khoản; lỡ có nhiều thì lấy ngày SỚM NHẤT (dư nợ hiện sớm hơn,
      // không bao giờ giấu nợ).
      if (giaiNganNgay === null || d.date < giaiNganNgay) giaiNganNgay = d.date;
    } else if (d.kind === "LOAN_REPAY") {
      traGoc.push({ ngay: d.date, soTien: d.amount });
    }
  }
  return { giaiNgan, giaiNganNgay, traGoc };
}

type TienGuiKhoan = {
  /** Σ DEPOSIT_OUT − Σ DEPOSIT_IN. */
  dangGiu: number;
  /** Ngày dòng DEPOSIT_OUT MUỘN NHẤT — cận dưới của ô "Ngày tất toán" (xem `mocTatToanSomNhat`). */
  ngayGuiCuoi: Date | null;
  /**
   * Có ÍT NHẤT MỘT dòng tiền gửi (OUT hoặc IN), bất kể `dangGiu` bằng bao nhiêu. Đây mới là tín hiệu
   * `xoaKhoanVay` chặn theo — nó đếm DÒNG, không cộng tiền. Lấy `dangGiu > 0` thay thế sẽ bỏ sót
   * khoản đã gửi rồi nhận lại hết (Σ = 0 nhưng dòng vẫn còn), khiến hộp xác nhận ở menu ⋯ hứa xoá
   * được rồi server mới ném — đúng ngõ cụt mà `lyDoKhongXoaKhoanVay` sinh ra để dọn.
   */
  coDong: boolean;
};

/**
 * Tiền gửi tiết kiệm bắt buộc ngân hàng ĐANG GIỮ, theo khoản vay = Σ DEPOSIT_OUT − Σ DEPOSIT_IN.
 * Cùng công thức với `tienGuiDangGiu()` (`vi-tu-du-no.ts`) nhưng gom 1 lượt đọc cho MỌI khoản — bảng
 * khoản vay chỉ vài dòng, gọi hàm kia trong vòng lặp là N+1 truy vấn.
 *
 * CỐ Ý tách khỏi `docDongGoc`: gộp chung thì hai loại này lọt vào `tachDongGoc` rồi hoá thành
 * `traGoc`/`giaiNgan`, tức tiền gửi trừ thẳng vào dư nợ vay — đúng cái bẫy `KIND_GOC` đang chặn.
 */
async function docTienGui(): Promise<Map<string, TienGuiKhoan>> {
  const nhom = await prisma.cashMovement.groupBy({
    by: ["loanId", "kind"],
    where: { loanId: { not: null }, kind: { in: [...KIND_TIEN_GUI] } },
    _sum: { amount: true },
    _max: { date: true },
  });
  const theoKhoan = new Map<string, TienGuiKhoan>();
  for (const n of nhom) {
    if (n.loanId === null) continue;
    const cu = theoKhoan.get(n.loanId) ?? { dangGiu: 0, ngayGuiCuoi: null, coDong: false };
    cu.coDong = true;
    const dau = n.kind === "DEPOSIT_OUT" ? 1 : -1;
    cu.dangGiu += dau * (n._sum.amount ?? 0);
    // CHỈ DEPOSIT_OUT: dòng DEPOSIT_IN là chính lượt hoàn lúc tất toán, lấy nó làm cận dưới thì
    // khoản đã tất toán tự chặn lượt tất toán kế tiếp sau khi mở lại.
    if (n.kind === "DEPOSIT_OUT") cu.ngayGuiCuoi = n._max.date;
    theoKhoan.set(n.loanId, cu);
  }
  return theoKhoan;
}

/**
 * Ngày SỚM NHẤT được phép chọn làm "Ngày tất toán" = mốc muộn nhất trong ba thứ: ngày bắt đầu khoản,
 * lần trả gốc gần nhất, lần gửi tiết kiệm gần nhất.
 *
 * Vì sao cần: lượt tất toán GHI TIỀN THẬT (dòng hoàn `DEPOSIT_IN` = Σ tiền gửi). Gõ nhầm một ngày
 * trước kỳ cuối là cả Σ tiền gửi rơi vào tháng chưa từng chi đồng nào ⇒ Sổ quỹ tháng đó phồng lên
 * đúng số ấy, tháng sau hụt đúng số ấy. Server (`tatToanKhoanVay`) mới là cổng thật; số này chỉ để ô
 * `<input type="date">` khai `min` cho chủ shop thấy trước.
 */
function mocTatToanSomNhat(
  startDate: Date,
  traGoc: TraGoc[],
  ngayGuiCuoi: Date | null
): Date {
  let moc = startOfDay(startDate);
  for (const t of traGoc) {
    const d = startOfDay(t.ngay);
    if (d > moc) moc = d;
  }
  if (ngayGuiCuoi !== null) {
    const d = startOfDay(ngayGuiCuoi);
    if (d > moc) moc = d;
  }
  return moc;
}

type LoanRecord = {
  id: string;
  kind: LoanKind;
  name: string;
  lender: string;
  duNoMoSo: number;
  startDate: Date;
  annualRateBp: number;
  termMonths: number | null;
  firstDueDate: Date | null;
  lastDueHandled: Date | null;
  closedAt: Date | null;
  note: string;
  /** Lãi CỐ ĐỊNH mỗi kỳ theo giấy ngân hàng (chỉ `BULLET`); NULL = tính theo `annualRateBp`. */
  laiCoDinhMoiKy: number | null;
  /** Tiền gửi tiết kiệm bắt buộc mỗi kỳ (0 = không có). */
  tienGuiBatBuocMoiKy: number;
};

function lichCuaKhoan(
  loan: LoanRecord,
  giaiNgan: number,
  giaiNganNgay: Date | null
): KhoanVayLich {
  return {
    kind: loan.kind,
    startDate: loan.startDate,
    firstDueDate: loan.firstDueDate,
    termMonths: loan.termMonths,
    annualRateBp: loan.annualRateBp,
    duNoMoSo: loan.duNoMoSo,
    giaiNgan,
    giaiNganNgay,
    laiCoDinhMoiKy: loan.laiCoDinhMoiKy,
    tienGuiBatBuocMoiKy: loan.tienGuiBatBuocMoiKy,
  };
}

export type KhoanVayRow = LoanRecord & {
  /** Số tiền dòng LOAN_IN (0 nếu khoản mang sang từ trước ngày mở sổ). */
  giaiNgan: number;
  /**
   * NGÀY của dòng LOAN_IN (null khi khoản mang sang). Trả ra cho client để hộp Tất toán thấu chi
   * dựng lại `KhoanVayLich` và tính lại lãi mỗi khi chủ shop đổi ngày — không phải gọi server.
   */
  giaiNganNgay: Date | null;
  /** Các lần trả gốc (cùng lý do với `giaiNganNgay`): lãi theo ngày chia đoạn theo chính chúng. */
  traGoc: TraGoc[];
  /** Dư nợ gốc TỚI HÔM NAY. */
  duNo: number;
  /**
   * Lãi thấu chi CHƯA THU tính tới hôm nay (từ ngày rút, hoặc con dấu kỳ lãi đã thu nếu muộn hơn).
   * `null` cho vay kỳ hạn và cho khoản đã tất toán — hai ca đó không có khái niệm "lãi đang chạy".
   */
  laiTamTinh: number | null;
  kyCho: DeXuatKy | null;
  /** Đã có lần trả gốc nào chưa — chặn sửa/xoá ở action (phase 3). */
  coTraGoc: boolean;
  /**
   * Tiền gửi tiết kiệm bắt buộc ngân hàng ĐANG GIỮ (Σ DEPOSIT_OUT − Σ DEPOSIT_IN). KHÔNG đụng dư nợ
   * gốc và KHÔNG BAO GIỜ vào P&L — tiền của chủ shop, ngân hàng giữ hộ tới lúc tất toán.
   */
  tienGuiDangGiu: number;
  /** Có dòng tiền gửi nào chưa (đếm DÒNG, không cộng tiền) — quyết định xoá được hồ sơ hay không. */
  coDongTienGui: boolean;
  /**
   * Cận DƯỚI của ô "Ngày tất toán" (xem `mocTatToanSomNhat`). Chỉ là gợi ý cho `min` của ô ngày —
   * `tatToanKhoanVay` kiểm lại độc lập trong transaction.
   */
  ngayTatToanSomNhat: Date;
};

/**
 * Khoản còn hiệu lực trước (closedAt null), trong mỗi nhóm mới tạo trước. `nulls: "first"` là BẮT
 * BUỘC: Postgres mặc định xếp NULL CUỐI khi ASC, tức khoản đã tất toán sẽ nhảy lên đầu bảng.
 */
export async function listKhoanVay(): Promise<KhoanVayRow[]> {
  const [loans, dongGoc, tienGui] = await Promise.all([
    prisma.loan.findMany({
      orderBy: [{ closedAt: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }],
    }),
    docDongGoc(),
    docTienGui(),
  ]);
  const homNay = new Date();

  return loans.map((loan) => {
    const { giaiNgan, giaiNganNgay, traGoc } = tachDongGoc(dongGoc.get(loan.id) ?? []);
    const lich = lichCuaKhoan(loan, giaiNgan, giaiNganNgay);
    return {
      id: loan.id,
      kind: loan.kind,
      name: loan.name,
      lender: loan.lender,
      duNoMoSo: loan.duNoMoSo,
      startDate: loan.startDate,
      annualRateBp: loan.annualRateBp,
      termMonths: loan.termMonths,
      firstDueDate: loan.firstDueDate,
      lastDueHandled: loan.lastDueHandled,
      closedAt: loan.closedAt,
      note: loan.note,
      laiCoDinhMoiKy: loan.laiCoDinhMoiKy,
      tienGuiBatBuocMoiKy: loan.tienGuiBatBuocMoiKy,
      giaiNgan,
      giaiNganNgay,
      traGoc,
      tienGuiDangGiu: tienGui.get(loan.id)?.dangGiu ?? 0,
      coDongTienGui: tienGui.get(loan.id)?.coDong ?? false,
      ngayTatToanSomNhat: mocTatToanSomNhat(
        loan.startDate,
        traGoc,
        tienGui.get(loan.id)?.ngayGuiCuoi ?? null
      ),
      duNo: duNoTai(lich, traGoc, homNay),
      laiTamTinh:
        loan.kind === "OVERDRAFT" && loan.closedAt === null
          ? deXuatTatToan(lich, traGoc, loan.lastDueHandled, homNay).lai
          : null,
      kyCho:
        loan.closedAt === null ? kyChoDuyet(lich, traGoc, loan.lastDueHandled, homNay) : null,
      coTraGoc: traGoc.length > 0,
    };
  });
}

/**
 * Đếm KHOẢN VAY đang có kỳ tới hạn chưa ghi — mỗi khoản tối đa 1 (kỳ chờ duyệt là kỳ SỚM NHẤT chưa
 * xử lý, duyệt tuần tự). Tên hàm và mọi câu chữ dùng nó phải nói "khoản vay", KHÔNG nói "kỳ": khoản
 * khai lùi ngày có 2–3 kỳ quá hạn vẫn chỉ đếm 1, chữ nói "kỳ" là hứa một con số app không tính.
 *
 * Chạy ở shell cho banner nhắc nên phải RẺ: không khoản vay nào có lịch thì trả 0 ngay, khỏi đọc
 * bảng dòng tiền.
 */
export async function demKhoanVayCoKyChoDuyet(): Promise<number> {
  const loans = await prisma.loan.findMany({
    where: { closedAt: null, firstDueDate: { not: null } },
  });
  if (loans.length === 0) return 0;

  const dongGoc = await docDongGoc();
  const homNay = new Date();
  return loans.filter((loan) => {
    const { giaiNgan, giaiNganNgay, traGoc } = tachDongGoc(dongGoc.get(loan.id) ?? []);
    const lich = lichCuaKhoan(loan, giaiNgan, giaiNganNgay);
    return kyChoDuyet(lich, traGoc, loan.lastDueHandled, homNay) !== null;
  }).length;
}
