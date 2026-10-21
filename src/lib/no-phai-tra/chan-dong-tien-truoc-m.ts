import { format } from "date-fns";

import type { Prisma } from "@/generated/prisma/client";

import { laNgayTruocMocM } from "@/lib/no-phai-tra/chan-so-chi-phi-da-khoa";
import { docMocM } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";

/**
 * KHOÁ DÒNG TIỀN GHI TAY TRƯỚC M khi đã bật nợ phải trả — MỘT cổng cho mọi đường ghi tiền tay NGOÀI `Expense`
 * (`CashMovement` mọi kind cũ: vay, tiền gửi bắt buộc, sổ tiết kiệm, góp/rút vốn, bán trực tiếp, thu khác…; `ThuNhap`).
 * Đối xứng `chan-so-chi-phi-da-khoa.ts` (cổng của `Expense`).
 *
 * BẤT BIẾN cần giữ sau bật: `Q(M−1) + Σ CUTOVER_net = hằng số` — Q(M−1) là quỹ app cuối ngày trước M theo
 * `cong-thuc-so-quy.ts`, CUTOVER là các dòng `CUTOVER_ADJ_*` bước bật ghi MỘT lần để quỹ tại M khớp tiền thật. Mọi
 * lượt ghi đổi Q(M−1) mà không bù CUTOVER ⇒ quỹ từ M lệch tiền thật đúng số đó. Vì vậy với dòng ngày < M (ngày VN):
 * không thêm, xoá, khôi phục; không đổi ngày, số tiền, loại (đổi chiều vào/ra), hay khoá cha (`loanId`/`savingsId`
 * đổi dư nợ khoản vay / gốc sổ tiết kiệm đã đối chiếu lúc bật; `cardId`/`phieuNhapId`/`viAdsId` đổi
 * nghĩa vụ đã chốt); không dời dòng ≥ M về trước M hay ngược lại.
 *
 * NGOẠI LỆ DUY NHẤT (chủ shop chốt 13/10): SỬA mà chỉ đổi mô tả (`laSuaChiMoTa`) — cùng NGÀY VN, cùng số tiền, kind,
 * năm khoá cha. Chặt hơn `laSuaGiuTien` của Expense (ở đó được đổi danh mục vì danh mục không chạm quỹ; ở đây kind
 * và khoá cha đều chạm quỹ hoặc dư nợ). So ngày theo NGÀY VN, không theo timestamp: quỹ tính theo ngày.
 *
 * KHÔNG thuộc cổng (ngoại lệ có chủ đích):
 *  - `CUTOVER_*`: sửa qua `suaDieuChinhChuyenDoi`, và lối sửa số tiền chi phí trước mốc (tự bù CUTOVER) — chính là
 *    vế bù của bất biến.
 *  - 4 kind nợ `CARD_PAY`·`SUPPLIER_PAY`·`SUPPLIER_REFUND`·`ADS_TOPUP`: đã có cửa sổ ngày ≥ M (`ngayTienMoiSchema`).
 *  - `ghiKhoiTaoNoPhaiTra` (bước bật, giữ khoá EXCLUSIVE) và `data-admin` xoá toàn bộ.
 *
 * HỢP ĐỒNG KHOÁ: người gọi PHẢI đã giữ `khoaChiaSeBatNoPhaiTra(tx)` là câu ĐẦU của CÙNG transaction, gọi cổng SAU khoá
 * (để đọc M mới nhất), và với SUA/XOA truyền bản cũ ĐỌC LẠI sau khoá — không thì lượt ghi đọc M = null trong lúc bước
 * bật chưa commit rồi ghi sau lưng nó, hoặc xét trên bản cũ đã bị lượt khác đổi.
 */

/** Phần "chạm tiền" của một dòng tiền mà lượt sửa có thể đổi. `ThuNhap` không có khoá cha ⇒ truyền `null`. */
export type PhanTienDongTien = {
  date: Date;
  amount: number;
  kind: string;
  loanId: string | null;
  savingsId: string | null;
  cardId: string | null;
  phieuNhapId: string | null;
  viAdsId: string | null;
};

/**
 * Thao tác ghi cần xét:
 *  - `TAO` / `XOA`: một hoặc nhiều dòng (deleteMany, cụm khôi phục thùng rác, duyệt kỳ vay sinh nhiều dòng) — chặn khi
 *    BẤT KỲ ngày nào < M. Mảng rỗng ⇒ không có gì để chặn;
 *  - `SUA`: `cu` = bản đọc LẠI sau khoá chung, `moi` = dữ liệu sẽ ghi.
 */
