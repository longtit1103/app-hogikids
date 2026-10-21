import { type LoanKind, type Prisma } from "@/generated/prisma/client";
import { startOfDay, subDays } from "date-fns";

import { type CashMovementKindTatCa, KIND_DU_NO_VAY } from "@/lib/cash-movements/cash-movement-kinds";
import { prisma } from "@/lib/prisma";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";
import { deXuatTatToan } from "@/lib/so-quy/lai-thau-chi";
import {
  duNoTai,
  kyChoDuyet,
  ngayTraKy,
  type DeXuatKy,
  type KhoanVayLich,
  type TraGoc,
} from "@/lib/so-quy/lich-tra-no";

/**
 * Đọc bảng khoản vay + kỳ trả nợ chờ duyệt. Dư nợ KHÔNG lưu cột riêng: luôn suy lại từ
 * `duNoMoSo + Σ LOAN_IN + Σ LAI_NHAP_GOC − Σ LOAN_REPAY` của chính các dòng `CashMovement` gắn `loanId`
 * (`DAU_DU_NO_VAY`) — không có chỗ nào để số dư nợ lệch với sổ.
 *
 * Trục DÒNG TIỀN thuần: gốc vay/trả gốc và tiền gửi tiết kiệm bắt buộc KHÔNG BAO GIỜ vào Lãi/Lỗ
 * (lãi vay mới là chi phí, đi qua `Expense` danh mục `interest`).
 */

/** Sổ tiết kiệm bắt buộc — CỐ Ý tách khỏi `KIND_GOC`, xem `tienGuiDangGiu` ở `vi-tu-du-no.ts`. */
const KIND_TIEN_GUI = ["DEPOSIT_OUT", "DEPOSIT_IN"] as const;

type DongGoc = { kind: CashMovementKindTatCa; amount: number; date: Date };

/** Client đọc khoản vay + dòng gốc — prisma gốc hoặc `tx` đang chạy (bước bật nợ phải trả). */
type DbKhoanVay = Pick<Prisma.TransactionClient, "loan" | "cashMovement">;

