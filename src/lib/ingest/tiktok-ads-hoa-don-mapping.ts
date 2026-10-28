/**
 * Mapping Bronze hoá đơn quảng cáo TikTok (Business Center, `/bc/account/transaction/get/`) → Silver
 * `TiktokAdsHoaDon`. THUẦN — không DB, không đồng hồ.
 *
 * Đầu vào là BẢN ĐỒ TRƯỜNG DẠNG CHUỖI do SQL rút từ jsonb (`v #>> '{}'` từng trường cấp một — xem
 * `transform-tiktok-ads-hoa-don.ts`), KHÔNG phải payload đã `JSON.parse`: `payment_portfolio_id` từng thấy trả
 * SỐ JSON (int64 ⇒ làm tròn …205000 thay vì …204945), tiền có thể là chuỗi hay số — đọc chuỗi là lossless cho cả hai.
 *
 * Dòng nào không đọc CHẮC CHẮN được thì trả LÝ DO để người gọi bỏ dòng + cảnh báo, KHÔNG ép 0 / không đoán
 * (cùng tinh thần `ads-report-mapping.ts`): một hoá đơn trừ thẻ ghi 0đ là nợ thẻ thấp đi trong im lặng.
 *
 * Land MỌI loại giao dịch (`transaction_type` lạ vẫn land) — chỉ CHIỀU TIỀN (`amount_type`) bắt buộc thuộc
 * POSITIVE | NEGATIVE, vì người đọc cộng/trừ theo nó.
 */

/** Bản đồ trường cấp một của payload, giá trị là chuỗi đã rút từ jsonb (JSON null ⇒ null). */
export type TruongHoaDonTho = Readonly<Record<string, string | null | undefined>>;

export type ChieuTienHoaDon = "POSITIVE" | "NEGATIVE";

export type HoaDonTiktok = {
  transactionId: string;
  bcId: string;
  advertiserId: string | null;
  invoiceId: string | null;
  createTime: Date;
  amount: number;
  subtotal: number | null;
  taxAmount: number | null;
  transactionType: string;
  billingType: string;
  amountType: ChieuTienHoaDon;
  paymentPortfolioId: string | null;
};

export type KetQuaMapHoaDon = { ok: true; hoaDon: HoaDonTiktok } | { ok: false; loi: string };

/** Tiền tệ DUY NHẤT chấp nhận — tài khoản đổi tiền tệ là số sai hàng chục nghìn lần. */
const TIEN_TE_HOP_LE = "VND";

/** Trần cột Postgres INTEGER: vượt thì upsert nổ — báo lý do rõ ràng thay vì lỗi DB mơ hồ. */
const TRAN_INT4 = 2_147_483_647;

/** Múi giờ khi payload không mang `timezone` — ad account Hogikids là giờ VN. */
const MUI_GIO_MAC_DINH = "UTC+07:00";

function chuoi(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = v.trim();
  return s === "" ? null : s;
}

/**
 * Tiền dạng chuỗi → Int đồng, LOSSLESS: chỉ nhận số nguyên không dấu (cho phép đuôi ".0…" vì jsonb giữ
 * nguyên `143000.0` nếu TikTok trả vậy). Phần lẻ khác 0, số âm, rác, vượt INTEGER ⇒ lý do lỗi.
 * Âm bị từ chối vì chiều tiền nằm ở `amount_type` — chấp nhận dấu ở đây là đảo chiều hai lần.
 */
export function tienKhongMat(v: string | null | undefined, ten: string): { ok: true; so: number } | { ok: false; loi: string } {
  const s = chuoi(v);
  if (s === null) return { ok: false, loi: `thiếu ${ten}` };
  const m = /^(\d+)(?:\.0+)?$/.exec(s);
  if (!m) return { ok: false, loi: `${ten} "${s}" không phải số nguyên không dấu (âm / phần lẻ / rác)` };
  const so = Number(m[1]);
  if (!Number.isSafeInteger(so) || so > TRAN_INT4) return { ok: false, loi: `${ten} "${s}" vượt trần số nguyên` };
  return { ok: true, so };
}

/** Như `tienKhongMat` nhưng trường VẮNG là hợp lệ (trả null — KHÔNG ép 0). Có mặt mà hỏng vẫn là lỗi. */
function tienTuyChon(v: string | null | undefined, ten: string): { ok: true; so: number | null } | { ok: false; loi: string } {
  if (chuoi(v) === null) return { ok: true, so: null };
  return tienKhongMat(v, ten);
}

/** "UTC+07:00" / "UTC-03:30" ⇒ phút lệch so với UTC. Khuôn khác (tên vùng, "GMT+7", rác) ⇒ null. */
function phutLechMuiGio(tz: string): number | null {
  const m = /^UTC([+-])(\d{2}):(\d{2})$/.exec(tz);
  if (!m) return null;
  const gio = Number(m[2]);
  const phut = Number(m[3]);
  if (gio > 14 || phut > 59) return null;
  return (m[1] === "-" ? -1 : 1) * (gio * 60 + phut);
}

