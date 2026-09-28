import { startOfMonth, subMonths } from "date-fns";

import type { DateRange } from "@/lib/date-range";
import { formatVnd } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import type { SoQuyThang } from "@/lib/so-quy/cong-thuc-so-quy";

/**
 * Đối chiếu số dư THẬT cuối tháng (chủ shop chốt tay) với số CUỐI KỲ của sổ quỹ.
 *
 * Sổ quỹ là tổng luỹ kế của 6 nguồn, KHÔNG có phép so nào với tiền thật — một dòng ghi sai từ tháng 5
 * làm quỹ lệch mãi tới tháng 12 mà không thứ gì đỏ. Bản chốt là hàng rào DUY NHẤT bắt lớp lỗi đó.
 *
 * Trục dòng tiền thuần: KHÔNG chạm Lãi/Lỗ (lưới `khong-ro-ri-vao-pnl.test.ts`), KHÔNG sửa công thức
 * sổ quỹ (`cong-thuc-so-quy.ts`) — module này chỉ ĐỌC `cuoiKy` đã tính rồi trừ.
 *
 * HAI KHOẢN CẤU TRÚC làm tiền thật lệch sổ mà KHÔNG phải sai sổ — bỏ qua là hàng rào tự sinh chênh
 * lệch giả rồi chỉ chủ shop sửa sổ ngược chiều:
 *  - THẤU CHI: `LOAN_IN` thấu chi là tiền VÀO quỹ, còn app ngân hàng thì âm ⇒ `quỹ = bank + tiền mặt
 *    + dư nợ thấu chi` (cùng đẳng thức với footnote thẻ Quỹ). Đây là số TẤT ĐỊNH nên tự cộng vào.
 *  - TIỀN ĐANG GỬI (sổ tiết kiệm sinh lãi `SAVINGS_OUT` + tiền gửi bắt buộc `DEPOSIT_OUT`): đã TRỪ khỏi
 *    quỹ nhưng vẫn hiện trong app ngân hàng. Không biết chủ shop có cộng nhầm hay không ⇒ chỉ dặn
 *    trước ở form, và khi chênh lệch ĐÚNG BẰNG số đang gửi thì nói thẳng "bạn cộng nhầm rồi".
 */

/** Hai số chủ shop gõ. `soDuBank` được phép ÂM (thấu chi), `tienMat` thì không (CHECK trong DB). */
export type BanChot = { soDuBank: number; tienMat: number };

/** Dòng đã đọc từ DB (hoặc null) — chỉ các trường thẻ cần, để hàm ghép không phụ thuộc kiểu Prisma. */
export type DongChot = BanChot & { thang: Date; note: string; updatedAt: Date };

export type KhoanCauTruc = {
  /** Σ dư nợ thấu chi còn hiệu lực — số dư bank THẤP hơn quỹ đúng bằng số này. */
  duNoThauChi: number;
  /** Σ tiền đang gửi (sổ tiết kiệm sinh lãi + tiền gửi bắt buộc) — đã trừ khỏi quỹ, KHÔNG được cộng vào số dư. */
  tienDangGui: number;
};

export const CAU_TRUC_RONG: KhoanCauTruc = { duNoThauChi: 0, tienDangGui: 0 };

/** Từ danh sách khoản vay + Σ sổ tiết kiệm đang gửi — cùng phép lọc với footnote của thẻ Quỹ. */
export function tinhKhoanCauTruc(
  loans: { kind: string; closedAt: Date | null; duNo: number; tienGuiDangGiu: number }[],
  tietKiemDangGui: number
): KhoanCauTruc {
  const conHieuLuc = loans.filter((l) => l.closedAt === null);
  return {
    duNoThauChi: conHieuLuc.filter((l) => l.kind === "OVERDRAFT").reduce((s, l) => s + l.duNo, 0),
    tienDangGui: conHieuLuc.reduce((s, l) => s + l.tienGuiDangGiu, 0) + tietKiemDangGui,
  };
}

/** Khoá của bản chốt: ngày ĐẦU tháng 00:00 giờ VN. Mọi ngày trong tháng về cùng một mốc. */
export function thangChot(d: Date): Date {
  return startOfMonth(d);
}

/**
 * `chenhLechTho = (bank + tiền mặt) − cuoiKy` · `chenhLech = chenhLechTho + dư nợ thấu chi` — số ĐỂ
 * KẾT LUẬN. Quy ước dấu: DƯƠNG là tiền thật NHIỀU HƠN sổ (thu chưa ghi / chi ghi thừa); ÂM là sổ nhiều
 * hơn tiền thật (chi chưa ghi / thu ghi thừa). Thẻ phải in CHỮ theo quy ước này, không chỉ in số.
 */
