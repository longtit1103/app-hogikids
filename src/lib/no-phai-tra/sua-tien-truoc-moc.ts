import { format } from "date-fns";

import { formatVnd } from "@/lib/format";
import { TIEN_TO_REF_ID as TIEN_TO_REF_PHIEU_NHAP } from "@/lib/nhap-hang/doi-chieu-phieu-nhap";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";

/**
 * Lõi THUẦN của lối "Sửa số tiền trước mốc" — lối DUY NHẤT đổi số tiền một dòng chi phí ngày < M sau khi đã bật
 * nợ phải trả. Server (`actions/sua-tien-truoc-moc.ts`) và giao diện (hiện nút) dùng chung để luật không lệch.
 *
 * Bất biến cần giữ: `Q(M−1) + Σ CUTOVER_net = hằng số` — quỹ app cuối M−1 cộng điều chỉnh mở sổ chính là tiền thật
 * đầu ngày M. Dòng chi trước M trừ quỹ (mọi danh mục, `dieuKienChiPhiTruQuy` chỉ cắt từ ≥ M) ⇒ đổi số tiền Δ = mới −
 * cũ làm Q(M−1) đổi −Δ ⇒ cùng transaction thêm MỘT dòng điều chỉnh mở sổ mới ngày M: Δ > 0 ⇒ `CUTOVER_ADJ_IN` |Δ|,
 * Δ < 0 ⇒ `CUTOVER_ADJ_OUT` |Δ|. Thêm dòng mới mỗi lần (append-only), KHÔNG BAO GIỜ sửa/xoá dòng của bước bật: chốt
 * chống bật lại đếm dòng `CUTOVER_*`, giảm về 0 là phá chốt.
 *
 * NGOẠI LỆ theo ngày mở sổ D0 (`min(CashMovement.date)`): quỹ chỉ cộng từ D0, dòng chi ngày < D0 KHÔNG nằm trong
 * Q(M−1) ⇒ sửa số tiền chỉ đổi Lãi/Lỗ, KHÔNG bù (bù là quỹ từ M phồng/hụt đúng Δ so với tiền thật). Chưa có D0
 * (sổ quỹ chưa mở) ⇒ cũng không bù. D0 phải đọc TRONG transaction sau khoá chung.
 *
 * Dòng ĐƯỢC sửa: ngày VN < M, nguồn ghi tay / import file / bộ sinh định kỳ, không thẻ. Dòng định kỳ an toàn: bộ sinh
 * chống trùng theo `(recurringId, recurringMonth)` (UNIQUE + `ON CONFLICT DO NOTHING`), KHÔNG theo số tiền ⇒ dòng đã
 * sửa vẫn chiếm ô tháng đó, không bị sinh lại; khai nhầm số tiền định kỳ là ca chủ shop cần sửa nhất. Bị loại (mỗi lý
 * do một mã):
 *  - Nhập hàng (`purchase`) hoặc `refId` phiếu nhập Pancake (kể cả đã đổi sang danh mục khác): "đã trả trước" của
 *    phiếu tra theo `refId` KHÔNG lọc danh mục ⇒ đổi số là nợ phiếu lệch, và Σ phiếu Y của vân tay bước bật lệch;
 *  - ADS_API: cửa máy ghi đè lại theo số nền tảng báo ⇒ phần bù thành sai;
 *  - lãi vay sinh cùng kỳ trả nợ / tất toán thấu chi (`refId` `LOAN:`): nửa còn lại của MỘT khoản trả ngân hàng
 *    (gốc đi `CashMovement` < M đã khoá) — sửa riêng nửa lãi là tách khỏi khoản trả thật (đồng bộ luật kỳ vay < M sau
 *    bật chỉ được đóng kỳ, không ghi tiền);
 *  - có thẻ (`cardId`): phòng thủ — dòng < M không thể mang thẻ (cửa sổ ghi thẻ ≥ M), thẻ có điểm neo riêng.
 */

/** `refId` của dòng lãi do duyệt kỳ trả nợ / tất toán thấu chi sinh ra (`LOAN:{loanId}:{yyyy-MM-dd}`). */
export const TIEN_TO_REF_LAI_VAY = "LOAN:";

/** Trần số tiền chi phí (Int32 an toàn, cùng trần form Sổ chi phí). */
export const TRAN_SO_TIEN_CHI_PHI = 2_000_000_000;

/** Trần mô tả `CashMovement` — cùng trần form dòng tiền. */
export const TRAN_MO_TA_DONG_TIEN = 200;

/** Dòng chi phí đem xét — bản đọc LẠI sau khoá chung (server) hoặc dòng đang hiện (giao diện). */
export type DongChiXetSuaTien = {
  date: Date;
  categoryId: string;
  refId: string | null;
  source: string;
  cardId: string | null;
};

export type LyDoKhongSuaTien =
  | "CHUA_BAT"
  | "TU_NGAY_BAT"
  | "NHAP_HANG"
  | "CHI_PHI_MAY"
  | "LAI_VAY"
  | "CO_THE";

/** Luật đủ tư cách: `null` = sửa được; ngược lại là lý do đầu tiên chặn (thứ tự cố định để câu báo ổn định). */
export function lyDoKhongSuaTienTruocMoc(dong: DongChiXetSuaTien, mocM: Date | null): LyDoKhongSuaTien | null {
  if (mocM === null) return "CHUA_BAT";
  if (khoaNgayVn(dong.date) >= khoaNgayVn(mocM)) return "TU_NGAY_BAT";
  if (dong.categoryId === "purchase" || dong.refId?.startsWith(TIEN_TO_REF_PHIEU_NHAP)) return "NHAP_HANG";
  if (dong.source === "ADS_API") return "CHI_PHI_MAY";
  if (dong.refId?.startsWith(TIEN_TO_REF_LAI_VAY)) return "LAI_VAY";
  if (dong.cardId !== null) return "CO_THE";
  return null;
}

