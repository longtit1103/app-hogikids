/**
 * Đọc ô sửa nhanh tại chỗ ở bảng sản phẩm (giá vốn + ngưỡng tồn thấp). Trước đây mỗi bảng chép riêng
 * một bản; gom về đây để hai bảng không lệch nhau. Khác `parseAmountInput` (`format-amount-input.ts`,
 * ô form ghi tay): rỗng ⇒ `undefined` (KHÔNG lưu) thay vì 0, và không kẹp trần.
 */

/** "45.000" hoặc "45000" → 45000 (int ≥0); rỗng/không hợp lệ → undefined (không lưu). */
export function parseMoneyInput(raw: string): number | undefined {
  const cleaned = raw.replace(/[^\d]/g, "");
  if (cleaned === "") return undefined;
  const n = Number.parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** Như trên nhưng rỗng → null (xóa ngưỡng riêng, dùng mặc định). */
export function parseThresholdInput(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const cleaned = trimmed.replace(/[^\d]/g, "");
  if (cleaned === "") return undefined;
  const n = Number.parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : undefined;
}
