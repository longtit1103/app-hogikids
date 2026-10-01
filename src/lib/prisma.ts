import type { PrismaClient } from "@/generated/prisma/client";

import { taoPrismaClient } from "./tao-prisma-client";

/**
 * Singleton PrismaClient. Next.js dev mode hot-reloads modules on every save;
 * without caching the client on `globalThis`, each reload would construct a
 * fresh PrismaClient and slowly exhaust the Postgres connection pool.
 * Production runs a single long-lived process, so the cache is a no-op there.
 *
 * `DATABASE_URL` được đọc ĐÚNG lúc dựng singleton (lần import đầu) — `tests/setup.ts` và
 * `tests/e2e/global-setup.ts` dựa vào điều này: chúng hoán URL sang DB test TRƯỚC khi import.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? taoPrismaClient(process.env.DATABASE_URL);

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
