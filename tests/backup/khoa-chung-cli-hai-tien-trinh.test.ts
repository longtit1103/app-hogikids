/**
 * KHOÁ GHI CHUNG CLI ↔ restore, bằng HAI tiến trình Node thật trên DB test: tiến trình test = phía
 * restore (`giuDocQuyenRestore`); tiến trình con = script CLI dùng singleton `@/lib/prisma` thật
 * (`tests/backup/tien-trinh-con/cli-ghi-thu-khoa-chung.ts`).
 *
 * Tiến trình con chạy với env đã XOÁ `VITEST` (Vitest được miễn khoá CLI) và tự báo `che-do` — test
 * khẳng định nó KHÔNG được miễn, không thì cả file xanh giả.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  catPhienGiuKhoaChung,
  giuDocQuyenRestore,
  SO_KHOA_GHI_CHUNG,
  tienToAppCli,
  type KetQuaGiuDocQuyen,
} from "@/lib/backup/khoa-chung-cli";
import { cauHinhClientKhoa, cheDoKhoaCli } from "@/lib/tao-prisma-client";

import { doiChieu } from "./cong-ghi-helpers";

const URL_TEST = process.env.TEST_DATABASE_URL!;
const SCRIPT = "tests/backup/tien-trinh-con/cli-ghi-thu-khoa-chung.ts";
const TEN_APP_CLI = `${tienToAppCli()}:cli-ghi-thu-khoa-chung.ts`;
const conSong: ChildProcess[] = [];

type SuKien = { su_kien: string; [k: string]: unknown };

const cauHinhRestore = () => cauHinhClientKhoa(URL_TEST, "hogikids-restore-test");

function chayCli(cheDo: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: URL_TEST, CLI_GHI_THU: "1" };
  delete env.VITEST;
  delete env.NEXT_RUNTIME;
  const proc = spawn(process.execPath, ["--import", "tsx", SCRIPT, cheDo], {
    cwd: process.cwd(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  conSong.push(proc);
  const suKien: SuKien[] = [];
  const nguoiCho: Array<() => void> = [];
  createInterface({ input: proc.stdout! }).on("line", (dong) => {
    try {
      suKien.push(JSON.parse(dong) as SuKien);
      nguoiCho.splice(0).forEach((f) => f());
    } catch {
      /* dòng không phải JSON */
    }
  });
  let stderr = "";
  proc.stderr!.on("data", (d) => (stderr += String(d)));
  const ketThuc = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((r) =>
    proc.on("exit", (code, signal) => r({ code, signal, stderr })),
  );
  const cho = async (ten: string): Promise<SuKien> => {
    for (;;) {
      const sk = suKien.find((x) => x.su_kien === ten);
      if (sk) return sk;
      const thoat = await Promise.race([new Promise<false>((r) => nguoiCho.push(() => r(false))), ketThuc.then(() => true)]);
      if (thoat && !suKien.find((x) => x.su_kien === ten)) throw new Error(`CLI thoát trước sự kiện ${ten}: ${stderr}`);
    }
  };
  return { proc, cho, ketThuc };
}

/** Chờ tiến trình thoát, có hạn (hạn = lưới chống treo test, không phải phép đo). */
function thoatTrong<T>(p: Promise<T>, ms: number): Promise<T | "het-han"> {
  return Promise.race([p, new Promise<"het-han">((r) => setTimeout(() => r("het-han"), ms))]);
}

/** Giành X, lặp tới khi được (hạn 10s chống treo). */
async function giuXCoHan(): Promise<KetQuaGiuDocQuyen> {
  const het = Date.now() + 10_000;
  let x = await giuDocQuyenRestore(cauHinhRestore());
  while (!x.ok && Date.now() < het) {
    await new Promise((r) => setTimeout(r, 50));
    x = await giuDocQuyenRestore(cauHinhRestore());
  }
  return x;
}

