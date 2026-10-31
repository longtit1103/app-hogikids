/**
 * `POST /api/restore` với cổng ghi THẬT + khoá ghi chung X THẬT (DB test): thứ tự lease → X → cờ →
 * drain → … → pre-backup, và mọi lối dừng trước phá huỷ là 409 "chưa thay đổi gì".
 *
 * Mock đúng các cửa ra ngoài như các suite restore khác: `runPgDump`/`runRestore` (không chạy pg client
 * thật), ghi file bản lùi, cổng quyền (chủ shop giả), thu hồi phiên, cổng SyncLog. Phần được kiểm —
 * cửa, bộ đếm, drain, khoá tư vấn, lối miễn — là mã thật.
 */
import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/session", () => ({
  thuHoiMoiPhienMoiNguoi: vi.fn(async () => undefined),
}));
vi.mock("@/lib/quyen/nguoi-dung-phien", async (importActual) => {
  const that = await importActual<typeof import("@/lib/quyen/nguoi-dung-phien")>();
  const { nguoiDungGia } = await import("../helpers/nguoi-dung-gia");
  return { ...that, docNguoiDungPhien: vi.fn(async () => nguoiDungGia()) };
});
vi.mock("@/lib/backup/thu-hoi-phien-co-han", () => ({
  thuHoiMoiPhienCoHan: vi.fn(async () => undefined),
}));
vi.mock("@/lib/ingest/sync-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ingest/sync-log")>()),
  coLuotDangChay: vi.fn(async () => false),
}));
vi.mock("@/lib/backup/run-pg-dump", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backup/run-pg-dump")>()),
  runPgDump: vi.fn(async () => Buffer.from("PGDMP-ban-lui-gia")),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const that = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...that,
    default: that,
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    readdir: vi.fn(async () => [] as string[]),
  };
});
vi.mock("@/lib/backup/run-restore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backup/run-restore")>()),
  kiemDumCoM1: vi.fn(async () => undefined),
  runRestore: vi.fn(async () => ({ format: "custom" as const })),
}));
// `choDrain` bọc spy (mặc định gọi bản thật) — chỉ để ép một ca "drain quá hạn" không phải chờ 2 phút.
vi.mock("@/lib/backup/cong-ghi-toan-cuc", async (importOriginal) => {
  const that = await importOriginal<typeof import("@/lib/backup/cong-ghi-toan-cuc")>();
  return { ...that, choDrain: vi.fn(that.choDrain) };
});

import { POST } from "@/app/api/restore/route";
import { choDrain, docBoDem, vaoCuaGhi } from "@/lib/backup/cong-ghi-toan-cuc";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { SO_KHOA_GHI_CHUNG, tienToAppCli } from "@/lib/backup/khoa-chung-cli";
import { runPgDump } from "@/lib/backup/run-pg-dump";
import { runRestore } from "@/lib/backup/run-restore";
import { thuHoiMoiPhienCoHan } from "@/lib/backup/thu-hoi-phien-co-han";
import { prisma } from "@/lib/prisma";
import { cauHinhClientKhoa } from "@/lib/tao-prisma-client";

import { anhDuLieu, chayGocRieng, choDen, datLaiCongGhi, doiChieu, donDuLieu, k, taoBarrier } from "./cong-ghi-helpers";

const URL_DB = process.env.DATABASE_URL!;

function yeuCauPhucHoi(): Request {
  const fd = new FormData();
  fd.append("file", new File([Buffer.from("PGDMP\x01noi-dung-gia")], "backup.dump"));
  return new Request("http://localhost/api/restore", { method: "POST", body: fd });
}

/** Số phiên đang giữ X khoá chung trên DB test (kiểm "đã nhả X"). */
async function soPhienGiuX(): Promise<number> {
  const r = await doiChieu.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_locks
     WHERE locktype = 'advisory' AND classid = 0 AND objid = ${SO_KHOA_GHI_CHUNG} AND objsubid = 1
       AND mode = 'ExclusiveLock' AND granted
       AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
  return r[0].n;
}

beforeEach(async () => {
  await donDuLieu();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(runPgDump).mockReset().mockResolvedValue(Buffer.from("PGDMP-ban-lui-gia"));
  vi.mocked(runRestore).mockReset().mockResolvedValue({ format: "custom" });
  vi.mocked(thuHoiMoiPhienCoHan).mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  datLaiCongGhi();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await donDuLieu();
  await doiChieu.$disconnect();
});