/**
 * `create_time` ("YYYY-MM-DD HH:MM:SS", giờ của ad account) + `timezone` ⇒ instant thật.
 * Múi giờ vắng ⇒ `UTC+07:00`. Múi giờ có mặt mà sai khuôn ⇒ lỗi (KHÔNG ép về giờ VN — sai múi là lệch ngày,
 * lệch kỳ sao kê). Kiểm khứ hồi để chặn ngày không tồn tại (V8 tự cuộn 31/02 sang 03/03).
 */
export function thoiDiemHoaDon(
  createTime: string | null | undefined,
  timezone: string | null | undefined
): { ok: true; luc: Date } | { ok: false; loi: string } {
  const ct = chuoi(createTime);
  if (ct === null) return { ok: false, loi: "thiếu create_time" };
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(ct);
  if (!m) return { ok: false, loi: `create_time "${ct}" sai khuôn YYYY-MM-DD HH:MM:SS` };
  const tz = chuoi(timezone) ?? MUI_GIO_MAC_DINH;
  const lech = phutLechMuiGio(tz);
  if (lech === null) return { ok: false, loi: `timezone lạ "${tz}" — không quy đổi được về giờ thật` };
  const dau = lech < 0 ? "-" : "+";
  const tuyetDoi = Math.abs(lech);
  const hh = String(Math.floor(tuyetDoi / 60)).padStart(2, "0");
  const mm = String(tuyetDoi % 60).padStart(2, "0");
  const luc = new Date(`${m[1]}T${m[2]}${dau}${hh}:${mm}`);
  if (Number.isNaN(luc.getTime())) return { ok: false, loi: `create_time "${ct}" không phải ngày giờ có thật` };
  const khuHoi = new Date(luc.getTime() + lech * 60_000).toISOString().slice(0, 19).replace("T", " ");
  if (khuHoi !== ct) return { ok: false, loi: `create_time "${ct}" không phải ngày giờ có thật` };
  return { ok: true, luc };
}

/**
 * Một hoá đơn (bản đồ trường chuỗi) → dòng Silver.
 * @param transactionId cột `externalId` của Bronze (= `transaction_id`, đã lossless) — giữ NGUYÊN, kể cả dạng ghép "A|B".
 * @param bronzeShopId `shopId` của dòng Bronze = bc_id — dùng khi payload không mang `bc_id`.
 */
export function mapHoaDonTiktok(
  transactionId: string,
  bronzeShopId: string,
  truong: TruongHoaDonTho | null | undefined
): KetQuaMapHoaDon {
  if (!truong || typeof truong !== "object") return { ok: false, loi: "payload không phải object" };
  if (chuoi(transactionId) === null) return { ok: false, loi: "thiếu transaction_id" };

  const tienTe = chuoi(truong.currency);
  if (tienTe !== null && tienTe !== TIEN_TE_HOP_LE) {
    return { ok: false, loi: `hoá đơn tiền tệ "${tienTe}", không phải VND` };
  }

  const transactionType = chuoi(truong.transaction_type);
  if (transactionType === null) return { ok: false, loi: "thiếu transaction_type" };
  const billingType = chuoi(truong.billing_type);
  if (billingType === null) return { ok: false, loi: "thiếu billing_type" };
  const amountType = chuoi(truong.amount_type);
  if (amountType !== "POSITIVE" && amountType !== "NEGATIVE") {
    return { ok: false, loi: `amount_type "${amountType ?? ""}" không phải POSITIVE | NEGATIVE — không biết chiều tiền` };
  }

  const luc = thoiDiemHoaDon(truong.create_time, truong.timezone);
  if (!luc.ok) return luc;
  const amount = tienKhongMat(truong.amount, "amount");
  if (!amount.ok) return amount;
  const subtotal = tienTuyChon(truong.subtotal, "subtotal");
  if (!subtotal.ok) return subtotal;
  const taxAmount = tienTuyChon(truong.tax_amount, "tax_amount");
  if (!taxAmount.ok) return taxAmount;

  const bcId = chuoi(truong.bc_id) ?? chuoi(bronzeShopId);
  if (bcId === null) return { ok: false, loi: "thiếu bc_id" };

  return {
    ok: true,
    hoaDon: {
      transactionId,
      bcId,
      advertiserId: chuoi(truong.account_id),
      invoiceId: chuoi(truong.invoice_id),
      createTime: luc.luc,
      amount: amount.so,
      subtotal: subtotal.so,
      taxAmount: taxAmount.so,
      transactionType,
      billingType,
      amountType,
      paymentPortfolioId: chuoi(truong.payment_portfolio_id),
    },
  };
}
