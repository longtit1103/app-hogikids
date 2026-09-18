/**
 * Shop id CỐ ĐỊNH của bộ fixture test — trước 2026-08-21 là hằng runtime trong
 * `src/lib/bronze/streams.ts`, nay runtime đọc từ bảng `Setting` (cấu hình được cho bản clone,
 * xem `src/lib/ket-noi/cau-hinh-shop.ts`) còn test giữ NGUYÊN giá trị cũ ở đây vì toàn bộ
 * fixture (payload Pancake thật đã gột) đều mang các id này.
 *
 * `tests/setup.ts` seed đúng 4 key `Setting` bằng đúng 4 giá trị này cho MỌI file test —
 * fixture và cấu hình lệch nhau là landRaw từ chối cả stream ngay dòng test đầu tiên.
 */
export const SHOP_KHO = "714995134";
export const SHOP_SHOPEE = "1942992175";
export const SHOP_TIKTOK = "100975192";
export const SHOP_TIKTOK_SHOP = "7494544063361551019";
/** Warehouse (uuid) của kho Kho Tổng — guard tồn realtime, key `pancakeWarehouseIdKhoTong`. */
export const WAREHOUSE_KHO_TONG = "8ea354a7-2350-4446-a1d5-8308353ff841";

/**
 * MỘT nguồn cho mọi nơi seed `Setting` (vitest setupFiles · e2e global-setup · helper
 * `seedShopIdSetting`) — thêm key cấu hình bắt buộc mới thì chỉ sửa Ở ĐÂY, ba nơi seed tự theo
 * (trước đây 3 danh sách chép tay là drift chờ sẵn: một phần suite đỏ ngẫu nhiên, phần khác xanh).
 */
export const SEED_SHOP_ID: ReadonlyArray<[key: string, value: string]> = [
  ["pancakeShopIdKho", SHOP_KHO],
  ["pancakeShopIdShopee", SHOP_SHOPEE],
  ["pancakeShopIdTiktok", SHOP_TIKTOK],
  ["tiktokShopShopId", SHOP_TIKTOK_SHOP],
  ["pancakeWarehouseIdKhoTong", WAREHOUSE_KHO_TONG],
];
