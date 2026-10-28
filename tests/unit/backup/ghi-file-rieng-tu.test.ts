import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { chuanBiThuMucRiengTu, ghiFileRiengTu } from "@/lib/backup/ghi-file-rieng-tu";
import { ghiBackupVaXacMinh, type NoiDungBackup } from "@/lib/gia-von/ghi-gia-von-theo-pancake";

/**
 * Bản lùi trước phục hồi + file tạm chứa DUMP (hash mật khẩu, kho token) phải chỉ chủ tiến trình đọc
 * được. Đo bằng `stat` THẬT trên đĩa dưới `umask 0022` (mặc định container) và thư mục ĐÃ TỒN TẠI
 * mode 0755 (bind-mount `./backups` có sẵn từ host) — `mkdir(…, { mode })` một mình không siết được
 * thư mục có sẵn nên test phải dựng đúng ca đó.
 */

const modeCua = async (p: string) => (await stat(p)).mode & 0o777;
const goc = (...phan: string[]) => path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..", ...phan);

let umaskCu: number;
let thuMucGoc: string;

beforeEach(async () => {
  umaskCu = process.umask(0o022);
  thuMucGoc = await mkdtemp(path.join(tmpdir(), "hk-mode-test-"));
});

afterEach(async () => {
  process.umask(umaskCu);
  await rm(thuMucGoc, { recursive: true, force: true });
});

describe("chuanBiThuMucRiengTu", () => {
  it("thư mục chưa tồn tại (lồng nhiều cấp) → thư mục lá 0700", async () => {
    const la = path.join(thuMucGoc, "a", "b");
    await chuanBiThuMucRiengTu(la);
    expect(await modeCua(la)).toBe(0o700);
  });

  it("thư mục ĐÃ TỒN TẠI mode 0755 (bind-mount có sẵn) → siết về 0700", async () => {
    const co = path.join(thuMucGoc, "backups");
    await mkdir(co, { mode: 0o755 });
    await chmod(co, 0o755);
    expect(await modeCua(co)).toBe(0o755);

    await chuanBiThuMucRiengTu(co);
    expect(await modeCua(co)).toBe(0o700);
  });

  it("bản lùi .dump cũ mode 0644 trong thư mục → siết về 0600; file khác không bị đụng", async () => {
    const co = path.join(thuMucGoc, "backups");
    await mkdir(co);
    const dumpCu = path.join(co, "pre-restore-20260101-000000-abc123.dump");
    const khac = path.join(co, "ghi-chu.txt");
    await writeFile(dumpCu, "x", { mode: 0o644 });
    await writeFile(khac, "y", { mode: 0o644 });
    await chmod(dumpCu, 0o644);
    await chmod(khac, 0o644);

    await chuanBiThuMucRiengTu(co);
    expect(await modeCua(dumpCu)).toBe(0o600);
    expect(await modeCua(khac)).toBe(0o644);
  });
});

describe("ghiFileRiengTu", () => {
  it("file mới 0600 dù umask 0022, nội dung nguyên vẹn", async () => {
    const f = path.join(thuMucGoc, "pre-restore-x.dump");
    await ghiFileRiengTu(f, Buffer.from("noi-dung-dump"));
    expect(await modeCua(f)).toBe(0o600);
    expect((await readFile(f)).toString()).toBe("noi-dung-dump");
  });

  it("file đã tồn tại → ném EEXIST, KHÔNG đè mất điểm lùi cũ", async () => {
    const f = path.join(thuMucGoc, "pre-restore-y.dump");
    await ghiFileRiengTu(f, Buffer.from("ban-dau"));
    await expect(ghiFileRiengTu(f, Buffer.from("ghi-de"))).rejects.toMatchObject({ code: "EEXIST" });
    expect((await readFile(f)).toString()).toBe("ban-dau");
  });
});

describe("snapshot giá vốn trước khi áp theo Pancake", () => {
  it("ghiBackupVaXacMinh tạo file 0600 dù umask 0022", async () => {
    const f = path.join(thuMucGoc, "backup-gia-von.json");
    const noiDung: NoiDungBackup = {
      ghiLuc: "2026-10-27T07:30:00.000Z",
      cheDo: "theo-pancake",
      soDong: 1,
      dong: [{ variantId: "v1", sku: "SKU-1", ten: "Áo · M", costPriceCu: 100, costPriceMoi: 200 }],
    };
    ghiBackupVaXacMinh(f, noiDung);
    expect(await modeCua(f)).toBe(0o600);
  });
});

/**
 * Các điểm ghi trong route/`run-restore` không dựng được bằng unit test (cần pg_dump + DB) — soi mã
 * nguồn đã lọc comment để không ai bỏ `mode`/helper đi mà test vẫn xanh.
 */
describe("điểm ghi dump trong route phục hồi + run-restore", () => {
  const boComment = (s: string) =>
    s
      .split("\n")
      .filter((d) => !/^\s*(\/\/|\*|\/\*)/.test(d))
      .join("\n");

  it("route restore: bản lùi đi qua chuanBiThuMucRiengTu + ghiFileRiengTu, không còn mkdir/writeFile trần", () => {
    const src = boComment(readFileSync(goc("src/app/api/restore/route.ts"), "utf8"));
    expect(src).toMatch(/await chuanBiThuMucRiengTu\(thuMuc\)/);
    expect(src).toMatch(/await ghiFileRiengTu\(join\(thuMuc, preName\), preRestore\)/);
    expect(src).not.toMatch(/await mkdir\(thuMuc, \{ recursive: true \}\)/);
    expect(src).not.toMatch(/await writeFile\(join\(thuMuc, preName\), preRestore\)/);
  });

  it("run-restore: mọi writeFile file tạm mang mode 0o600", () => {
    const src = boComment(readFileSync(goc("src/lib/backup/run-restore.ts"), "utf8"));
    const cacLanGhi = src.match(/await writeFile\([^)]*\)/g) ?? [];
    expect(cacLanGhi.length).toBeGreaterThanOrEqual(3);
    for (const dong of cacLanGhi) expect(dong).toContain("mode: 0o600");
  });
});
