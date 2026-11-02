import { loiVuotTranAmount } from "@/lib/format-amount-input";

/**
 * Dòng đỏ ngay dưới ô tiền khi số gõ vượt trần 2 tỷ (`MAX_AMOUNT_INPUT`); không vượt thì không
 * render gì. Dùng cho form chưa có chỗ hiện lỗi riêng — form nào cũng PHẢI khoá nút Lưu bằng cùng
 * `loiVuotTranAmount(value)` (cổng thật vẫn ở action; đây là báo trước, không phải cổng).
 *
 * Truyền `id` rồi rải `thuocTinhLoiVuotTran(value, id)` lên ô nhập để trình đọc màn hình gắn câu lỗi
 * vào đúng ô (`aria-invalid` + `aria-describedby`); không có id thì dòng lỗi vẫn hiện nhưng không nối với ô.
 */
export function LoiVuotTranTien({ value, id }: { value: number | null | undefined; id?: string }) {
  const loi = value === null || value === undefined ? null : loiVuotTranAmount(value);
  if (!loi) return null;
  return (
    <p id={id} role="alert" className="text-xs text-error" data-testid="loi-vuot-tran-tien">
      {loi}
    </p>
  );
}

/** Thuộc tính a11y cho ô nhập tiền đi kèm `LoiVuotTranTien` cùng `id`; không vượt trần thì không thêm gì. */
export function thuocTinhLoiVuotTran(
  value: number | null | undefined,
  id: string,
): { "aria-invalid"?: true; "aria-describedby"?: string } {
  const vuot = value !== null && value !== undefined && loiVuotTranAmount(value) !== null;
  return vuot ? { "aria-invalid": true, "aria-describedby": id } : {};
}
