import { format } from "date-fns";

import type {
  CashMovement,
  Expense,
  KySaoKeThe,
  Loan,
  PhieuNhapNo,
  SoTietKiem,
  TheTinDung,
  ThuNhap,
  ViAdsTraTruoc,
} from "@/generated/prisma/client";

import { CASH_MOVEMENT_KIND_META } from "@/lib/cash-movements/cash-movement-kinds";
import { khoaThangDinhKy } from "@/lib/expenses/khoa-thang-dinh-ky";
import { formatVnd } from "@/lib/format";

/**
 * Hàm THUẦN dựng ảnh chụp một bản ghi tiền sắp bị xoá cứng (bảng `BanGhiDaXoa`): nhãn tiếng Việt,
 * số tiền hiển thị, ngày nghiệp vụ, và payload JSON đủ để dựng lại nguyên trạng.
 *
 * Không đụng Prisma runtime (chỉ import KIỂU) ⇒ test chạy không cần DB, và tầng action là nơi duy
 * nhất biết transaction.
 *
 * NHÃN được LƯU chứ không dựng lại lúc đọc: tên danh mục / tên khoản vay có thể đã đổi hoặc chính
 * bản ghi cha đã bị xoá sau đó, lúc ấy màn thùng rác sẽ in ra một dòng trống không ai nhận ra.
 */

export const BANG_THUNG_RAC = [
  "Expense",
  "CashMovement",
  "ThuNhap",
  "Loan",
  "SoTietKiem",
  // Nợ phải trả — hồ sơ (không mang tiền tự thân). Thẻ chụp KÈM neo/kỳ sao kê con (`AnhBanGhi.kySaoKe`).
  "PhieuNhapNo",
  "TheTinDung",
  "ViAdsTraTruoc",
] as const;

export type BangThungRac = (typeof BANG_THUNG_RAC)[number];

/**
 * Bảng có thể DỰNG LẠI từ ảnh: 8 bảng đứng tên một mục thùng rác + `KySaoKeThe` (chỉ đi KÈM thẻ, không
 * bao giờ là một mục riêng — kỳ sao kê thật không xoá được, neo 0 xoá cùng thẻ).
 */
export type BangDung = BangThungRac | "KySaoKeThe";

/**
 * Trường được chụp của từng bảng — liệt kê TƯỜNG MINH thay vì trải nguyên object, vì hai lý do:
 * (1) lời gọi `findUnique({ include: … })` hay kèm cả object quan hệ (`category`), trải vào ảnh là
 * dựng lại hỏng; (2) thêm cột mới vào 5 bảng này mà quên khai ở đây là ảnh chụp mất cột đó, khôi
 * phục ra một bản ghi khác bản gốc. Lưới `tests/unit/thung-rac/chup-anh-ban-ghi.test.ts` đối chiếu
 * bảng này với schema Prisma bằng máy nên ca (2) luôn đỏ ngay.
 */
export const TRUONG_CHUP: Record<BangDung, readonly string[]> = {
  Expense: [
    "id", "date", "categoryId", "adsSource", "description", "channelId",
    "amount", "source", "refId", "recurringId", "recurringMonth", "createdAt",
    // Nợ phải trả: "trừ vào thẻ". Ảnh chụp trước khi có cột không mang khoá ⇒ khôi phục ra NULL (đúng).
    "cardId",
  ],
  CashMovement: [
    "id", "date", "kind", "amount", "description", "loanId", "savingsId", "createdAt",
    // Nợ phải trả: thẻ / phiếu nhập / ví ads + mã yêu cầu ghi (truy vết). Khôi phục dòng kind mới phải
    // đi đủ cổng nợ phải trả — việc của phase mở đường ghi các kind đó.
    "cardId", "phieuNhapId", "viAdsId", "yeuCauId",
  ],
  ThuNhap: ["id", "date", "kind", "amount", "description", "savingsId", "refId", "createdAt"],
  Loan: [
    "id", "name", "lender", "duNoMoSo", "startDate", "annualRateBp", "termMonths",
    "firstDueDate", "lastDueHandled", "closedAt", "note", "createdAt", "kind",
    "laiCoDinhMoiKy", "tienGuiBatBuocMoiKy",
  ],
  SoTietKiem: [
    "id", "name", "bank", "principal", "startDate", "termMonths", "maturityDate",
    "annualRateBp", "loanId", "closedAt", "note", "createdAt",
  ],
  PhieuNhapNo: [
    "id", "refId", "shopId", "maPhieu", "ngayPhieu", "tongTien", "daTraTruoc", "daHuy",
    "lechDaGiaiThich", "lechDaGiaiThichSo", "note", "createdAt",
  ],
  TheTinDung: ["id", "ten", "nganHang", "ngayChotSaoKe", "ngayHanTra", "closedAt", "note", "createdAt"],
  KySaoKeThe: [
    "id", "cardId", "ngayChot", "soDu", "hanTra", "daTraTruocMoSo", "laNeoMoSo", "uocTinhLucChot",
    "note", "createdAt",
  ],
  ViAdsTraTruoc: ["id", "nenTang", "soDuNeo", "ngayNeo", "nguonNap", "note", "createdAt"],
};

