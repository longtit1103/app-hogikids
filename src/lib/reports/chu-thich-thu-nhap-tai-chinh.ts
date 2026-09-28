import { formatVnd } from "@/lib/format";

/**
 * Chú thích biên ròng khi kỳ CÓ thu nhập tài chính.
 *
 * Công thức biên ròng GIỮ NGUYÊN `netProfit / pnlPercentBase` (quyết định chủ shop #10, 10/09):
 * mẫu số vẫn là doanh thu bán hàng, tử số vẫn là lãi ròng đã gồm lãi tiết kiệm. Đổi lại, chữ là
 * thứ duy nhất ngăn tháng đáo hạn sổ bị đọc thành "bán hàng đột nhiên lãi hơn".
 *
 * Module RIÊNG, THUẦN (chỉ import `formatVnd`): Client Component gọi được mà không kéo `@/lib/prisma`
 * vào browser bundle — cùng lý do `pnl-percent-base.ts` tách riêng.
 */

/** Câu cho màn hiện biên ròng TOÀN SHOP. `null` = kỳ không có gì để nói. */
export function chuThichBienRongCoThuNhap(financialIncome: number): string | null {
  if (financialIncome <= 0) return null;
  return `có gồm thu nhập tài chính ${formatVnd(financialIncome)}`;
}

/**
 * Câu cho màn theo KÊNH — nghĩa NGƯỢC LẠI: `calcPnlCore` ép `financialIncome = 0` dưới lăng kính
 * kênh, nên biên ròng từng kênh KHÔNG gồm khoản này. Không nói ra thì cộng biên ròng các kênh lại
 * không ra biên ròng toàn shop mà không ai giải thích được vì sao.
 */
export function chuThichBienRongTheoKenh(financialIncome: number): string | null {
  if (financialIncome <= 0) return null;
  return `Biên ròng từng kênh KHÔNG gồm thu nhập tài chính ${formatVnd(
    financialIncome
  )} của kỳ — lãi tiết kiệm không thuộc kênh bán nào, chỉ có ở bảng Lãi/Lỗ toàn shop.`;
}