/** Gom dòng gốc theo khoản vay: 1 lượt đọc cho MỌI khoản (số khoản vay chỉ vài dòng). */
async function docDongGoc(db: DbKhoanVay = prisma): Promise<Map<string, DongGoc[]>> {
  const dong = await db.cashMovement.findMany({
    where: { loanId: { not: null }, kind: { in: [...KIND_DU_NO_VAY] } },
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

type DongGocTach = {
  giaiNgan: number;
  giaiNganNgay: Date | null;
  traGoc: TraGoc[];
  nhapGoc: TraGoc[];
};

/**
 * LOAN_IN = giải ngân (tối đa 1 dòng/khoản); LOAN_REPAY = các lần trả gốc; LAI_NHAP_GOC = lãi kỳ ngân
 * hàng cộng vào dư nợ (thấu chi "lãi nhập gốc"). Giữ NGÀY của dòng LOAN_IN: dư nợ đếm theo ngày dòng
 * tiền, không theo `Loan.startDate` (chủ shop sửa được `startDate`).
 */
function tachDongGoc(dong: DongGoc[]): DongGocTach {
  let giaiNgan = 0;
  let giaiNganNgay: Date | null = null;
  const traGoc: TraGoc[] = [];
  const nhapGoc: TraGoc[] = [];
  for (const d of dong) {
    if (d.kind === "LOAN_IN") {
      giaiNgan += d.amount;
      // Hợp đồng là tối đa 1 LOAN_IN/khoản; lỡ có nhiều thì lấy ngày SỚM NHẤT (dư nợ hiện sớm hơn,
      // không bao giờ giấu nợ).
      if (giaiNganNgay === null || d.date < giaiNganNgay) giaiNganNgay = d.date;
    } else if (d.kind === "LOAN_REPAY") {
      traGoc.push({ ngay: d.date, soTien: d.amount });
    } else if (d.kind === "LAI_NHAP_GOC") {
      nhapGoc.push({ ngay: d.date, soTien: d.amount });
    }
  }
  return { giaiNgan, giaiNganNgay, traGoc, nhapGoc };
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
  /** Thấu chi "lãi nhập gốc" — duyệt kỳ lãi cộng lãi vào dư nợ thay vì trừ quỹ (chỉ `OVERDRAFT`). */
  laiNhapGoc: boolean;
};

function lichCuaKhoan(
  loan: LoanRecord,
  { giaiNgan, giaiNganNgay, nhapGoc }: DongGocTach
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
    laiNhapGoc: loan.laiNhapGoc,
    nhapGoc,
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
  /** Các dòng lãi nhập gốc (thấu chi "lãi nhập gốc") — TĂNG dư nợ từ ngày kỳ; lãi theo ngày chia đoạn theo chúng. */
  nhapGoc: TraGoc[];
  /** Dư nợ gốc TỚI HÔM NAY. */
  duNo: number;
  /**
   * Lãi thấu chi CHƯA THU tính tới hôm nay (từ ngày rút, hoặc con dấu kỳ lãi đã thu nếu muộn hơn).
   * `null` cho vay kỳ hạn và cho khoản đã tất toán — hai ca đó không có khái niệm "lãi đang chạy".
   */
  laiTamTinh: number | null;
  kyCho: DeXuatKy | null;
  /** Đã có lần trả gốc nào chưa — chặn sửa/xoá ở action. */
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
    const tach = tachDongGoc(dongGoc.get(loan.id) ?? []);
    const { giaiNgan, giaiNganNgay, traGoc, nhapGoc } = tach;
    const lich = lichCuaKhoan(loan, tach);
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
      laiNhapGoc: loan.laiNhapGoc,
      giaiNgan,
      giaiNganNgay,
      traGoc,
      nhapGoc,
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
    const tach = tachDongGoc(dongGoc.get(loan.id) ?? []);
    return kyChoDuyet(lichCuaKhoan(loan, tach), tach.traGoc, loan.lastDueHandled, homNay) !== null;
  }).length;
}

/** Kỳ SỚM NHẤT chưa xử lý của một khoản, đến hạn TRƯỚC ngày bật nợ phải trả. */
export type KyVayTruocM = { loanId: string; ten: string; khoaNgayKy: string };

/**
 * Khoản vay còn hiệu lực có kỳ (trả nợ kỳ hạn, lãi + gốc cuối kỳ, lãi tháng thấu chi) đến hạn trước ngày bật
 * `mocM` mà chưa duyệt / chưa đóng dấu "không thu" (con dấu `lastDueHandled`) — mỗi khoản tối đa một dòng, kỳ
 * sớm nhất (duyệt tuần tự). Duyệt kỳ ghi tiền ĐÚNG ngày đến hạn, nên sau khi bật kỳ trước ngày bật không ghi
 * được nữa ⇒ bước bật đòi dọn hết trước. Cùng luật `kyChoDuyet` với bảng Khoản vay, chỉ khác "hôm nay" = ngày
 * trước ngày bật. `db` = `tx` khi đọc trong transaction bước bật.
 *
 * CHỈ kỳ đến hạn trong [ngày mở sổ `d0`, M) — cùng cận dưới với lần chi định kỳ chưa ghi
 * (`docDinhKyChuaGhiTruocM`). Kỳ trước ngày mở sổ nằm NGOÀI quỹ: tiền kỳ đó đã nằm trong số dư mở sổ, để treo sau
 * bật vô hại (sau bật chỉ còn đóng dấu "không thu", không ghi tiền). Đòi DUYỆT nó trước bật thì ngược lại có hại:
 * dòng trả nợ đề ngày đến hạn kéo lùi ngày mở sổ, lôi chi phí cũ vào quỹ và trừ gốc lần hai với khoản mang sang.
 * `d0` null (chưa mở sổ) ⇒ không kỳ nào thuộc quỹ ⇒ rỗng.
 */
export async function dsKyChoTruocM(
  mocM: Date,
  d0: Date | null,
  db: DbKhoanVay = prisma
): Promise<KyVayTruocM[]> {
  if (d0 === null) return [];
  const loans = await db.loan.findMany({
    where: { closedAt: null, firstDueDate: { not: null } },
    orderBy: [{ startDate: "asc" }, { id: "asc" }],
  });
  if (loans.length === 0) return [];

  const dongGoc = await docDongGoc(db);
  // Cuối ngày M − 1 (giờ VN): `kyChoDuyet` lấy `endOfDay` của mốc này làm hạn — kỳ đúng ngày M không tính.
  const truocM = subDays(new Date(`${khoaNgayVn(mocM)}T00:00:00+07:00`), 1);
  return loans.flatMap((loan) => {
    const tach = tachDongGoc(dongGoc.get(loan.id) ?? []);
    const ky = kyChoDuyet(lichCuaKhoan(loan, tach), tach.traGoc, loan.lastDueHandled, truocM, d0);
    return ky === null ? [] : [{ loanId: loan.id, ten: loan.name, khoaNgayKy: khoaNgayVn(ky.denNgay) }];
  });
}

/** Khoản đã trả hết gốc với kỳ cuối trước ngày bật mà ngân hàng còn giữ tiền gửi bắt buộc (chưa tất toán). */
export type TienGuiChuaTatToanTruocM = { loanId: string; ten: string; khoaNgayKyCuoi: string; tienGui: number };

/**
 * Khoản vay còn mở (thường là "trả gốc cuối kỳ" có tiền gửi bắt buộc) mà: kỳ CUỐI đến hạn trước ngày bật `mocM`,
 * dư nợ cuối ngày M − 1 = 0, và tiền gửi đang giữ (Σ DEPOSIT_OUT − Σ DEPOSIT_IN) > 0. Ngoài đời ngân hàng thường
 * cấn trừ / hoàn tiền gửi ngay kỳ cuối ⇒ tiền đó đã nằm trong số dư ngân hàng cuối M − 1 (chốt vào điều chỉnh ngày
 * bật). Sau khi bật: tất toán đề ngày < M bị khoá, đề ngày ≥ M là ghi `DEPOSIT_IN` lần hai ⇒ quỹ cao hơn tiền thật
 * đúng số tiền gửi; không tất toán thì tiền gửi treo mãi ⇒ bước bật đòi tất toán TRƯỚC.
 * Dư nợ xét tại M − 1 (không phải hôm nay): trả gốc muộn từ M trở đi ⇒ ngân hàng hoàn tiền gửi cũng từ M ⇒ tất
 * toán sau bật đề đúng ngày đó là đúng, không chặn. `db` = `tx` khi đọc trong transaction bước bật.
 */
export async function dsTienGuiChuaTatToanTruocM(
  mocM: Date,
  db: DbKhoanVay = prisma
): Promise<TienGuiChuaTatToanTruocM[]> {
  const nhomTienGui = await db.cashMovement.groupBy({
    by: ["loanId", "kind"],
    where: { loanId: { not: null }, kind: { in: [...KIND_TIEN_GUI] } },
    _sum: { amount: true },
  });
  const tienGui = new Map<string, number>();
  for (const n of nhomTienGui) {
    if (n.loanId === null) continue;
    const dau = n.kind === "DEPOSIT_OUT" ? 1 : -1;
    tienGui.set(n.loanId, (tienGui.get(n.loanId) ?? 0) + dau * (n._sum.amount ?? 0));
  }
  const coTienGui = [...tienGui].filter(([, so]) => so > 0).map(([id]) => id);
  if (coTienGui.length === 0) return [];

  const loans = await db.loan.findMany({
    where: { id: { in: coTienGui }, closedAt: null, termMonths: { not: null }, firstDueDate: { not: null } },
    orderBy: [{ startDate: "asc" }, { id: "asc" }],
  });
  if (loans.length === 0) return [];

  const dongGoc = await docDongGoc(db);
  const dauNgayM = new Date(`${khoaNgayVn(mocM)}T00:00:00+07:00`);
  const truocM = subDays(dauNgayM, 1);
  return loans.flatMap((loan) => {
    if (loan.termMonths === null) return [];
    const tach = tachDongGoc(dongGoc.get(loan.id) ?? []);
    const lich = lichCuaKhoan(loan, tach);
    const kyCuoi = ngayTraKy(lich, loan.termMonths);
    if (kyCuoi >= dauNgayM || duNoTai(lich, tach.traGoc, truocM) !== 0) return [];
    return [{ loanId: loan.id, ten: loan.name, khoaNgayKyCuoi: khoaNgayVn(kyCuoi), tienGui: tienGui.get(loan.id) ?? 0 }];
  });
}
