/**
 * Khuôn DUY NHẤT của bc_id Business Center TikTok (chuỗi 6–32 chữ số; thực tế 19). Dùng chung cho kho thô
 * (`landRaw` stream `tiktokbusiness/invoice` + `tiktokbusiness/cost`), route dấu lượt hoá đơn, action đánh dấu BC "không
 * dùng thẻ" và CHECK `TiktokBcHoaDon_bc_id_khuon` của bảng bền (`'^[0-9]{6,32}$'` — cùng nghĩa; test
 * `tests/unit/no-phai-tra/khuon-bc-id-tiktok.test.ts` ghim hai bên). Hai khuôn lệch nhau thì BC lọt kho thô (cổng nhớ là
 * "từng đọc được") mà không bao giờ đánh dấu được ⇒ chặn vĩnh viễn.
 */
export const BC_ID_TIKTOK_HOP_LE = /^\d{6,32}$/;
