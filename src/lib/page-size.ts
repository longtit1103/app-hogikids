/**
 * Số dòng mỗi trang của MỌI bảng danh sách (đơn hàng, sản phẩm, biến thể/tồn kho, báo cáo SP, đơn theo
 * kênh, sổ chi phí) — quy ước thiết kế "phân trang 20 dòng/trang" (`docs/huong-dan-thiet-ke.md`).
 * MỘT nguồn: truy vấn phía server và bảng phía client dùng cùng hằng này nên số trang/`OFFSET` không
 * thể lệch nhau. Tách file riêng (không phụ thuộc gì) để cả client lẫn server import mà không kéo module nặng.
 */
export const PAGE_SIZE = 20;
