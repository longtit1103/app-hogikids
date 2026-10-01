import ts from "typescript";

/**
 * Bộ đọc mã nguồn cho lưới "cổng bắt buộc" (`cong-bat-buoc.test.ts`) — bằng CÂY CÚ PHÁP TypeScript,
 * không bằng regex/dòng. Lý do: bản đọc theo dòng cắt thân hàm tới dòng `}` đầu tiên ở cột 0, nên hàm
 * viết trên MỘT dòng mượn được cổng của hàm sau nó; và chỉ tìm "có chữ `congAction(` trong thân" nên
 * gọi cổng rồi bỏ kết quả, hoặc gọi cổng SAU mutation, vẫn qua. Trên cây cú pháp:
 * - mỗi hàm export là một nút riêng, thân là đúng khối `{…}` của nó (chú thích/chuỗi không bao giờ bị
 *   nhầm là mã);
 * - cổng phải là CÂU LỆNH ĐẦU TIÊN của thân, và kết quả phải được kiểm ngay câu sau.
 *
 * Mọi hàm ở đây THUẦN (nhận chuỗi mã) — lưới tự kiểm bằng chuỗi mẫu đột biến.
 */

export const TEN_CONG_ACTION: readonly string[] = ["congAction", "congChuShopAction"];
export const TEN_CONG_ROUTE: readonly string[] = ["congRoute", "congChuShopRoute"];
export const TEN_CONG_TRANG: readonly string[] = ["yeuCauQuyenTrang", "yeuCauChuShopTrang"];

/** Tên handler Route Handler Next.js. */
export const PHUONG_THUC_HTTP: ReadonlySet<string> = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

/** Export cấu hình (hằng) mà Next.js đọc ở route/trang — được phép, miễn là `export const`. */
export const EXPORT_CAU_HINH: ReadonlySet<string> = new Set([
  "dynamic",
  "dynamicParams",
  "revalidate",
  "fetchCache",
  "runtime",
  "preferredRegion",
  "maxDuration",
  "metadata",
  "viewport",
]);

/** Module DUY NHẤT được cấp từng loại cổng — tên trùng mà nguồn khác là cổng giả. */
export const MODULE_CONG_ACTION = "@/lib/quyen/cong-action";
export const MODULE_CONG_ROUTE = "@/lib/quyen/cong-route";
export const MODULE_CONG_TRANG = "@/lib/quyen/cong-trang";

/** Cổng chỉ-chủ-shop (không nhận quyền) trong ba bộ cổng. */
export const TEN_CONG_CHU_SHOP: readonly string[] = ["congChuShopAction", "congChuShopRoute", "yeuCauChuShopTrang"];

/**
 * Đuôi file MÃ NGUỒN mà Next/TS có thể nạp (`tsconfig` bật `allowJs`): lọc chỉ `.ts/.tsx` thì một
 * `page.js` hay action `.mjs` nằm ngoài mọi lưới.
 */
export const DUOI_MA_NGUON = "(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)";
export const laFileMaNguon = (rel: string): boolean => new RegExp(`\\.${DUOI_MA_NGUON}$`).test(rel);

function scriptKind(tenFile: string): ts.ScriptKind {
  if (/\.tsx$/.test(tenFile)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(tenFile)) return ts.ScriptKind.JSX;
  if (/\.[mc]?js$/.test(tenFile)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function docCay(src: string, tenFile = "mau.ts"): ts.SourceFile {
  return ts.createSourceFile(tenFile, src, ts.ScriptTarget.Latest, true, scriptKind(tenFile));
}

function coModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false);
}

/** Dòng đầu của mã nút — cho thông báo vi phạm. */
export function dongDau(node: ts.Node): string {
  return node.getText().split("\n")[0];
}

/** Directive `"use server"` cấp FILE (phần mở đầu của file). */
export function laFileUseServer(sf: ts.SourceFile): boolean {
  for (const st of sf.statements) {
    if (!ts.isExpressionStatement(st) || !ts.isStringLiteral(st.expression)) return false;
    if (st.expression.text === "use server") return true;
  }
  return false;
}

