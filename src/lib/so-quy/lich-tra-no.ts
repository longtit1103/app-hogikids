import { addMonths, differenceInCalendarDays, endOfDay, startOfDay } from "date-fns";

/**
 * Lịch kỳ trả + đề xuất lãi/gốc (spec §5.2). THUẦN, không Prisma. Mọi mốc `startOfDay` giờ VN TRƯỚC
 * khi đếm ngày — lệch giờ một tí là lệch nguyên một ngày lãi.
 *
 * Lãi/gốc chỉ là ĐỀ XUẤT: chủ shop sửa được trước khi bấm ghi. Vay KỲ HẠN tính lãi trên dư nợ ĐẦU kỳ
 * (trả bớt gốc giữa kỳ ⇒ chênh vài chục nghìn — "đủ tốt" có chủ đích, sửa tay); THẤU CHI thì không
 * được "đủ tốt" như thế: ngân hàng tính lãi THEO NGÀY nên trả bớt gốc giữa kỳ giảm lãi ngay, xem
 * `laiTheoNgay`.
 */
export type KhoanVayLich = {
  /**
   * TERM = vay kỳ hạn (lãi trên dư nợ đầu kỳ + gốc chia đều). OVERDRAFT = thấu chi: `termMonths`
   * LUÔN null, `firstDueDate` tuỳ chọn, kỳ chỉ thu LÃI tính theo ngày, gốc trả khi tất toán.
   * BULLET = trả gốc cuối kỳ: có ĐỦ `termMonths` + `firstDueDate` như vay kỳ hạn, nhưng kỳ 1…n−1
   * chỉ trả lãi, kỳ n trả TRỌN gốc.
   */
  kind: "TERM" | "OVERDRAFT" | "BULLET";
  /** Ngày giải ngân (khoản mới) hoặc ngày mang sang (khoản cũ) = due_0. */
  startDate: Date;
  /** NULL cùng `termMonths` = không có lịch trả (vay người thân "khi nào có thì trả"). */
  firstDueDate: Date | null;
  termMonths: number | null;
  /** Lãi %/năm × 100: 10,5% = 1050. */
  annualRateBp: number;
  /** Dư nợ mang sang lúc mở sổ — CHỈ vào dư nợ, KHÔNG vào quỹ. */
  duNoMoSo: number;
  /** Số tiền dòng LOAN_IN duy nhất của khoản; 0 nếu khoản mang sang. */
  giaiNgan: number;
  /**
   * NGÀY của chính dòng LOAN_IN (null khi `giaiNgan = 0`). Cố ý TÁCH khỏi `startDate`: dư nợ theo
   * spec §5.2 đếm theo ngày của DÒNG TIỀN, còn `startDate` chỉ là due_0 để đếm ngày kỳ 1 và chủ shop
   * sửa được. Lấy `startDate` làm mốc giải ngân là cộng tiền vay vào dư nợ trước ngày nó thật sự về.
   */
  giaiNganNgay: Date | null;
  /**
   * Lãi CỐ ĐỊNH mỗi kỳ theo số tiền trên hợp đồng (ca của BULLET). NULL = tính từ `annualRateBp`
   * như cũ. KHÔNG dùng 0 làm sentinel: vay không lãi là trạng thái hợp lệ, lấy 0 nghĩa là "chưa
   * khai" thì khoản vay 0đ lãi sẽ âm thầm bị tính lãi theo %/năm.
   */
  laiCoDinhMoiKy: number | null;
  /** Tiền gửi tiết kiệm bắt buộc mỗi kỳ (0 = không có). DÒNG TIỀN thuần, KHÔNG BAO GIỜ là chi phí. */
  tienGuiBatBuocMoiKy: number;
};

export type TraGoc = { ngay: Date; soTien: number };

