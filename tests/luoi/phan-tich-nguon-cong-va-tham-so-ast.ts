import ts from "typescript";

import { dongDau } from "./phan-tich-cong-bang-ast";

/**
 * Hai cách lách lưới "cổng đầu thân" mà chỉ đọc câu lệnh đầu không thấy (lưới tự kiểm ở
 * `cong-bat-buoc-tu-kiem-dot-bien.test.ts`):
 * - tham số có giá trị mặc định CHẠY mã — chạy trước câu lệnh đầu thân, tức trước cổng;
 * - cổng GIẢ trùng tên — lưới nhận cổng theo TÊN ở chỗ gọi, nên tên phải đến từ đúng module.
 */

/** Biểu thức có thể CHẠY mã (gọi hàm, tạo đối tượng, await, gán…) — không được nằm trong giá trị mặc định tham số. */
function laBieuThucTacDong(n: ts.Node): boolean {
  if (
    ts.isCallExpression(n) ||
    ts.isNewExpression(n) ||
    ts.isTaggedTemplateExpression(n) ||
    ts.isAwaitExpression(n) ||
    ts.isYieldExpression(n) ||
    ts.isDeleteExpression(n)
  ) {
    return true;
  }
  if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
    (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) {
    return true;
  }
  return (
    ts.isBinaryExpression(n) &&
    n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  );
}

/**
 * Tham số có giá trị mặc định CHẠY mã: initializer tham số chạy TRƯỚC câu lệnh đầu thân, tức trước cổng
 * — và client gọi được Server Action với đối số `undefined` để kích nó. Trả danh sách mô tả vi phạm.
 */
export function thamSoMacDinhTacDong(fn: ts.SignatureDeclaration): string[] {
  const viPham: string[] = [];
  const soi = (n: ts.Node): void => {
    const init = ts.isParameter(n) || ts.isBindingElement(n) ? n.initializer : undefined;
    if (init) {
      let co = false;
      const di = (x: ts.Node): void => {
        if (laBieuThucTacDong(x)) co = true;
        if (!co) ts.forEachChild(x, di);
      };
      di(init);
      if (co) viPham.push(`tham số mặc định chạy mã trước cổng — \`${n.getText()}\``);
    }
    ts.forEachChild(n, soi);
  };
  for (const p of fn.parameters) soi(p);
  return viPham;
}

const LOAI_KHAI_BAO_CO_TEN = (n: ts.Node): boolean =>
  ts.isVariableDeclaration(n) ||
  ts.isFunctionDeclaration(n) ||
  ts.isFunctionExpression(n) ||
  ts.isClassDeclaration(n) ||
  ts.isClassExpression(n) ||
  ts.isParameter(n) ||
  ts.isBindingElement(n) ||
  ts.isEnumDeclaration(n) ||
  ts.isModuleDeclaration(n) ||
  ts.isImportEqualsDeclaration(n);

/**
 * Định danh cổng/hàm kiểm (`ten` → module duy nhất được cấp) phải đến từ ĐÚNG module: `import { x }
 * from "<module>"` không đổi tên, không chỉ-kiểu; không file nào được tự khai báo (hàm/biến/tham
 * số/lớp) trùng tên — lưới đọc TÊN ở chỗ gọi, nên tên trùng mà nguồn khác là cổng giả qua lưới. Tên
 * được GỌI trong file mà không có import hợp lệ cũng đỏ (vd dựa vào biến toàn cục).
 */
export function viPhamNguonDinhDanh(sf: ts.SourceFile, moduleTheoTen: Readonly<Record<string, string>>): string[] {
  const viPham: string[] = [];
  const ten = Object.keys(moduleTheoTen);
  const daImportDung = new Set<string>();

  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const nguon = ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : "?";
    const clause = st.importClause;
    if (clause.name && ten.includes(clause.name.text)) {
      viPham.push(`\`${clause.name.text}\` import mặc định từ "${nguon}" — phải là import có tên từ "${moduleTheoTen[clause.name.text]}"`);
    }
    const nb = clause.namedBindings;
    if (nb && ts.isNamespaceImport(nb) && ten.includes(nb.name.text)) {
      viPham.push(`\`${nb.name.text}\` là namespace import từ "${nguon}"`);
    }
    if (!nb || !ts.isNamedImports(nb)) continue;
    for (const el of nb.elements) {
      const x = el.name.text;
      if (!ten.includes(x)) continue;
      const goc = el.propertyName?.text ?? x;
      if (nguon !== moduleTheoTen[x]) {
        viPham.push(`\`${x}\` import từ "${nguon}" — cổng/hàm kiểm thật chỉ ở "${moduleTheoTen[x]}"`);
      } else if (goc !== x) {
        viPham.push(`\`${x}\` là tên đổi từ \`${goc}\` — không import đổi tên`);
      } else if (clause.isTypeOnly || el.isTypeOnly) {
        viPham.push(`\`${x}\` import chỉ-kiểu`);
      } else {
        daImportDung.add(x);
      }
    }
  }

  const duocGoi = new Set<string>();
  const di = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && ten.includes(n.text)) {
      const cha = n.parent;
      if (LOAI_KHAI_BAO_CO_TEN(cha) && (cha as ts.NamedDeclaration).name === n) {
        viPham.push(`\`${n.text}\` khai báo cục bộ (\`${dongDau(cha)}\`) — che cổng/hàm kiểm thật`);
      }
      if (ts.isCallExpression(cha) && cha.expression === n) duocGoi.add(n.text);
    }
    ts.forEachChild(n, di);
  };
  di(sf);
  for (const x of duocGoi) {
    if (!daImportDung.has(x)) viPham.push(`\`${x}\` được gọi mà không import từ "${moduleTheoTen[x]}"`);
  }
  return viPham;
}
