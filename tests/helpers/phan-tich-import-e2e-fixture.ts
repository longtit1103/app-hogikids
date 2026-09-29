import path from "node:path";

import ts from "typescript";

/**
 * Bộ phân tích cho hàng rào "mọi spec e2e lấy `test`/`expect` từ fixture chờ stream xong"
 * (`tests/unit/e2e-dung-fixture-cho-stream.test.ts`).
 *
 * Đọc MÃ NGUỒN bằng TypeScript compiler API (không import spec, không regex trên văn bản thô) ⇒
 * câu import nằm trong chú thích hoặc trong chuỗi tự bị bỏ qua, còn mọi DẠNG cú pháp mang giá trị
 * đều hiện ra thành nút AST: import tĩnh, `export … from`, `import x = require()`, `require (…)`
 * (có hay không dấu cách), `import(…)` động.
 *
 * Làm việc trên một "dự án ảo": Map đường dẫn TƯƠNG ĐỐI so với `tests/e2e` (dấu `/`) → mã nguồn.
 * Nhờ vậy bộ tự kiểm dựng được mọi ca lách bằng chuỗi mà không phải tạo file spec giả trong repo.
 *
 * Hai luật:
 *  1. Không file nào trong `tests/e2e/**` (trừ chính fixture) được lấy GIÁ TRỊ từ test runner của
 *     Playwright. Import CHỈ-KIỂU vẫn được (`import type`, `import { type X }`, `import("…").Page`).
 *  2. Mỗi spec: định danh `test` (và `expect` nếu có) phải là import GIÁ TRỊ truy được về đúng
 *     export cùng tên của fixture — trực tiếp, hoặc qua helper cục bộ tái xuất (nhiều bước, chống
 *     vòng). Helper tự khai báo `test` riêng ⇒ vi phạm, kể cả khi nó bọc lại test của fixture.
 */

/** Đường dẫn fixture, tương đối so với `tests/e2e`. */
export const FILE_FIXTURE = "fixture-cho-trang-stream-xong.ts";

/** Thứ Playwright chạy. PHẢI trùng NGUYÊN VĂN `testMatch` trong `playwright.config.ts` (test khoá). */
export const LA_SPEC = /\.spec\.tsx?$/;

/** File mã nguồn hàng rào quét (spec + helper). */
export const LA_MA_NGUON = /\.tsx?$/;

/** Test runner Playwright: `@playwright/test` và bản tái xuất `playwright/test` (kể cả đường con). */
const MODULE_CAM = /^@?playwright\/test(\/|$)/;

const DUOI_THU = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

export interface LoiE2e {
  /** Đường dẫn tương đối so với `tests/e2e`. */
  file: string;
  dong: number;
  moTa: string;
}

/** Nguồn của một định danh: `ten` trong `module` ("*" = namespace, "default" = mặc định). */
interface NguonTen {
  module: string;
  ten: string;
}

/** Export của một file: từ module khác (`module` có) hoặc từ tên cục bộ `ten` (`module` rỗng). */
interface XuatTen {
  module?: string;
  ten: string;
  dong: number;
}

interface ThongTinFile {
  loiPlaywright: LoiE2e[];
  /** Tên cục bộ → nguồn import GIÁ TRỊ (bỏ qua import chỉ-kiểu). */
  importGiaTri: Map<string, NguonTen & { dong: number }>;
  /** Tên cục bộ khai báo ở cấp file (không phải import) → dòng. */
  khaiBaoCucBo: Map<string, number>;
  xuat: Map<string, XuatTen>;
  xuatSao: { module: string; dong: number }[];
}

type KetQuaTruy = { ok: true; tenCuoi: string } | { ok: false; lyDo: string };

function tenCuaNut(n: ts.ModuleExportName): string {
  return n.text;
}

/** Mọi tên được khai báo bởi một binding (kể cả destructuring `const { test } = …`). */
function tenTrongBinding(b: ts.BindingName): string[] {
  if (ts.isIdentifier(b)) return [b.text];
  return b.elements.flatMap((el) => (ts.isOmittedExpression(el) ? [] : tenTrongBinding(el.name)));
}

function coModifier(n: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === kind);
}

