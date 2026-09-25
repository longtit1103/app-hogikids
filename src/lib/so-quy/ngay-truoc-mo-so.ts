import { startOfDay } from "date-fns";

/**
 * D0 = ngày mở sổ quỹ (`ngayMoSo()` ở `so-quy-queries.ts`) = MIN(`CashMovement.date`) toàn bảng,
 * KHÔNG cấu hình ở Cài đặt. Một dòng tiền THẬT ghi lùi trước D0 — ghi tay, giải ngân khoản vay, gửi
 * sổ tiết kiệm — kéo D0 lùi theo, làm MỌI số Đầu kỳ/Cuối kỳ của các tháng đã xem đổi im lặng. MỌI form
 * sinh dòng tiền thật phải hỏi lại trước khi ghi (khuôn hai lượt bấm ở `cash-movement-form-modal.tsx`)
 * — hàm này là phép so DUY NHẤT dùng chung cho cả ba form (ghi tay, khoản vay, sổ tiết kiệm).
 *
 * So theo NGÀY (neo +07:00 như mọi form ghi tay khác), không theo giờ: `d0` đọc thẳng từ cột
 * `CashMovement.date` nên có thể mang giờ lẻ khác 00:00 — `startOfDay` cắt về đầu ngày trước khi so,
 * để ghi ĐÚNG ngày D0 luôn ra `false` (không hỏi) bất kể D0 lưu giờ nào.
 */
export function ngayTruocMoSo(ngay: string, d0: Date | null): boolean {
  if (d0 === null || !ngay) return false;
  return new Date(`${ngay}T00:00:00+07:00`) < startOfDay(d0);
}
