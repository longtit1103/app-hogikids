import type { PrismaClient } from "@/generated/prisma/client";

import { taoPrismaClient } from "./tao-prisma-client";

/**
 * Singleton PrismaClient của app — client DUY NHẤT bật CỔNG GHI trong tiến trình (`{ congGhi: true }`:
 * lưới phụ cấp op + đếm `$transaction` lẻ, xem `src/lib/backup/cong-ghi-toan-cuc.ts`). Ngoài Next
 * (script nạp `@/lib/prisma`) nó còn tự giữ khoá ghi chung CLI ở lần ghi đầu (`tao-prisma-client.ts`).
 *
 * ⚠️ Neo `globalThis` ở MỌI môi trường, kể cả production — KHÔNG chỉ để chống hot-reload: Next nạp
 * module thành NHIỀU bản sao trong cùng tiến trình (bundle server action ≠ bundle route handler). Mỗi
 * bản sao dựng một client riêng là nhân đôi pool kết nối, và lớp bọc cổng ghi của bản này không thấy
 * `$transaction` lẻ đang chạy ở bản kia. Đo MỘT LẦN ở spike trên `next build && next start`: bỏ neo ⇒
 * route đọc bộ đếm = 0 trong khi action đang ghi. Lưới hồi quy thường trực là bản Vitest mô phỏng hai
 * bản module bằng `vi.resetModules()` (`tests/backup/cong-ghi-mot-bo-dem-va-ep-kieu.test.ts`), kèm lưới
 * trên bản build thật `npm run test:e2e:prod:cong-ghi` (`tests/e2e/cong-ghi-prod.spec.ts` — action và route
 * ở hai bundle đọc CÙNG bộ đếm; bỏ neo ⇒ đỏ). Đổi bundler/cấu hình Next thì chạy lại lệnh đó.
 *
 * `DATABASE_URL` được đọc ĐÚNG lúc dựng singleton (lần import đầu) — `tests/setup.ts` và
 * `tests/e2e/global-setup.ts` dựa vào điều này: chúng hoán URL sang DB test TRƯỚC khi import.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient = (globalForPrisma.prisma ??= taoPrismaClient(process.env.DATABASE_URL, {
  congGhi: true,
}));
