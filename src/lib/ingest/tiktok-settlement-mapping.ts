/**
 * Mapping Bronze TikTok Shop → Silver "tiền đã về" (Phase 2). CHỈ dòng tiền đối
 * chiếu (bất biến #2 — KHÔNG doanh thu). Money trong payload là STRING → parse
 * lossless (không đụng int64 vì không phải number lớn). Ngày = epoch GIÂY →
 * `new Date(epoch*1000)` (instant thật; container TZ=Asia/Ho_Chi_Minh nên biên
 * tháng theo giờ VN — xem bất biến #3).
 */

/** String/number tiền → Int VND (round, GIỮ DẤU ÂM). null/rỗng/hỏng → 0. */
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
 * transform). null nếu thiếu `order_create_time`.
 */
export function mapAdsTxn(externalId: string, shopId: string, payload: unknown): MappedAdsSettlement | null {
  if (!isObj(payload)) return null;
  const orderCreateTime = epochToDate(payload.order_create_time);
  if (!orderCreateTime) return null;
  return {
    transactionId: externalId,
    shopId,
    adjustmentId: asString(payload.adjustment_id),
    orderCreateTime,
    settlementAmount: moneyValue(payload.settlement_amount), // ÂM giữ nguyên
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

/** Payment → lệnh rút về bank. null nếu payload hỏng. */
export function mapPayment(externalId: string, shopId: string, payload: unknown): MappedPayment | null {
  if (!isObj(payload)) return null;
  return {
    paymentId: externalId,
    shopId,
    status: asString(payload.status) ?? "",
    paidTime: epochToDate(payload.paid_time),
    settlementValue: moneyValue(payload.settlement_amount),
    amountValue: moneyValue(payload.amount),
    reserveValue: moneyValue(payload.reserve_amount),
    bankAccount: asString(payload.bank_account),
  };
}
