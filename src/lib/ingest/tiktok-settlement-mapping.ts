/**
 * Mapping Bronze TikTok Shop → Silver "tiền đã về" (Phase 2). CHỈ dòng tiền đối
 * chiếu (bất biến #2 — KHÔNG doanh thu). Money trong payload là STRING → parse
 * lossless (không đụng int64 vì không phải number lớn). Ngày = epoch GIÂY →
 * `new Date(epoch*1000)` (instant thật; container TZ=Asia/Ho_Chi_Minh nên biên
 * tháng theo giờ VN — xem bất biến #3).
 */

/**
 * String/number tiền → Int VND (round, GIỮ DẤU ÂM). null/rỗng/hỏng → 0.
 *
 * CHỈ còn cho `mapStatement` (số hiển thị "Tiền đã về" cấp sao kê, không đi vào quỹ). Field tiền đi
 * vào quỹ (lệnh rút bank, khoản ads trừ ví) dùng `docTienBatBuoc`/`docTienTuyChon`: ở đó "đọc không
 * được" mà thành 0 là ghi đè số đúng trong Silver bằng 0.
 */
export function toIntMoney(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/** Epoch GIÂY (string/number) → Date instant. null/rỗng/≤0 → null. */
export function epochToDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000);
}

function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === "string" ? v : String(v);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** payload.settlement_amount có 2 shape: scalar (statement/txn) hoặc {value} (payment). */
function moneyValue(v: unknown): number {
  if (isObj(v) && "value" in v) return toIntMoney((v as { value: unknown }).value);
  return toIntMoney(v);
}

/** Giá trị "vắng mặt" của một field tiền: không có key, null, chuỗi rỗng hoặc toàn khoảng trắng. */
function laTienVang(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

/** Số hữu hạn (number hoặc chuỗi số) → Int (round, giữ dấu); mọi thứ khác → null. */
function soTienHuuHan(v: unknown): number | null {
  // `Number("  ")` = 0 và `Number(true)` = 1 — chỉ nhận đúng number/chuỗi KHÔNG rỗng.
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v) : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  return null;
}

/**
 * Tiền BẮT BUỘC → Int VND, hoặc `null` khi thiếu / rỗng / không phải số.
 *
 * Vì sao không trả 0: TikTok kéo lại cùng bản ghi mà shape trôi (field tiền thành chuỗi lạ hoặc mất
 * hẳn) thì payload khác hash ⇒ land thành bản MỚI NHẤT ⇒ transform đọc bản đó. Đổi thành 0 là upsert
 * đè số đúng trong Silver bằng 0: "Đã rút về bank" + Sổ quỹ hụt đúng số tiền đó, SyncLog vẫn xanh.
 * `null` ⇒ mapper từ chối bản ghi ⇒ Silver cũ giữ nguyên, transform đếm `skipped` ⇒ route báo đỏ.
 * `"0"` / `0` là số 0 THẬT ⇒ trả 0.
 */
export function docTienBatBuoc(v: unknown): number | null {
  if (laTienVang(v)) return null;
  return soTienHuuHan(v);
}

/**
 * Tiền TUỲ CHỌN → Int VND: vắng mặt ⇒ 0 (field phụ API có thể không trả); CÓ mặt mà không phải số ⇒
 * `null` (shape đã trôi — không đoán 0 thay sàn, mapper từ chối cả bản ghi).
 */
export function docTienTuyChon(v: unknown): number | null {
  if (laTienVang(v)) return 0;
  return soTienHuuHan(v);
}

/** Bóc `{value}` của shape payment (`{value, currency}`); scalar giữ nguyên. */
function giaTriTien(v: unknown): unknown {
  return isObj(v) && "value" in v ? (v as { value: unknown }).value : v;
}

export type MappedSettlement = {
  statementId: string;
  shopId: string;
  statementTime: Date;
  paymentTime: Date | null;
  paymentStatus: string;
  paymentId: string | null;
  settlementAmount: number;
  revenueAmount: number;
  feeAmount: number;
  adjustmentAmount: number;
  netSalesAmount: number;
  shippingCostAmount: number;
  currency: string;
};