/**
 * Cột kiểu `DateTime` của từng bảng. JSON không có kiểu ngày nên ảnh chụp lưu chuỗi ISO; lúc khôi
 * phục phải đổi NGƯỢC đúng những cột này — quên một cột là Prisma nhận string và ném lỗi kiểu, hoặc
 * tệ hơn, ghi vào một ngày lệch múi giờ.
 */
export const TRUONG_NGAY: Record<BangDung, readonly string[]> = {
  Expense: ["date", "createdAt"],
  CashMovement: ["date", "createdAt"],
  ThuNhap: ["date", "createdAt"],
  Loan: ["startDate", "firstDueDate", "lastDueHandled", "closedAt", "createdAt"],
  SoTietKiem: ["startDate", "maturityDate", "closedAt", "createdAt"],
  PhieuNhapNo: ["ngayPhieu", "createdAt"],
  TheTinDung: ["closedAt", "createdAt"],
  KySaoKeThe: ["ngayChot", "hanTra", "createdAt"],
  ViAdsTraTruoc: ["ngayNeo", "createdAt"],
};

/** Ghi chú khôi phục — những thứ KHÔNG nằm trong chính bản ghi bị xoá nhưng mất theo nó. */
export type GhiChuKhoiPhuc = {
  /** `deleteExpense(mode="stop_recurring")` đã tắt mẫu định kỳ nào. Khôi phục KHÔNG bật lại. */
  recurringDaTat?: string;
  /**
   * Sổ tiết kiệm đang trỏ tới khoản vay này. `SoTietKiem.loanId` là FK `SetNull` ⇒ xoá `Loan` làm
   * liên kết sổ↔vay mất VĨNH VIỄN mà không bảng nào giữ lại; chụp id ở đây để khôi phục nối lại.
   */
  soTietKiemIds?: string[];
};

/** Ảnh chụp đầy đủ nằm trong cột `BanGhiDaXoa.anh`. `ban` = số phiên bản shape. */
export type AnhBanGhi = {
  ban: 1;
  chinh: Record<string, unknown>;
  /** Dòng tiền bị xoá KÈM bản ghi cha (khoản vay / sổ tiết kiệm). Rỗng với 3 bảng còn lại. */
  cashMovements: Record<string, unknown>[];
  /** Thu nhập (lãi tiết kiệm) bị xoá kèm sổ. */
  thuNhap: Record<string, unknown>[];
  /** Neo / kỳ sao kê bị xoá KÈM thẻ (chỉ `TheTinDung`). Ảnh cũ không có khoá ⇒ coi như rỗng. */
  kySaoKe?: Record<string, unknown>[];
  ghiChu: GhiChuKhoiPhuc;
};

export type ThongTinAnh = { nhan: string; soTien: number; ngay: Date; anh: AnhBanGhi };

/** Nguồn dựng ảnh — mỗi bảng đòi đúng phần ngữ cảnh mà nhãn của nó cần. */
export type NguonAnh =
  | { bang: "Expense"; banGhi: Expense; tenDanhMuc: string; ghiChu?: GhiChuKhoiPhuc }
  | { bang: "CashMovement"; banGhi: CashMovement }
  | { bang: "ThuNhap"; banGhi: ThuNhap }
  | { bang: "Loan"; banGhi: Loan; cashMovements: CashMovement[]; ghiChu?: GhiChuKhoiPhuc }
  | { bang: "SoTietKiem"; banGhi: SoTietKiem; cashMovements: CashMovement[]; thuNhap: ThuNhap[] }
  | { bang: "PhieuNhapNo"; banGhi: PhieuNhapNo }
  | { bang: "TheTinDung"; banGhi: TheTinDung; kySaoKe: KySaoKeThe[] }
  | { bang: "ViAdsTraTruoc"; banGhi: ViAdsTraTruoc };

