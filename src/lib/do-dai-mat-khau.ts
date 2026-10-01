/**
 * Hằng số thuần (KHÔNG import `node:crypto`) — form phía client cũng import được qua schema mật khẩu mới.
 * Đặt trong `password.ts` thì bundle trình duyệt kéo `promisify(scrypt)` và trang đổi mật khẩu lần đầu
 * sập ngay khi tải.
 */

/**
 * Trần độ dài mật khẩu, dùng CHUNG cho cả màn đăng nhập lẫn màn đổi mật khẩu.
 *
 * PHẢI là một hằng số duy nhất, không được để mỗi nơi tự khai một số: nếu màn đổi mật khẩu cho
 * đặt chuỗi dài hơn trần của màn đăng nhập thì chủ shop đặt xong sẽ TỰ KHOÁ MÌNH VĨNH VIỄN —
 * hash mới lưu thành công, mọi phiên bị thu hồi theo thiết kế, rồi lượt đăng nhập kế tiếp bị
 * chặn ngay ở bước kiểm dữ liệu và chỉ nhận đúng thông báo chung "Email hoặc mật khẩu không
 * đúng" (thông báo cố ý không nói lý do để chống dò tài khoản), nên không có cách nào đoán ra.
 * Đường thoát duy nhất khi đó là vào tận DB sửa tay.
 *
 * 200 dư sức cho cả passphrase dài lẫn chuỗi do trình quản lý mật khẩu sinh, mà vẫn chặn được
 * payload cỡ MB nhồi vào scrypt.
 */
export const MAX_PASSWORD_LENGTH = 200;