/** Có directive `"use server"` ở BẤT KỲ đâu (kể cả trong thân hàm — Server Action inline). */
export function coUseServerBatKy(sf: ts.SourceFile): boolean {
  let co = false;
  const di = (n: ts.Node): void => {
    if (ts.isExpressionStatement(n) && ts.isStringLiteral(n.expression) && n.expression.text === "use server") co = true;
    if (!co) ts.forEachChild(n, di);
  };
  di(sf);
  return co;
}

/** Có định danh (gọi, import, tham chiếu) mang một trong các tên — trên MÃ, không tính chú thích/chuỗi. */
export function coDinhDanh(node: ts.Node, ten: readonly string[]): boolean {
  let co = false;
  const di = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && ten.includes(n.text)) co = true;
    if (!co) ts.forEachChild(n, di);
  };
  di(node);
  return co;
}

/** Có LỜI GỌI `ten(...)` trong nút. */
export function coLoiGoi(node: ts.Node, ten: readonly string[]): boolean {
  let co = false;
  const di = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && ten.includes(n.expression.text)) co = true;
    if (!co) ts.forEachChild(n, di);
  };
  di(node);
  return co;
}

export type HamExport = { ten: string; macDinh: boolean; node: ts.FunctionDeclaration };
export type DanhSachExport = {
  /** `export [default] [async] function …` có thân. */
  ham: HamExport[];
  /** `export const <tên>` (tên từng biến). */
  hang: { ten: string; dong: string }[];
  /** Dạng export khác: `export { … }`, `export * from`, `export default <biểu thức>`, class, enum. */
  khac: string[];
};

/** Liệt kê MỌI export cấp file (bỏ qua export chỉ-kiểu). */
export function lietKeExport(sf: ts.SourceFile): DanhSachExport {
  const kq: DanhSachExport = { ham: [], hang: [], khac: [] };
  for (const st of sf.statements) {
    if (ts.isExportAssignment(st)) {
      kq.khac.push(dongDau(st));
      continue;
    }
    if (ts.isExportDeclaration(st)) {
      if (!st.isTypeOnly) kq.khac.push(dongDau(st));
      continue;
    }
    if (!coModifier(st, ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st)) continue;
    if (ts.isFunctionDeclaration(st) && st.body) {
      kq.ham.push({
        ten: st.name?.text ?? "default",
        macDinh: coModifier(st, ts.SyntaxKind.DefaultKeyword),
        node: st,
      });
      continue;
    }
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        kq.hang.push({ ten: ts.isIdentifier(d.name) ? d.name.text : d.name.getText(), dong: dongDau(st) });
      }
      continue;
    }
    kq.khac.push(dongDau(st));
  }
  return kq;
}

export function laAsync(fn: ts.FunctionDeclaration): boolean {
  return coModifier(fn, ts.SyntaxKind.AsyncKeyword);
}

/** `await <tên>(...)` với tên thuộc tập cổng. */
function laAwaitGoiCong(e: ts.Expression | undefined, tenCong: readonly string[]): boolean {
  return (
    !!e &&
    ts.isAwaitExpression(e) &&
    ts.isCallExpression(e.expression) &&
    ts.isIdentifier(e.expression.expression) &&
    tenCong.includes(e.expression.expression.text)
  );
}

function boNgoac(e: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(e) ? boNgoac(e.expression) : e;
}

/** `!<x>.ok` — trả `<x>` (đã bỏ ngoặc), hoặc null. */
function bieuThucKiemOk(e: ts.Expression): ts.Expression | null {
  if (!ts.isPrefixUnaryExpression(e) || e.operator !== ts.SyntaxKind.ExclamationToken) return null;
  const pa = boNgoac(e.operand);
  if (!ts.isPropertyAccessExpression(pa) || pa.name.text !== "ok") return null;
  return boNgoac(pa.expression);
}

function cauReturn(st: ts.Statement): ts.ReturnStatement | null {
  if (ts.isReturnStatement(st)) return st;
  if (ts.isBlock(st) && st.statements.length === 1 && ts.isReturnStatement(st.statements[0])) return st.statements[0];
  return null;
}

