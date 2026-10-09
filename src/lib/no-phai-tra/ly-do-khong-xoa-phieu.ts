/**
 * Vì sao một hồ sơ phiếu nợ (`PhieuNhapNo`) KHÔNG xoá được — một câu dùng chung cho server (thùng
 * rác / action xoá ném đúng câu này) lẫn client (menu giải thích trước khi bấm). Thuần: không React,
 * không Prisma. Khuôn `ly-do-khong-xoa-khoan-vay.ts`.
 *
 * Luật: còn ÍT NHẤT MỘT dòng tiền gắn phiếu (`SUPPLIER_PAY` / `SUPPLIER_REFUND`) ⇒ chặn. Đếm DÒNG
 * chứ không cộng tiền: phiếu đã trả 5 rồi được hoàn 5 có Σ = 0 nhưng dòng vẫn còn, và FK Restrict
 * `CashMovement.phieuNhapId` sẽ từ chối xoá — nói trước bằng câu hiểu được, đừng để lỗi khoá ngoại.
 */

export type TrangThaiKhoaXoaPhieu = {
  /** Số dòng `CashMovement` đang gắn phiếu (mọi kind). */
  soDongTien: number;
};

/** `null` = xoá được. Ngược lại là câu nói thật + đường gỡ. */
export function lyDoKhongXoaPhieu(t: TrangThaiKhoaXoaPhieu): string | null {
  if (t.soDongTien <= 0) return null;
  return (
    `Phiếu này còn ${t.soDongTien} dòng trả/hoàn tiền nhà cung cấp — xoá các dòng đó ở bảng Khoản tiền ` +
    "khác (tab Dòng tiền) trước, rồi xoá được phiếu này. Còn nợ suy thẳng từ chính những dòng đó."
  );
}