async function donDongCli(): Promise<void> {
  await doiChieu.setting.deleteMany({ where: { key: { startsWith: "cong-ghi-test:cli:" } } });
}

beforeEach(() => donDongCli());
afterAll(async () => {
  for (const p of conSong) if (p.exitCode === null) p.kill("SIGKILL");
  await donDongCli();
  await doiChieu.$disconnect();
});

describe("chế độ khoá CLI", () => {
  it("tiến trình Vitest được miễn; tiến trình con (đã xoá VITEST) KHÔNG được miễn", async () => {
    expect(cheDoKhoaCli()).toBe(false);
    const cli = chayCli("ghi-mot");
    expect(await cli.cho("che-do")).toMatchObject({ khoaCli: true, coVitest: false });
    expect((await cli.ketThuc).code).toBe(0);
  }, 60_000);

  it("cauHinhClientKhoa: bóc application_name sẵn có trong URL, gắn keepAlive + tên ứng dụng", () => {
    const c = cauHinhClientKhoa("postgresql://u:p@h:5432/db_test?schema=app&application_name=khac", "ten-moi");
    expect(new URL(String(c.connectionString)).searchParams.has("application_name")).toBe(false);
    expect(c).toMatchObject({ application_name: "ten-moi", keepAlive: true, options: "-c search_path=app -c TimeZone=UTC" });
  });
});

