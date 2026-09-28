/**
 * Mapping Bronze `RawShopeeWalletTxn` → Silver `ShopeeSettlement` ("Tiền đã về"
 * Shopee, Phase 3 hub Tài chính). CHỈ dòng tiền đối chiếu — ĐỘC LẬP P&L/doanh thu
 * (doanh thu CHỈ từ Pancake, bất biến #2).
 *
 * `externalId` = khoá tổng hợp do Bronze `idExpr` tính (`txnTime|type|orderCode|amount`),
 * `latestPayloads` trả sẵn ở cột `externalId` → DÙNG THẲNG, KHÔNG dựng lại bằng JS
 * (tránh lệch chuỗi giữa SQL idExpr và JS → 2 khoá khác nhau cho cùng dòng).
 * `amount` đã CÓ DẤU (parser ép theo cột "Dòng tiền"). Money < 2^53 → parse thường an toàn.
 */

export type MappedShopeeSettlement = {
  externalId: string;
  shopId: string;
  txnTime: Date;
  type: string;
  orderCode: string | null;
  amount: number;
  status: string;
  runningBalance: number;
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === "string" ? v : String(v);
}

/** number/string → Int (round). null/rỗng/không phải số → null. */
function toInt(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * Dòng ví → Silver. null nếu thiếu `txnTime` hoặc `amount` (đều là thành phần khoá
 * — payload hỏng thì bỏ, KHÔNG dựng dòng Silver rác). `runningBalance` thiếu → 0 (display-only).
 */
export function mapShopeeWallet(externalId: string, shopId: string, payload: unknown): MappedShopeeSettlement | null {
  if (!isObj(payload)) return null;
  const txnTime = payload.txnTime ? new Date(String(payload.txnTime)) : null;
  if (!txnTime || Number.isNaN(txnTime.getTime())) return null;
  const amount = toInt(payload.amount);
  if (amount === null) return null;
  return {
    externalId,
    shopId,
    txnTime,
    type: asString(payload.type) ?? "OTHER",
    orderCode: asString(payload.orderCode),
    amount,
    status: asString(payload.status) ?? "",
    runningBalance: toInt(payload.runningBalance) ?? 0,
  };
}