function phanTichMotFile(file: string, maNguon: string): ThongTinFile {
  const sf = ts.createSourceFile(
    file,
    maNguon,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const dong = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const info: ThongTinFile = {
    loiPlaywright: [],
    importGiaTri: new Map(),
    khaiBaoCucBo: new Map(),
    xuat: new Map(),
    xuatSao: [],
  };
  const baoCam = (n: ts.Node, moTa: string) => info.loiPlaywright.push({ file, dong: dong(n), moTa });

  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const module = st.moduleSpecifier.text;
      const clause = st.importClause;
      const giaTri: string[] = [];
      const ghi = (cucBo: string, ten: string) => {
        giaTri.push(cucBo === ten ? cucBo : `${ten} as ${cucBo}`);
        info.importGiaTri.set(cucBo, { module, ten, dong: dong(st) });
      };
      if (!clause) {
        giaTri.push("(import chạy side-effect)");
      } else if (!clause.isTypeOnly) {
        if (clause.name) ghi(clause.name.text, "default");
        const nb = clause.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) ghi(nb.name.text, "*");
        if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            if (!el.isTypeOnly) ghi(el.name.text, tenCuaNut(el.propertyName ?? el.name));
          }
        }
      }
      if (MODULE_CAM.test(module) && giaTri.length > 0) {
        baoCam(st, `import giá trị {${giaTri.join(", ")}} từ "${module}"`);
      }
    } else if (ts.isImportEqualsDeclaration(st)) {
      const ref = st.moduleReference;
      if (!st.isTypeOnly && ts.isExternalModuleReference(ref) && ts.isStringLiteralLike(ref.expression)) {
        const module = ref.expression.text;
        info.importGiaTri.set(st.name.text, { module, ten: "*", dong: dong(st) });
        if (MODULE_CAM.test(module)) baoCam(st, `import ${st.name.text} = require("${module}")`);
      }
    } else if (ts.isExportDeclaration(st)) {
      const module =
        st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : undefined;
      if (st.isTypeOnly) continue;
      const giaTri: string[] = [];
      const clause = st.exportClause;
      if (!clause) {
        if (module) {
          giaTri.push("*");
          info.xuatSao.push({ module, dong: dong(st) });
        }
      } else if (ts.isNamespaceExport(clause)) {
        giaTri.push(`* as ${tenCuaNut(clause.name)}`);
        if (module) info.xuat.set(tenCuaNut(clause.name), { module, ten: "*", dong: dong(st) });
      } else {
        for (const el of clause.elements) {
          if (el.isTypeOnly) continue;
          const ten = tenCuaNut(el.propertyName ?? el.name);
          giaTri.push(ten);
          info.xuat.set(tenCuaNut(el.name), { module, ten, dong: dong(st) });
        }
      }
      if (module && MODULE_CAM.test(module) && giaTri.length > 0) {
        baoCam(st, `tái xuất giá trị {${giaTri.join(", ")}} từ "${module}"`);
      }
    } else {
      // Khai báo giá trị cấp file: biến / hàm / lớp / enum (có `export` ⇒ cũng là export cục bộ).
      const ten: string[] = [];
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) ten.push(...tenTrongBinding(d.name));
      } else if (
        (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) &&
        st.name
      ) {
        ten.push(st.name.text);
      }
      const coExport = coModifier(st, ts.SyntaxKind.ExportKeyword);
      for (const t of ten) {
        info.khaiBaoCucBo.set(t, dong(st));
        if (coExport) info.xuat.set(t, { ten: t, dong: dong(st) });
      }
    }
  }

  // `require(…)` / `import(…)` ở MỌI độ sâu (trong hàm, trong test…). Kiểu `import("…").X` là nút
  // ImportType, không phải CallExpression ⇒ tự được bỏ qua đúng ý.
  const duyet = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const laImportDong = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      const laRequire = ts.isIdentifier(n.expression) && n.expression.text === "require";
      if (laImportDong || laRequire) {
        const ten = laImportDong ? "import" : "require";
        const doi = n.arguments[0];
        if (!doi || !ts.isStringLiteralLike(doi)) {
          baoCam(n, `${ten}(…) với đối số không phải chuỗi hằng — hàng rào không kiểm được nguồn`);
        } else if (MODULE_CAM.test(doi.text)) {
          baoCam(n, `${ten}("${doi.text}") — lấy giá trị lúc chạy từ test runner Playwright`);
        }
      }
    }
    ts.forEachChild(n, duyet);
  };
  duyet(sf);
  return info;
}

/** Phân giải specifier TƯƠNG ĐỐI thành file trong dự án ảo; package / ngoài `tests/e2e` ⇒ null. */
function giaiModule(duAn: Map<string, ThongTinFile>, tuFile: string, module: string): string | null {
  if (!module.startsWith("./") && !module.startsWith("../")) return null;
  const goc = path.posix.normalize(path.posix.join(path.posix.dirname(tuFile), module));
  const khongJs = goc.replace(/\.(m|c)?jsx?$/, "");
  for (const base of goc === khongJs ? [goc] : [goc, khongJs]) {
    for (const duoi of DUOI_THU) {
      if (duAn.has(base + duoi)) return base + duoi;
    }
  }
  return null;
}

