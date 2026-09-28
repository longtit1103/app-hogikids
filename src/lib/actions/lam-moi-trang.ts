import { revalidatePath } from "next/cache";

/**
 * Làm mới các trang đọc dư nợ / quỹ sau một lượt ghi chạm khoản vay.
 *
 * Ba lời gọi, KHÔNG thừa: `/tai-chinh` là tab Dòng tiền, `/` là Dashboard, còn `("/", "layout")` là
 * banner "N kỳ trả nợ tới hạn chưa ghi" — banner nằm ở layout shell nên revalidate trang không đụng
 * tới nó, và chủ shop sẽ thấy lời nhắc cũ kể cả sau khi vừa duyệt xong kỳ.
 *
 * Ở file riêng (KHÔNG "use server") vì `cash-movements.ts` và `khoan-vay.ts` đều cần: file
 * "use server" chỉ được export async function nên không thể chứa helper dùng chung dạng này.
 */
export function lamMoiTrang(): void {
  revalidatePath("/tai-chinh");
  revalidatePath("/");
  revalidatePath("/", "layout");
}
