/**
 * Mapping Bronze BÁO CÁO quảng cáo (Meta insights / TikTok Business report) → dòng chi tiêu CHƯA
 * VAT, để dựng lại `Expense` (`source=ADS_API`) khi trong tay chỉ còn kho thô.
 *
 * Chi tiêu trong báo cáo là số CHƯA THUẾ ở CẢ HAI sàn, mà VAT không phải field của báo cáo:
 *  - Meta: KHÔNG có API hoá đơn cho tài khoản trả THẺ ⇒ hằng số khai tay, khớp `CONFIG.vatRate`
 *    của `n8n/meta-ads-nightly.json`.
 *  - TikTok: đo từ hoá đơn Business Center đã land trong kho thô — xem `buildVatByMonth`.
 *
 * Tiền trong payload là CHUỖI ("81617", "0" — đã kiểm trên prod 28/07) ⇒ parse rồi làm tròn.
 * Dòng nào không đọc chắc chắn được thì trả LỖI để người gọi BỎ dòng + cảnh báo, KHÔNG ép 0: ghi 0đ
 * vào sổ chi phí là hạ chi phí thật xuống trong im lặng, lãi đẹp lên.
 */

/** VAT Meta — hằng số khai tay (Meta không có API hoá đơn cho tài khoản trả thẻ). */
export const VAT_META = 0.1;

/** VAT dùng khi THÁNG đó không đo được từ hoá đơn TikTok — soi gương `VAT_MAC_DINH` của n8n. */
export const VAT_MAC_DINH = 0.1;

/** Ngoài dải này là bất thường (mapping trôi / hoá đơn lạ) ⇒ không ghi số sai vào sổ. */
const VAT_TRAN_DUOI = 0.03;
const VAT_TRAN_TREN = 0.2;

/** Loại giao dịch hoá đơn tính vào VAT — cùng biểu thức với `tinhVat` của n8n. */
const LOAI_HOA_DON = /BILL|PAYMENT/i;

/** Tiền tệ DUY NHẤT chấp nhận được — ad account đổi tiền tệ là chi tiêu sai ~26.000 lần. */
const TIEN_TE_HOP_LE = "VND";

export type AdsReportRow = {
  /** "YYYY-MM-DD" giờ VN — TZ của cả 2 ad account đều Asia/Ho_Chi_Minh nên map thẳng 1:1. */
  date: string;
  campaignId: string;
  campaignName: string;
  /** Chi tiêu CHƯA thuế, Int đồng. */
  spendExVat: number;
  /** Chỉ TikTok Ads: auction và GMV Max là 2 dòng chi tiêu khác nhau ⇒ tách khoá. */
  adType?: "auction" | "gmv_max";
};

