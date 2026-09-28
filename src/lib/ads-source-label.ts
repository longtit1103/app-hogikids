/**
 * NGUỒN NHÃN DUY NHẤT cho nguồn chi tiêu quảng cáo (`Expense.adsSource`).
 * Module thuần, KHÔNG import prisma → client + server đều dùng chung.
 *
 * Dùng bởi: expand "Quảng cáo" tab P&L, badge nguồn ads `/kenh/:id`, và
 * `expense-table` (phase 4). Một nhãn duy nhất, không lệch chữ giữa các màn.
 */
export const ADS_SOURCE_LABELS: Record<string, string> = {
  META: "Meta",
  TIKTOK_ADS: "TikTok Ads",
  SHOPEE_ADS: "Shopee Ads",
};

/**
 * Nhãn hiển thị cho một nguồn ads:
 * - `null` hoặc `"KHAC"` → "Khác".
 * - key có trong `ADS_SOURCE_LABELS` → nhãn tương ứng.
 * - key lạ → trả NGUYÊN `key` (TUYỆT ĐỐI không nuốt vào "Khác" — nguồn mới
 *   vẫn hiện rõ để không âm thầm gộp số).
 */
export function adsSourceLabel(key: string | null): string {
  if (key === null || key === "KHAC") return "Khác";
  return ADS_SOURCE_LABELS[key] ?? key;
}