/**
 * Cách nhánh từ chối trả về:
 * - `ketQua`: action — `if (!c.ok) return c;` (nhánh lỗi gán thẳng vào `ActionResult`);
 * - `response`: route — `if (!c.ok) return c.response;`;
 * - `khong-kiem`: trang — cổng tự `redirect()` (ném), không có kết quả phải kiểm.
 */
export type CachTraVe = "ketQua" | "response" | "khong-kiem";

/**
 * Cổng có phải CÂU LỆNH ĐẦU TIÊN của thân và kết quả có được kiểm ngay không. `null` = đạt; chuỗi = lý do.
 *
 * Dạng đạt:
 * - `const c = await <cổng>(…);` rồi NGAY SAU `if (!c.ok) return c;` (hoặc `return c.response;` ở route);
 * - `if (!(await <cổng>(…)).ok) return …;`;
 * - trang: `await <cổng>(…);` hoặc `const x = await <cổng>(…);`.
 */
export function kiemCongDauThan(fn: ts.FunctionDeclaration, tenCong: readonly string[], traVe: CachTraVe): string | null {
  const [dau, sau] = fn.body?.statements ?? [];
  if (!dau) return "thân rỗng — không có cổng";

  if (ts.isIfStatement(dau)) {
    const x = bieuThucKiemOk(dau.expression);
    if (traVe !== "khong-kiem" && x && laAwaitGoiCong(x, tenCong) && cauReturn(dau.thenStatement)) return null;
    return "câu lệnh đầu tiên không phải cổng";
  }

  if (traVe === "khong-kiem" && ts.isExpressionStatement(dau) && laAwaitGoiCong(dau.expression, tenCong)) return null;

  if (!ts.isVariableStatement(dau)) return "câu lệnh đầu tiên không phải cổng";
  const [khai, ...thua] = dau.declarationList.declarations;
  if (thua.length > 0 || !khai || !laAwaitGoiCong(khai.initializer, tenCong)) return "câu lệnh đầu tiên không phải cổng";
  if (traVe === "khong-kiem") return null;

  if (!ts.isIdentifier(khai.name)) return "kết quả cổng bị bóc tách — không kiểm được `.ok`";
  const ten = khai.name.text;
  const loiKhongKiem = `kết quả cổng không được kiểm ngay (\`if (!${ten}.ok) return ${ten}${traVe === "response" ? ".response" : ""};\`)`;
  if (!sau || !ts.isIfStatement(sau)) return loiKhongKiem;
  const x = bieuThucKiemOk(sau.expression);
  const ret = cauReturn(sau.thenStatement);
  if (!x || !ts.isIdentifier(x) || x.text !== ten || !ret?.expression) return loiKhongKiem;
  const e = ret.expression;
  const traDung =
    traVe === "ketQua"
      ? ts.isIdentifier(e) && e.text === ten
      : ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === ten && e.name.text === "response";
  return traDung ? null : loiKhongKiem;
}

/**
 * Lời gọi cổng ở câu lệnh đầu thân (chỉ dùng SAU KHI `kiemCongDauThan` đã đạt) — để đọc đối số THẬT
 * so với bảng quyền mong đợi.
 */
export function loiGoiCongDauThan(fn: ts.FunctionDeclaration): ts.CallExpression | null {
  const dau = fn.body?.statements[0];
  if (!dau) return null;
  let e: ts.Expression | undefined;
  if (ts.isIfStatement(dau)) {
    e = bieuThucKiemOk(dau.expression) ?? undefined;
  } else if (ts.isExpressionStatement(dau)) {
    e = dau.expression;
  } else if (ts.isVariableStatement(dau)) {
    e = dau.declarationList.declarations[0]?.initializer;
  }
  return e && ts.isAwaitExpression(e) && ts.isCallExpression(e.expression) ? e.expression : null;
}

/** Tên mọi định danh mà tham số của hàm khai ra (kể cả bóc tách `{ a, b: [c] }`). */
export function tenThamSo(fn: ts.SignatureDeclaration): Set<string> {
  const ten = new Set<string>();
  const gom = (n: ts.BindingName): void => {
    if (ts.isIdentifier(n)) ten.add(n.text);
    else for (const el of n.elements) if (!ts.isOmittedExpression(el)) gom(el.name);
  };
  for (const p of fn.parameters) gom(p.name);
  return ten;
}
