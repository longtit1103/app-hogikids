import { Prisma } from "@/generated/prisma/client";
import { format } from "date-fns";

import { rangBuocTrungKhoa } from "@/lib/prisma-loi-adapter";

/**
 * Khoá tháng `yyyy-MM` (giờ VN — container/test đều ghim `TZ=Asia/Ho_Chi_Minh`) của một dòng chi phí
 * ĐỊNH KỲ, ghi vào cột `Expense.recurringMonth`. Cặp `(recurringId, recurringMonth)` là UNIQUE dưới DB
 * ⇒ mỗi mẫu định kỳ có TỐI ĐA 1 dòng/tháng, do chính Postgres bảo đảm chứ không nhờ transaction.
 *
 * MỌI đường ghi dòng mang `recurringId` (bộ sinh, dòng đầu lúc tạo mẫu, sửa ngày, khôi phục thùng
 * rác) phải lấy khoá từ ĐÚNG hàm này trên ĐÚNG `date` sẽ ghi. Hai CHECK dưới DB chặn mọi lệch:
 * `recurringId` và `recurringMonth` cùng NULL/cùng có, và khoá phải khớp tháng VN của `date`
 * (migration `20260928160000_mot_dong_dinh_ky_moi_thang_rang_buoc_duy_nhat`).
 *
 * Hàm THUẦN (không chạm DB) — `chup-anh-ban-ghi.ts` cũng dùng.
 */
export function khoaThangDinhKy(date: Date): string {
  return format(date, "yyyy-MM");
}

/**
 * Lỗi là va chạm ràng buộc "1 dòng/mẫu/tháng" (P2002 trên `(recurringId, recurringMonth)`)? Dùng để
 * dịch lỗi đó thành câu tiếng Việt ở các đường ghi tay, thay vì câu lỗi chung hay trang 500.
 * Prisma 7 không còn `meta.target`; ràng buộc đọc từ nguyên nhân adapter — tên index
 * `Expense_recurringId_recurringMonth_key`, hoặc danh sách cột khi Postgres không gửi tên.
 */
export function laLoiTrungDongDinhKyThang(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return false;
  const rb = rangBuocTrungKhoa(e);
  if (!rb) return false;
  return (rb.index?.includes("recurringMonth") ?? false) || (rb.fields?.includes("recurringMonth") ?? false);
}