export type DeXuatKy = {
  ky: number;
  tuNgay: Date;
  denNgay: Date;
  soNgay: number;
  duNoDauKy: number;
  lai: number;
  goc: number;
  /**
   * Tiền gửi tiết kiệm bắt buộc của kỳ — đi ra Sổ quỹ thành `CashMovement` DEPOSIT_OUT, TUYỆT ĐỐI
   * không thành `Expense`. CHỈ khoản BULLET mới có; mọi loại khác LUÔN 0 (xem `deXuatKy`).
   */
  tienGui: number;
};

/**
 * Có lịch kỳ hay không. Thấu chi KHÔNG có `termMonths` (không có lịch trả gốc) nên chỉ cần
 * `firstDueDate` — đòi đủ cả hai như vay kỳ hạn là chặn nhầm đúng ca hợp lệ của thấu chi. TERM và
 * BULLET đều phải có đủ cả hai (CHECK `Loan_lich_theo_loai` ở DB).
 */
export function coLich(l: KhoanVayLich): l is KhoanVayLich & { firstDueDate: Date } {
  if (l.firstDueDate === null) return false;
  return l.kind === "OVERDRAFT" || l.termMonths !== null;
}

/**
 * Trần vòng lặp kỳ cho thấu chi — nó không có `termMonths` để chặn trên. Cùng con số với trần zod
 * kỳ hạn (600 kỳ = 50 năm): điều kiện dừng THẬT vẫn là `due_k` vượt hôm nay, đây chỉ là chốt chặn
 * để một `firstDueDate` khai lùi cả thế kỷ không treo vòng lặp.
 */
const TRAN_KY = 600;

/** Số kỳ tối đa của lịch: thấu chi lấy trần, vay kỳ hạn/trả gốc cuối kỳ lấy đúng `termMonths`. */
function soKyToiDa(l: KhoanVayLich & { firstDueDate: Date }): number {
  return l.kind === "OVERDRAFT" ? TRAN_KY : (l.termMonths ?? 0);
}

/** due_0 = startDate; due_k = firstDueDate + (k−1) tháng (date-fns tự kẹp 31 → 28/29/30). */
export function ngayTraKy(l: KhoanVayLich, k: number): Date {
  if (k === 0) return startOfDay(l.startDate);
  if (!coLich(l)) throw new Error("Khoản vay không có lịch trả");
  return startOfDay(addMonths(l.firstDueDate, k - 1));
}

/** Dư nợ tại cuối ngày t = mang sang + giải ngân (nếu dòng LOAN_IN đã có ngày ≤ t) − Σ trả gốc ≤ t. */
export function duNoTai(l: KhoanVayLich, traGoc: TraGoc[], t: Date): number {
  const moc = endOfDay(t);
  const daTra = traGoc.filter((x) => x.ngay <= moc).reduce((s, x) => s + x.soTien, 0);
  const daGiaiNgan = l.giaiNganNgay !== null && startOfDay(l.giaiNganNgay) <= moc;
  return l.duNoMoSo + (daGiaiNgan ? l.giaiNgan : 0) - daTra;
}

/**
 * Mẫu số của lãi theo ngày: 10.000 bp × 365 ngày; và hai lần mẫu, dùng cho phép làm tròn nửa lên.
 * Viết `BigInt(...)` chứ không phải hằng `…n` vì `tsconfig.target` của dự án là ES2017.
 */
const MAU_LAI_NGAY = BigInt(3_650_000);
const HAI_LAN_MAU = BigInt(7_300_000);

/**
 * Lãi THEO NGÀY trên đoạn `[tuNgay, denNgay)` — công thức của thấu chi.
 *
 * Vì sao phải chia đoạn: ngân hàng tính lãi trên dư nợ THỰC của từng ngày, nên một lần trả bớt gốc
 * giữa kỳ làm lãi giảm ngay từ hôm đó. Lấy "dư nợ đầu kỳ × số ngày" (cách của vay kỳ hạn) sẽ đòi
 * thừa hàng trăm nghìn. Mốc chia = mọi ngày dư nợ ĐỔI trong khoảng: ngày dòng LOAN_IN + các ngày
 * trả gốc.
 *
 * Làm tròn ĐÚNG MỘT LẦN ở cuối (nửa lên), không làm tròn từng đoạn — làm tròn từng ngày là dồn sai
 * số theo số đoạn. Nhân bằng `BigInt` vì tích `Σ(dư nợ × ngày) × bp` vượt 2^53 với khoản lớn/dài
 * (2 tỷ × 3.650 ngày × 10.000bp = 7,3e16), tức Number sẽ trả số lệch mà không báo lỗi.
 */
