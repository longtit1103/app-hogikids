import path from "node:path";

import ts from "typescript";

import { docCay, TEN_CONG_CHU_SHOP, TEN_CONG_TRANG, tenThamSo } from "./phan-tich-cong-bang-ast";

/**
 * Đọc ĐỐI SỐ THẬT của lời gọi cổng đầu thân — bằng cây cú pháp, không import/chạy mã — để lưới so với
 * bảng quyền mong đợi (`bang-quyen-mong-doi.ts`). Chỉ gập được biểu thức HẰNG: chuỗi, mảng, object
 * literal, `Object.freeze(…)`, `Object.values(<object literal>)`, ép kiểu, và định danh trỏ tới `const`
 * cấp file (cùng file, hoặc `export const` của module được import theo `@/…` / đường dẫn tương đối).
 * Mọi thứ khác (tham số, `let`, lời gọi hàm tuỳ ý, spread) ⇒ KHÔNG gập được ⇒ lưới đỏ: đối số cổng
 * phải xác định được khi đọc mã, không phụ thuộc dữ liệu lúc chạy.
 */

/** Giá trị cổng quy chuẩn: quyền đơn, mảng quyền (ít nhất một), chỉ-chủ-shop, hoặc chỉ-đăng-nhập. */
export type GiaTriCong = string | readonly string[] | "CHU_SHOP" | "CHI_DANG_NHAP";

/** Đọc nội dung file theo đường dẫn tương đối gốc repo; `null` = không có. */
export type DocFile = (rel: string) => string | null;

type GiaTriTinh = string | GiaTriTinh[] | { [k: string]: GiaTriTinh };
type KetQua<T> = { ok: true; v: T } | { ok: false; lyDo: string };

const DUOI_THU = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js"];
const SAU_TOI_DA = 8;

type NguCanh = { file: string; sf: ts.SourceFile; docFile: DocFile; sau: number };

function loi<T>(lyDo: string): KetQua<T> {
  return { ok: false, lyDo };
}

/** `@/x` → `src/x`, `./x` → cạnh file; thử các đuôi. */
function timModule(tuFile: string, nguon: string, docFile: DocFile): { file: string; src: string } | null {
  let goc: string;
  if (nguon.startsWith("@/")) goc = `src/${nguon.slice(2)}`;
  else if (nguon.startsWith("./") || nguon.startsWith("../")) goc = path.posix.join(path.posix.dirname(tuFile), nguon);
  else return null;
  for (const d of DUOI_THU) {
    const src = docFile(goc + d);
    if (src !== null) return { file: goc + d, src };
  }
  return null;
}

function laConst(st: ts.VariableStatement): boolean {
  return (st.declarationList.flags & ts.NodeFlags.Const) !== 0;
}

function coExport(st: ts.Statement): boolean {
  return ts.canHaveModifiers(st) && (ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false);
}

/** `const <ten> = …` cấp file (tuỳ chọn: bắt buộc có `export`). */
function timConstCapFile(sf: ts.SourceFile, ten: string, canExport: boolean): ts.Expression | null {
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st) || !laConst(st) || (canExport && !coExport(st))) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === ten && d.initializer) return d.initializer;
    }
  }
  return null;
}