/** Statement → net thực về. null nếu payload hỏng / thiếu `statement_time`. */
export function mapStatement(externalId: string, shopId: string, payload: unknown): MappedSettlement | null {
  if (!isObj(payload)) return null;
  const statementTime = epochToDate(payload.statement_time);
  if (!statementTime) return null; // thiếu ngày sao kê → bỏ (an toàn cấp tháng)
  return {
    statementId: externalId,
    shopId,
    statementTime,
    paymentTime: epochToDate(payload.payment_time),
    paymentStatus: asString(payload.payment_status) ?? "",
    // [L1] payment_id = display/debug-only (chưa join statement→payment). Đọc từ payload
    // đã JSON.parse — NẾU mai làm join theo khóa này phải rút SQL `payload->>'payment_id'`
    // (bất biến #6, chống int64 làm tròn). Fixtures/TikTok Open API hiện trả string.
    paymentId: asString(payload.payment_id),
    settlementAmount: moneyValue(payload.settlement_amount),
    revenueAmount: moneyValue(payload.revenue_amount),
    feeAmount: moneyValue(payload.fee_amount),
    adjustmentAmount: moneyValue(payload.adjustment_amount),
    netSalesAmount: moneyValue(payload.net_sales_amount),
    shippingCostAmount: moneyValue(payload.shipping_cost_amount),
    currency: asString(payload.currency) ?? "VND",
  };
}

export type MappedAdsSettlement = {
  transactionId: string;
  shopId: string;
  adjustmentId: string | null;
  orderCreateTime: Date;
  settlementAmount: number;
};

/**
 * Ads txn (type=GMV_PAYMENT_FOR_TIKTOK_ADS) → khoản TikTok trừ ads (ÂM). Người
 * gọi ĐÃ lọc đúng ads (query cross-version — chống re-fetch rớt `type`, xem
 * transform). null nếu thiếu `order_create_time` HOẶC `settlement_amount` không đọc
 * được (khoản này được cộng lại vào Sổ quỹ — 0 giả là quỹ lệch đúng số đó).
 */
export function mapAdsTxn(externalId: string, shopId: string, payload: unknown): MappedAdsSettlement | null {
  if (!isObj(payload)) return null;
  const orderCreateTime = epochToDate(payload.order_create_time);
  if (!orderCreateTime) return null;
  const settlementAmount = docTienBatBuoc(giaTriTien(payload.settlement_amount)); // ÂM giữ nguyên
  if (settlementAmount === null) return null;
  return {
    transactionId: externalId,
    shopId,
    adjustmentId: asString(payload.adjustment_id),
    orderCreateTime,
    settlementAmount,
  };
}

export type MappedPayment = {
  paymentId: string;
  shopId: string;
  status: string;
  paidTime: Date | null;
  settlementValue: number;
  amountValue: number;
  reserveValue: number;
  bankAccount: string | null;
};

/**
 * Payment → lệnh rút về bank. null nếu payload hỏng, `settlement_amount.value` (số TIỀN VỀ BANK —
 * nguồn Sổ quỹ) thiếu/không phải số, hoặc `amount`/`reserve_amount` CÓ mặt mà không phải số. Cùng
 * khuôn `mapShopeeWallet`: bản ghi tiền hỏng bị bỏ, KHÔNG dựng dòng Silver với số đoán.
 */
export function mapPayment(externalId: string, shopId: string, payload: unknown): MappedPayment | null {
  if (!isObj(payload)) return null;
  const status = asString(payload.status) ?? "";
  // Chỉ lệnh rút ĐÃ TRẢ (`PAID`) mới vào Sổ quỹ ⇒ chỉ khi đó `settlement_amount` BẮT BUỘC đọc được.
  // PROCESSING/FAILED… có thể chưa có số (shape chưa đo) — vắng ⇒ 0, nhưng CÓ mà hỏng vẫn từ chối.
  const settlementValue =
    status === "PAID" ? docTienBatBuoc(giaTriTien(payload.settlement_amount)) : docTienTuyChon(giaTriTien(payload.settlement_amount));
  const amountValue = docTienTuyChon(giaTriTien(payload.amount));
  const reserveValue = docTienTuyChon(giaTriTien(payload.reserve_amount));
  if (settlementValue === null || amountValue === null || reserveValue === null) return null;
  return {
    paymentId: externalId,
    shopId,
    status,
    paidTime: epochToDate(payload.paid_time),
    settlementValue,
    amountValue,
    reserveValue,
    bankAccount: asString(payload.bank_account),
  };
}
