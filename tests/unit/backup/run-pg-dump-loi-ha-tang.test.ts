import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `runPgDump` gói lỗi `execFile` giống hệt `run-restore.ts` (`stderr` thô CHỈ ra console server,
 * KHÔNG ghép vào message ném lên — message đó chảy thẳng vào response `/api/backup`). Lỗi giả ở
 * đây mang `stderr` NHẠY CẢM dù SIGTERM thường để `stderr` rỗng thật — cố ý khác thực tế để test
 * không mù: nếu code vô tình ghép `stderr` vào message, assertion "không chứa" phải bắt được.
 */
const STDERR_NHAY_CAM =
  'pg_dump: error: connection to server at "supabase-db" (172.18.0.5) failed: FATAL: role "postgres" does not exist';

const gia = vi.hoisted(() => ({ loi: undefined as Error | undefined }));

vi.mock("node:child_process", () => ({
  execFile: (
    _cmd: string,
    _args: string[],
    _opts: unknown,
    cb: (err: unknown, kq?: { stdout: Buffer; stderr: string }) => void,
  ) => {
    if (gia.loi) cb(gia.loi);
    else cb(new Error("Test chưa khai kịch bản lỗi"));
  },
}));

import { giay, HAN_PG_DUMP_MS } from "@/lib/backup/han-chay-lenh-pg";
import { runPgDump } from "@/lib/backup/run-pg-dump";

beforeEach(() => {
  gia.loi = undefined;
  vi.stubEnv("DATABASE_URL", "postgresql://u:p@db-gia:5432/postgres?schema=app");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loiKhiDump(): Promise<string> {
  const err = await runPgDump().then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return (err as Error).message;
}

describe("runPgDump — câu báo lỗi không lộ chi tiết hạ tầng", () => {
  it("quá hạn (SIGTERM) → câu báo cố định 'quá hạn', KHÔNG chứa stderr", async () => {
    gia.loi = Object.assign(new Error("Command failed"), {
      killed: true,
      signal: "SIGTERM",
      stderr: STDERR_NHAY_CAM,
    });

    const cau = await loiKhiDump();

    expect(cau).toContain(`quá hạn ${giay(HAN_PG_DUMP_MS)}`);
    expect(cau).not.toContain("supabase-db");
    expect(cau).not.toContain("172.18");
    expect(cau).not.toContain("FATAL");
  });

  it("lỗi khác (không quá hạn) → câu báo cố định, KHÔNG chứa stderr", async () => {
    gia.loi = Object.assign(new Error("exit 1"), {
      code: 1,
      killed: false,
      stderr: STDERR_NHAY_CAM,
    });

    const cau = await loiKhiDump();

    expect(cau).toContain("pg_dump thất bại");
    expect(cau).not.toContain("quá hạn");
    expect(cau).not.toContain("supabase-db");
    expect(cau).not.toContain("172.18");
    expect(cau).not.toContain("FATAL");
  });
});
