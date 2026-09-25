import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `giuKhoaViecNang` (đọc/ghi bảng `Setting`) đứng TRƯỚC `runPgDump()` trong route, nên nếu nó NÉM
 * (DB down) mà route không bọc riêng thì lỗi thoát thẳng ra ngoài handler — Next.js trả 500 HTML
 * mặc định, phá hợp đồng JSDoc của route ("luôn trả 500 JSON {error}"). Suite này ép đúng nhánh đó
 * bằng cách mock `giuKhoaViecNang` ném lỗi, giữ nguyên `traKhoaViecNang` thật (không được gọi vì
 * `theViec` chưa từng có).
 */
vi.mock("@/lib/session", () => ({
  getAuthenticatedUserId: vi.fn(async () => "test-user-id"),
}));
vi.mock("@/lib/backup/run-pg-dump", () => ({
  runPgDump: vi.fn(async () => Buffer.from("PGDMP giả")),
}));
vi.mock("@/lib/backup/khoa-viec-nang", async (importOriginal) => {
  const thuc = await importOriginal<typeof import("@/lib/backup/khoa-viec-nang")>();
  return { ...thuc, giuKhoaViecNang: vi.fn(thuc.giuKhoaViecNang) };
});

import { POST } from "@/app/api/backup/route";
import { giuKhoaViecNang } from "@/lib/backup/khoa-viec-nang";
import { prisma } from "@/lib/prisma";

function req(): Request {
  return new Request("http://localhost/api/backup", { method: "POST" });
}

beforeEach(async () => {
  await prisma.syncLog.deleteMany({ where: { kind: "BACKUP" } });
  vi.mocked(giuKhoaViecNang).mockReset();
});

afterAll(async () => {
  await prisma.syncLog.deleteMany({ where: { kind: "BACKUP" } });
  await prisma.$disconnect();
});

describe("POST /api/backup — giuKhoaViecNang ném (DB không phản hồi)", () => {
  it("→ 503 JSON câu cố định, KHÔNG lộ message Prisma thô, KHÔNG ghi SyncLog", async () => {
    const LOI_DB_THO = 'Prisma: connect ECONNREFUSED supabase-db:5432 role "postgres"';
    vi.mocked(giuKhoaViecNang).mockRejectedValueOnce(new Error(LOI_DB_THO));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const res = await POST(req());

      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).not.toContain(LOI_DB_THO);
      expect(body.error).not.toContain("supabase-db");
      expect(body.error).toContain("khoá việc nặng");

      expect(await prisma.syncLog.count({ where: { kind: "BACKUP" } })).toBe(0);
    } finally {
      log.mockRestore();
    }
  });
});