/** Nhãn loại thu nhập — v1 chỉ một loại, nhưng để `Record` thì thêm loại mới là lỗi biên dịch. */
const NHAN_THU_NHAP: Record<ThuNhap["kind"], string> = { LAI_TIET_KIEM: "Lãi tiết kiệm" };

function ngayVn(d: Date): string {
  return format(d, "dd/MM/yyyy");
}

/** Khuôn nhãn chung: "{việc} — {tiền} — {ngày}", đuôi là các ghi chú phụ nối bằng " · ". */
function ghepNhan(viec: string, soTien: number, ngay: Date, duoi: string[]): string {
  return [`${viec} — ${formatVnd(soTien)} — ${ngayVn(ngay)}`, ...duoi.filter((s) => s !== "")].join(
    " · "
  );
}

/** Serialize: chỉ giữ cột đã khai, `Date` → chuỗi ISO (JSONB không có kiểu ngày). */
function chuanHoa(bang: BangDung, banGhi: Record<string, unknown>): Record<string, unknown> {
  const ra: Record<string, unknown> = {};
  for (const truong of TRUONG_CHUP[bang]) {
    const gt = banGhi[truong];
    ra[truong] = gt instanceof Date ? gt.toISOString() : (gt ?? null);
  }
  return ra;
}

/**
 * Đổi NGƯỢC ảnh chụp về `data` cho Prisma `create` — chuỗi ISO → `Date` theo `TRUONG_NGAY`.
 * Xuất ra để `khoi-phuc-ban-ghi.ts` dùng; giữ cạnh `chuanHoa` để hai chiều không bao giờ lệch.
 */
export function doiNguocBanGhi(
  bang: BangDung,
  raw: Record<string, unknown>
): Record<string, unknown> {
  const ra: Record<string, unknown> = { ...raw };
  for (const truong of TRUONG_NGAY[bang]) {
    const gt = ra[truong];
    if (typeof gt === "string") ra[truong] = new Date(gt);
  }
  // Khoá tháng định kỳ TÍNH LẠI từ `date` chứ không tin ảnh: ảnh chụp trước khi có cột
  // `recurringMonth` không mang khoá, mà dòng định kỳ thiếu khoá bị CHECK dưới DB từ chối.
  if (bang === "Expense") {
    ra.recurringMonth =
      typeof ra.recurringId === "string" && ra.date instanceof Date ? khoaThangDinhKy(ra.date) : null;
  }
  return ra;
}

/**
 * Số tiền hiển thị của một khoản vay: `duNoMoSo` với khoản MANG SANG, còn lại là số đã giải ngân.
 * Hồ sơ `Loan` không có cột tiền nào — lấy đại `annualRateBp` hay 0 thì dòng thùng rác in "0 ₫" và
 * chủ shop không nhận ra mình vừa xoá khoản vay 200 triệu nào.
 */
function tienKhoanVay(banGhi: Loan, cashMovements: CashMovement[]): number {
  if (banGhi.duNoMoSo > 0) return banGhi.duNoMoSo;
  return cashMovements
    .filter((m) => m.kind === "LOAN_IN")
    .reduce((tong, m) => tong + m.amount, 0);
}

