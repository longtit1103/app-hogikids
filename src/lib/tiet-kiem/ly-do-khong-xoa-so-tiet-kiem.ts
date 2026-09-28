/**
 * Vì sao một SỔ TIẾT KIỆM không xoá được nữa — một câu trả lời duy nhất cho cả server
 * (`xoaSoTietKiem` ném đúng câu này) lẫn client (menu ⋯ mở hộp giải thích TRƯỚC khi chủ shop bấm
 * phải toast đỏ). Thuần: không React, không Prisma.
 *
 * Khuôn: `src/lib/so-quy/ly-do-khong-xoa-khoan-vay.ts`. Thứ tự ba cổng dưới đây PHẢI khớp đúng thứ
 * tự `xoaSoTietKiem` kiểm trong transaction — đảo thứ tự là hộp nói một câu còn toast đỏ nói câu
 * khác cho cùng một sổ.
 */

export type TrangThaiKhoaXoa = {
  /** `closedAt != null` — sổ đã tất toán / đã rút. */
  daTatToan: boolean;
  /** Có bản ghi `ThuNhap` nào gắn sổ này (lãi đã vào dòng "Thu nhập tài chính" của Lãi/Lỗ). */
  coThuNhap: boolean;
  /**
   * Có dòng `CashMovement` nào NGOÀI đúng một dòng `SAVINGS_OUT` do app sinh. Đếm DÒNG chứ không
   * cộng tiền: sổ gửi rồi nhận lại hết có Σ = 0 nhưng dòng vẫn còn, mà `xoaSoTietKiem` xoá sổ là
   * kéo theo dòng của sổ ⇒ quỹ nhảy lên im lặng.
   */
  coDongGhiTay: boolean;
};

/**
 * Câu cho ca "chưa tất toán, chưa ghi lãi, nhưng có dòng tiền ghi tay". Tách hằng để server ném
 * ĐÚNG chuỗi này và test khoá được bằng `toBe` — không phải `toContain` một mẩu chữ.
 */
export const LY_DO_CO_DONG_GHI_TAY =
  "Sổ này còn dòng tiền ghi tay ngoài dòng gửi do app sinh — xoá các dòng đó ở bảng Khoản tiền " +
  "khác (tab Dòng tiền) trước, rồi xoá được sổ này";

/** `null` = xoá được. Ngược lại là câu nói thật + đường gỡ. */
export function lyDoKhongXoaSoTietKiem(t: TrangThaiKhoaXoa): string | null {
  if (t.daTatToan) {
    return (
      "Sổ này đã tất toán — gốc đã về quỹ và lãi (nếu có) đã vào Lãi/Lỗ, xoá thẳng là mất dấu cả " +
      "hai. Mở lại sổ trước (menu ⋯ → Mở lại, app tự gỡ dòng nhận lại gốc và dòng lãi nó đã sinh), " +
      "rồi mới xoá được."
    );
  }
  if (t.coThuNhap) {
    // Ca này chỉ xảy ra khi sổ đã mở lại mà bản ghi lãi còn sót (dòng lãi ghi tay, không mang
    // `refId` app sinh). Nói thẳng nó đang nằm ở đâu trong Lãi/Lỗ.
    return (
      "Sổ này đã ghi lãi vào sổ thu nhập — số đó đang nằm ở dòng “Thu nhập tài chính” của bảng " +
      "Lãi/Lỗ. Xoá dòng lãi đó trước, rồi mới xoá được sổ."
    );
  }
  if (t.coDongGhiTay) return LY_DO_CO_DONG_GHI_TAY;
  return null;
}