export function tinhChenhLechChot(
  chot: BanChot,
  cuoiKy: number,
  duNoThauChi = 0
): { soChot: number; chenhLechTho: number; chenhLech: number } {
  const soChot = chot.soDuBank + chot.tienMat;
  const chenhLechTho = soChot - cuoiKy;
  return { soChot, chenhLechTho, chenhLech: chenhLechTho + duNoThauChi };
}

export type CauChenhLech = {
  nhan: string;
  giaiThich: string;
  tone: "khop" | "duong" | "am";
};

/**
 * Câu diễn giải chênh lệch (đã tính thấu chi). Mỗi nhánh chỉ ĐÚNG hướng đi tìm; nhánh dương còn phải
 * loại trừ ca "cộng nhầm tiền đang gửi" trước khi kết luận sai sổ — đây là lỗi thật dễ mắc nhất.
 */
/**
 * Sổ quỹ đã trừ ads chạy bằng thẻ tín dụng ngay ngày chạy, còn tiền chỉ rời ngân hàng lúc trả sao kê ⇒
 * số dư đem so phải TRỪ dư nợ thẻ chưa thanh toán. Đứng ĐẦU danh sách nguyên nhân "tiền thật nhiều hơn
 * sổ" vì đây là nguyên nhân THƯỜNG TRỰC (có mặt mọi tháng còn nợ thẻ), không phải sai sót.
 */
export const CAU_NO_THE_TIN_DUNG =
  "Kiểm trước: quảng cáo trả bằng thẻ tín dụng đã trừ vào sổ ngay ngày chạy — dư nợ thẻ CHƯA thanh toán phải trừ khỏi số dư ngân hàng khi chốt.";

export function cauChenhLech(chenhLech: number, cauTruc: KhoanCauTruc = CAU_TRUC_RONG): CauChenhLech {
  const { duNoThauChi, tienDangGui } = cauTruc;
  if (chenhLech === 0) {
    return {
      nhan: "Khớp sổ",
      giaiThich:
        duNoThauChi > 0
          ? `Tiền thật + dư nợ thấu chi ${formatVnd(duNoThauChi)} bằng đúng số cuối kỳ của sổ quỹ.`
          : "Tiền thật bằng đúng số cuối kỳ của sổ quỹ.",
      tone: "khop",
    };
  }
  if (chenhLech > 0) {
    const nhan = `Tiền thật NHIỀU HƠN sổ ${formatVnd(chenhLech)}`;
    if (tienDangGui > 0 && chenhLech === tienDangGui) {
      return {
        nhan,
        giaiThich: `Đúng bằng ${formatVnd(tienDangGui)} đang gửi tiết kiệm / tiền gửi bắt buộc — bạn đã cộng số đó vào số dư ngân hàng. Trừ ra là khớp, KHÔNG phải sai sổ.`,
        tone: "duong",
      };
    }
    return {
      nhan,
      giaiThich:
        "Có khoản thu chưa ghi vào sổ, hoặc khoản chi ghi thừa / ghi trùng." +
        // Quảng cáo trả bằng THẺ TÍN DỤNG (chủ shop chốt 24/09): sổ trừ chi phí ads ngay ngày chạy, còn tiền
        // chỉ rời ngân hàng lúc thanh toán sao kê ⇒ chưa trả thẻ thì tiền thật "thừa" đúng bằng dư nợ thẻ.
        ` ${CAU_NO_THE_TIN_DUNG}` +
        (tienDangGui > 0
          ? ` Kiểm trước: số dư bạn gõ có cộng nhầm ${formatVnd(tienDangGui)} đang gửi tiết kiệm / tiền gửi bắt buộc không.`
          : ""),
      tone: "duong",
    };
  }
  return {
    nhan: `Sổ NHIỀU HƠN tiền thật ${formatVnd(-chenhLech)}`,
    giaiThich: "Có khoản chi chưa ghi vào sổ, hoặc khoản thu ghi thừa / ghi trùng.",
    tone: "am",
  };
}

/** Vì sao thẻ không có gì để so — nói rõ thay vì im. */
export type KhaDungChot = "ok" | "chua_mo_so" | "truoc_mo_so";