describe("POST /api/restore — cổng ghi + khoá ghi chung", () => {
  it("action vào TRƯỚC cờ ⇒ restore CHỜ nó commit rồi mới chụp bản lùi; action mới bị từ chối", async () => {
    const thuTu: string[] = [];
    const b = taoBarrier();
    const action = chayGocRieng(async () => {
      const cua = vaoCuaGhi();
      if (!cua.ok) return cua.loi;
      try {
        await prisma.setting.create({ data: { key: k("act:1"), value: "x" } });
        await b.cho();
        await prisma.setting.create({ data: { key: k("act:2"), value: "x" } });
        thuTu.push("action-commit");
        return { ok: true as const };
      } finally {
        cua.ra();
      }
    });
    await b.daToi;

    let anhLucChupBanLui: string[] = [];
    vi.mocked(runPgDump).mockImplementation(async () => {
      thuTu.push("pre-backup");
      anhLucChupBanLui = await anhDuLieu();
      return Buffer.from("PGDMP-ban-lui-gia");
    });

    const phucHoi = POST(yeuCauPhucHoi());
    await choDen(() => docBoDem().dangDrain);
    expect(dangPhucHoi()).toBe(true);
    expect(runPgDump).not.toHaveBeenCalled();
    // Lượt phục hồi KHÔNG tự đếm mình: bộ đếm chỉ có action đang chờ.
    expect(docBoDem().soRequest).toBe(1);

    // Writer mới trong lúc drain ⇒ bị từ chối ngay ở cửa.
    expect(
      await chayGocRieng(async () => {
        const cua = vaoCuaGhi();
        if (!cua.ok) return cua.loi;
        cua.ra();
        return { ok: true as const };
      }),
    ).toEqual({ ok: false, error: LOI_DANG_PHUC_HOI });

    b.mo();
    expect(await action).toEqual({ ok: true });
    const res = await phucHoi;
    expect(res.status).toBe(200);
    expect(thuTu).toEqual(["action-commit", "pre-backup"]);
    expect(anhLucChupBanLui).toEqual([`${k("act:1")}=x`, `${k("act:2")}=x`]);
    expect(dangPhucHoi()).toBe(false);
    expect(await soPhienGiuX()).toBe(0);
  });

  it("CLI đang giữ khoá chung ⇒ 409 kèm pid/application_name/backend_start, CHƯA bật cờ, chưa chụp bản lùi", async () => {
    const cli = new pg.Client(cauHinhClientKhoa(URL_DB, `${tienToAppCli()}:thu-test`));
    await cli.connect();
    try {
      const pid = (await cli.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await cli.query("SELECT pg_advisory_lock_shared($1)", [SO_KHOA_GHI_CHUNG]);
      const res = await POST(yeuCauPhucHoi());
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; phienDangGiu: { pid: number; applicationName: string; backendStart: string; mode: string }[] };
      expect(body.error).toMatch(/còn nguyên/);
      expect(body.phienDangGiu).toEqual([
        expect.objectContaining({ pid, applicationName: `${tienToAppCli()}:thu-test`, mode: "ShareLock" }),
      ]);
      expect(body.phienDangGiu[0].backendStart).toMatch(/^\d{4}-/);
      expect(dangPhucHoi()).toBe(false);
      expect(runPgDump).not.toHaveBeenCalled();
    } finally {
      await cli.end();
    }
    // Lease của lượt 409 đã được trả: lượt kế tiếp chạy trọn.
    expect((await POST(yeuCauPhucHoi())).status).toBe(200);
  });

  it("drain quá hạn ⇒ 409 chưa thay đổi gì, cờ + X nhả, không chụp bản lùi", async () => {
    vi.mocked(choDrain).mockResolvedValueOnce(false);
    const res = await POST(yeuCauPhucHoi());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/còn nguyên/);
    expect(runPgDump).not.toHaveBeenCalled();
    expect(dangPhucHoi()).toBe(false);
    expect(await soPhienGiuX()).toBe(0);
  });

  it("kết nối giữ X bị cắt giữa lúc chụp bản lùi ⇒ 409 ở chốt sau bản lùi, runRestore KHÔNG chạy", async () => {
    vi.mocked(runPgDump).mockImplementation(async () => {
      await doiChieu.$queryRaw`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = 'hogikids-restore'`;
      return Buffer.from("PGDMP-ban-lui-gia");
    });
    const res = await POST(yeuCauPhucHoi());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/khoá ghi chung/);
    expect(runRestore).not.toHaveBeenCalled();
    expect(dangPhucHoi()).toBe(false);
  });

  it("lượt phục hồi ghi được trong lúc giữ cờ (lối miễn): thu hồi phiên ghi DB qua singleton có cổng", async () => {
    vi.mocked(thuHoiMoiPhienCoHan).mockImplementation(async () => {
      expect(dangPhucHoi()).toBe(true);
      await prisma.setting.create({ data: { key: k("thu-hoi"), value: "x" } });
    });
    const res = await POST(yeuCauPhucHoi());
    expect(res.status).toBe(200);
    expect((await res.json()).canhBao).toBeUndefined();
    expect(await anhDuLieu()).toEqual([`${k("thu-hoi")}=x`]);
  });

  it("runRestore chạy chốt cuối: X còn giữ ngay trước lệnh phá huỷ", async () => {
    let xLucPhaHuy = -1;
    vi.mocked(runRestore).mockImplementation(async (_buf, opts) => {
      await opts?.truocKhiPhaHuy?.();
      xLucPhaHuy = await soPhienGiuX();
      return { format: "custom" };
    });
    expect((await POST(yeuCauPhucHoi())).status).toBe(200);
    expect(xLucPhaHuy).toBe(1);
    expect(await soPhienGiuX()).toBe(0);
  });
});
