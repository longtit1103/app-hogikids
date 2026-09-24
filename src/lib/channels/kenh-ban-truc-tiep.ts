/**
 * Kênh "Bán trực tiếp" — đơn lên từ màn "Bán hàng" của Pancake, khách trả tiền TẠI SHOP.
 *
 * Nhận diện (`mapChannel`): Pancake để trống nguồn đơn, không gắn sàn, và đánh dấu
 * `received_at_shop = true` — BẤT KỂ đơn tạo ở shop nào (đo 23/09: hai đơn đầu tiên tạo trong shop
 * TikTok). Đơn tạo tay trong shop sàn mà KHÔNG nhận tại shop vẫn về `website` như cũ.
 *
 * Tiền khách đã trả (`Order.paidAtShop`) là tiền THẬT đã về ⇒ Sổ quỹ cộng thẳng (đơn COMPLETED).
 * Chủ shop KHÔNG ghi tay `DIRECT_SALE` cho những đơn này — ghi là đếm tiền 2 lần.
 */
export const KENH_BAN_TRUC_TIEP = "direct";