/** Truy export `ten` của `file` về tận gốc; thành công chỉ khi gốc là fixture. */
function truyXuat(
  duAn: Map<string, ThongTinFile>,
  file: string,
  ten: string,
  daTham: Set<string>
): KetQuaTruy {
  const khoa = `${file}#${ten}`;
  if (daTham.has(khoa)) return { ok: false, lyDo: `vòng tái xuất tại ${file} ("${ten}")` };
  daTham.add(khoa);
  const info = duAn.get(file);
  if (!info) return { ok: false, lyDo: `không thấy ${file}` };
  if (file === FILE_FIXTURE) {
    return info.xuat.has(ten) ? { ok: true, tenCuoi: ten } : { ok: false, lyDo: `fixture không xuất "${ten}"` };
  }

  const quaModule = (module: string, tenNguon: string, dongX: number): KetQuaTruy => {
    const dich = giaiModule(duAn, file, module);
    if (!dich) return { ok: false, lyDo: `${file}:${dongX} lấy "${ten}" từ "${module}" — không phải file trong tests/e2e` };
    if (tenNguon === "*" || tenNguon === "default") {
      return { ok: false, lyDo: `${file}:${dongX} lấy "${ten}" dạng ${tenNguon === "*" ? "namespace" : "default"}` };
    }
    return truyXuat(duAn, dich, tenNguon, daTham);
  };

  const x = info.xuat.get(ten);
  if (x) {
    if (x.module) return quaModule(x.module, x.ten, x.dong);
    const imp = info.importGiaTri.get(x.ten);
    if (imp) return quaModule(imp.module, imp.ten, imp.dong);
    return { ok: false, lyDo: `${file}:${x.dong} tự khai báo "${ten}" thay vì tái xuất từ fixture` };
  }
  for (const sao of info.xuatSao) {
    const dich = giaiModule(duAn, file, sao.module);
    if (!dich) continue;
    const kq = truyXuat(duAn, dich, ten, daTham);
    if (kq.ok) return kq;
  }
  return { ok: false, lyDo: `${file} không xuất "${ten}"` };
}

/** Đường import fixture đúng cho một spec (tính từ thư mục của spec). */
export function duongFixtureTu(spec: string): string {
  const tuongDoi = path.posix.relative(path.posix.dirname(spec), FILE_FIXTURE).replace(/\.ts$/, "");
  return tuongDoi.startsWith(".") ? tuongDoi : `./${tuongDoi}`;
}

function kiemSpec(duAn: Map<string, ThongTinFile>, spec: string, info: ThongTinFile): LoiE2e[] {
  const loi: LoiE2e[] = [];
  for (const ten of ["test", "expect"] as const) {
    const cucBo = info.khaiBaoCucBo.get(ten);
    if (cucBo !== undefined) {
      loi.push({ file: spec, dong: cucBo, moTa: `tự khai báo "${ten}" cục bộ thay vì import từ fixture` });
      continue;
    }
    const imp = info.importGiaTri.get(ten);
    if (!imp) {
      if (ten === "test") loi.push({ file: spec, dong: 1, moTa: `không có import GIÁ TRỊ "test"` });
      continue;
    }
    const dich = giaiModule(duAn, spec, imp.module);
    let kq: KetQuaTruy;
    if (!dich) kq = { ok: false, lyDo: `"${imp.module}" không phải file trong tests/e2e` };
    else if (imp.ten === "*" || imp.ten === "default") kq = { ok: false, lyDo: `import dạng ${imp.ten}` };
    else kq = truyXuat(duAn, dich, imp.ten, new Set());
    if (kq.ok && kq.tenCuoi !== ten) kq = { ok: false, lyDo: `là "${kq.tenCuoi}" của fixture, không phải "${ten}"` };
    if (!kq.ok) {
      loi.push({ file: spec, dong: imp.dong, moTa: `"${ten}" không truy được về fixture: ${kq.lyDo}` });
    }
  }
  return loi;
}

/**
 * Kiểm cả dự án ảo `tests/e2e`: khoá = đường dẫn tương đối (dấu `/`), giá trị = mã nguồn.
 * Trả mọi vi phạm (rỗng = đạt).
 */
export function kiemTraE2e(maNguon: ReadonlyMap<string, string>): LoiE2e[] {
  const duAn = new Map<string, ThongTinFile>();
  for (const [file, ma] of maNguon) duAn.set(file, phanTichMotFile(file, ma));
  if (!duAn.has(FILE_FIXTURE)) return [{ file: FILE_FIXTURE, dong: 1, moTa: "không thấy file fixture" }];

  const loi: LoiE2e[] = [];
  for (const [file, info] of duAn) {
    if (file === FILE_FIXTURE) continue;
    loi.push(...info.loiPlaywright);
    if (LA_SPEC.test(file)) loi.push(...kiemSpec(duAn, file, info));
  }
  return loi.sort((a, b) => a.file.localeCompare(b.file) || a.dong - b.dong);
}