/** Đọc được thì trả dòng; không thì trả LÝ DO để người gọi ghi vào cảnh báo (không nuốt lặng). */
export type KetQuaMapAds = { ok: true; row: AdsReportRow } | { ok: false; loi: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Tiền dạng chuỗi/số → Int đồng. Thiếu / hỏng / âm → null (không ép 0). */
function toSpend(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/** Ngày báo cáo → "YYYY-MM-DD". Sai định dạng → null (biên tháng của P&L phụ thuộc field này). */
function toReportDate(v: unknown): string | null {
  const s = String(v ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function toText(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

/**
 * Meta insights (`time_increment=1`, level=campaign) → dòng chi tiêu.
 * Shape thật: `{spend, campaign_id, campaign_name, date_start, date_stop, account_currency, …}`.
 *
 * GUARD TIỀN TỆ: workflow n8n DỪNG hẳn khi `account_currency` khác VND, nên lượt dựng lại phải chặn
 * y như thế. Bỏ guard thì một ad account trả bằng USD sẽ vào sổ với spend 1.500 → 1.650đ thay vì
 * ~39 triệu — hụt ~26.000 lần trong im lặng. Payload prod 28/07 có field này ở 1320/1320 dòng;
 * thiếu hẳn field thì vẫn cho qua (bản gốc đời cũ), khác VND mới chặn.
 */
export function mapMetaAdsReport(payload: unknown): KetQuaMapAds {
  if (!isObj(payload)) return { ok: false, loi: "payload không phải object" };
  const tienTe = toText(payload.account_currency);
  if (tienTe && tienTe !== TIEN_TE_HOP_LE) {
    return { ok: false, loi: `ad account dùng tiền tệ "${tienTe}", không phải VND` };
  }
  const date = toReportDate(payload.date_start);
  const campaignId = toText(payload.campaign_id);
  const spendExVat = toSpend(payload.spend);
  if (!date || !campaignId || spendExVat === null) {
    return { ok: false, loi: "thiếu date_start / campaign_id / spend" };
  }
  return {
    ok: true,
    row: { date, campaignId, campaignName: toText(payload.campaign_name), spendExVat },
  };
}

/**
 * TikTok Business report → dòng chi tiêu.
 * Shape thật: `{dimensions:{campaign_id, stat_time_day}, metrics:{campaign_name, cost|spend}}`.
 *
 * Loại chiến dịch nhận diện bằng CHÍNH payload (mirror `idExpr` của Bronze ở `streams.ts`): chỉ
 * endpoint auction trả `metrics.spend`, chỉ GMV Max trả `metrics.cost`. Luật này BUỘC hai node
 * `keoReport` của `n8n/tiktok-business-nightly.json` phải xin hai bộ metric RỜI NHAU — thêm `cost`
 * vào node auction (hoặc `spend` vào node GMV Max) là phá khoá Bronze lẫn khoá `Expense`. Có CẢ hai
 * metric ⇒ không còn biết dòng thuộc loại nào ⇒ trả lỗi để bỏ dòng, KHÔNG im lặng đoán auction.
 */
export function mapTiktokAdsReport(payload: unknown): KetQuaMapAds {
  if (!isObj(payload)) return { ok: false, loi: "payload không phải object" };
  const dim = isObj(payload.dimensions) ? payload.dimensions : {};
  const met = isObj(payload.metrics) ? payload.metrics : {};
  const coSpend = met.spend !== null && met.spend !== undefined;
  const coCost = met.cost !== null && met.cost !== undefined;
  if (coSpend && coCost) {
    return {
      ok: false,
      loi: "payload có CẢ metrics.spend lẫn metrics.cost — không xác định được auction hay GMV Max",
    };
  }
  const date = toReportDate(dim.stat_time_day);
  const campaignId = toText(dim.campaign_id);
  const spendExVat = toSpend(coSpend ? met.spend : met.cost);
  if (!date || !campaignId || spendExVat === null) {
    return { ok: false, loi: "thiếu stat_time_day / campaign_id / chi tiêu" };
  }
  return {
    ok: true,
    row: {
      date,
      campaignId,
      campaignName: toText(met.campaign_name),
      spendExVat,
      adType: coSpend ? "auction" : "gmv_max",
    },
  };
}

export type VatTheoThang = {
  /**
   * Tỉ lệ VAT cho một ngày chi tiêu. `null` = tháng đó ĐO ĐƯỢC nhưng tỉ lệ vô lý ⇒ người gọi phải
   * BỎ dòng, không được rơi về mặc định (ghi VAT sai vào sổ chi phí là sai âm thầm).
   */
  rateForDate(date: string): number | null;
};

/**
 * Tỉ lệ VAT quảng cáo TikTok, đo từ hoá đơn Business Center trong kho thô — BẢN SOI GƯƠNG của hàm
 * `tinhVat` trong `n8n/tiktok-business-nightly.json`. HAI NƠI PHẢI ĐỔI CÙNG NHAU: n8n đo VAT cho
 * lượt ghi mỗi đêm, hàm này đo lại cho lượt dựng lại — lệch nhau là cùng một dòng chi phí được ghi
 * bằng hai tỉ lệ thuế khác nhau tuỳ đường nào chạy sau.
 *
 * Vì sao đo chứ không đóng cứng 0,10: nhà nước đổi thuế suất thì hoá đơn kỳ mới mang số mới, còn
 * lượt dựng lại đóng cứng sẽ GHI ĐÈ bằng số cũ — đúng loại lỗi âm thầm mà đường dựng lại này sinh
 * ra để diệt.
 *
 * ⚠️ ĐỪNG đọc thành "đổi thuế thì mọi đường tự bám theo". Chỉ hàm NÀY (đường dựng lại) tra theo
 * tháng; workflow n8n đo MỘT suất cho cả cửa sổ nó vừa kéo, nên một lượt backfill cắt qua ngày đổi
 * thuế vẫn ghi sai âm thầm — điều kiện bắt buộc là cả cửa sổ nằm trong một chế độ thuế
 * (`n8n/huong-dan-cai-dat-workflows.md` §"Cửa sổ ngày"). Và Meta thì không có gì để đo, cả hai
 * đường đều dùng hằng khai tay.
 *
 * Khác n8n ở đúng một điểm, có chủ đích: n8n đo MỘT tỉ lệ cho cửa sổ 7/60 ngày nó vừa kéo, còn lượt
 * dựng lại trải toàn bộ lịch sử nên gộp theo THÁNG (kỳ khai thuế) — trộn nhiều thời kỳ thuế vào một
 * tỉ lệ là sai âm thầm. Tháng không đo được ⇒ mặc định 0,10 (hoá đơn chỉ phủ 2026-04→2026-07 trong
 * khi chi tiêu trải từ 2026-01).
 *
 * CHỈ TỪ CHỐI khi ĐO ĐƯỢC một tỉ lệ mà tỉ lệ đó vô lý — đó mới là "con số sai". Tháng có hoá đơn mà
 * không dòng nào khớp `BILL|PAYMENT` thì nghi mapping trôi: cảnh báo TO nhưng vẫn dùng mặc định,
 * vì hoá đơn TikTok xuất theo NGƯỠNG nên trễ và lệch tháng (đo prod: tháng 2026-07 chỉ có ĐÚNG 1
 * hoá đơn) — bỏ cả tháng chi tiêu vì một hoá đơn loại lạ là mất chi phí thật, tệ hơn hẳn.
 * n8n throw ở ca này vì nó đo trên cửa sổ vài ngày và có thể chạy lại ngay; lượt dựng lại thì không.
 */
export function buildVatByMonth(invoicePayloads: unknown[], warnings: string[]): VatTheoThang {
  const gop = new Map<string, { sub: number; thue: number; soHoaDon: number }>();
  for (const payload of invoicePayloads) {
    if (!isObj(payload)) continue;
    // `create_time` dạng "YYYY-MM-DD HH:MM:SS" theo giờ ad account (UTC+07:00 — có trong payload).
    const thang = String(payload.create_time ?? "").slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(thang)) continue;
    const g = gop.get(thang) ?? { sub: 0, thue: 0, soHoaDon: 0 };
    g.soHoaDon++;
    if (LOAI_HOA_DON.test(toText(payload.transaction_type))) {
      g.sub += Math.abs(Number(payload.subtotal ?? 0) || 0);
      g.thue += Math.abs(Number(payload.tax_amount ?? 0) || 0);
    }
    gop.set(thang, g);
  }

  const tiLe = new Map<string, number>();
  const thangTuChoi = new Set<string>();
  for (const [thang, g] of gop) {
    if (g.sub === 0) {
      warnings.push(
        `VAT quảng cáo TikTok tháng ${thang}: có ${g.soHoaDon} hoá đơn nhưng không dòng nào khớp loại ` +
          `BILL|PAYMENT — nghi API đổi tên transaction_type, tạm dùng VAT mặc định ` +
          `${VAT_MAC_DINH * 100}%, kiểm lại mapping hoá đơn`
      );
      continue;
    }
    const rate = g.thue / g.sub;
    if (rate < VAT_TRAN_DUOI || rate > VAT_TRAN_TREN) {
      thangTuChoi.add(thang);
      warnings.push(
        `VAT quảng cáo TikTok tháng ${thang} đo được ${(rate * 100).toFixed(2)}% — ngoài dải ` +
          `${VAT_TRAN_DUOI * 100}–${VAT_TRAN_TREN * 100}%, KHÔNG dựng lại chi tiêu tháng này`
      );
      continue;
    }
    tiLe.set(thang, rate);
  }

  return {
    rateForDate(date: string): number | null {
      const thang = date.slice(0, 7);
      if (thangTuChoi.has(thang)) return null;
      return tiLe.get(thang) ?? VAT_MAC_DINH;
    },
  };
}
