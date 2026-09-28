import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ghiEnv } from "../scripts/lib/ghi-env";

/**
 * Unit test THUẦN cho `ghiEnv` — không đụng DB, chỉ đọc/ghi 1 file .env tạm.
 *
 * Hai bẫy trọng tâm (đều là lỗi đã dính ngày tích hợp API):
 *  1) `.env` có 2 dòng cùng key → phải ghi đè CẢ HAI (dòng SAU thắng nên sửa mỗi dòng đầu = token rỗng).
 *  2) token chứa `$&`/`$1`/`$$` → phải ghi NGUYÊN VĂN (String.replace diễn giải chuỗi thay thế → hỏng).
 */
describe("ghiEnv", () => {
  let dir: string;
  let envPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "ghi-env-"));
    envPath = path.join(dir, ".env");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function docDong(): string[] {
    return readFileSync(envPath, "utf8").split("\n");
  }

  it("key đã có → thay TẠI CHỖ đúng 1 lần, giữ nguyên các dòng khác", () => {
    writeFileSync(envPath, "KHAC=giu_nguyen\nTOK=cu\nSAU=cung_giu\n");

    ghiEnv(envPath, { TOK: "moi" });

    const lines = docDong().filter(Boolean);
    // TOK xuất hiện đúng 1 lần với giá trị mới; không thêm dòng trùng, không đụng key khác.
    expect(lines.filter((l) => l.startsWith("TOK=")).length).toBe(1);
    expect(lines).toContain("TOK=moi");
    expect(lines).toContain("KHAC=giu_nguyen");
    expect(lines).toContain("SAU=cung_giu");
  });

  it("2 dòng trùng key → ghi đè CẢ HAI (không để sót dòng token cũ)", () => {
    writeFileSync(envPath, "TOK=cu1\nGIUA=x\nTOK=cu2\n");

    ghiEnv(envPath, { TOK: "moi" });

    const tokLines = docDong().filter((l) => l.startsWith("TOK="));
    expect(tokLines).toEqual(["TOK=moi", "TOK=moi"]);
    // Không còn giá trị cũ nào sót lại.
    expect(readFileSync(envPath, "utf8")).not.toContain("cu1");
    expect(readFileSync(envPath, "utf8")).not.toContain("cu2");
  });

  it("key chưa có → APPEND xuống cuối, có xuống dòng", () => {
    writeFileSync(envPath, "CO_SAN=1\n");

    ghiEnv(envPath, { MOI: "gia_tri" });

    const content = readFileSync(envPath, "utf8");
    expect(content).toContain("CO_SAN=1");
    expect(content).toContain("MOI=gia_tri");
    // Kết thúc bằng newline, không dính vào dòng trước.
    expect(content.endsWith("MOI=gia_tri\n")).toBe(true);
  });

  it("file .env chưa tồn tại → tạo mới với các key truyền vào", () => {
    ghiEnv(envPath, { A: "1", B: "2" });

    const content = readFileSync(envPath, "utf8");
    expect(content).toContain("A=1");
    expect(content).toContain("B=2");
  });

  it("BẪY $: token chứa `$&` → ghi NGUYÊN VĂN, KHÔNG diễn giải (repro lỗi H1)", () => {
    writeFileSync(envPath, "TOK=cu\n");

    ghiEnv(envPath, { TOK: "abc$&def" });

    const content = readFileSync(envPath, "utf8");
    expect(content).toContain("TOK=abc$&def");
    // Không được nhân bản key kiểu `TOK=abcTOK=cudef` (biểu hiện khi replacement là chuỗi).
    expect(content).not.toContain("TOK=abcTOK=");
    expect(docDong().filter((l) => l.startsWith("TOK=")).length).toBe(1);
  });

  it("BẪY $: các mẫu `$1`/$'/`$$` trong value đều ghi nguyên văn khi APPEND (key mới)", () => {
    writeFileSync(envPath, "X=1\n");

    ghiEnv(envPath, { TOK: "a$1b$'c$$d" });

    expect(readFileSync(envPath, "utf8")).toContain("TOK=a$1b$'c$$d");
  });
});
