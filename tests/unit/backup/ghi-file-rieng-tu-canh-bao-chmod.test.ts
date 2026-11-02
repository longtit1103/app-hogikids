import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chuanBiThuMucRiengTu } from "@/lib/backup/ghi-file-rieng-tu";

/**
 * Cảnh báo "không siết được quyền" của `chuanBiThuMucRiengTu` (best-effort): im lặng dưới Vitest để log test không
 * ồn, nhưng PRODUCTION vẫn phải cảnh báo — đó là dấu vết duy nhất báo bản lùi chứa dump có thể đọc được bởi uid khác.
 * `chmod` bị giả để luôn trượt EPERM (thư mục thuộc uid khác trên bind-mount); mkdir/readdir là thật trên thư mục tạm.
 */

vi.mock("node:fs/promises", async (importOriginal) => {
  const that = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...that,
    chmod: vi.fn(async () => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    }),
  };
});

let thuMuc: string;
let warnSpy: { mockRestore: () => void } | undefined;

beforeEach(() => {
  thuMuc = mkdtempSync(path.join(tmpdir(), "hk-canh-bao-chmod-"));
  writeFileSync(path.join(thuMuc, "pre-restore-x.dump"), "x");
  writeFileSync(path.join(thuMuc, "ghi-chu.txt"), "y");
});

afterEach(() => {
  vi.unstubAllEnvs();
  warnSpy?.mockRestore();
  warnSpy = undefined;
  rmSync(thuMuc, { recursive: true, force: true });
});

describe("chuanBiThuMucRiengTu: cảnh báo khi chmod trượt", () => {
  it("chmod trượt KHÔNG chặn lượt chạy; cảnh báo phát cho thư mục (0700) và từng .dump (0600), không cho file khác", async () => {
    const canhBao = vi.fn();
    await expect(chuanBiThuMucRiengTu(thuMuc, canhBao)).resolves.toBeUndefined();
    expect(canhBao).toHaveBeenCalledTimes(2);
    expect(canhBao.mock.calls[0][0]).toMatch(/0700/);
    expect(canhBao.mock.calls[1][0]).toMatch(/0600.*pre-restore-x\.dump/);
  });

  it("dưới NODE_ENV=test: mặc định im lặng (Vitest không bị in cảnh báo chmod)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const warn = (warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {}));
    await chuanBiThuMucRiengTu(thuMuc);
    expect(warn).not.toHaveBeenCalled();
  });

  it("production: mặc định VẪN cảnh báo (console.warn) cho thư mục và .dump", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const warn = (warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {}));
    await chuanBiThuMucRiengTu(thuMuc);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toMatch(/Không siết được quyền 0700/);
    expect(String(warn.mock.calls[1][0])).toMatch(/Không siết được quyền 0600/);
  });
});