export type ThaoTacDongTien =
  | { loai: "TAO" | "XOA"; ngay: Date[] }
  | { loai: "SUA"; cu: PhanTienDongTien; moi: PhanTienDongTien };

/** Lượt sửa chỉ đổi mô tả: cùng NGÀY VN, cùng số tiền, kind và cả năm khoá cha. */
export function laSuaChiMoTa(cu: PhanTienDongTien, moi: PhanTienDongTien): boolean {
  return (
    khoaNgayVn(cu.date) === khoaNgayVn(moi.date) &&
    cu.amount === moi.amount &&
    cu.kind === moi.kind &&
    cu.loanId === moi.loanId &&
    cu.savingsId === moi.savingsId &&
    cu.cardId === moi.cardId &&
    cu.phieuNhapId === moi.phieuNhapId &&
    cu.viAdsId === moi.viAdsId
  );
}

/** Lõi THUẦN: `"TRUOC_M"` khi luật chặn, `null` = cho qua. M null (chưa bật) ⇒ luôn `null`; dòng ≥ M giữ luật cũ. */
export function lyDoDongTienTruocM(t: ThaoTacDongTien, mocM: Date | null): "TRUOC_M" | null {
  if (mocM === null) return null;
  switch (t.loai) {
    case "TAO":
    case "XOA":
      return t.ngay.some((d) => laNgayTruocMocM(d, mocM)) ? "TRUOC_M" : null;
    case "SUA":
      if (laSuaChiMoTa(t.cu, t.moi)) return null;
      return laNgayTruocMocM(t.cu.date, mocM) || laNgayTruocMocM(t.moi.date, mocM) ? "TRUOC_M" : null;
  }
}

/** Câu từ chối — dùng chung cho action (toast / ô ngày của form) và cột trạng thái thùng rác. */
export function cauDongTienTruocM(mocM: Date): string {
  return (
    `Dòng tiền trước ngày bật theo dõi nợ (${format(mocM, "dd/MM/yyyy")}) đã chốt vào số dư mở sổ — chỉ sửa được ` +
    `mô tả; không thêm, xoá, khôi phục hay đổi ngày / số tiền / loại / khoản gắn.`
  );
}

/**
 * Tuỳ chọn của lượt từ chối — cho action nói ĐÚNG đường gỡ của nó thay vì câu chung (vd duyệt kỳ vay: "đóng kỳ
 * bằng 'Ngân hàng không thu kỳ này'"; tạo khoản vay: "khai chế độ mang sang"), và trỏ đúng ô của form đang mở.
 * Vắng ⇒ câu chung `cauDongTienTruocM` + ô `date` (hành vi cũ).
 */
export type TuyChonLoiDongTienTruocM = {
  /** Câu riêng, dựng từ M (M chỉ biết SAU khoá chung, nên truyền hàm chứ không truyền chuỗi). */
  cau?: (mocM: Date) => string;
  /** Tên ô form nhận lỗi (form khoản vay dùng `ngayGiaiNgan`/`startDate`, form tất toán `ngayTatToan`…). */
  field?: string;
};

/** Cùng mã `DA_BAT_NO_PHAI_TRA` với `LoiSoChiPhiDaKhoa` — UI đã biết mã này; `field` trỏ ô ngày của form. */
export class LoiDongTienTruocM extends Error {
  readonly code = "DA_BAT_NO_PHAI_TRA" as const;
  readonly field: string;

  constructor(
    readonly mocM: Date,
    tuyChon: TuyChonLoiDongTienTruocM = {},
  ) {
    super(tuyChon.cau ? tuyChon.cau(mocM) : cauDongTienTruocM(mocM));
    this.name = "LoiDongTienTruocM";
    this.field = tuyChon.field ?? "date";
  }
}

/**
 * Cổng của mọi đường ghi tiền tay ngoài `Expense`: đọc M (SAU khoá chung của người gọi) rồi ném `LoiDongTienTruocM`
 * khi luật chặn. M null ⇒ qua. `tuyChon` chỉ đổi câu báo / ô nhận lỗi, KHÔNG đổi luật.
 */
export async function chanDongTienTruocM(
  db: Pick<Prisma.TransactionClient, "setting">,
  t: ThaoTacDongTien,
  tuyChon?: TuyChonLoiDongTienTruocM,
): Promise<void> {
  const mocM = await docMocM(db);
  if (mocM !== null && lyDoDongTienTruocM(t, mocM) !== null) throw new LoiDongTienTruocM(mocM, tuyChon);
}
