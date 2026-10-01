import type { CashFlow } from "@/lib/reports/cash-flow";

/**
 * Tab Dòng tiền cho người THIẾU `tai-chinh-so-quy:xem`: lãi tiết kiệm trong kỳ thuộc khối Sổ quỹ
 * (sổ tiết kiệm), không thuộc dòng tiền.
 *
 * Bỏ khoản lãi khỏi CẢ dòng tách riêng LẪN số chênh lệch — chỉ ẩn dòng mà giữ nguyên `balance` thì
 * lãi vẫn suy ngược được bằng một phép trừ từ bốn số đang in cạnh đó, và công thức in dưới thẻ sẽ
 * không cộng ra đúng số. Hàm THUẦN: không tính lại vế tiền nào khác (nguồn vẫn là `computeCashFlow`).
 */
export function dongTienKhongLaiTietKiem(flow: CashFlow): CashFlow {
  return { ...flow, thuNhapTaiChinh: 0, balance: flow.balance - flow.thuNhapTaiChinh };
}