export function laiTheoNgay(
  l: KhoanVayLich,
  traGoc: TraGoc[],
  tuNgay: Date,
  denNgay: Date
): number {
  const dau = startOfDay(tuNgay);
  const cuoi = startOfDay(denNgay);
  if (differenceInCalendarDays(cuoi, dau) <= 0) return 0;

  const moc = [dau, cuoi];
  const themMoc = (d: Date | null) => {
    if (d === null) return;
    const m = startOfDay(d);
    if (m > dau && m < cuoi) moc.push(m);
  };
  themMoc(l.giaiNganNgay);
  for (const t of traGoc) themMoc(t.ngay);
  moc.sort((a, b) => a.getTime() - b.getTime());

  // Σ(dư nợ × số ngày) — số nguyên, an toàn trong Number (≤ 2e9 × vài chục nghìn ngày).
  let tong = 0;
  for (let i = 0; i + 1 < moc.length; i++) {
    const soNgay = differenceInCalendarDays(moc[i + 1], moc[i]);
    if (soNgay <= 0) continue; // nhiều dòng trả gốc cùng một ngày ⇒ mốc trùng
    // Kẹp ≥ 0: dư nợ âm (sổ ghi thừa) không được sinh lãi ÂM chạy vào Sổ chi phí.
    tong += Math.max(0, duNoTai(l, traGoc, moc[i])) * soNgay;
  }

  // Làm tròn nửa lên trên số nguyên: floor((2·tích + mẫu) / (2·mẫu)).
  const tich = BigInt(tong) * BigInt(l.annualRateBp);
  return Number((tich * BigInt(2) + MAU_LAI_NGAY) / HAI_LAN_MAU);
}

/**
 * Đề xuất lãi/gốc của kỳ `k`. `lastDueHandled` = con dấu kỳ đã xử lý, BẮT BUỘC truyền (null = chưa
 * kỳ nào) — nó KẸP mốc đầu kỳ.
 *
 * Vì sao phải kẹp: chủ shop sửa `firstDueDate` SAU khi đã duyệt một kỳ thì `due_{k−1}` của lịch mới
 * có thể lùi về TRƯỚC ngày kỳ vừa trả. Dòng `LOAN_REPAY` của kỳ đó nằm SAU mốc nên bị bỏ qua ⇒ app
 * đề xuất lại NGUYÊN gốc + lãi cả kỳ trên số dư nợ cũ, tức đòi trả hai lần cùng một kỳ. Mốc thật là
 * cái MUỘN HƠN giữa `due_{k−1}` và con dấu.
 */
