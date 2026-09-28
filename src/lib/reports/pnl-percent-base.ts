/**
 * Mẫu số DUY NHẤT cho mọi "% / doanh thu" toàn app (bảng Lãi/Lỗ, Excel, KPI
 * Dashboard, tab Xu hướng, so kênh) = doanh thu ĐÃ TRỪ voucher — đúng bằng dòng
 * "Doanh thu" đứng đầu bảng Lãi/Lỗ, nên dòng đó luôn 100% và "Biên ròng" ở mọi
 * màn cùng một nghĩa (quyết định chủ shop 2026-08-07; trước đó nơi chia gộp nơi
 * chia thuần, lệch ~0,01% nhưng là hai định nghĩa đội chung một nhãn).
 * Kẹp ≥ 0: voucher vượt doanh thu là dữ liệu dị — mẫu số âm sẽ đảo dấu CẢ CỘT %,
 * thà cột trống (caller coi 0 là "không tính %") còn hơn cả bảng phần trăm ngược.
 *
 * Module RIÊNG, THUẦN (không import gì): hàm này được Client Component gọi
 * (`pnl-tab.tsx`, `report-export-buttons.tsx`) — đặt trong `pnl.ts` là kéo cả
 * `@/lib/prisma` vào browser bundle. Tham số structural (không `Pick<PnlBreakdown>`)
 * cũng vì lý do đó — type của `pnl.ts` kéo theo `@prisma/client`.
 */
export function pnlPercentBase(b: { revenue: number; voucher: number }): number {
  return Math.max(0, b.revenue - b.voucher);
}
