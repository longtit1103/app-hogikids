/**
 * Vì sao một khoản vay KHÔNG xoá được nữa — một câu trả lời duy nhất cho cả server (`xoaKhoanVay`
 * ném đúng câu này) lẫn client (menu ⋯ mở hộp giải thích trước khi chủ shop bấm phải câu lỗi).
 * Thuần: không React, không Prisma.
 *
 * Vì sao phải nói dài: ngõ cụt thật đã xảy ra. Khoản trả gốc cuối kỳ (BULLET) có kỳ 1 `goc = 0` nên
 * duyệt kỳ 1 KHÔNG sinh dòng trả gốc nào — chỉ `Expense` lãi + dòng gửi tiết kiệm + con dấu
 * `lastDueHandled`. Chủ shop khai nhầm 200 triệu, duyệt một kỳ rồi mới phát hiện: mục "Xoá" biến mất
 * khỏi menu (không lời giải thích), câu lỗi cũ nói "Đã ghi kỳ trả — không xoá được, chỉ tất toán"
 * (SAI: chưa trả đồng gốc nào), mà "chỉ tất toán" lại dẫn thẳng vào "Còn dư nợ 200.000.000 ₫ — trả
 * hết gốc trước khi tất toán". Hai câu vòng vào nhau.
 *
 * Con dấu `lastDueHandled` KHÔNG có đường lùi ở bất kỳ đâu trong app (quét toàn `src/`: chỉ có câu
 * ghi TIẾN con dấu, không câu nào set null) — nên hồ sơ khoản vay đã duyệt kỳ là KHÔNG xoá được,
 * vĩnh viễn. Luật chặn đó giữ nguyên; chỗ này chỉ nói THẬT về nó và chỉ đúng đường vòng nếu có.
 */

export type TrangThaiKhoaXoa = {
  /** Đã có dòng `LOAN_REPAY` nào chưa. */
  coTraGoc: boolean;
  /** Con dấu `lastDueHandled` đã đóng chưa (đã duyệt ít nhất một kỳ). */
  daDuyetKy: boolean;
  /**
   * Khoản khai chế độ "mang sang" (`duNoMoSo > 0`) — dư nợ nằm thẳng trên hồ sơ, KHÔNG có dòng giải
   * ngân nào để xoá. Đúng ca này thì không còn đường gỡ sạch, phải nói thẳng.
   */
  mangSang: boolean;
  /**
   * Có ÍT NHẤT MỘT dòng tiền gửi tiết kiệm (gửi hoặc nhận lại) gắn khoản này. Đếm DÒNG chứ không
   * cộng tiền: khoản đã gửi rồi nhận lại hết có Σ = 0 nhưng dòng vẫn còn, mà `xoaKhoanVay` xoá hồ sơ
   * là kéo theo `deleteMany` mọi dòng của khoản ⇒ quỹ nhảy lên im lặng.
   */
  coTienGui: boolean;
};

/**
 * Câu cho ca "chưa duyệt kỳ, chưa trả gốc, nhưng đã có dòng tiền gửi ghi tay". Tách hằng để server
 * ném ĐÚNG chuỗi này — trước đây server giữ câu riêng nên hộp ở menu ⋯ vẫn hứa xoá được.
 */
export const LY_DO_CO_TIEN_GUI =
  "Khoản vay này đã có dòng tiền gửi tiết kiệm — xoá các dòng đó ở bảng Khoản tiền khác " +
  "(tab Dòng tiền) trước, rồi xoá được khoản vay này";

/** `null` = xoá được. Ngược lại là câu nói thật + đường gỡ (hoặc lời thú nhận là chưa có đường gỡ). */
export function lyDoKhongXoaKhoanVay(t: TrangThaiKhoaXoa): string | null {
  if (t.coTraGoc) {
    return (
      "Khoản vay này đã có dòng trả gốc nên hồ sơ không xoá được nữa — dư nợ và Sổ quỹ suy thẳng từ " +
      "chính những dòng đó. Muốn đóng sổ thì trả hết dư nợ rồi bấm Tất toán; khoản vẫn nằm lại trong " +
      "bảng kèm dấu “Đã tất toán”."
    );
  }
  if (!t.daDuyetKy) {
    // Thứ tự KHỚP server: hai cổng trên xét trước, cổng tiền gửi xét sau — đổi thứ tự là hộp ở menu
    // ⋯ nói một câu còn toast đỏ nói câu khác cho cùng một khoản.
    return t.coTienGui ? LY_DO_CO_TIEN_GUI : null;
  }
  if (t.mangSang) {
    return (
      "Đã duyệt kỳ trả nợ — con dấu kỳ KHÔNG lùi được ở bất kỳ đâu trong app, nên hồ sơ khoản vay " +
      "không xoá được nữa (dù chưa trả đồng gốc nào). Khoản này khai theo dư nợ mang sang nên KHÔNG " +
      "có dòng giải ngân để xoá ⇒ app chưa có đường gỡ sạch: xoá dòng lãi ở Sổ chi phí và dòng gửi " +
      "tiết kiệm ở bảng Khoản tiền khác thì hết tiền oan, nhưng hồ sơ vẫn nằm lại nguyên dư nợ. Thẻ " +
      "kỳ chờ duyệt dọn bằng nút “Ngân hàng không thu kỳ này”."
    );
  }
  return (
    "Đã duyệt kỳ trả nợ — con dấu kỳ KHÔNG lùi được ở bất kỳ đâu trong app, nên hồ sơ khoản vay " +
    "không xoá được nữa (dù chưa trả đồng gốc nào). Khai nhầm thì gỡ theo thứ tự: 1) xoá dòng lãi ở " +
    "Sổ chi phí · 2) xoá dòng gửi tiết kiệm và dòng giải ngân ở bảng Khoản tiền khác (tab Dòng tiền) " +
    "— dư nợ về 0 · 3) bấm Tất toán để đóng sổ. Khoản vẫn nằm lại trong bảng kèm dấu “Đã tất toán”."
  );
}
