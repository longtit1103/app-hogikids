/**
 * Công thức lãi đơn — THUẦN (drawer client + test dùng chung, KHÔNG đụng DB).
 * CÙNG công thức cấp-đơn với pnl.ts (phase 5). Tiền VND Int.
 */

/** COGS đơn = Σ qty × costPrice. costPrice null (SKU không khớp variant) hoặc = 0 → cộng 0 + đếm missing. */
export function calcOrderCogs(items: { quantity: number; costPrice: number | null }[]): {
  cogs: number;
  missingCostCount: number;
} {
  let cogs = 0;
  let missingCostCount = 0;
  for (const it of items) {
    if (it.costPrice === null || it.costPrice === 0) {
      missingCostCount++;
      continue;
    }
    cogs += it.quantity * it.costPrice;
  }
  return { cogs, missingCostCount };
}

/** Lãi đơn = itemsTotal − discount − platformFeeEst − cogs (có thể âm). */
export function calcOrderProfit(i: {
  itemsTotal: number;
  discount: number;
  platformFeeEst: number;
  cogs: number;
}): number {
  return i.itemsTotal - i.discount - i.platformFeeEst - i.cogs;
}
