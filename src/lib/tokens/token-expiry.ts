/**
 * Hạn các token kết nối (Meta Ads, TikTok Shop) — đọc từ bảng `Setting` để HIỆN LÊN MÀN CÀI ĐẶT.
 *
 * VÌ SAO cần hiện trên app: token Meta KHÔNG gia hạn tự động được (đo 2026-07-25: đổi lại token đang
 * sống không kéo dài thêm ngày nào), nên bắt buộc có người vào Graph API Explorer lấy token mới trước
 * hạn. Workflow n8n có cảnh báo, nhưng cảnh báo đó nằm trong log của n8n — chủ shop không mở n8n nên
 * coi như không có. Token chết âm thầm = chi phí quảng cáo ngừng chảy vào P&L = lãi tự nhiên đẹp lên,
 * đúng kiểu hỏng đã giết hệ cũ.
 *
 * Chỉ nhận MỐC HẠN (epoch giây), KHÔNG bao giờ nhận/trả giá trị token.
 */

export type MucCanhBaoToken = "ok" | "sap-het" | "gap" | "het-han" | "chua-biet";

export type HanToken = {
  /** Tên hiển thị cho người không rành kỹ thuật. */
  ten: string;
  /** Một câu giải thích token này dùng để làm gì — mất nó thì mất cái gì. */
  moTa: string;
  conNgay: number | null;
  hetHanLuc: Date | null;
  muc: MucCanhBaoToken;
  /** Máy tự gia hạn được thì người dùng không phải làm gì. */
  tuGiaHan: boolean;
  /** Việc cần làm khi tới hạn — chỉ điền cho token phải làm tay. */
  viecCanLam?: string;
};

/** Còn dưới ngần này ngày thì nhắc; dưới NGAY_GAP thì báo đỏ. Khớp ngưỡng cảnh báo của workflow. */
export const NGAY_SAP_HET = 30;
export const NGAY_GAP = 14;

type CauHinhToken = {
  key: string;
  ten: string;
  moTa: string;
  tuGiaHan: boolean;
  viecCanLam?: string;
};

/**
 * Thứ tự cố ý: token phải làm tay đứng TRƯỚC, vì đó là thứ duy nhất cần chủ shop hành động.
 * `tuGiaHan: true` chỉ hiện cho biết máy đang lo, không bao giờ hiện cảnh báo trừ khi đã hết hạn
 * (hết hạn mà máy vẫn chưa gia hạn ⇒ có gì đó hỏng thật, đáng kêu).
 */
const DANH_SACH: CauHinhToken[] = [
  {
    key: "metaAdsTokenExpireAt",
    ten: "Token quảng cáo Facebook",
    moTa: "Dùng để kéo chi tiêu quảng cáo Facebook vào lãi lỗ. Hết hạn là chi phí quảng cáo ngừng chảy vào báo cáo, lãi trông đẹp hơn thực tế.",
    tuGiaHan: false,
    viecCanLam: "Vào Graph API Explorer lấy token mới, rồi nạp vào hệ thống (Meta không cho gia hạn tự động).",
  },
  {
    key: "metaAdsDataAccessExpireAt",
    ten: "Quyền đọc dữ liệu Facebook",
    moTa: "Hạn thứ hai của Facebook, tính riêng với token. Hết hạn là Facebook từ chối mọi yêu cầu dù token còn sống.",
    tuGiaHan: false,
    viecCanLam: "Cấp quyền lại cho ứng dụng trên Facebook — bắt buộc người thật bấm, không tự động được.",
  },
  {
    key: "tiktokShopAccessTokenExpireAt",
    ten: "Token TikTok Shop",
    moTa: "Dùng để kéo phí sàn và tiền về của TikTok. Máy tự gia hạn trước hạn 36 tiếng.",
    tuGiaHan: true,
  },
  {
    key: "tiktokShopRefreshTokenExpireAt",
    ten: "Khoá gia hạn TikTok Shop",
    moTa: "Khoá để máy tự gia hạn token TikTok. Mất khoá này là phải cấp quyền lại bằng tay.",
    tuGiaHan: false,
    viecCanLam: "Cấp quyền lại cho ứng dụng trên TikTok Shop Partner.",
  },
];

function tinhMuc(conNgay: number | null, tuGiaHan: boolean): MucCanhBaoToken {
  if (conNgay === null) return "chua-biet";
  if (conNgay <= 0) return "het-han";
  // Máy tự gia hạn thì không làm phiền người dùng bằng cảnh báo — chỉ hết hạn thật mới đáng kêu.
  if (tuGiaHan) return "ok";
  if (conNgay < NGAY_GAP) return "gap";
  if (conNgay < NGAY_SAP_HET) return "sap-het";
  return "ok";
}

/**
 * @param mocHan map key→value lấy từ bảng `Setting` (value là epoch GIÂY dạng chuỗi).
 *   Thiếu key hoặc giá trị không phải số dương ⇒ "chưa biết" chứ KHÔNG coi là hết hạn — báo nhầm
 *   "hết hạn" khi chỉ là chưa có dữ liệu sẽ làm người đọc mất tin vào cảnh báo.
 */
export function tinhHanToken(mocHan: Map<string, string>, bayGio: Date = new Date()): HanToken[] {
  const nowMs = bayGio.getTime();
  return DANH_SACH.map((c) => {
    const raw = Number(mocHan.get(c.key) ?? 0);
    const hopLe = Number.isFinite(raw) && raw > 0;
    const hetHanLuc = hopLe ? new Date(raw * 1000) : null;
    const conNgay = hetHanLuc ? Math.floor((hetHanLuc.getTime() - nowMs) / 86_400_000) : null;
    return {
      ten: c.ten,
      moTa: c.moTa,
      conNgay,
      hetHanLuc,
      muc: tinhMuc(conNgay, c.tuGiaHan),
      tuGiaHan: c.tuGiaHan,
      viecCanLam: c.viecCanLam,
    };
  });
}

/** Có gì đáng để chủ shop chú ý ngay không (dùng để quyết định hiện banner). */
export function coCanhBaoToken(ds: HanToken[]): boolean {
  return ds.some((t) => t.muc === "gap" || t.muc === "het-han" || t.muc === "sap-het");
}

/** Key cần lấy từ bảng `Setting` — CHỈ mốc hạn, tuyệt đối không kèm token thô. */
export const KEY_HAN_TOKEN = DANH_SACH.map((c) => c.key);
