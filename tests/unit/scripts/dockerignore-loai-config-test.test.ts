import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * `next build` trong Dockerfile type-check MỌI file thuộc `include` của tsconfig. Config test ở gốc
 * repo (`playwright*.config.ts`, `vitest*.config.ts`) import file dưới `tests/` hoặc import lẫn nhau
 * — mà `tests/` đã bị `.dockerignore` loại. Một config test lọt vào ảnh ⇒ build chết TS2307
 * (đo thật 01/10: `playwright.prod.config.ts` import `./playwright.config` đã bị loại). Lưới này bắt
 * ngay ở local thay vì chờ job "Dựng ảnh Docker" trên CI.
 */
const GOC = path.resolve(__dirname, "../../..");
const CONFIG_TEST = /^(playwright|vitest)[\w.-]*\.config\.(ts|mts|cts|js|mjs|cjs)$/;

/** Khớp mẫu `.dockerignore` cấp gốc đơn giản (`*` không qua `/`) — đủ cho các dòng tên file ở gốc. */
function khopMau(mau: string, ten: string): boolean {
  const re = new RegExp(`^${mau.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
  return re.test(ten);
}

describe(".dockerignore loại mọi config test ở gốc repo", () => {
  const mauLoai = readFileSync(path.join(GOC, ".dockerignore"), "utf8")
    .split("\n")
    .map((d) => d.trim())
    .filter((d) => d !== "" && !d.startsWith("#") && !d.startsWith("!"));
  const configTest = readdirSync(GOC).filter((ten) => CONFIG_TEST.test(ten));

  it("có ít nhất playwright.config.ts và vitest.config.ts để soát (lưới không mù)", () => {
    expect(configTest).toEqual(expect.arrayContaining(["playwright.config.ts", "vitest.config.ts"]));
  });

  it.each(configTest)("%s bị .dockerignore loại", (ten) => {
    expect(mauLoai.some((mau) => khopMau(mau, ten))).toBe(true);
  });

  it("tự kiểm: tên không khớp mẫu nào thì báo chưa loại", () => {
    expect(["playwright.config.ts"].some((m) => khopMau(m, "playwright.prod.config.ts"))).toBe(false);
    expect(["playwright*.config.ts"].some((m) => khopMau(m, "playwright.prod.config.ts"))).toBe(true);
  });
});