describe("CLI ngoài tiến trình ↔ restore", () => {
  it("CLI đã ghi (giữ shared) ⇒ restore không giành được X, trả pid/application_name/backend_start", async () => {
    const cli = chayCli("ghi-roi-cho");
    const { pidKhoa } = await cli.cho("da-ghi");
    const x = await giuDocQuyenRestore(cauHinhRestore());
    expect(x.ok).toBe(false);
    if (x.ok) return;
    expect(x.nguoiGiu).toEqual([expect.objectContaining({ pid: pidKhoa, mode: "ShareLock", applicationName: TEN_APP_CLI, catDuoc: true })]);
    expect(x.nguoiGiu[0].backendStart).toMatch(/^\d{4}-/);
    cli.proc.stdin!.write("thoat\n");
    expect((await cli.ketThuc).code).toBe(0);
  }, 60_000);

  it("restore giữ X ⇒ CLI ném ở lần ghi đầu, exit 3, không ghi dòng nào", async () => {
    const x = await giuDocQuyenRestore(cauHinhRestore());
    expect(x.ok).toBe(true);
    try {
      const cli = chayCli("ghi-mot");
      await cli.cho("bi-chan");
      expect((await cli.ketThuc).code).toBe(3);
      expect(await doiChieu.setting.count({ where: { key: { startsWith: "cong-ghi-test:cli:mot:" } } })).toBe(0);
    } finally {
      if (x.ok) await x.khoa.nha();
    }
  }, 60_000);

  it("`$disconnect()` của client nhả khoá — tiến trình còn sống nhưng restore giành được X", async () => {
    const cli = chayCli("ghi-roi-disconnect");
    await cli.cho("da-nha");
    const x = await giuXCoHan();
    expect(x.ok).toBe(true);
    if (x.ok) await x.khoa.nha();
    cli.proc.stdin!.write("thoat\n");
    expect((await cli.ketThuc).code).toBe(0);
  }, 60_000);

  it("kill -9 CLI đang giữ khoá ⇒ restore giành được X", async () => {
    const cli = chayCli("ghi-roi-cho");
    await cli.cho("da-ghi");
    expect((await giuDocQuyenRestore(cauHinhRestore())).ok).toBe(false);
    cli.proc.kill("SIGKILL");
    expect((await cli.ketThuc).signal).toBe("SIGKILL");
    const x = await giuXCoHan();
    expect(x.ok).toBe(true);
    if (x.ok) await x.khoa.nha();
  }, 60_000);

  it("conGiu(): true khi còn giữ X, false khi kết nối giữ X bị cắt", async () => {
    const x = await giuDocQuyenRestore(cauHinhRestore());
    expect(x.ok).toBe(true);
    if (!x.ok) return;
    expect(await x.khoa.conGiu()).toBe(true);
    await doiChieu.$queryRaw`SELECT pg_terminate_backend(${x.khoa.pid}::int)`;
    expect(await x.khoa.conGiu()).toBe(false);
    await x.khoa.nha();
  }, 60_000);

  it("catPhienGiuKhoaChung: cắt đúng phiên CLI đang giữ ⇒ CLI exit 1; pid không giữ khoá ⇒ không cắt", async () => {
    const cli = chayCli("ghi-roi-cho");
    const { pidKhoa } = await cli.cho("da-ghi");
    const pidLa = (await doiChieu.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid;
    expect(await catPhienGiuKhoaChung(cauHinhRestore(), pidLa)).toEqual({ ketQua: "khong-chan" });
    expect(await catPhienGiuKhoaChung(cauHinhRestore(), Number(pidKhoa))).toEqual({ ketQua: "da-cat" });
    const kq = await thoatTrong(cli.ketThuc, 10_000);
    expect(kq).not.toBe("het-han");
    if (kq === "het-han") return;
    expect(kq.code).toBe(1);
    expect(kq.stderr).toContain("mất kết nối giữ khoá");
  }, 60_000);

  it("phiên POOL CLI rảnh (không giữ khoá) chặn restore ⇒ cắt được ⇒ restore giành X đi tiếp", async () => {
    // Script ngủ (Mac gập máy): kết nối khoá đã tuột/đã cắt, nhưng kết nối POOL còn sống phía server.
    // Restore giành được X rồi chờ phiên CLI tắt ⇒ 409 liệt kê đúng phiên pool này — nút cắt phải cắt được.
    const pool = new pg.Client(cauHinhClientKhoa(URL_TEST, `${tienToAppCli()}-pool`));
    pool.on("error", () => {});
    await pool.connect();
    try {
      const lan1 = await giuDocQuyenRestore(cauHinhRestore(), 300);
      expect(lan1.ok).toBe(false);
      if (lan1.ok) return;
      const phien = lan1.nguoiGiu.find((p) => p.applicationName === `${tienToAppCli()}-pool`);
      expect(phien?.mode).toBe("phien:idle");
      if (!phien) return;

      // pid đúng mà backend_start lệch (pid đã thuộc phiên mới) ⇒ không cắt.
      expect(await catPhienGiuKhoaChung(cauHinhRestore(), phien.pid, "2000-01-01T00:00:00.000Z")).toEqual({ ketQua: "khong-chan" });
      expect(await catPhienGiuKhoaChung(cauHinhRestore(), phien.pid, phien.backendStart)).toEqual({ ketQua: "da-cat" });

      const lan2 = await giuDocQuyenRestore(cauHinhRestore(), 5_000);
      expect(lan2.ok).toBe(true);
      if (lan2.ok) await lan2.khoa.nha();
    } finally {
      await pool.end().catch(() => {});
    }
  }, 60_000);

  it("KHÔNG cắt phiên giữ X của lượt phục hồi, cũng không cắt phiên mang tiền tố restore", async () => {
    const x = await giuDocQuyenRestore(cauHinhRestore());
    expect(x.ok).toBe(true);
    if (!x.ok) return;
    const restoreKhac = new pg.Client(cauHinhClientKhoa(URL_TEST, "hogikids-restore"));
    restoreKhac.on("error", () => {});
    await restoreKhac.connect();
    try {
      // Cắt bằng một kết nối KHÁC (như route cắt phiên) — cùng role, cùng DB.
      const catBang = cauHinhClientKhoa(URL_TEST, "hogikids-cat-phien");
      expect(await catPhienGiuKhoaChung(catBang, x.khoa.pid)).toEqual({ ketQua: "khong-chan" });
      expect(await x.khoa.conGiu()).toBe(true);
      const pidRestoreKhac = (await restoreKhac.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      expect(await catPhienGiuKhoaChung(catBang, pidRestoreKhac)).toEqual({ ketQua: "khong-chan" });
    } finally {
      await restoreKhac.end().catch(() => {});
      await x.khoa.nha();
    }
  }, 60_000);

  it("cắt kết nối giữ khoá của CLI đang ghi liên tục ⇒ CLI exit 1, 0 dòng ghi sau khi restore giữ X", async () => {
    const cli = chayCli("ghi-lien-tuc");
    const { pidKhoa } = await cli.cho("dang-ghi");
    const admin = new pg.Client(cauHinhClientKhoa(URL_TEST, "cong-ghi-test-cat"));
    await admin.connect();
    let x: KetQuaGiuDocQuyen | null = null;
    try {
      const du = Date.now() + 10_000;
      while (
        (await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM "Setting" WHERE key LIKE $1`, ["cong-ghi-test:cli:lt:%"])).rows[0]
          .n < 30 &&
        Date.now() < du
      );
      await admin.query("SELECT pg_terminate_backend($1)", [pidKhoa]);
      x = await giuXCoHan();
      expect(x.ok).toBe(true);
      const mocX = (await admin.query<{ t: string }>("SELECT clock_timestamp()::text AS t")).rows[0].t;
      const kq = await thoatTrong(cli.ketThuc, 10_000);
      expect(kq).not.toBe("het-han");
      if (kq === "het-han") return;
      expect(kq.code).toBe(1);
      expect(kq.stderr).toContain("mất kết nối giữ khoá");
      const sau = await admin.query<{ n: number }>(
        `SELECT count(*) FILTER (WHERE value::timestamptz > $2::timestamptz)::int AS n FROM "Setting" WHERE key LIKE $1`,
        ["cong-ghi-test:cli:lt:%", mocX],
      );
      expect(sau.rows[0].n).toBe(0);
    } finally {
      if (x?.ok) await x.khoa.nha();
      await admin.end();
    }
  }, 60_000);

  it("lệnh ghi đang bay lúc khoá tuột ⇒ restore chỉ coi là giữ X khi phiên CLI đã tắt; 0 dòng commit sau X", async () => {
    const cli = chayCli("ghi-cham");
    const { pidKhoa } = await cli.cho("dang-ghi");
    const admin = new pg.Client(cauHinhClientKhoa(URL_TEST, "cong-ghi-test-cat"));
    await admin.connect();
    let x: KetQuaGiuDocQuyen | null = null;
    try {
      const du = Date.now() + 10_000;
      while (
        (
          await admin.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND state = 'active' AND query LIKE '%pg_sleep(0.5)%'
                AND application_name LIKE $1`,
            [`${tienToAppCli()}%`],
          )
        ).rows[0].n === 0 &&
        Date.now() < du
      );
      await admin.query("SELECT pg_terminate_backend($1)", [pidKhoa]);
      x = await giuXCoHan();
      expect(x.ok).toBe(true);
      const mocX = (await admin.query<{ t: string }>("SELECT clock_timestamp()::text AS t")).rows[0].t;
      expect(await thoatTrong(cli.ketThuc, 10_000)).not.toBe("het-han");
      // Chờ hơn một nhịp ghi chậm để lệnh đang bay (nếu có) kịp commit trước khi đếm.
      await new Promise((r) => setTimeout(r, 1_000));
      const sau = await admin.query<{ n: number }>(
        `SELECT count(*) FILTER (WHERE value::timestamptz > $2::timestamptz)::int AS n FROM "Setting" WHERE key LIKE $1`,
        ["cong-ghi-test:cli:cham:%", mocX],
      );
      expect(sau.rows[0].n).toBe(0);
    } finally {
      if (x?.ok) await x.khoa.nha();
      await admin.end();
    }
  }, 60_000);

  it("số khoá cố định — app, CLI và restore cùng một K", () => {
    expect(SO_KHOA_GHI_CHUNG).toBe(261_028_001);
  });
});
