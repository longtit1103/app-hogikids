import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TTL khoá phục hồi tính từ NGÂN SÁCH số lệnh nhanh trong vùng giữ khoá (`NGAN_SACH_LENH_NHANH`,
 * `han-chay-lenh-pg.ts`). Ngân sách đó chỉ đúng khi số lệnh THẬT của mỗi nhánh `runRestore` còn nằm
 * dưới nó kèm biên — suite này ĐẾM lệnh thật (chặn `execFile`, đọc `timeout` từng lời gọi) thay vì tin
 * comment. Thêm một lệnh nhanh vào một nhánh mà không nới ngân sách ⇒ đỏ ở đây, không phải chờ một
 * lượt phục hồi thật bị TTL nhả cờ giữa chừng.
 *
 * `runRestore` nằm TRỌN trong vùng giữ khoá (route gọi nó sau khi giành khoá bảo trì). Cổng sớm
 * `kiemDumCoM1` của route chạy trước khi giành khoá nên không thuộc phép đếm này.
 */
const gia = vi.hoisted(() => {
  const goi: { cmd: string; args: string[]; timeout: number | undefined }[] = [];
  const copyM1 =
    "COPY app._prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count) FROM stdin;\n" +
    "m1\tc\t2026-09-30 17:00:00+00\t20260930170000_tai_khoan_phu_phan_quyen\t\\N\t\\N\t2026-09-30 17:00:00+00\t1\n" +
    "\\.\n";
  return { goi, copyM1 };
});

vi.mock("node:child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    opts: { timeout?: number },
    cb: (err: unknown, kq?: { stdout: string; stderr: string }) => void,
  ) => {
    gia.goi.push({ cmd, args, timeout: opts.timeout });
    // Mục lục rỗng (không object lạ), khối migration có M1, câu hỏi quyền trả "t", còn lại rỗng.
    const stdout = args[0] === "-a" ? gia.copyM1 : args.includes("-At") ? "t\n" : "";
    cb(null, { stdout, stderr: "" });
  },
}));

import {
  HAN_LENH_NHANH_MS,
  HAN_NAP_PHUC_HOI_MS,
  NGAN_SACH_LENH_NHANH,
} from "@/lib/backup/han-chay-lenh-pg";
import { runRestore } from "@/lib/backup/run-restore";

/** Biên tối thiểu phải còn giữa số lệnh thật và ngân sách (xem comment `NGAN_SACH_LENH_NHANH`). */
const BIEN_TOI_THIEU = 2;

const DUMP = Buffer.from("PGDMP\x01noi-dung-gia");
const SQL_GZ = readFileSync(join(__dirname, "../../fixtures/backup/sau-m1.sql.gz"));

function demTheoHan(): { nhanh: number; nap: number; khac: number } {
  const nhanh = gia.goi.filter((g) => g.timeout === HAN_LENH_NHANH_MS).length;
  const nap = gia.goi.filter((g) => g.timeout === HAN_NAP_PHUC_HOI_MS).length;
  return { nhanh, nap, khac: gia.goi.length - nhanh - nap };
}

beforeEach(() => {
  gia.goi.length = 0;
  vi.stubEnv("DATABASE_URL", "postgresql://u:p@db-gia:5432/postgres?schema=app");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("số lệnh nhanh trong vùng giữ khoá nằm dưới ngân sách TTL, còn biên", () => {
  it.each([
    ["custom (.dump)", DUMP, "custom"],
    ["plain (.sql.gz)", SQL_GZ, "plain-gzip"],
  ] as const)("nhánh %s: đúng 1 lệnh nạp, lệnh nhanh + biên ≤ ngân sách", async (_ten, file, dinhDang) => {
    await expect(runRestore(file)).resolves.toEqual({ format: dinhDang });

    const dem = demTheoHan();
    expect(dem.nap).toBe(1);
    expect(dem.khac).toBe(0); // mọi lệnh đều mang một trong hai hạn đã tính vào TTL
    expect(dem.nhanh + BIEN_TOI_THIEU).toBeLessThanOrEqual(NGAN_SACH_LENH_NHANH);
  });

  it("số đo hiện tại: mỗi nhánh đúng 3 lệnh nhanh (đổi thì cập nhật comment ngân sách)", async () => {
    await runRestore(DUMP);
    const custom = demTheoHan().nhanh;
    gia.goi.length = 0;
    await runRestore(SQL_GZ);
    const plain = demTheoHan().nhanh;

    expect({ custom, plain }).toEqual({ custom: 3, plain: 3 });
  });
});
