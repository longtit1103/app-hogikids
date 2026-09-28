/**
 * Nhãn Việt cho `settlement_status` của MỘT dòng SKU affiliate (drawer creator; chủ shop chốt 30/08: chỉ
 * đổi cách hiển thị, không đụng reader). Thuần TS, không Prisma — dùng được trong component "use client".
 *
 * FAIL-OPEN "chưa chốt" (đo 28/08 trên 261 dòng thật): chỉ HAI giá trị là trạng thái CUỐI —
 * `SETTLED` (sàn đã chốt hoa hồng) · `INELIGIBLE` (không đủ điều kiện). Mọi chuỗi khác (`To-SETTLE`,
 * `AWAITING PAYMENT`, giá trị lạ sàn thêm sau này, khác hoa/thường) VÀ cả null (sàn không báo) đều là
 * "đang chờ sàn chốt". KHÔNG suy "đã chốt" từ việc có `actual_paid_*`: 28/94 dòng INELIGIBLE vẫn có
 * actual, còn 2 dòng chờ thật thì không (đo 28/08).
 *
 * Chuỗi gốc của sàn giữ ở `goc` để UI đưa vào `title` — đổi nhãn không được làm mất bằng chứng.
 */

export type NhanTrangThaiChot = {
  nhan: "đã chốt" | "không đủ ĐK" | "đang chờ sàn chốt";
  /** Chuỗi `settlement_status` nguyên văn của sàn; null = sàn không báo. */
  goc: string | null;
};

/** So sánh CHÍNH XÁC (phân biệt hoa/thường): sàn trả `SETTLED`/`INELIGIBLE` in hoa — biến thể lạ ⇒ chưa chốt. */
export function nhanTrangThaiChotHoaHong(trangThai: string | null): NhanTrangThaiChot {
  if (trangThai === "SETTLED") return { nhan: "đã chốt", goc: trangThai };
  if (trangThai === "INELIGIBLE")
    return { nhan: "không đủ ĐK", goc: trangThai };
  return { nhan: "đang chờ sàn chốt", goc: trangThai };
}
