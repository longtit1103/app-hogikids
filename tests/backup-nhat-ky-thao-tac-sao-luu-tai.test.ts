import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Nhật ký thao tác (`AuditLog`) của nút "Sao lưu ngay" — `POST /api/backup` ghi `SAO_LUU_TAI`.
 *
 * Bản dump chứa TOÀN BỘ DB (hash mật khẩu, kho token) ⇒ lượt tải phải để lại dấu vết ở
 * `/quan-tri/nhat-ky`: OK ghi SAU khi file đã sinh xong và TRƯỚC khi trả file; ghi hỏng thì KHÔNG trả
 * file (fail-closed); pg_dump hỏng thì dòng LOI. Đang có lượt phục hồi giữ khoá thì bỏ dòng (cùng luật
 * dòng SyncLog: ghi lúc đó là INSERT vào schema sắp bị thay).
 */
vi.mock("@/lib/quyen/nguoi-dung-phien", async (importActual) => {
  const that = await importActual<typeof import("@/lib/quyen/nguoi-dung-phien")>();
  const { nguoiDungGia } = await import("./helpers/nguoi-dung-gia");
  return {
    ...that,
    docNguoiDungPhien: vi.fn(async () =>
      nguoiDungGia({ id: "test-nhat-ky-sao-luu", email: "chu-shop-sao-luu@hogikids.test" }),
    ),
  };
});
vi.mock("@/lib/backup/run-pg-dump", () => ({ runPgDump: vi.fn() }));
vi.mock("@/lib/backup/khoa-bao-tri", async (importOriginal) => {
  const thuc = await importOriginal<typeof import("@/lib/backup/khoa-bao-tri")>();
  return { ...thuc, dangPhucHoi: vi.fn(thuc.dangPhucHoi) };
});
vi.mock("@/lib/nhat-ky/ghi-nhat-ky", async (importOriginal) => {
  const thuc = await importOriginal<typeof import("@/lib/nhat-ky/ghi-nhat-ky")>();
  return { ...thuc, ghiNhatKy: vi.fn(thuc.ghiNhatKy) };
});

import { POST } from "@/app/api/backup/route";
import { dangPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { runPgDump } from "@/lib/backup/run-pg-dump";
import { ghiNhatKy } from "@/lib/nhat-ky/ghi-nhat-ky";
import { prisma } from "@/lib/prisma";

const ACTOR = "test-nhat-ky-sao-luu";

async function dongNhatKy() {
  return prisma.auditLog.findMany({ where: { actorId: ACTOR }, orderBy: { thoiDiem: "asc" } });
}

async function don(): Promise<void> {
  await prisma.auditLog.deleteMany({ where: { actorId: ACTOR } });
  await prisma.syncLog.deleteMany({ where: { kind: "BACKUP" } });
}

function req(): Request {
  return new Request("http://localhost/api/backup", { method: "POST" });
}

beforeEach(async () => {
  await don();
  vi.mocked(runPgDump).mockReset().mockResolvedValue(Buffer.from("PGDMP giả cho nhật ký"));
  vi.mocked(dangPhucHoi).mockReset().mockReturnValue(false);
  vi.mocked(ghiNhatKy).mockClear();
});

afterAll(async () => {
  await don();
  await prisma.$disconnect();
});

describe("POST /api/backup — nhật ký SAO_LUU_TAI", () => {
  it("dump OK ⇒ 200 kèm file + ĐÚNG 1 dòng OK mang actor và tên file, ghi SAU pg_dump", async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    const tenFile = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1];

    const dong = await dongNhatKy();
    expect(dong).toHaveLength(1);
    expect(dong[0]).toMatchObject({
      hanhDong: "SAO_LUU_TAI",
      ketQua: "OK",
      actorEmail: "chu-shop-sao-luu@hogikids.test",
      doiTuongLoai: "BanSaoLuu",
      doiTuongMoTa: tenFile,
    });
    expect(vi.mocked(runPgDump).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(ghiNhatKy).mock.invocationCallOrder[0],
    );
  });

  it("pg_dump hỏng ⇒ 500 + 1 dòng LOI, không dòng OK", async () => {
    vi.mocked(runPgDump).mockRejectedValue(new Error("pg_dump: kết nối bị từ chối"));
    const res = await POST(req());
    expect(res.status).toBe(500);
    const dong = await dongNhatKy();
    expect(dong).toHaveLength(1);
    expect(dong[0]).toMatchObject({ hanhDong: "SAO_LUU_TAI", ketQua: "LOI", ghiChu: { lyDo: "Sao lưu thất bại" } });
  });

  it("ghi nhật ký OK hỏng ⇒ 500, KHÔNG trả file, KHÔNG có SyncLog OK", async () => {
    vi.mocked(ghiNhatKy).mockRejectedValueOnce(new Error("mất kết nối DB giữa chừng"));
    const res = await POST(req());
    expect(res.status).toBe(500);
    expect(res.headers.get("Content-Disposition")).toBeNull();
    expect((await res.json()).error).toMatch(/nhật ký/);
    const log = await prisma.syncLog.findMany({ where: { kind: "BACKUP" } });
    expect(log.map((l) => l.status)).toEqual(["ERROR"]);
  });

  it("lượt phục hồi bắt đầu trong lúc pg_dump chạy ⇒ bỏ dòng nhật ký (không ghi vào schema sắp bị thay)", async () => {
    vi.mocked(runPgDump).mockImplementation(async () => {
      vi.mocked(dangPhucHoi).mockReturnValue(true);
      return Buffer.from("PGDMP giả");
    });
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(ghiNhatKy).not.toHaveBeenCalled();
    expect(await dongNhatKy()).toHaveLength(0);
  });
});
