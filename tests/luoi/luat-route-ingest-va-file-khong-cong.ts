import path from "node:path";

import ts from "typescript";

import { docCay, DUOI_MA_NGUON, laFileMaNguon, lietKeExport, PHUONG_THUC_HTTP } from "./phan-tich-cong-bang-ast";
import { thamSoMacDinhTacDong, viPhamNguonDinhDanh } from "./phan-tich-nguon-cong-va-tham-so-ast";
import { viPhamExportRoute } from "./luat-cong-bat-buoc";

/**
 * LUẬT THUẦN cho phần `src/app` NGOÀI ba cổng (spec §3.5): route ingest (bearer là câu đầu từng
 * handler), route công khai + file đặc biệt Next (không chạm lớp dữ liệu), và xếp loại file theo tên
 * để không đuôi nào (`page.js`, `route.mjs`…) lọt khỏi lưới.
 */

// ─── Route ingest: bearer là câu đầu handler ───────────────────────────────────────────────────────

/** Hàm kiểm bearer → module duy nhất cấp nó. */
export const MODULE_HAM_BEARER = {
  requireIngestSecret: "@/lib/ingest/ingest-auth",
  requireTokenVaultSecret: "@/lib/ingest/token-vault-auth",
} as const;
export type HamBearer = keyof typeof MODULE_HAM_BEARER;

/**
 * Handler ingest: câu 1 `const x = <hàm bearer>(<tham số request đầu tiên>);`, câu 2 `if (x) return x;`
 * (hoặc `return <bọc>(x);`). `null` = đạt.
 */
function kiemBearerDauThan(fn: ts.FunctionDeclaration, ham: HamBearer): string | null {
  const [dau, sau] = fn.body?.statements ?? [];
  const req = fn.parameters[0]?.name;
  if (!req || !ts.isIdentifier(req)) return "handler không có tham số request (định danh) đầu tiên";
  const khongPhai = `câu lệnh đầu tiên không phải \`const x = ${ham}(${req.text});\``;
  if (!dau || !ts.isVariableStatement(dau) || dau.declarationList.declarations.length !== 1) return khongPhai;
  const d = dau.declarationList.declarations[0];
  const e = d.initializer;
  if (
    !ts.isIdentifier(d.name) ||
    !e ||
    !ts.isCallExpression(e) ||
    !ts.isIdentifier(e.expression) ||
    e.expression.text !== ham ||
    e.arguments.length !== 1 ||
    !ts.isIdentifier(e.arguments[0]) ||
    e.arguments[0].text !== req.text
  ) {
    return khongPhai;
  }
  const x = d.name.text;
  const loiKiem = `kết quả bearer không được trả ngay (\`if (${x}) return ${x};\`)`;
  if (!sau || !ts.isIfStatement(sau) || !ts.isIdentifier(sau.expression) || sau.expression.text !== x) return loiKiem;
  const then = sau.thenStatement;
  const ret = ts.isReturnStatement(then)
    ? then
    : ts.isBlock(then) && then.statements.length === 1 && ts.isReturnStatement(then.statements[0])
      ? then.statements[0]
      : null;
  const r = ret?.expression;
  const traX =
    !!r &&
    ((ts.isIdentifier(r) && r.text === x) ||
      (ts.isCallExpression(r) && r.arguments.length === 1 && ts.isIdentifier(r.arguments[0]) && r.arguments[0].text === x));
  return traX ? null : loiKiem;
}

/** Vi phạm của MỘT route dưới `src/app/api/ingest/`: từng handler có mục bearer + mở bằng đúng hàm đó. */
export function viPhamRouteIngest(file: string, src: string, bearer: Readonly<Record<string, HamBearer>>): string[] {
  const sf = docCay(src, file);
  const ds = lietKeExport(sf);
  const viPham = [...viPhamExportRoute(file, ds), ...viPhamNguonDinhDanh(sf, MODULE_HAM_BEARER).map((l) => `${file}: ${l}`)];
  for (const ham of ds.ham.filter((h) => !h.macDinh && PHUONG_THUC_HTTP.has(h.ten))) {
    const khoa = `${file}#${ham.ten}`;
    viPham.push(...thamSoMacDinhTacDong(ham.node).map((l) => `${khoa}: ${l}`));
    if (!Object.hasOwn(bearer, khoa)) {
      viPham.push(`${khoa}: thiếu mục trong BEARER_ROUTE_INGEST`);
      continue;
    }
    const loi = kiemBearerDauThan(ham.node, bearer[khoa]);
    if (loi) viPham.push(`${khoa}: ${loi}`);
  }
  return viPham;
}