export function deXuatKy(
  l: KhoanVayLich,
  traGoc: TraGoc[],
  k: number,
  lastDueHandled: Date | null
): DeXuatKy {
  if (!coLich(l)) throw new Error("Khoản vay không có lịch trả");
  const mocLich = ngayTraKy(l, k - 1);
  const conDau = lastDueHandled === null ? null : startOfDay(lastDueHandled);
  const tuNgay = conDau !== null && conDau > mocLich ? conDau : mocLich;
  const denNgay = ngayTraKy(l, k);
  // Kẹp ≥ 0: gọi thẳng `deXuatKy` cho một kỳ đã nằm SAU con dấu cho ra khoảng âm — thà lãi 0 (chủ
  // shop sửa tay được) còn hơn một số lãi âm chạy thẳng vào Sổ chi phí. `kyChoDuyet` không rơi vào
  // nhánh này vì nó chỉ trả kỳ có `due_k` > con dấu.
  const soNgay = Math.max(0, differenceInCalendarDays(denNgay, tuNgay));
  // Dư nợ ĐẦU kỳ = dư nợ tại cuối ngày mốc (đã trừ gốc kỳ trước ghi đúng ngày đó).
  const duNoDauKy = Math.max(0, duNoTai(l, traGoc, tuNgay));

  // Tiền gửi tiết kiệm bắt buộc không phụ thuộc số ngày hay dư nợ: ngân hàng thu đúng số khai mỗi kỳ.
  //
  // Kẹp về 0 cho MỌI loại khác BULLET, TƯỜNG MINH chứ không dựa vào việc cột `tienGuiBatBuocMoiKy`
  // tình cờ đang bằng 0: sổ tiết kiệm bắt buộc là thuộc tính CHỈ CỦA BULLET (khoản thấu chi tất toán
  // qua `tat-toan-thau-chi.ts` — đường đó mù `DEPOSIT_*`, nó đóng khoản mà không hoàn, rồi
  // `kiemKhoanVay` chặn mọi lượt ghi vào khoản đã đóng ⇒ tiền của chủ shop mất dấu vĩnh viễn khỏi
  // quỹ). Một bản ghi cũ còn sót số tiền gửi vì thế KHÔNG được đẻ ra đề xuất DEPOSIT_OUT.
  const tienGui = l.kind === "BULLET" ? l.tienGuiBatBuocMoiKy : 0;
  const chung = { ky: k, tuNgay, denNgay, soNgay, duNoDauKy, tienGui };

  // `switch` CẠN KIỆT (nhánh `default` gán vào `never`): thêm một loại vay mới mà quên chỗ này thì
  // `tsc --noEmit` đỏ ngay, thay vì âm thầm rơi vào công thức của vay kỳ hạn.
  switch (l.kind) {
    // Thấu chi: ngân hàng CHỈ thu lãi mỗi kỳ (gốc trả khi tất toán) và lãi tính theo ngày trên dư nợ
    // từng đoạn. Gốc 0 là ĐỀ XUẤT — tháng nào chủ shop trả bớt gốc thì sửa tay ở thẻ kỳ.
    case "OVERDRAFT":
      return { ...chung, lai: laiTheoNgay(l, traGoc, tuNgay, denNgay), goc: 0 };

    case "TERM":
    case "BULLET": {
      const termMonths = l.termMonths;
      if (termMonths === null) throw new Error("Khoản vay không có lịch trả");
      // BULLET khai lãi CỐ ĐỊNH theo giấy của ngân hàng: tháng 30 ngày hay 31 ngày đều thu đúng số
      // đó, tính lại theo %/năm sẽ lệch vài chục nghìn mỗi kỳ. Đọc `laiCoDinhMoiKy` CHỈ ở nhánh
      // BULLET: một khoản TERM còn sót số cũ (đổi loại sau khi khai) không được lấy số đó thay công
      // thức theo ngày.
      const laiKhai = l.kind === "BULLET" ? l.laiCoDinhMoiKy : null;
      // Nhân trước chia sau, làm tròn MỘT lần. 2e9 × 1e4 × 366 < 2^53.
      const lai = laiKhai ?? Math.round((duNoDauKy * l.annualRateBp * soNgay) / (10_000 * 365));
      const gocGiaiNgan = l.duNoMoSo + l.giaiNgan;
      // BULLET trả gốc TRỌN ở kỳ cuối ⇒ gốc đều = 0: kỳ 1…n−1 ra `min(dư nợ, 0) = 0`, kỳ n rơi vào
      // vế `k >= termMonths` nên ra đúng dư nợ còn lại. Không cần nhánh tính gốc thứ hai.
      const gocDeu = l.kind === "BULLET" ? 0 : Math.round(gocGiaiNgan / termMonths);
      const goc = k >= termMonths ? duNoDauKy : Math.min(duNoDauKy, gocDeu);
      return { ...chung, lai, goc };
    }

    default: {
      const loaiChuaXuLy: never = l.kind;
      throw new Error(`deXuatKy: loại khoản vay chưa hỗ trợ "${String(loaiChuaXuLy)}"`);
    }
  }
}

