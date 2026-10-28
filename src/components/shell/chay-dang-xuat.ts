/**
 * Chạy đăng xuất qua Server Action và xử lý lỗi mạng: lời gọi ném (mất kết nối, máy chủ không phản
 * hồi) thì báo cho người dùng và Ở LẠI trang — phiên chưa xoá được nên không được điều hướng về
 * màn đăng nhập như thể đã thoát. Trả `true` khi đã đăng xuất.
 */
export async function chayDangXuat(d: {
  logout: () => Promise<unknown>;
  /** Chỉ gọi sau khi `logout` thành công. */
  dieuHuong: () => void;
  baoLoi: (thongDiep: string) => void;
}): Promise<boolean> {
  try {
    await d.logout();
  } catch {
    d.baoLoi("Không đăng xuất được — kiểm tra kết nối mạng rồi thử lại.");
    return false;
  }
  d.dieuHuong();
  return true;
}
