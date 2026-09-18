/**
 * MỘT định nghĩa duy nhất cho 10 loại "khoản tiền khác" ghi tay (bảng `CashMovement`): nhãn tiếng Việt,
 * chiều tiền, câu gợi ý dưới ô chọn loại. Chiều VÀO/RA SUY từ loại — không lưu cột riêng nên không có
 * ca "loại nói vào mà cột nói ra".
 *
 * Trục DÒNG TIỀN thuần — KHÔNG BAO GIỜ vào P&L (CLAUDE.md bất biến #1; lưới
 * `tests/unit/cash-movements/khong-ro-ri-vao-pnl.test.ts`). Không import Prisma: test thuần chạy không
 * cần DB; đồng bộ với enum Prisma `CashMovementKind` được kiểm ở mức KIỂU trong
 * `cash-movement-queries.ts`.
 */

export type CashDirection = "IN" | "OUT";

/** Thứ tự = thứ tự hiển thị: 6 loại VÀO trước, 4 loại RA sau. */
export const CASH_MOVEMENT_KINDS = [
  "LOAN_IN",
  "CAPITAL_IN",
  "DIRECT_SALE",
  "OTHER_IN",
  "DEPOSIT_IN",
  "SAVINGS_IN",
  "LOAN_REPAY",
  "CAPITAL_OUT",
  "DEPOSIT_OUT",
  "SAVINGS_OUT",
] as const;

export type CashMovementKind = (typeof CASH_MOVEMENT_KINDS)[number];

export type CashMovementKindMeta = { label: string; direction: CashDirection; hint: string };

export const CASH_MOVEMENT_KIND_META: Record<CashMovementKind, CashMovementKindMeta> = {
  LOAN_IN: {
    label: "Vay vốn",
    direction: "IN",
    hint: "Tiền vay về tài khoản shop — chọn khoản vay bên dưới. Phần LÃI app sẽ đề xuất mỗi kỳ.",
  },
  CAPITAL_IN: {
    label: "Góp vốn / nhập quỹ",
    direction: "IN",
    hint: "Chủ shop bỏ tiền túi vào shop — kể cả số dư sẵn có lúc mở sổ quỹ.",
  },
  DIRECT_SALE: {
    label: "Bán trực tiếp",
    direction: "IN",
    hint: "Thu tiền bán ngoài sàn. Chỉ ghi dòng tiền — muốn tính vào Lãi/Lỗ thì lên đơn ở Pancake POS.",
  },
  DEPOSIT_IN: {
    label: "Nhận lại tiền gửi",
    direction: "IN",
    hint: "Ngân hàng trả lại sổ tiết kiệm bắt buộc — chọn khoản vay. Tất toán khoản vay ghi dòng này tự động.",
  },
  SAVINGS_IN: {
    label: "Nhận lại gốc tiết kiệm",
    direction: "IN",
    hint: "Ngân hàng trả lại GỐC sổ tiết kiệm sinh lãi — chọn sổ tiết kiệm. Chỉ gõ phần gốc: lãi app ghi riêng thành Thu nhập tài chính.",
  },
  OTHER_IN: {
    label: "Thu khác",
    direction: "IN",
    hint: "Khoản thu không thuộc loại nào ở trên (nhà cung cấp hoàn tiền, thanh lý…).",
  },
  LOAN_REPAY: {
    label: "Trả nợ gốc",
    direction: "OUT",
    hint: "Trả phần GỐC — chọn khoản vay. Không phải chi phí.",
  },
  CAPITAL_OUT: {
    label: "Rút vốn",
    direction: "OUT",
    hint: "Chủ shop rút tiền về túi cá nhân — không phải chi phí.",
  },
  DEPOSIT_OUT: {
    label: "Gửi tiết kiệm bắt buộc",
    direction: "OUT",
    hint: "Tiền gửi ngân hàng bắt buộc theo khoản vay — chọn khoản vay. Tiền vẫn của shop, ngân hàng giữ hộ tới lúc tất toán nên KHÔNG phải chi phí.",
  },
  SAVINGS_OUT: {
    label: "Gửi tiết kiệm sinh lãi",
    direction: "OUT",
    hint: "Tiền shop tự gửi ngân hàng lấy lãi — chọn sổ tiết kiệm. Tiền vẫn của shop nên KHÔNG phải chi phí; tiền gửi BẮT BUỘC theo hợp đồng vay thì chọn 'Gửi tiết kiệm bắt buộc'.",
  },
};

export function isInflow(kind: CashMovementKind): boolean {
  return CASH_MOVEMENT_KIND_META[kind].direction === "IN";
}

/** Số CÓ DẤU để cộng dồn/hiển thị: vào +, ra −. `amount` luôn dương (CHECK ở DB + zod ở action). */
export function signedAmount(kind: CashMovementKind, amount: number): number {
  return isInflow(kind) ? amount : -amount;
}

export function isCashMovementKind(value: unknown): value is CashMovementKind {
  return typeof value === "string" && (CASH_MOVEMENT_KINDS as readonly string[]).includes(value);
}
