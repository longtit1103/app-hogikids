import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  duongFixtureTu,
  FILE_FIXTURE,
  kiemTraE2e,
  LA_MA_NGUON,
  LA_SPEC,
  type LoiE2e,
} from "../helpers/phan-tich-import-e2e-fixture";

/**
 * HÀNG RÀO QUY ƯỚC E2E: mọi spec `tests/e2e/**\/*.spec.{ts,tsx}` phải lấy `test`/`expect` từ
 * `fixture-cho-trang-stream-xong.ts`, và KHÔNG file nào trong `tests/e2e/**` (trừ fixture) được lấy
 * GIÁ TRỊ từ `@playwright/test`.
 *
 * `(app)/loading.tsx` làm lượt tải cả trang được STREAM: `load` có thể bắn khi nội dung còn nằm
 * trong vùng ẩn `S:n` ngoài `<main>`. Fixture bọc `page.goto`/`page.reload` để chỉ trả về khi
 * stream xong. Spec lấy `test` từ nơi khác thì mất lớp bọc đó — xanh ở máy nhanh, đỏ chập chờn
 * trên CI (đọc số dính chữ số, locator strict vỡ vì hai bản DOM), rất khó chẩn đoán.
 *
 * Phân tích bằng AST (`../helpers/phan-tich-import-e2e-fixture.ts`) — chú thích và chuỗi không bị
 * đọc nhầm thành import; helper tái xuất, `import()` động, `require (…)`, thư mục con, `.spec.tsx`
 * đều bị soi. Chỉ import KIỂU từ `@playwright/test` là được.
 */
const THU_MUC_E2E = path.resolve(__dirname, "../e2e");

function huongDan(file: string): string {
  return (
    `sửa: \`import { expect, test, type Page } from "${duongFixtureTu(file)}";\` ` +
    "(fixture chờ stream của (app)/loading.tsx xong mới trả về từ goto/reload). " +
    "Helper cần expect/request thì lấy từ fixture; chỉ được import KIỂU từ @playwright/test."
  );
}

function dinhDang(loi: LoiE2e[]): string {
  return loi.map((l) => `tests/e2e/${l.file}:${l.dong} — ${l.moTa} — ${huongDan(l.file)}`).join("\n");
}

const MA_NGUON_E2E = new Map<string, string>(
  readdirSync(THU_MUC_E2E, { recursive: true, encoding: "utf8" })
    .map((f) => f.split(path.sep).join("/"))
    .filter((f) => LA_MA_NGUON.test(f))
    .sort()
    .map((f) => [f, readFileSync(path.join(THU_MUC_E2E, f), "utf8")])
);
const SPECS = [...MA_NGUON_E2E.keys()].filter((f) => LA_SPEC.test(f));
const LOI_THAT = kiemTraE2e(MA_NGUON_E2E);

describe("e2e: mọi spec dùng fixture chờ stream xong", () => {
  it("quét được thư mục e2e (chặn lưới xanh rỗng khi đổi đường dẫn)", () => {
    expect(SPECS.length).toBeGreaterThanOrEqual(10);
    expect(MA_NGUON_E2E.has(FILE_FIXTURE)).toBe(true);
  });

  it.each([...MA_NGUON_E2E.keys()])("%s đạt hàng rào", (file) => {
    const loi = LOI_THAT.filter((l) => l.file === file);
    expect(loi, dinhDang(loi)).toEqual([]);
  });

  it("thứ Playwright chạy = thứ hàng rào quét (testDir + testMatch trong playwright.config.ts)", () => {
    const tenConfig = path.resolve(__dirname, "../../playwright.config.ts");
    const sf = ts.createSourceFile(tenConfig, readFileSync(tenConfig, "utf8"), ts.ScriptTarget.Latest, true);
    const giaTri = new Map<string, string>();
    const duyet = (n: ts.Node): void => {
      if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name)) giaTri.set(n.name.text, n.initializer.getText(sf));
      ts.forEachChild(n, duyet);
    };
    duyet(sf);
    expect(giaTri.get("testDir")).toBe('"./tests/e2e"');
    expect(giaTri.get("testMatch"), "đổi testMatch thì đổi cả LA_SPEC của hàng rào").toBe(String(LA_SPEC));
  });
});

