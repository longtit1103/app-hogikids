import { format } from "date-fns";

import type { CashMovement, Expense, Loan, SoTietKiem, ThuNhap } from "@prisma/client";

import { CASH_MOVEMENT_KIND_META } from "@/lib/cash-movements/cash-movement-kinds";
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
] as const;

export type BangThungRac = (typeof BANG_THUNG_RAC)[number];

/**
 * Trường được chụp của từng bảng — liệt kê TƯỜNG MINH thay vì trải nguyên object, vì hai lý do:
 * (1) lời gọi `findUnique({ include: … })` hay kèm cả object quan hệ (`category`), trải vào ảnh là
 * dựng lại hỏng; (2) thêm cột mới vào 5 bảng này mà quên khai ở đây là ảnh chụp mất cột đó, khôi
 * phục ra một bản ghi khác bản gốc. Lưới `tests/unit/thung-rac/chup-anh-ban-ghi.test.ts` đối chiếu
 * bảng này với schema Prisma bằng máy nên ca (2) luôn đỏ ngay.
 */
export const TRUONG_CHUP: Record<BangThungRac, readonly string[]> = {
  Expense: [
    "id", "date", "categoryId", "adsSource", "description", "channelId",
    "amount", "source", "refId", "recurringId", "createdAt",
  ],
  CashMovement: ["id", "date", "kind", "amount", "description", "loanId", "savingsId", "createdAt"],
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
};

/**
 * Cột kiểu `DateTime` của từng bảng. JSON không có kiểu ngày nên ảnh chụp lưu chuỗi ISO; lúc khôi
 * phục phải đổi NGƯỢC đúng những cột này — quên một cột là Prisma nhận string và ném lỗi kiểu, hoặc
 * tệ hơn, ghi vào một ngày lệch múi giờ.
 */
export const TRUONG_NGAY: Record<BangThungRac, readonly string[]> = {
  Expense: ["date", "createdAt"],
  CashMovement: ["date", "createdAt"],
  ThuNhap: ["date", "createdAt"],
  Loan: ["startDate", "firstDueDate", "lastDueHandled", "closedAt", "createdAt"],
  SoTietKiem: ["startDate", "maturityDate", "closedAt", "createdAt"],
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
  ghiChu: GhiChuKhoiPhuc;
};

export type ThongTinAnh = { nhan: string; soTien: number; ngay: Date; anh: AnhBanGhi };

/** Nguồn dựng ảnh — mỗi bảng đòi đúng phần ngữ cảnh mà nhãn của nó cần. */
export type NguonAnh =
  | { bang: "Expense"; banGhi: Expense; tenDanhMuc: string; ghiChu?: GhiChuKhoiPhuc }
  | { bang: "CashMovement"; banGhi: CashMovement }
  | { bang: "ThuNhap"; banGhi: ThuNhap }
  | { bang: "Loan"; banGhi: Loan; cashMovements: CashMovement[]; ghiChu?: GhiChuKhoiPhuc }
  | { bang: "SoTietKiem"; banGhi: SoTietKiem; cashMovements: CashMovement[]; thuNhap: ThuNhap[] };

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
function chuanHoa(bang: BangThungRac, banGhi: Record<string, unknown>): Record<string, unknown> {
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
  bang: BangThungRac,
  raw: Record<string, unknown>
): Record<string, unknown> {
  const ra: Record<string, unknown> = { ...raw };
  for (const truong of TRUONG_NGAY[bang]) {
    const gt = ra[truong];
    if (typeof gt === "string") ra[truong] = new Date(gt);
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

  const anh: AnhBanGhi = {
    ban: 1,
    chinh: chuanHoa(nguon.bang, nguon.banGhi as unknown as Record<string, unknown>),
    cashMovements: cashMovements.map((m) =>
      chuanHoa("CashMovement", m as unknown as Record<string, unknown>)
    ),
    thuNhap: thuNhap.map((t) => chuanHoa("ThuNhap", t as unknown as Record<string, unknown>)),
    ghiChu,
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
  }
}