// ─── File không cổng: không được chạm lớp dữ liệu ──────────────────────────────────────────────────

/**
 * Module mà file ĐẶC BIỆT của Next (loading/error/not-found/icon/opengraph-image…) được import — file
 * này không có cổng nên chỉ được dựng khung giao diện. Danh sách TRẮNG (không phải đen): import bất
 * kỳ `@/lib/...` truy vấn nào, kể cả gián tiếp, đều đỏ.
 */
export const NGUON_DUOC_PHEP_FILE_DAC_BIET: readonly (string | RegExp)[] = [
  "react",
  "react-dom",
  "next",
  /^next\/[\w/-]+$/,
  /^@\/components\/ui\/[\w-]+$/,
  "@/lib/utils",
  "@/lib/format",
  "lucide-react",
];

const khopNguon = (nguon: string, ds: readonly (string | RegExp)[]) =>
  ds.some((m) => (typeof m === "string" ? m === nguon : m.test(nguon)));

/**
 * File KHÔNG có cổng chỉ được import từ `nguonDuocPhep` (import chỉ-kiểu thì tuỳ ý), không `import()`
 * động / `require`, không nhắc định danh `prisma`.
 */
export function viPhamKhongChamDuLieu(file: string, src: string, nguonDuocPhep: readonly (string | RegExp)[]): string[] {
  const sf = docCay(src, file);
  const viPham: string[] = [];
  for (const st of sf.statements) {
    if (ts.isImportEqualsDeclaration(st)) {
      viPham.push(`${file}: import … = require()`);
      continue;
    }
    let nguon: string | null = null;
    let chiKieu = false;
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      nguon = st.moduleSpecifier.text;
      chiKieu = !!st.importClause?.isTypeOnly;
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      nguon = st.moduleSpecifier.text;
      chiKieu = st.isTypeOnly;
    }
    if (nguon !== null && !chiKieu && !khopNguon(nguon, nguonDuocPhep)) {
      viPham.push(`${file}: import "${nguon}" — file không cổng không được chạm lớp dữ liệu`);
    }
  }
  const di = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword) viPham.push(`${file}: import() động`);
      if (ts.isIdentifier(n.expression) && n.expression.text === "require") viPham.push(`${file}: require()`);
    }
    if (ts.isIdentifier(n) && n.text === "prisma") viPham.push(`${file}: nhắc \`prisma\``);
    ts.forEachChild(n, di);
  };
  di(sf);
  return viPham;
}

/** Tên file đặc biệt của Next (không đuôi) mà Next tự phục vụ/render — không phải page/layout/route. */
export const RE_FILE_DAC_BIET_NEXT =
  /^(?:(?:opengraph-image|twitter-image|icon|apple-icon)\d*|sitemap|robots|manifest|default|loading|error|global-error|template|not-found|forbidden|unauthorized)$/;

export type LoaiFileApp = "trang" | "route" | "dac-biet" | "module";

/**
 * Xếp loại một file dưới `src/app` theo TÊN (bỏ đuôi — mọi đuôi mã nguồn, `page.ts`/`page.js` cũng là
 * trang): trang (page/layout) · route · file đặc biệt Next · module thường (Next không phục vụ). `null`
 * = không phải mã nguồn (css, ico…).
 */
export function phanLoaiFileApp(rel: string): LoaiFileApp | null {
  if (!laFileMaNguon(rel)) return null;
  const ten = path.posix.basename(rel).replace(new RegExp(`\\.${DUOI_MA_NGUON}$`), "");
  if (ten === "page" || ten === "layout") return "trang";
  if (ten === "route") return "route";
  if (RE_FILE_DAC_BIET_NEXT.test(ten)) return "dac-biet";
  return "module";
}