describe("kiemTraE2e (chính bộ phân tích)", () => {
  const FIXTURE_SRC =
    'import { test as testGoc, expect, request, type Page } from "@playwright/test";\n' +
    "export { expect, request };\n" +
    'export type { Page } from "@playwright/test";\n' +
    "export const test = testGoc.extend({});\n";
  const DUNG = 'import { expect, test, type Page } from "./fixture-cho-trang-stream-xong";\n';
  const THAN = 'test("x", async ({ page }) => { await page.goto("/"); expect(1).toBe(1); });\n';

  /** Dựng dự án ảo gồm fixture + các file cho trước; trả lỗi. */
  const kiem = (files: Record<string, string>) =>
    kiemTraE2e(new Map([[FILE_FIXTURE, FIXTURE_SRC], ...Object.entries(files)]));

  describe("hợp lệ ⇒ không lỗi", () => {
    it.each<[string, Record<string, string>]>([
      ["spec chuẩn", { "a.spec.ts": DUNG + THAN }],
      ["spec thư mục con, đường ../", { "con/a.spec.ts": DUNG.replace("./fixture", "../fixture") + THAN }],
      ["spec thư mục con 2 cấp", { "x/y/a.spec.tsx": DUNG.replace("./fixture", "../../fixture") + THAN }],
      [
        "import chỉ-kiểu từ @playwright/test",
        {
          "a.spec.ts":
            DUNG +
            'import type { Locator } from "@playwright/test";\n' +
            'import { type Page as P, type APIResponse } from "@playwright/test";\n' +
            'export type { Locator } from "@playwright/test";\n' +
            'const f = (p: import("@playwright/test").Page) => p;\n' +
            THAN,
        },
      ],
      [
        "câu import cũ nằm trong chú thích / chuỗi",
        {
          "a.spec.ts":
            '// import { test } from "@playwright/test";\n' +
            '/* export { test } from "@playwright/test"; require("@playwright/test") */\n' +
            DUNG +
            'const s = \'import { test } from "@playwright/test"\';\n' +
            'const t = `await import("@playwright/test")`;\n' +
            THAN,
        },
      ],
      [
        "test đến qua helper tái xuất từ fixture (2 bước, đổi tên)",
        {
          "h1.ts": 'export { test as t, expect } from "./fixture-cho-trang-stream-xong";\n',
          "h2.ts": 'import { t, expect } from "./h1";\nexport { t as test, expect };\n',
          "a.spec.ts": 'import { test, expect } from "./h2";\n' + THAN,
        },
      ],
      [
        "helper dùng expect/request của fixture",
        {
          "helper.ts": 'import { expect, request } from "./fixture-cho-trang-stream-xong";\nexport const f = () => [expect, request];\n',
          "a.spec.ts": DUNG + 'import { f } from "./helper";\n' + THAN,
        },
      ],
      ["import động module khác", { "a.spec.ts": DUNG + 'const m = await import("@prisma/client");\n' + THAN }],
    ])("%s", (_ten, files) => {
      expect(kiem(files)).toEqual([]);
    });
  });

  describe("lách ⇒ đỏ", () => {
    it.each<[string, Record<string, string>, RegExp]>([
      ["import test thẳng từ @playwright/test", { "a.spec.ts": 'import { test, expect } from "@playwright/test";\n' + THAN }, /import giá trị/],
      [
        "có import fixture nhưng lấy thêm test từ Playwright",
        { "a.spec.ts": DUNG.replace("expect, test, ", "expect, ") + 'import { test } from "@playwright/test";\n' + THAN },
        /import giá trị \{test\}/,
      ],
      ["namespace / default", { "a.spec.ts": DUNG + 'import * as pw from "@playwright/test";\nimport pw2 from "@playwright/test";\n' + THAN }, /import giá trị/],
      ["import trộn kiểu + giá trị nhiều dòng", { "a.spec.ts": DUNG + 'import {\n  type Page,\n  devices,\n} from "@playwright/test";\n' + THAN }, /\{devices\}/],
      ["require có dấu cách", { "a.spec.ts": DUNG + 'const pw = require ( "@playwright/test" );\n' + THAN }, /require\("@playwright\/test"\)/],
      ["import x = require()", { "a.spec.ts": DUNG + 'import pw = require("@playwright/test");\n' + THAN }, /= require/],
      ["await import() trong test", { "a.spec.ts": DUNG + 'test("y", async () => { const { test: t } = await import("@playwright/test"); });\n' }, /import\("@playwright\/test"\)/],
      ["import() với đối số không phải hằng", { "a.spec.ts": DUNG + 'const m = "@playwright/test";\nvoid import(m);\n' + THAN }, /không phải chuỗi hằng/],
      ["playwright/test (tái xuất của runner)", { "a.spec.ts": 'import { test, expect } from "playwright/test";\n' + THAN }, /playwright\/test/],
      ["export { test } from @playwright/test trong spec", { "a.spec.ts": DUNG + 'export { test as t2 } from "@playwright/test";\n' + THAN }, /tái xuất giá trị/],
      [
        "helper tái xuất test của Playwright, spec import type fixture",
        {
          "h.ts": 'export { test, expect } from "@playwright/test";\n',
          "a.spec.ts": 'import type { Page } from "./fixture-cho-trang-stream-xong";\nimport { test, expect } from "./h";\n' + THAN,
        },
        /tái xuất giá trị/,
      ],
      [
        "helper export * từ Playwright",
        { "h.ts": 'export * from "@playwright/test";\n', "a.spec.ts": 'import { test, expect } from "./h";\n' + THAN },
        /\{\*\}/,
      ],
      [
        "helper tự khai báo test bọc lại fixture",
        {
          "h.ts": 'import { test as goc } from "./fixture-cho-trang-stream-xong";\nexport const test = goc.extend({});\n',
          "a.spec.ts": 'import { test } from "./h";\n' + THAN,
        },
        /tự khai báo "test"/,
      ],
      [
        "vòng tái xuất giữa hai helper",
        {
          "h1.ts": 'export { test } from "./h2";\n',
          "h2.ts": 'export { test } from "./h1";\n',
          "a.spec.ts": 'import { test } from "./h1";\n' + THAN,
        },
        /vòng tái xuất/,
      ],
      ["spec chỉ import type từ fixture", { "a.spec.ts": 'import type { test } from "./fixture-cho-trang-stream-xong";\n' + THAN }, /không có import GIÁ TRỊ "test"/],
      ["đổi vai: expect của fixture đặt tên test", { "a.spec.ts": 'import { expect as test } from "./fixture-cho-trang-stream-xong";\n' + THAN }, /là "expect" của fixture/],
      ["spec thư mục con lấy từ Playwright", { "con/a.spec.ts": 'import { test, expect } from "@playwright/test";\n' + THAN }, /con\/a\.spec\.ts/],
      ["spec .spec.tsx lấy từ Playwright", { "a.spec.tsx": 'import { test, expect } from "@playwright/test";\n' + THAN }, /a\.spec\.tsx/],
      ["spec thư mục con trỏ sai đường fixture", { "con/a.spec.ts": DUNG + THAN }, /không phải file trong tests\/e2e|không xuất/],
      ["test lấy từ package khác", { "a.spec.ts": 'import { test, expect } from "vitest";\n' + THAN }, /"vitest" không phải file/],
      ["destructuring test từ require động", { "a.spec.ts": 'const { test, expect } = require("@playwright/test");\n' + THAN }, /tự khai báo "test"/],
    ])("%s", (_ten, files, moTa) => {
      const loi = kiem(files);
      expect(loi.length, "phải có vi phạm").toBeGreaterThan(0);
      expect(loi.map((l) => `${l.file}:${l.dong} ${l.moTa}`).join("\n")).toMatch(moTa);
    });
  });

  it("thông điệp nêu file:dòng thật và đường fixture đúng cho thư mục con", () => {
    const dungCon = DUNG.replace("./fixture", "../fixture");
    const loi = kiem({ "con/a.spec.ts": dungCon + '\nimport { devices } from "@playwright/test";\n' + THAN });
    expect(loi).toEqual([{ file: "con/a.spec.ts", dong: 3, moTa: 'import giá trị {devices} từ "@playwright/test"' }]);
    expect(huongDan("con/a.spec.ts")).toContain('from "../fixture-cho-trang-stream-xong"');
    expect(huongDan("a.spec.ts")).toContain('from "./fixture-cho-trang-stream-xong"');
  });

  it("thiếu fixture ⇒ đỏ (không xanh rỗng khi đổi tên fixture)", () => {
    expect(kiemTraE2e(new Map([["a.spec.ts", DUNG + THAN]]))).toHaveLength(1);
  });
});
