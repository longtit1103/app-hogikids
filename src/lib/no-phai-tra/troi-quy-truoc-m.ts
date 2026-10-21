import { z } from "zod";

/**
 * Chỉ báo TRÔI QUỸ TRƯỚC NGÀY BẬT (lõi thuần — không đọc DB).
 *
 * Lúc bật, chủ shop chọn các dòng điều chỉnh (`CUTOVER_ADJ_IN/OUT`, đúng ngày M) sao cho
 * quỹ app cuối M − 1 + Σ điều chỉnh = tiền thật cuối M − 1. Tiền thật của quá khứ không đổi nữa, nên về sau
 * tổng ấy phải đứng yên:
 *
 *   trôi = (Q(M − 1) hiện tại + Σ điều chỉnh hiện tại) − (Q(M − 1) lúc bật + Σ điều chỉnh lúc bật)
 *
 * Mọi đường ghi tay ngày < M đã bị khoá sau bật; lối "sửa số tiền trước mốc" ghi kèm dòng điều chỉnh bù đúng
 * phần chênh ⇒ trôi vẫn 0. Còn lại là dữ liệu MÁY về muộn cho ngày < M (ví Shopee import thêm, TikTok, đơn bán
 * tại quầy đổi trạng thái, ads tự động chốt lại) — các nguồn này không qua cổng tay. Trôi ≠ 0 ⇒ quỹ từ ngày bật
 * lệch tiền thật ĐÚNG bằng số trôi (dương = app cao hơn thật). Chỉ báo CHỈ ĐỌC: chủ shop kiểm rồi tự sửa dòng
 * điều chỉnh mở sổ, app không tự sửa.
 */

/**
 * Loại `YeuCauGhi` của bước bật — CHÉP từ `LOAI_YEU_CAU_BAT` (`ghi-khoi-tao-no-phai-tra.ts`): lưới
 * `tests/chi-action-bat-duoc-import-khoi-tao.test.ts` cấm mọi file `src/` ngoài action bật import module đó.
 * Test của chỉ báo khẳng định hai hằng bằng nhau.
 */
export const LOAI_YEU_CAU_BAT_DOC = "XAC_NHAN_BAT";

/** Hai số lúc bật, rút từ kết quả yêu cầu bật (`YeuCauGhi` loại `XAC_NHAN_BAT`, `ketQua.data`). */
export type SoLieuLucBat = {
  /** Quỹ app cuối M − 1 đúng lúc bật (`vanTayQuy.quyApp`). */
  quyApp: number;
  /** Tác động CÓ DẤU của các dòng điều chỉnh bước bật đã ghi (`dieuChinh`: IN +, OUT −). */
  dieuChinhNet: number;
};

export type SoLieuHienTai = {
  /** Quỹ app cuối M − 1 tính lại bây giờ (cùng hàm vân tay của bước bật). */
  quyApp: number;
  /** Σ CÓ DẤU mọi dòng `CUTOVER_ADJ_*` đang có (kể cả dòng bù của lối sửa số tiền, dòng chủ shop đã sửa). */
  dieuChinhNet: number;
};

const soNguyen = z.number().int();

/**
 * Hình dạng tối thiểu cần đọc của `ketQua` bước bật. Bản bật trước khi có vân tay quỹ thiếu `vanTayQuy` ⇒
 * không đọc được ⇒ ẩn chỉ báo (không đoán số lúc bật).
 */
const KET_QUA_BAT = z.object({
  ok: z.literal(true),
  data: z.object({
    vanTayQuy: z.object({ quyApp: soNguyen }),
    dieuChinh: z.array(z.object({ chieu: z.enum(["IN", "OUT"]), soTien: soNguyen })),
  }),
});

/** `ketQua` JSON của yêu cầu bật ⇒ số lúc bật; thiếu/hỏng (bản cũ chưa lưu vân tay) ⇒ null. */
export function docSoLieuLucBat(ketQua: unknown): SoLieuLucBat | null {
  const r = KET_QUA_BAT.safeParse(ketQua);
  if (!r.success) return null;
  return {
    quyApp: r.data.data.vanTayQuy.quyApp,
    dieuChinhNet: r.data.data.dieuChinh.reduce((s, d) => s + (d.chieu === "IN" ? d.soTien : -d.soTien), 0),
  };
}

/** Σ có dấu của các dòng điều chỉnh đang có: `CUTOVER_ADJ_IN` +, `CUTOVER_ADJ_OUT` −. */
export function netDieuChinh(dong: readonly { kind: string; amount: number }[]): number {
  return dong.reduce((s, d) => {
    if (d.kind === "CUTOVER_ADJ_IN") return s + d.amount;
    if (d.kind === "CUTOVER_ADJ_OUT") return s - d.amount;
    return s;
  }, 0);
}

/** Số trôi (VND, có dấu). Thiếu số lúc bật ⇒ null (ẩn chỉ báo). */
export function tinhTroiQuyTruocM(lucBat: SoLieuLucBat | null, hienTai: SoLieuHienTai): number | null {
  if (lucBat === null) return null;
  return hienTai.quyApp + hienTai.dieuChinhNet - (lucBat.quyApp + lucBat.dieuChinhNet);
}

/** Nguồn của một dòng ngày < M được ghi vào app SAU lúc bật — gợi ý chỗ trôi. */
export type NguonVeMuon = "VI_SHOPEE" | "TIKTOK_VE_BANK" | "ADS_TIKTOK_VI" | "CHI_PHI" | "GHI_TAY" | "THU_NHAP";

export const NHAN_NGUON_VE_MUON: Record<NguonVeMuon, string> = {
  VI_SHOPEE: "Ví Shopee rút về ngân hàng",
  TIKTOK_VE_BANK: "TikTok chuyển về ngân hàng",
  ADS_TIKTOK_VI: "Ads TikTok trừ ví",
  CHI_PHI: "Sổ chi phí",
  GHI_TAY: "Ghi tay Sổ quỹ",
  THU_NHAP: "Thu nhập tài chính",
};

export type DongVeMuon = {
  nguon: NguonVeMuon;
  /** Ngày VN của dòng (`yyyy-MM-dd`). */
  khoaNgay: string;
  /** Tác động CÓ DẤU lên quỹ (vào +, ra −) — cùng dấu với trôi. */
  tacDong: number;
  moTa: string;
};

/** Dòng tác động lớn nhất trước (theo trị tuyệt đối), bỏ dòng 0đ; hoà ⇒ ngày cũ trước. */
export function chonDongNoiBat(dong: readonly DongVeMuon[], toiDa: number): DongVeMuon[] {
  return dong
    .filter((d) => d.tacDong !== 0)
    .sort((a, b) => Math.abs(b.tacDong) - Math.abs(a.tacDong) || a.khoaNgay.localeCompare(b.khoaNgay))
    .slice(0, toiDa);
}
