/**
 * Đọc số DO SÀN BÁO (TikTok Shop Analytics + TikTok Business) ra kiểu của app.
 *
 * Ba khuôn này là ĐO THẬT trên payload prod 25/08, không phải tài liệu:
 *  - Tiền là OBJECT `{amount, currency}` — `amount` là CHUỖI, hai định dạng: `"330000.00"`
 *    (shop/products/videos) và `"0"` (shop_lives). Không bao giờ là number.
 *  - Tỉ lệ là CHUỖI hai khuôn: `"0.0827"` (thập phân) và `"0.00%"` (riêng
 *    `shop_lives.click_to_order_rate`).
 *  - Đếm là number thật ở analytics, nhưng là CHUỖI ở Business API (`orders: "0"`).
 *
 * BẤT BIẾN #2: mọi số đi qua đây là SỐ THAM KHẢO — không được rơi vào `pnl.ts`.
 * Luật chung: không đọc CHẮC CHẮN được ⇒ `null` + để lớp trên cảnh báo. Rơi về 0 là bịa ra một
 * phép đo chưa từng xảy ra, và 0 thì trông "hợp lý" nên không ai phát hiện.
 */

const TIEN_TE_HOP_LE = "VND";
/** Số thập phân KHÔNG âm dạng chuỗi — tiền sàn không bao giờ âm (hoàn tiền có trường riêng). */
const SO_THAP_PHAN = /^\d+(\.\d+)?$/;
const SO_NGUYEN = /^\d+$/;
/** Tỉ lệ khuôn phần trăm: "0.00%", "12.5%". */
const TI_LE_PHAN_TRAM = /^(\d+(\.\d+)?)%$/;

function laObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Tiền sàn: object `{amount, currency}`. Trả `Int` VND, hoặc null khi không đọc CHẮC CHẮN được. */
export function docTienSan(v: unknown): number | null {
  if (!laObj(v)) return null;
  if (v.currency !== TIEN_TE_HOP_LE) return null;
  const amount = v.amount;
  if (typeof amount !== "string" || !SO_THAP_PHAN.test(amount)) return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  // VND không có đơn vị nhỏ hơn đồng. `gpm` của video có phần lẻ thật ("297833.94") ⇒ làm tròn,
  // không cắt cụt: cắt cụt lệch xuống một cách hệ thống khi cộng hàng trăm dòng.
  return Math.round(n);
}

/**
 * Tiền của TikTok BUSINESS API — CHUỖI TRẦN, không phải object `{amount, currency}` (khuôn của
 * TikTok Shop analytics ở trên). Đo thật trên payload GMV Max cấp item: `cost` là chuỗi số NGUYÊN
 * ("592"), `gross_revenue` có thể mang phần thập phân ("219789.00").
 *
 * Để ở ĐÂY chứ không viết lại trong reader: luật parse số sàn phải nằm một chỗ, nếu không hai nơi
 * sẽ trôi khác nhau đúng vào lúc sàn đổi khuôn.
 */
export function docTienChuoiSan(v: unknown): number | null {
  if (typeof v !== "string" || !SO_THAP_PHAN.test(v)) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

/** Tỉ lệ sàn: "0.0827" (thập phân) hoặc "0.00%" (phần trăm). Trả số 0–1, hoặc null. */
export function docTiLeSan(v: unknown): number | null {
  if (typeof v !== "string" || v === "") return null;
  const pct = TI_LE_PHAN_TRAM.exec(v);
  if (pct) {
    const n = Number(pct[1]);
    return Number.isFinite(n) ? n / 100 : null;
  }
  if (!SO_THAP_PHAN.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Đếm sàn: number nguyên ≥ 0, hoặc chuỗi toàn chữ số. Trả number, hoặc null. */
export function docDemSan(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 ? v : null;
  if (typeof v === "string" && SO_NGUYEN.test(v)) return Number(v);
  return null;
}
