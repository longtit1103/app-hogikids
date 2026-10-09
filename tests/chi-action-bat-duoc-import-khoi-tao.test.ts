import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * LƯỚI AST — `ghiKhoiTaoNoPhaiTra` (ghi `Setting.noPhaiTraTuNgay`, neo thẻ trước M, `CUTOVER_ADJ_*`) là hàm
 * NỘI BỘ của bước xác nhận bật (spec §5.4). Một action khác import nó là có đường thứ hai ghi dữ liệu
 * khởi tạo khi CHƯA bật — lách mọi cổng `daBatNoPhaiTra`, hoặc bật lần hai sinh điều chỉnh quỹ trùng.
 *
 * Hai lớp:
 *  1. Mọi file trong `src/` có khai báo import / export-from / `import()` động trỏ tới module khởi tạo
 *     (đường alias `@/` hoặc tương đối) ⇒ PHẢI là `src/lib/actions/bat-no-phai-tra.ts`.
 *  2. Mọi file `src/` nhắc khoá Setting của công tắc (`KEY_NO_PHAI_TRA_TU_NGAY` / chuỗi `noPhaiTraTuNgay`)
 *     thuộc danh sách cố định có lý do — đường ghi M mới (vd `setting.upsert` ở một màn cài đặt) không
 *     lọt lưới vì quên khai.
 * Test (`tests/`) được import trực tiếp để chứng minh tính nguyên tử — lưới chỉ quét `src/`.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_KHOI_TAO = "src/lib/no-phai-tra/ghi-khoi-tao-no-phai-tra";
const DUOC_IMPORT = new Set(["src/lib/actions/bat-no-phai-tra.ts"]);

const DUOC_NHAC_KHOA_SETTING: Record<string, string> = {
  "src/lib/no-phai-tra/cong-bat-no-phai-tra.ts": "định nghĩa khoá + đọc M (`docMocM`)",
  "src/lib/no-phai-tra/ghi-khoi-tao-no-phai-tra.ts": "đường ghi M DUY NHẤT (câu ghi cuối của bước bật)",
  "src/lib/actions/bat-no-phai-tra.ts": "nhật ký bước bật trỏ đối tượng Setting theo khoá",
  "src/lib/actions/data-admin.ts": "xoá toàn bộ dữ liệu — gỡ công tắc cùng các bảng nợ phải trả",
};

function lietKe(rel: string): string[] {
  return readdirSync(path.join(ROOT, rel)).flatMap((ten) => {
    const r = `${rel}/${ten}`;
    if (statSync(path.join(ROOT, r)).isDirectory()) return ten === "generated" ? [] : lietKe(r);
    return /\.(ts|tsx)$/.test(ten) ? [r] : [];
  });
}

/** Đường module ⇒ đường file gốc (không đuôi) tính từ ROOT, hoặc null với gói ngoài. */
function giaiDuong(tuFile: string, spec: string): string | null {
  if (spec.startsWith("@/")) return `src/${spec.slice(2)}`.replace(/\.(ts|tsx)$/, "");
  if (spec.startsWith(".")) return path.posix.join(path.posix.dirname(tuFile), spec).replace(/\.(ts|tsx)$/, "");
  return null;
}

/** Mọi đường module mà file kéo vào: `import … from`, `export … from`, `import("…")`. */
function duongImport(src: string, tenFile: string): string[] {
  const sf = ts.createSourceFile(tenFile, src, ts.ScriptTarget.Latest, true);
  const ra: string[] = [];
  const di = (n: ts.Node) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      ra.push(n.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ImportKeyword &&
      n.arguments[0] &&
      ts.isStringLiteralLike(n.arguments[0])
    ) {
      ra.push(n.arguments[0].text);
    }
    ts.forEachChild(n, di);
  };
  di(sf);
  return ra;
}

function fileImportKhoiTao(files: readonly string[], doc: (f: string) => string): string[] {
  return files.filter((f) =>
    duongImport(doc(f), f).some((spec) => giaiDuong(f, spec) === MODULE_KHOI_TAO)
  );
}

const docThat = (f: string) => readFileSync(path.join(ROOT, f), "utf8");

describe("chỉ action xác nhận bật được import ghiKhoiTaoNoPhaiTra", () => {
  const FILES = lietKe("src");

  it("quét được cây src/ (lưới không rỗng) và module khởi tạo tồn tại", () => {
    expect(FILES.length).toBeGreaterThan(200);
    expect(FILES).toContain(`${MODULE_KHOI_TAO}.ts`);
  });

  it("tập file import module khởi tạo = đúng { bat-no-phai-tra.ts }", () => {
    expect(fileImportKhoiTao(FILES, docThat)).toEqual([...DUOC_IMPORT]);
  });

  it("file nhắc khoá Setting của công tắc ⊆ danh sách có lý do", () => {
    const nhac = FILES.filter((f) => /KEY_NO_PHAI_TRA_TU_NGAY|noPhaiTraTuNgay/.test(docThat(f)));
    expect(nhac.filter((f) => !Object.hasOwn(DUOC_NHAC_KHOA_SETTING, f))).toEqual([]);
    // Danh sách không thừa: mục nào không còn nhắc khoá thì xoá khỏi danh sách.
    expect(Object.keys(DUOC_NHAC_KHOA_SETTING).filter((f) => !nhac.includes(f))).toEqual([]);
  });

  it("chính lưới: bắt import alias, tương đối, export-from và import() động; bỏ qua chú thích", () => {
    const gia: Record<string, string> = {
      "src/lib/actions/a.ts": `import { ghiKhoiTaoNoPhaiTra } from "@/lib/no-phai-tra/ghi-khoi-tao-no-phai-tra";`,
      "src/lib/no-phai-tra/b.ts": `export { ghiKhoiTaoNoPhaiTra } from "./ghi-khoi-tao-no-phai-tra";`,
      "src/lib/actions/c.ts": `const m = await import("../no-phai-tra/ghi-khoi-tao-no-phai-tra");`,
      "src/lib/actions/d.ts": `// import from "@/lib/no-phai-tra/ghi-khoi-tao-no-phai-tra"\nexport const x = 1;`,
      "src/lib/actions/e.ts": `import { docMocM } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";`,
    };
    expect(fileImportKhoiTao(Object.keys(gia), (f) => gia[f])).toEqual([
      "src/lib/actions/a.ts",
      "src/lib/no-phai-tra/b.ts",
      "src/lib/actions/c.ts",
    ]);
  });
});
