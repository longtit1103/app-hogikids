import type { IngestAdsBody } from "./ads-schema";
import {
  laNgayChiTieuAdsHopLy,
  NGAY_CHI_TIEU_ADS_SOM_NHAT,
} from "./ngay-chi-tieu-ads-hop-ly";

/** Nguồn chi tiêu quảng cáo — CÙNG hợp đồng với body `/api/ingest/ads`. */
export type AdsSource = IngestAdsBody["source"];

/** Một dòng chi tiêu CHƯA VAT — hợp đồng chung của n8n và bước dựng lại từ kho thô. */
export type AdsSpendRow = IngestAdsBody["rows"][number];

export type PreparedAdsExpense = {
  refId: string;
  date: Date;
  /** Chính chuỗi "YYYY-MM-DD" đã neo thành `date` — dùng để so ngày mà không phải format ngược lại. */
  dateKey: string;
  description: string;
  amount: number;
};

/** Kênh của khoản chi tiêu — `Expense.channelId` phải khớp giữa hai đường ghi. */
export function adsChannelId(source: AdsSource): string {
  return source === "META" ? "facebook" : "tiktok";
}

/**
 * CÔNG THỨC DUY NHẤT của một dòng chi tiêu quảng cáo trong sổ (`Expense`, `source=ADS_API`).
 *
 * Dùng CHUNG cho hai đường ghi: `/api/ingest/ads` (n8n đẩy mỗi đêm) và bước dựng lại từ kho thô
 * (đọc báo cáo Bronze). Hai đường sinh KHÁC khoá là đẻ dòng trùng — cùng (chiến dịch, ngày) nằm ở
 * 2 dòng ⇒ chi phí quảng cáo đếm 2 lần, lãi ròng tụt mà không tra ra nguyên nhân. Nên khoá, phép
 * nhân VAT và cách neo ngày để ĐÚNG một chỗ này.
 *
 * - `refId` = `${source}:${date}:${campaignId}`; riêng TikTok Ads AUCTION mang infix `auction:`
 *   (mirror khoá Bronze ở `streams.ts`) vì cùng (chiến dịch, ngày) có thể có CẢ dòng auction lẫn
 *   GMV Max — 2 chi tiêu KHÁC nhau. GMV Max/Meta giữ khoá TRẦN để refId prod cũ không đổi.
 * - `amount = round(spendExVat × (1 + vatRate))` — làm tròn TỪNG dòng (app là biên tiền; sàn trả
 *   số chưa thuế, hộ kinh doanh không khấu trừ được VAT đầu vào).
 * - `date` neo `T00:00:00+07:00` (bất biến #3) ⇒ 1 dòng ads = 1 ngày VN.
 * - Ngày ngoài `[2000-01-01, hôm nay VN]` ⇒ THROW (`laNgayChiTieuAdsHopLy`, cùng biên với cửa file).
 *   Ném chứ không kẹp im lặng — người gọi đi qua `chuanBiDongAdsHoacBoQua` để bỏ ĐÚNG dòng đó.
 */
export function prepareAdsExpenseRow(source: AdsSource, row: AdsSpendRow): PreparedAdsExpense {
  if (!laNgayChiTieuAdsHopLy(row.date)) {
    throw new Error(
      `Ngày chi tiêu ads "${row.date}" (chiến dịch ${row.campaignId}) nằm ngoài khoảng ` +
        `${NGAY_CHI_TIEU_ADS_SOM_NHAT} → hôm nay giờ VN — người gọi tính sai ngày; ghi vào sổ là ` +
        `chi phí nằm ở năm không báo cáo nào phủ.`,
    );
  }
  return {
    refId:
      source === "TIKTOK_ADS" && row.adType === "auction"
        ? `${source}:auction:${row.date}:${row.campaignId}`
        : `${source}:${row.date}:${row.campaignId}`,
    date: new Date(`${row.date}T00:00:00+07:00`),
    dateKey: row.date,
    description: row.campaignName || row.campaignId,
    amount: Math.round(row.spendExVat * (1 + row.vatRate)),
  };
}

/**
 * `prepareAdsExpenseRow` cho MỘT dòng, nhưng dòng hỏng (ngày ngoài biên) ⇒ trả `null` + đẩy cảnh báo
 * thay vì ném. Hai đường ghi dùng chung để cùng một luật: BỎ ĐÚNG dòng hỏng, các dòng còn lại vẫn
 * vào sổ.
 *
 * Vì sao không đỏ cả lô: n8n gửi chi tiêu theo chunk 500 dòng trộn nhiều ngày/chiến dịch, THỬ LẠI khi
 * gặp 5xx rồi ném — mọi chunk phía sau cũng không được POST. Một dòng ngày hỏng khi đó làm mất chi phí
 * quảng cáo của CẢ lượt (lãi báo cao lên), trái luật "ghi số trước, kêu lỗi sau" của chính workflow.
 * Dòng bị bỏ vẫn hiện: cảnh báo ở nhật ký đồng bộ + đếm vào `rowsSkipped`.
 */
export function chuanBiDongAdsHoacBoQua(
  source: AdsSource,
  row: AdsSpendRow,
  warnings: string[],
): PreparedAdsExpense | null {
  try {
    return prepareAdsExpenseRow(source, row);
  } catch (e) {
    warnings.push(`Bỏ qua chi tiêu ads ${source}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