/** Câu tiếng Việt cho từng lý do — server trả về toast. */
export function cauKhongSuaTien(lyDo: LyDoKhongSuaTien, mocM: Date | null): string {
  const ngay = mocM === null ? "" : format(mocM, "dd/MM/yyyy");
  switch (lyDo) {
    case "CHUA_BAT":
      return "Chưa bật theo dõi nợ phải trả — sửa số tiền như thường ở Sổ chi phí.";
    case "TU_NGAY_BAT":
      return `Chỉ dùng lối này cho chi phí trước ngày bật theo dõi nợ (${ngay}) — dòng từ ngày đó sửa như thường.`;
    case "NHAP_HANG":
      return (
        "Chi phí Nhập hàng (hoặc dòng sinh từ phiếu nhập Pancake) không sửa số tiền được — số đó là phần đã trả " +
        "của phiếu trong sổ nợ."
      );
    case "CHI_PHI_MAY":
      return "Dòng quảng cáo tự động từ API — máy sẽ ghi lại theo số nền tảng báo, không sửa tay được.";
    case "LAI_VAY":
      return (
        "Dòng lãi vay sinh cùng kỳ trả nợ / tất toán (chung một khoản trả ngân hàng) — không sửa riêng số lãi " +
        "trước ngày bật được."
      );
    case "CO_THE":
      return "Khoản chi trừ vào thẻ không sửa số tiền ở đây được.";
  }
}

/** Chiều + số tiền dòng điều chỉnh mở sổ ghi thêm, hoặc không bù (dòng ngoài quỹ: trước D0 / chưa mở sổ). */
export type KeHoachBu = { coBu: false } | { coBu: true; chieu: "IN" | "OUT"; soTien: number };

/**
 * Bù cho lượt đổi `cu → moi` (≠ nhau — người gọi đã chặn Δ = 0). Dòng ngày ≥ D0 (ngày VN) nằm trong Q(M−1) ⇒ bù
 * +Δ vào điều chỉnh mở sổ: Δ > 0 (chi tăng, quỹ cuối M−1 giảm) ⇒ VÀO; Δ < 0 ⇒ RA. Ngày < D0 hoặc chưa có D0 ⇒
 * không bù.
 */
export function keHoachBuSuaTien(ngayDong: Date, cu: number, moi: number, d0: Date | null): KeHoachBu {
  if (d0 === null || khoaNgayVn(ngayDong) < khoaNgayVn(d0)) return { coBu: false };
  const delta = moi - cu;
  return { coBu: true, chieu: delta > 0 ? "IN" : "OUT", soTien: Math.abs(delta) };
}

function cat(s: string, toiDa: number): string {
  const gon = s.trim().replace(/\s+/g, " ");
  return gon.length <= toiDa ? gon : `${gon.slice(0, toiDa - 1)}…`;
}

type ThongTinSua = { ngayDong: Date; moTaDong: string; cu: number; moi: number; lyDo: string };

/**
 * Mô tả dòng điều chỉnh bù — lưu vĩnh viễn, phải nêu ĐÚNG dòng chi được sửa (ngày + mô tả) và số cũ → mới. Phần
 * lý do đứng cuối nên khi vượt trần chỉ lý do bị cắt; luôn ≤ `TRAN_MO_TA_DONG_TIEN` và không rỗng.
 */
export function moTaDongBu(t: ThongTinSua): string {
  const moTa = cat(t.moTaDong, 40) || "(không mô tả)";
  const dau =
    `Bù sửa chi phí ${format(t.ngayDong, "dd/MM/yyyy")} "${moTa}": ` + `${formatVnd(t.cu)} → ${formatVnd(t.moi)}`;
  return cat(`${dau} — ${t.lyDo}`, TRAN_MO_TA_DONG_TIEN);
}

/** Mô tả nhật ký (`doiTuong.moTa`): số cũ → mới + có/không bù (nhật ký không mang số tiền ở `ghiChu`). */
export function moTaNhatKySuaTien(t: ThongTinSua & { bu: KeHoachBu; mocM: Date }): string {
  const dau =
    `Sửa số tiền chi phí ${format(t.ngayDong, "dd/MM/yyyy")} "${cat(t.moTaDong, 40)}": ` +
    `${formatVnd(t.cu)} → ${formatVnd(t.moi)}`;
  const bu = t.bu.coBu
    ? ` · bù điều chỉnh mở sổ ${t.bu.chieu === "IN" ? "vào" : "ra"} ${formatVnd(t.bu.soTien)} ngày ` +
      format(t.mocM, "dd/MM/yyyy")
    : " · không bù (dòng nằm ngoài quỹ: trước ngày mở sổ quỹ)";
  return `${dau}${bu} · lý do: ${cat(t.lyDo, 120)}`;
}

/** Kết quả trả về giao diện để báo. */
export type KetQuaSuaTienTruocMoc = { coBu: boolean; chieu?: "IN" | "OUT"; soTienBu?: number };

export type MaLoiSuaTien = LyDoKhongSuaTien | "KHONG_TIM_THAY" | "SO_TIEN_DA_DOI" | "SO_TIEN_KHONG_DOI";

/** Lỗi nghiệp vụ của lối sửa — action bắt và trả `{ code, error }`; transaction lùi trọn. */
export class LoiSuaTienTruocMoc extends Error {
  constructor(
    readonly code: MaLoiSuaTien,
    message: string
  ) {
    super(message);
    this.name = "LoiSuaTienTruocMoc";
  }
}