export type DoiChieuSoDuChot = {
  thang: Date;
  khaDung: KhaDungChot;
  /** Bản chốt của tháng đang xem; null = chưa chốt (hoặc không khả dụng). */
  chot: DongChot | null;
  /** Số cuối kỳ sổ quỹ của tháng — lấy NGUYÊN từ `tinhSoQuyThang`, không tính lại. */
  cuoiKy: number;
  /** Quỹ tới hôm nay — để thẻ nói "cuối kỳ là số dự kiến" CHỈ khi hai số thật sự khác nhau. */
  quyHomNay: number;
  cauTruc: KhoanCauTruc;
  soChot: number | null;
  chenhLechTho: number | null;
  chenhLech: number | null;
  /** Tháng liền trước đã tới lúc chốt mà chưa có bản chốt — null nếu đã chốt hoặc chưa tới lúc. */
  thangTruocChuaChot: Date | null;
};

export async function docSoDuChot(thang: Date): Promise<DongChot | null> {
  return prisma.soDuChotThang.findUnique({ where: { thang: thangChot(thang) } });
}

/**
 * Ghép bản chốt (đã đọc, hoặc null) với `soQuy` đã tính cho CÙNG tháng — THUẦN, không chạm DB.
 * Tách riêng để `tai-chinh/page.tsx` đọc `docSoDuChot` trong CÙNG `Promise.all` với các nguồn khác
 * rồi ghép sau. `range` của tab Dòng tiền luôn là một tháng dương lịch trọn nên tháng = `thangChot(range.from)`.
 *
 * Caller tự fetch nên hợp đồng "dòng đúng tháng" được KIỂM chứ không chỉ ghi ở comment: ghép nhầm
 * dòng của tháng khác là thẻ in chênh lệch của một thế giới khác mà trông vẫn hợp lý.
 */
export function ghepDoiChieuSoDuChot(
  range: DateRange,
  soQuy: SoQuyThang,
  dong: { thangNay: DongChot | null; thangTruoc: DongChot | null },
  cauTruc: KhoanCauTruc = CAU_TRUC_RONG
): DoiChieuSoDuChot {
  const thang = thangChot(range.from);
  const thangTruoc = subMonths(thang, 1);
  for (const [ten, row, mong] of [
    ["thangNay", dong.thangNay, thang],
    ["thangTruoc", dong.thangTruoc, thangTruoc],
  ] as const) {
    if (row !== null && row.thang.getTime() !== mong.getTime()) {
      throw new Error(`ghepDoiChieuSoDuChot: dòng ${ten} thuộc tháng khác tháng đang ghép`);
    }
  }

  const khong = {
    thang,
    chot: null,
    cuoiKy: soQuy.cuoiKy,
    quyHomNay: soQuy.quyHomNay,
    cauTruc,
    soChot: null,
    chenhLechTho: null,
    chenhLech: null,
    thangTruocChuaChot: null,
  } as const;
  if (soQuy.d0 === null) return { ...khong, khaDung: "chua_mo_so" };
  if (soQuy.truocMoSo) return { ...khong, khaDung: "truoc_mo_so" };

  // Tháng trước "tới lúc chốt" khi nó không nằm trước tháng mở sổ. (Không kiểm "chưa hết tháng": đã
  // là tháng liền trước tháng đang xem thì chắc chắn đã qua ít nhất một ngày cuối tháng.)
  const thangTruocChuaChot =
    dong.thangTruoc === null && thangTruoc.getTime() >= thangChot(soQuy.d0).getTime() ? thangTruoc : null;

  if (dong.thangNay === null) return { ...khong, khaDung: "ok", thangTruocChuaChot };
  const { soChot, chenhLechTho, chenhLech } = tinhChenhLechChot(dong.thangNay, soQuy.cuoiKy, cauTruc.duNoThauChi);
  return {
    ...khong,
    khaDung: "ok",
    chot: dong.thangNay,
    soChot,
    chenhLechTho,
    chenhLech,
    thangTruocChuaChot,
  };
}

/** Đọc + ghép trong một lời gọi — cho nơi không có sẵn `Promise.all` để gom (test, script). */
export async function doiChieuSoDuChot(
  range: DateRange,
  soQuy: SoQuyThang,
  cauTruc: KhoanCauTruc = CAU_TRUC_RONG
): Promise<DoiChieuSoDuChot> {
  const thang = thangChot(range.from);
  const [thangNay, thangTruoc] = await Promise.all([docSoDuChot(thang), docSoDuChot(subMonths(thang, 1))]);
  return ghepDoiChieuSoDuChot(range, soQuy, { thangNay, thangTruoc }, cauTruc);
}
