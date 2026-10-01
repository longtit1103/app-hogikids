import { existsSync } from "node:fs";
import path from "node:path";

import { defineConfig } from "prisma/config";

/**
 * Cấu hình Prisma CLI (Prisma 7 — thay cho `url` trong `schema.prisma` và mục `"prisma"` trong
 * `package.json`). CHỈ dùng cho lệnh CLI: `migrate deploy/status/dev`, `db seed`, `db execute`,
 * `generate`. Client lúc chạy app KHÔNG đọc file này — nó dựng ở `src/lib/tao-prisma-client.ts`.
 *
 * Nạp `.env`: Prisma 7 thôi tự nạp `.env` cho CLI. Giữ NGUYÊN hành vi của Prisma 6 bằng loader có sẵn
 * của Node (không thêm `dotenv`): biến đã có trong môi trường THẮNG `.env` (`process.loadEnvFile`
 * không đè biến sẵn có) — nên lệnh gọi kèm `DATABASE_URL=<db test>` (CI, `tests/e2e/global-setup.ts`,
 * `scripts/preview-local.sh`) vẫn trỏ đúng DB test như trước. Không có `.env` (container, CI) thì bỏ
 * qua — container nhận biến qua `env_file` của docker compose.
 *
 * `url` đọc `process.env` chứ KHÔNG dùng helper `env()` của Prisma: `env()` ném lỗi khi thiếu biến,
 * mà `prisma generate` trong `Dockerfile` chạy KHÔNG có `DATABASE_URL` (ảnh không nướng secret).
 * Lệnh cần DB thật mà thiếu biến vẫn tự báo lỗi thiếu URL.
 *
 * Schema Postgres (`app`) vẫn đi theo tham số `?schema=app` trong URL — schema engine của CLI hiểu
 * tham số này như Prisma 6.
 */
const envPath = path.resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "",
  },
});
