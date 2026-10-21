/**
 * Số dòng mỗi trang của sổ chi phí. Tách khỏi `expense-queries.ts` (module nặng, chạm Prisma) để trang/tab
 * cần số này — vd về trang cuối khi `?trang=` vượt — không phải kéo cả module truy vấn vào.
 */
export const EXPENSE_PAGE_SIZE = 20;
