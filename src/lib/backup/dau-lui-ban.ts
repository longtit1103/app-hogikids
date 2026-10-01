import { format } from "date-fns";

import { prisma } from "@/lib/prisma";

/**
 * Dấu "DB đang ở trạng thái sau lùi bản phân quyền" — `deploy/rollback-phan-quyen-m1.sql` ghi (ISO
 * UTC), `deploy/tien-lai-phan-quyen-m1.sql` xoá. Tên khoá là HỢP ĐỒNG với 2 script SQL + tiền kiểm
 * runbook §2b; đổi ở đây thì đổi cả ba.
 *
 * Vì sao app bản mới phải đọc: lùi bản xong, lượt deploy kế tiếp đi qua §2b thấy `git diff prisma/`
 * rỗng nên không có gì nhắc chạy `tien-lai` — ảnh mới lên với `ShopProfile` đời trước lùi (thông tin
 * shop sửa trong lúc lùi biến khỏi UI) và STAFF vẫn bị khoá sentinel mà không ai biết.
 */
export const KEY_DAU_LUI_BAN = "phanQuyenDangLui";

/** Mốc lùi để hiện cho chủ shop (giờ VN — container `TZ=Asia/Ho_Chi_Minh`); giá trị lạ hiện nguyên văn. */
export function dinhDangMocLuiBan(giaTri: string): string {
  const moc = new Date(giaTri);
  return Number.isNaN(moc.getTime()) ? giaTri : format(moc, "HH:mm dd/MM/yyyy");
}

/**
 * Đọc ĐÚNG MỘT dòng `Setting` theo khoá chính. `null` = không ở trạng thái sau lùi. Chỉ layout gọi, và
 * chỉ cho chủ shop — lỗi DB ném lên như mọi nguồn khác của layout (không nuốt: nuốt là tắt banner đúng
 * lúc không đọc được trạng thái).
 */
export async function docDauLuiBan(): Promise<string | null> {
  const dong = await prisma.setting.findUnique({ where: { key: KEY_DAU_LUI_BAN }, select: { value: true } });
  return dong ? dinhDangMocLuiBan(dong.value) : null;
}
