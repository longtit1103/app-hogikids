import { PrismaClient } from "@prisma/client";

/**
 * Singleton PrismaClient. Next.js dev mode hot-reloads modules on every save;
 * without caching the client on `globalThis`, each reload would construct a
 * fresh PrismaClient and slowly exhaust the Postgres connection pool.
 * Production runs a single long-lived process, so the cache is a no-op there.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
