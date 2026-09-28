/**
 * Dọn cờ khoá bảo trì VÔ ĐIỀU KIỆN — chỉ dùng để trả trạng thái sạch giữa các test.
 *
 * Vì sao không nằm trong `src/lib/backup/khoa-bao-tri.ts`: đường trả khoá thật (`traKhoaPhucHoi`)
 * CỐ Ý đòi thẻ phiên, vì xoá vô điều kiện chính là lỗi mà thẻ sinh ra để bịt — một lượt phục hồi cũ
 * đã bị TTL nhả, về muộn, sẽ cướp cờ của lượt đang chạy. Để hàm xoá-bừa ở đây thì mã prod không có
 * đường nào gọi được nó.
 *
 * Vì sao test cần: cờ neo `globalThis` nên rò từ file test này sang file test khác; một file quên
 * trả khoá là mọi file chạy sau đều nhận 503, và lúc đó không file nào cầm được thẻ của lượt đã bỏ
 * quên.
 */
export function donKhoaPhucHoi(): void {
  delete (globalThis as Record<string, unknown>).__phienPhucHoiDb;
}