/** Giá trị `export const <tenExport>` của module `nguon` (theo cả `export { x } from "…"` tái xuất). */
function giaiExport(nguon: string, tenExport: string, nc: NguCanh): KetQua<GiaTriTinh> {
  if (nc.sau >= SAU_TOI_DA) return loi(`\`${tenExport}\` lồng quá sâu`);
  const m = timModule(nc.file, nguon, nc.docFile);
  if (!m) return loi(`không đọc được module "${nguon}" của \`${tenExport}\``);
  const sf = docCay(m.src, m.file);
  const nc2: NguCanh = { file: m.file, sf, docFile: nc.docFile, sau: nc.sau + 1 };
  const e = timConstCapFile(sf, tenExport, true);
  if (e) return gap(e, nc2);
  for (const st of sf.statements) {
    if (!ts.isExportDeclaration(st) || st.isTypeOnly || !st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (!st.exportClause || !ts.isNamedExports(st.exportClause)) continue;
    const el = st.exportClause.elements.find((x) => x.name.text === tenExport);
    if (el) return giaiExport(st.moduleSpecifier.text, el.propertyName?.text ?? tenExport, nc2);
  }
  return loi(`"${nguon}" không có \`export const ${tenExport}\``);
}

function giaiDinhDanh(ten: string, nc: NguCanh): KetQua<GiaTriTinh> {
  if (nc.sau >= SAU_TOI_DA) return loi(`định danh \`${ten}\` lồng quá sâu`);
  const cung = timConstCapFile(nc.sf, ten, false);
  if (cung) return gap(cung, { ...nc, sau: nc.sau + 1 });

  for (const st of nc.sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause?.namedBindings || !ts.isNamedImports(st.importClause.namedBindings)) continue;
    const el = st.importClause.namedBindings.elements.find((e) => e.name.text === ten);
    if (!el || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    return giaiExport(st.moduleSpecifier.text, el.propertyName?.text ?? ten, nc);
  }
  return loi(`\`${ten}\` không phải const cấp file/const import`);
}

function laGoiObject(e: ts.CallExpression, ham: string): boolean {
  const c = e.expression;
  return (
    ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === "Object" && c.name.text === ham
  );
}

/** Gập một biểu thức HẰNG thành giá trị. */
function gap(e: ts.Expression, nc: NguCanh): KetQua<GiaTriTinh> {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return { ok: true, v: e.text };
  if (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isTypeAssertionExpression(e) ||
    ts.isNonNullExpression(e)
  ) {
    return gap(e.expression, nc);
  }
  if (ts.isArrayLiteralExpression(e)) {
    const v: GiaTriTinh[] = [];
    for (const x of e.elements) {
      if (ts.isSpreadElement(x) || ts.isOmittedExpression(x)) return loi(`mảng có spread/lỗ — \`${e.getText()}\``);
      const k = gap(x, nc);
      if (!k.ok) return k;
      v.push(k.v);
    }
    return { ok: true, v };
  }
  if (ts.isObjectLiteralExpression(e)) {
    const v: { [k: string]: GiaTriTinh } = {};
    for (const p of e.properties) {
      if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
        const k = gap(p.initializer, nc);
        if (!k.ok) return k;
        v[p.name.text] = k.v;
      } else if (ts.isShorthandPropertyAssignment(p)) {
        const k = giaiDinhDanh(p.name.text, nc);
        if (!k.ok) return k;
        v[p.name.text] = k.v;
      } else {
        return loi(`object có thuộc tính không gập được — \`${p.getText()}\``);
      }
    }
    return { ok: true, v };
  }
  if (ts.isCallExpression(e) && e.arguments.length === 1 && !ts.isSpreadElement(e.arguments[0])) {
    if (laGoiObject(e, "freeze")) return gap(e.arguments[0], nc);
    if (laGoiObject(e, "values")) {
      const k = gap(e.arguments[0], nc);
      if (!k.ok) return k;
      if (typeof k.v === "string" || Array.isArray(k.v)) return loi(`Object.values trên giá trị không phải object`);
      return { ok: true, v: Object.values(k.v) };
    }
  }
  if (ts.isIdentifier(e)) return giaiDinhDanh(e.text, nc);
  return loi(`biểu thức không gập được thành hằng — \`${e.getText()}\``);
}

function thanhQuyen(v: GiaTriTinh, nguon: string): KetQua<string | readonly string[]> {
  if (typeof v === "string") return { ok: true, v };
  if (Array.isArray(v) && v.every((x): x is string => typeof x === "string")) return { ok: true, v };
  return loi(`đối số cổng không phải quyền/mảng quyền — \`${nguon}\``);
}

/**
 * Giá trị cổng THẬT của lời gọi cổng đầu thân `fn`. Cổng chỉ-chủ-shop ⇒ `CHU_SHOP`; cổng quyền không
 * truyền quyền ⇒ `CHI_DANG_NHAP`; còn lại gập đối số quyền thành hằng.
 */
export function giaTriCongThat(
  fn: ts.FunctionDeclaration,
  call: ts.CallExpression,
  file: string,
  docFile: DocFile,
): KetQua<GiaTriCong> {
  const ten = ts.isIdentifier(call.expression) ? call.expression.text : "?";
  if (call.arguments.some(ts.isSpreadElement)) return loi(`đối số cổng dùng spread`);
  const laTrang = TEN_CONG_TRANG.includes(ten);
  // Trang: đối số 1 là đường dẫn; quyền (nếu có) ở đối số 2.
  const soDoiSoKhongQuyen = laTrang ? 1 : 0;
  if (TEN_CONG_CHU_SHOP.includes(ten)) {
    return call.arguments.length === soDoiSoKhongQuyen ? { ok: true, v: "CHU_SHOP" } : loi(`\`${ten}\` nhận sai số đối số`);
  }
  if (call.arguments.length === soDoiSoKhongQuyen) return { ok: true, v: "CHI_DANG_NHAP" };
  if (call.arguments.length !== soDoiSoKhongQuyen + 1) return loi(`\`${ten}\` nhận sai số đối số`);
  const arg = call.arguments[soDoiSoKhongQuyen];

  // Tham số của chính hàm che mọi const cấp file trùng tên — và giá trị do CLIENT gửi.
  const thamSo = tenThamSo(fn);
  let cheBoiThamSo = "";
  const di = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && thamSo.has(n.text)) cheBoiThamSo = n.text;
    ts.forEachChild(n, di);
  };
  di(arg);
  if (cheBoiThamSo) return loi(`đối số cổng dùng tham số \`${cheBoiThamSo}\` của hàm (giá trị từ người gọi)`);

  const sf = fn.getSourceFile();
  const k = gap(arg, { file, sf, docFile, sau: 0 });
  if (!k.ok) return k;
  return thanhQuyen(k.v, arg.getText());
}

/** Hai giá trị cổng bằng nhau: mảng so như TẬP (thứ tự không mang nghĩa ở cổng "ít nhất một"). */
export function cungGiaTriCong(a: GiaTriCong, b: GiaTriCong): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.length === sb.length && sa.every((x, i) => x === sb[i]);
}

export function moTaGiaTriCong(v: GiaTriCong): string {
  return typeof v === "string" ? v : `[${v.join(", ")}]`;
}