/** Kỳ SỚM NHẤT đã tới hạn mà chưa xử lý: due_k ≤ endOfDay(homNay) và (lastDueHandled null hoặc due_k > lastDueHandled). */
export function kyChoDuyet(
  l: KhoanVayLich,
  traGoc: TraGoc[],
  lastDueHandled: Date | null,
  homNay: Date
): DeXuatKy | null {
  if (!coLich(l)) return null;
  const han = endOfDay(homNay);
  const tran = soKyToiDa(l);
  for (let k = 1; k <= tran; k++) {
    const due = ngayTraKy(l, k);
    if (due > han) return null;
    if (lastDueHandled !== null && due <= startOfDay(lastDueHandled)) continue;
    const dx = deXuatKy(l, traGoc, k, lastDueHandled);
    // Dư nợ về 0 KHÔNG còn là dấu hiệu "hết nghĩa vụ": BULLET khai lãi CỐ ĐỊNH, độc lập dư nợ, và
    // tiền gửi tiết kiệm bắt buộc cũng vậy. Trả bớt gốc sớm ở kỳ 33 mà chỉ xét dư nợ thì kỳ 34–36
    // biến mất khỏi màn hình trong khi ngân hàng vẫn thu đủ 3 kỳ lãi — số đó không bao giờ vào Sổ
    // chi phí và Lãi/Lỗ báo lãi khống. TERM/OVERDRAFT không đổi hành vi: lãi hai loại đó tỉ lệ dư
    // nợ (dư nợ 0 ⇒ lãi 0) và `tienGui` nay LUÔN 0 ngoài BULLET.
    return dx.duNoDauKy > 0 || dx.lai > 0 || dx.tienGui > 0 ? dx : null;
  }
  return null;
}

/**
 * Đếm số kỳ ĐÃ TỚI HẠN tính tới `homNay` — cho câu "Sẽ có {n} kỳ chờ duyệt" ở form khoản vay. Chỉ
 * đếm theo LỊCH (không đụng dòng tiền, không con dấu) vì form đang khai khoản vay MỚI: chưa có dòng
 * trả gốc nào để trừ. Dừng ở kỳ đầu tiên vượt hạn — `due_k` tăng đơn điệu.
 */
export function demKyDaToiHan(l: KhoanVayLich, homNay: Date): number {
  if (!coLich(l)) return 0;
  const han = endOfDay(homNay);
  let n = 0;
  const tran = soKyToiDa(l);
  for (let k = 1; k <= tran; k++) {
    if (ngayTraKy(l, k) > han) break;
    n++;
  }
  return n;
}

/**
 * `demKyDaToiHan` cho form khai khoản vay MỚI — nơi gọi chỉ có bốn ô lịch (loại/ngày nền/ngày kỳ
 * đầu/kỳ hạn), chưa có `annualRateBp`/dư nợ/tiền gửi. Gói việc "dựng `KhoanVayLich` RỖNG rồi đếm"
 * ở đây để `khoan-vay-form-fields.tsx` dưới 200 dòng — thuần suy diễn từ lịch, không cần React.
 */
export function soKyChoTheoLich(
  kind: KhoanVayLich["kind"],
  startDate: Date,
  firstDueDate: Date,
  termMonths: number | null,
  homNay: Date
): number {
  return demKyDaToiHan(
    {
      kind,
      startDate,
      firstDueDate,
      termMonths,
      annualRateBp: 0,
      duNoMoSo: 0,
      giaiNgan: 0,
      giaiNganNgay: null,
      laiCoDinhMoiKy: null,
      tienGuiBatBuocMoiKy: 0,
    },
    homNay
  );
}