/** Dựng nhãn + số tiền + ngày + payload cho một bản ghi sắp xoá. Hàm thuần, không chạm DB. */
export function dungAnhBanGhi(nguon: NguonAnh): ThongTinAnh {
  const cashMovements = "cashMovements" in nguon ? nguon.cashMovements : [];
  const thuNhap = "thuNhap" in nguon && Array.isArray(nguon.thuNhap) ? nguon.thuNhap : [];
  const ghiChu = "ghiChu" in nguon && nguon.ghiChu ? nguon.ghiChu : {};
  const kySaoKe = nguon.bang === "TheTinDung" ? nguon.kySaoKe : [];

  const anh: AnhBanGhi = {
    ban: 1,
    chinh: chuanHoa(nguon.bang, nguon.banGhi as unknown as Record<string, unknown>),
    cashMovements: cashMovements.map((m) =>
      chuanHoa("CashMovement", m as unknown as Record<string, unknown>)
    ),
    thuNhap: thuNhap.map((t) => chuanHoa("ThuNhap", t as unknown as Record<string, unknown>)),
    ghiChu,
    ...(kySaoKe.length > 0
      ? { kySaoKe: kySaoKe.map((k) => chuanHoa("KySaoKeThe", k as unknown as Record<string, unknown>)) }
      : {}),
  };

  switch (nguon.bang) {
    case "Expense": {
      const e = nguon.banGhi;
      // Mẫu định kỳ KHÔNG được tự bật lại lúc khôi phục (bật lại là tháng sau sinh thêm một khoản
      // chi chủ shop đã cố ý dừng) — nói thẳng trên nhãn để không ai chờ điều ngược lại.
      const duoi = [
        e.description,
        ghiChu.recurringDaTat ? "đã tắt lặp hàng tháng (khôi phục KHÔNG bật lại)" : "",
      ];
      return {
        nhan: ghepNhan(nguon.tenDanhMuc, e.amount, e.date, duoi),
        soTien: e.amount,
        ngay: e.date,
        anh,
      };
    }
    case "CashMovement": {
      const m = nguon.banGhi;
      return {
        nhan: ghepNhan(CASH_MOVEMENT_KIND_META[m.kind].label, m.amount, m.date, [m.description]),
        soTien: m.amount,
        ngay: m.date,
        anh,
      };
    }
    case "ThuNhap": {
      const t = nguon.banGhi;
      return {
        nhan: ghepNhan(NHAN_THU_NHAP[t.kind], t.amount, t.date, [t.description]),
        soTien: t.amount,
        ngay: t.date,
        anh,
      };
    }
    case "Loan": {
      const l = nguon.banGhi;
      const soTien = tienKhoanVay(l, cashMovements);
      const duoi = [
        cashMovements.length > 0 ? `kèm ${cashMovements.length} dòng tiền` : "",
        (ghiChu.soTietKiemIds?.length ?? 0) > 0
          ? `kèm liên kết ${ghiChu.soTietKiemIds?.length} sổ tiết kiệm`
          : "",
      ];
      return {
        nhan: ghepNhan(`Khoản vay ${l.name}`, soTien, l.startDate, duoi),
        soTien,
        ngay: l.startDate,
        anh,
      };
    }
    case "SoTietKiem": {
      const s = nguon.banGhi;
      const duoi = [
        cashMovements.length > 0 ? `kèm ${cashMovements.length} dòng tiền` : "",
        thuNhap.length > 0 ? `kèm ${thuNhap.length} dòng lãi` : "",
      ];
      return {
        nhan: ghepNhan(`Sổ tiết kiệm ${s.name}`, s.principal, s.startDate, duoi),
        soTien: s.principal,
        ngay: s.startDate,
        anh,
      };
    }
    case "PhieuNhapNo": {
      const p = nguon.banGhi;
      const duoi = [
        p.daHuy ? "đã huỷ" : "",
        p.daTraTruoc > 0 ? `đã trả trước ${formatVnd(p.daTraTruoc)}` : "",
      ];
      return { nhan: ghepNhan(`Phiếu nợ ${p.maPhieu}`, p.tongTien, p.ngayPhieu, duoi), soTien: p.tongTien, ngay: p.ngayPhieu, anh };
    }
    case "TheTinDung": {
      const t = nguon.banGhi;
      // Hồ sơ thẻ không có cột tiền; chỉ thẻ không giao dịch, không kỳ thật, neo 0 mới xoá được ⇒ 0 đúng nghĩa.
      const duoi = [t.nganHang, kySaoKe.length > 0 ? `kèm ${kySaoKe.length} neo dư nợ` : ""];
      return { nhan: ghepNhan(`Thẻ ${t.ten}`, 0, t.createdAt, duoi), soTien: 0, ngay: t.createdAt, anh };
    }
    case "ViAdsTraTruoc": {
      const v = nguon.banGhi;
      return { nhan: ghepNhan(`Ví quảng cáo ${v.nenTang}`, v.soDuNeo, v.ngayNeo, ["số dư neo"]), soTien: v.soDuNeo, ngay: v.ngayNeo, anh };
    }
  }
}
