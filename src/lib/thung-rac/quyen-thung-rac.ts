import { QUYEN_CHU_SHOP } from "@/lib/quyen/cong-action";
import type { Quyen } from "@/lib/quyen/danh-muc-quyen";
import { coQuyen, laChuShop, type NguoiDung } from "@/lib/quyen/nguoi-dung-phien";
import { BANG_THUNG_RAC, type BangThungRac } from "@/lib/thung-rac/chup-anh-ban-ghi";

/**
 * Quyền của THÙNG RÁC theo LOẠI BẢN GHI thực tế (spec phân quyền §1.4) — không theo trang.
 *
 * Khôi phục / xoá vĩnh viễn một mục là thao tác trên chính loại dữ liệu đó (khôi phục khoản vay =
 * dựng lại dòng gốc vay vào sổ quỹ), nên đòi đúng quyền `sua` của module sở hữu loại đó. `bang` luôn
 * đọc từ DB trong transaction ghi — không bao giờ tin loại do client gửi.
 */
export const QUYEN_THEO_BANG: Readonly<Record<BangThungRac, Quyen>> = Object.freeze({
  Expense: "chi-phi:sua",
  CashMovement: "tai-chinh-dong-tien:sua",
  Loan: "tai-chinh-so-quy:sua",
  SoTietKiem: "tai-chinh-so-quy:sua",
  ThuNhap: "tai-chinh-so-quy:sua",
});

/** Vào màn thùng rác cần ÍT NHẤT MỘT trong ba quyền `sua` (mảng = "ít nhất một" ở cổng). */
export const QUYEN_VAO_THUNG_RAC: readonly Quyen[] = Object.freeze([
  "chi-phi:sua",
  "tai-chinh-dong-tien:sua",
  "tai-chinh-so-quy:sua",
]);


/**
 * Ném TRONG transaction khôi phục / xoá vĩnh viễn khi người gọi thiếu quyền của loại bản ghi vừa
 * đọc — ném (không `return`) để Prisma rollback trọn, kể cả con dấu CAS đã đóng trước đó.
 */
export class LoiThieuQuyenThungRac extends Error {
  /** Mã quyền thiếu cho `ghiChu.quyenThieu` (hoặc `QUYEN_CHU_SHOP` khi loại bản ghi lạ). */
  constructor(public readonly quyenThieu: string) {
    super("Bạn không có quyền thực hiện thao tác này");
    this.name = "LoiThieuQuyenThungRac";
  }
}

/** Quyền THÊM cho dòng tiền gắn khoản vay / sổ tiết kiệm — cùng luật với `cash-movements.ts`. */
const QUYEN_DONG_GAN_SO_QUY: Quyen = "tai-chinh-so-quy:sua";

/**
 * Ảnh chụp một dòng `CashMovement` có mang liên kết khoản vay / sổ tiết kiệm không. Ảnh KHÔNG đọc được
 * (hỏng / shape lạ — kể cả `chinh` là mảng) ⇒ coi như CÓ (fail-closed): khôi phục một dòng không rõ là
 * dựng lại gốc vay mà người gọi có thể không được đụng. Khoá liên kết vắng mặt = không gắn (khôi phục
 * ra đúng một dòng trơn).
 *
 * `listThungRac` lọc danh sách bằng điều kiện SQL TƯƠNG ĐƯƠNG (`DONG_TIEN_TRON_SQL` ở
 * `thung-rac-queries.ts`) — đổi luật ở đây phải đổi cả bên đó; lưới
 * `tests/thung-rac-loc-dong-tien-gan-khoan-vay.integration.test.ts` đối chiếu hai bên trên cùng bộ ảnh.
 */
export function anhDongTienGanSoQuy(anh: unknown): boolean {
  if (anh === null || typeof anh !== "object" || Array.isArray(anh)) return true;
  const chinh = (anh as { chinh?: unknown }).chinh;
  if (chinh === null || typeof chinh !== "object" || Array.isArray(chinh)) return true;
  const { loanId, savingsId } = chinh as { loanId?: unknown; savingsId?: unknown };
  return (loanId !== null && loanId !== undefined) || (savingsId !== null && savingsId !== undefined);
}

/** Các loại bản ghi người dùng được thấy/thao tác trong thùng rác. Chủ shop ⇒ tất cả. */
export function bangDuocPhep(nd: NguoiDung): BangThungRac[] {
  return BANG_THUNG_RAC.filter((b) => coQuyen(nd, QUYEN_THEO_BANG[b]));
}

/**
 * Phạm vi danh sách thùng rác của một người xem — truyền NGUYÊN vào `listThungRac`. Cùng luật với
 * `kiemQuyenBang`: dòng tiền gắn khoản vay / sổ tiết kiệm chỉ hiện khi có `tai-chinh-so-quy:sua` —
 * không khôi phục được thì cũng không được thấy (cột Trạng thái của dòng đó còn nói khoản vay đã tất
 * toán / đã xoá).
 */
export type PhamViThungRac = { bang: readonly BangThungRac[]; xemDongTienGanSoQuy: boolean };

export function phamViThungRac(nd: NguoiDung): PhamViThungRac {
  return { bang: bangDuocPhep(nd), xemDongTienGanSoQuy: coQuyen(nd, QUYEN_DONG_GAN_SO_QUY) };
}

/**
 * Ném `LoiThieuQuyenThungRac` nếu `nd` không được thao tác loại `bang`. `bang` lạ (không thuộc
 * `BANG_THUNG_RAC` — dữ liệu hỏng / bản cũ) ⇒ fail-closed: chỉ chủ shop qua.
 *
 * Dòng `CashMovement` gắn khoản vay / sổ tiết kiệm (đọc từ `anh` trong DB, không tin client) đòi thêm
 * `tai-chinh-so-quy:sua`: khôi phục nó là dựng lại một dòng gốc vay / tiền gửi — đúng việc action
 * dòng tiền đòi quyền Sổ quỹ. Quyền dòng tiền kiểm TRƯỚC để nhật ký nêu đúng quyền thiếu đầu tiên.
 */
export function kiemQuyenBang(nd: NguoiDung, bang: string, anh: unknown): void {
  if (!(BANG_THUNG_RAC as readonly string[]).includes(bang)) {
    if (!laChuShop(nd)) throw new LoiThieuQuyenThungRac(QUYEN_CHU_SHOP);
    return;
  }
  const quyen = QUYEN_THEO_BANG[bang as BangThungRac];
  if (!coQuyen(nd, quyen)) throw new LoiThieuQuyenThungRac(quyen);
  if (bang === "CashMovement" && anhDongTienGanSoQuy(anh) && !coQuyen(nd, QUYEN_DONG_GAN_SO_QUY)) {
    throw new LoiThieuQuyenThungRac(QUYEN_DONG_GAN_SO_QUY);
  }
}
