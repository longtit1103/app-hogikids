/**
 * File `src/` còn đi qua wrapper "chỉ đòi đăng nhập" thay vì ba cổng quyền (`yeuCauQuyenTrang` /
 * `congAction` / `congRoute`). ĐÃ RỖNG: hai wrapper cũ đã xoá khỏi `src/lib/session.ts`, mọi trang /
 * action / route mở bằng cổng quyền. Lưới `cong-bat-buoc.test.ts` ca (1) ép mảng này rỗng và khoá tập
 * export của `session.ts` — khôi phục wrapper là đỏ.
 */
export const ALLOWLIST_WRAPPER_CU: readonly string[] = [];
