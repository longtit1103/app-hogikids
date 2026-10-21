import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * LƯỚI AST — đã bật nợ phải trả (M ≠ null) thì DÒNG TIỀN NGÀY < M ĐÃ CHỐT: quỹ cuối M−1 được chốt theo tiền thật bằng
 * điều chỉnh mở sổ `CUTOVER_ADJ_*` (bước bật, ghi một lần) ⇒ bất biến `Q(M−1) + Σ CUTOVER_net = hằng`. Thêm / sửa /
 * xoá / khôi phục một `CashMovement` hay `ThuNhap` ngày < M mà không bù là quỹ từ M lệch khỏi tiền thật đúng số đó —
 * không test số nào đỏ. Cổng duy nhất: `chanDongTienTruocM` (`src/lib/no-phai-tra/chan-dong-tien-truoc-m.ts`).
 *
 * Soi THEO HÀM, không theo file: một file thường có nhiều đường ghi (tạo / sửa / xoá sổ tiết kiệm…), xoá cổng ở MỘT
 * hàm trong khi các hàm khác của file vẫn gọi cổng thì lưới theo file vẫn xanh. Ba lớp:
 *
 *  1. Quét toàn `src/` (bỏ `generated`): mọi HÀM chứa lệnh ghi `CashMovement`/`ThuNhap` phải được khai ở MỘT trong
 *     ba danh sách — `HAM_GOI_CONG` (gọi cổng trong chính hàm, hoặc trong hàm cùng file mà nó gọi TRỰC TIẾP),
 *     `HAM_GHI_HO` (hàm phụ không export; mọi nơi gọi nó đã được khai) hoặc `NGOAI_LE` (lý do + máy soi hình dạng).
 *     "Ghi" = (a) `.cashMovement|.thuNhap.<create|createMany|createManyAndReturn|update|updateMany|
 *     updateManyAndReturn|upsert|delete|deleteMany>(` — cả `tx["cashMovement"]`; (b) chuỗi/template chứa SQL
 *     `INSERT INTO` / `UPDATE` / `DELETE FROM` bảng `"CashMovement"` / `"ThuNhap"` (mọi `$executeRaw*`/`$queryRaw*`,
 *     `Prisma.sql`); (c) GHI QUA ALIAS: `const c = tx.cashMovement` / `const { cashMovement } = tx` rồi `c.create(`;
 *     (d) GHI LỒNG qua quan hệ `movements` / `thuNhap` của `Loan`/`SoTietKiem`/thẻ/phiếu/ví (`movements: { create… }`).
 *     Mọi khoá ngoại của hai bảng là `Restrict` (không cascade) — xoá cha không âm thầm ghi dòng tiền.
 *  2. Hàm gọi cổng "trước M" (`chanDongTienTruocM`, hay `doTinhTrang` của khôi phục thùng rác): MỌI transaction chứa
 *     câu ghi mở đầu bằng `await khoaChiaSeBatNoPhaiTra(…)` VÔ ĐIỀU KIỆN (bước bật giữ EXCLUSIVE; không khoá thì đọc
 *     M = null rồi ghi sau lưng nó), truyền `OPT_TX_DONG_TIEN`, gọi cổng TRƯỚC câu ghi đầu tiên. Ngoại lệ hẹp: nhánh
 *     `if (isKindNoPhaiTraGhiTay(…))` của dòng tiền ghi tay — 4 kind nợ chỉ sống trong cửa sổ ngày ≥ M
 *     (`congNoPhaiTra` → `ngayTienMoiSchema`) nên không chạm quỹ cuối M−1.
 *  3. Tự đột biến (nguồn thật cắt đúng thân hàm + chuỗi nguồn giả + cây `src/` tạm) ⇒ lưới phải đỏ.
 *
 * Giới hạn còn lại (chấp nhận, cùng giới hạn lưới Expense): alias nhiều tầng (truyền delegate vào hàm khác, gán lại
 * biến), tên bảng ghép chuỗi động — không có trong `src/` hôm nay; đường đó phải tự khai. Lưới không soi BIỂU THỨC
 * điều kiện quanh lời gọi cổng (vd `if (!boQua)`) — phần đó do test hành vi giữ
 * (`tests/unit/cash-movements/dong-tien-truoc-m-sau-bat.integration.test.ts`,
 * `tests/unit/so-quy/khoan-vay-tiet-kiem-truoc-m-sau-bat.integration.test.ts`, thùng rác `khoi-phuc-no-phai-tra`).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CONG = "chanDongTienTruocM";
/** Cổng "trước M" ⇒ áp luật khoá chung câu đầu + `OPT_TX_DONG_TIEN` cho transaction ghi. */
const CONG_CAN_KHOA = new Set([CONG, "doTinhTrang"]);

/**
 * [file, hàm, cổng]: hàm GHI dòng tiền phải gọi `cổng(` trong chính nó hoặc trong hàm cùng file nó gọi trực tiếp.
 * `ngayTienMoiSchema` = cổng đã duyệt của 4 kind nợ phải trả (`CARD_PAY`·`SUPPLIER_PAY`·`SUPPLIER_REFUND`·
 * `ADS_TOPUP`): ngày ∈ [M, hôm nay] nên không bao giờ chạm quỹ đã chốt.
 */
const HAM_GOI_CONG: [string, string, string][] = [
  ["src/lib/actions/cash-movements.ts", "createCashMovement", CONG],
  ["src/lib/actions/cash-movements.ts", "updateCashMovement", CONG],
  ["src/lib/actions/cash-movements.ts", "deleteCashMovement", CONG],
  ["src/lib/actions/khoan-vay.ts", "taoKhoanVay", CONG],
  ["src/lib/actions/khoan-vay.ts", "suaKhoanVay", CONG],
  ["src/lib/actions/khoan-vay.ts", "xoaKhoanVay", CONG],
  ["src/lib/actions/khoan-vay.ts", "tatToanKhoanVay", CONG],
  ["src/lib/actions/khoan-vay.ts", "chayGhiKy", CONG],
  ["src/lib/actions/tat-toan-thau-chi.ts", "chayTatToan", CONG],
  // Dòng lãi kỳ của thấu chi "lãi nhập gốc": sửa số / xoá kéo theo dòng `LAI_NHAP_GOC` đi cặp.
  ["src/lib/actions/expenses.ts", "updateExpense", CONG],
  ["src/lib/actions/expenses.ts", "deleteExpense", CONG],
  ["src/lib/actions/so-tiet-kiem.ts", "taoSoTietKiem", CONG],
  ["src/lib/actions/so-tiet-kiem.ts", "suaSoTietKiem", CONG],
  ["src/lib/actions/so-tiet-kiem.ts", "xoaSoTietKiem", CONG],
  ["src/lib/actions/tat-toan-so-tiet-kiem.ts", "tatToanSoTietKiem", CONG],
  ["src/lib/actions/tat-toan-so-tiet-kiem.ts", "moLaiSoTietKiem", CONG],
  // Cổng của khôi phục nằm ở `doTinhTrang` — chuỗi tới lõi `lyDoDongTienTruocM` khoá ở `CHUOI_CONG_KHOI_PHUC`.
  ["src/lib/thung-rac/khoi-phuc-ban-ghi.ts", "khoiPhucBanGhiDaXoa", "doTinhTrang"],
  ["src/lib/actions/phieu-nhap-no.ts", "ghiNhanPhieuVaoSoNo", "ngayTienMoiSchema"],
  // Qua `traGopSchema(mocM)`; câu ghi ở `chayTraGop` (HAM_GHI_HO).
  ["src/lib/actions/tra-tien-hang.ts", "traTienHangGop", "ngayTienMoiSchema"],
];

/** Chuỗi cổng khôi phục thùng rác: [file, hàm, phải gọi] (trực tiếp hoặc qua hàm cùng file). */
const CHUOI_CONG_KHOI_PHUC: [string, string, string][] = [
  ["src/lib/thung-rac/do-tinh-trang-khoi-phuc.ts", "doTinhTrang", "viPhamNoPhaiTraKhiKhoiPhuc"],
  ["src/lib/thung-rac/cua-so-no-phai-tra-khoi-phuc.ts", "viPhamNoPhaiTraKhiKhoiPhuc", "lyDoDongTienTruocM"],
];

/** `file#hàm` phụ GHI thay hàm gọi — không export, mọi nơi gọi nằm trong hàm đã khai (máy soi). */
const HAM_GHI_HO: Record<string, string> = {
  "src/lib/actions/cash-movements.ts#ghiCoHangRaoCha": "câu UPDATE có rào dùng chung của updateCashMovement — cổng + khoá ở hàm gọi",
  "src/lib/thung-rac/khoi-phuc-ban-ghi.ts#taoLai": "dựng lại từng bản ghi của cụm — cổng `doTinhTrang` ở khoiPhucBanGhiDaXoa",
  "src/lib/actions/tra-tien-hang.ts#chayTraGop": "transaction trả gộp `SUPPLIER_PAY` — ngày đã qua `ngayTienMoiSchema` ở traTienHangGop",
  "src/lib/actions/tra-tien-hang.ts#chayTraGopCoRetry": "bọc thử lại một lần của chayTraGop",
};

type SoiNgoaiLe = (ham: ts.FunctionLikeDeclaration, sf: ts.SourceFile) => string | null;

/**
 * `file#hàm` GHI dòng tiền mà KHÔNG qua cổng — mỗi dòng một lý do + máy soi hình dạng câu ghi (đổi hình dạng ⇒ đỏ,
 * phải xét lại). Thêm vào đây là quyết định có chủ ý.
 */
const NGOAI_LE: Record<string, { lyDo: string; soi: SoiNgoaiLe }> = {
  "src/lib/actions/cash-movements.ts#suaDieuChinhChuyenDoi": {
    lyDo:
      "sửa dòng điều chỉnh mở sổ `CUTOVER_*` (chỉ chủ shop): chính là vế CUTOVER của bất biến — ngày luôn = M, chỉ đổi số " +
      "tiền + mô tả; chỉ báo trôi quỹ trước M so Q(M−1) + Σ CUTOVER hiện tại",
    soi: (h, sf) => soiChiSuaTienMoTaCutover(h, sf),
  },
  "src/lib/actions/sua-tien-truoc-moc.ts#suaSoTienTruocMoc": {
    lyDo:
      "lối 'Sửa số tiền trước mốc': đổi số tiền Expense < M và TỰ BÙ `CUTOVER_ADJ_*` ±Δ ĐÚNG ngày M cùng transaction ⇒ " +
      "quỹ từ M không đổi; khoá chung câu đầu + M/D0 trong transaction ở `DUONG_BU_CUTOVER` của " +
      "`khoa-chung-bat-cho-duong-ghi-nhap-hang.test.ts`",
    soi: (h, sf) => soiChiTaoCutoverNgayM(h, sf),
  },
  "src/lib/no-phai-tra/ghi-khoi-tao-no-phai-tra.ts#ghiKhoiTaoNoPhaiTra": {
    lyDo:
      "bước bật: ghi điều chỉnh mở sổ `CUTOVER_*` ĐÚNG ngày M, MỘT lần (chỉ `actions/bat-no-phai-tra.ts` import — lưới " +
      "AST riêng); đây là nơi sinh ra số dư đã chốt",
    soi: (h, sf) => soiChiTaoCutoverNgayM(h, sf),
  },
  "src/lib/actions/data-admin.ts#deleteAllData": {
    lyDo: "xoá TOÀN BỘ dữ liệu giao dịch (quản trị) — cùng transaction xoá mốc M, điều chỉnh mở sổ, hồ sơ nợ",
    soi: (h, sf) => soiChiXoaToanBo(h, sf),
  },
};

// ── Phân tích AST ───────────────────────────────────────────────────────────────────────────────

const PHUONG_THUC_GHI = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
]);
const BANG = new Set(["cashMovement", "thuNhap"]);
/** Quan hệ tới CashMovement/ThuNhap trên bảng cha + thao tác ghi lồng của Prisma. */
const QUAN_HE = new Set(["movements", "thuNhap"]);
const GHI_LONG = new Set([...PHUONG_THUC_GHI, "connectOrCreate", "connect", "disconnect", "set"]);
/** SQL ghi bảng — cả `"app"."CashMovement"`; `"CashMovementKind"` không khớp (dấu nháy đóng). */
const SQL_GHI = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:"?app"?\s*\.\s*)?"(CashMovement|ThuNhap)"/i;
const CAP_FILE = "<cấp file>";

const sfCua = (src: string, ten: string) => ts.createSourceFile(ten, src, ts.ScriptTarget.Latest, true);

function moiNut(goc: ts.Node, loc: (n: ts.Node) => boolean): ts.Node[] {
  const ra: ts.Node[] = [];
  const di = (n: ts.Node) => {
    if (loc(n)) ra.push(n);
    ts.forEachChild(n, di);
  };
  di(goc);
  return ra;
}

function laGoi(n: ts.Node, ten: string): n is ts.CallExpression {
  return ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === ten;
}

const nam = (n: ts.Node, goc: ts.Node) => n.getStart() >= goc.pos && n.end <= goc.end;
const dong = (sf: ts.SourceFile, n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;

/** Tên hàm mang nút hàm `n` (khai báo, method, hay arrow/function gán cho biến/thuộc tính); vô danh ⇒ null. */
function tenCuaHam(n: ts.Node): string | null {
  if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name !== undefined && ts.isIdentifier(n.name)) {
    return n.name.text;
  }
  if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
    const p = n.parent;
    if ((ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p)) && ts.isIdentifier(p.name)) return p.name.text;
  }
  return null;
}

/** Hàm CÓ TÊN gần nhất chứa nút (callback vô danh của `$transaction`/`chayCoRetry` thuộc về hàm ngoài). */
function hamChua(n: ts.Node): string {
  for (let p: ts.Node | undefined = n.parent; p !== undefined; p = p.parent) {
    const ten = tenCuaHam(p);
    if (ten !== null) return ten;
  }
  return CAP_FILE;
}

/** Bảng tên → hàm của file, dựng một lần cho mỗi cây cú pháp. */
const boNhoHam = new WeakMap<ts.SourceFile, Map<string, ts.FunctionLikeDeclaration[]>>();

function timHam(sf: ts.SourceFile, ten: string): ts.FunctionLikeDeclaration[] {
  let bang = boNhoHam.get(sf);
  if (bang === undefined) {
    bang = new Map();
    for (const n of moiNut(sf, (x) => tenCuaHam(x) !== null)) {
      const t = tenCuaHam(n) as string;
      bang.set(t, [...(bang.get(t) ?? []), n as ts.FunctionLikeDeclaration]);
    }
    boNhoHam.set(sf, bang);
  }
  return bang.get(ten) ?? [];
}

/** Mọi lệnh ghi CashMovement/ThuNhap của file theo dạng (a)(b)(c)(d). */
function cauGhi(sf: ts.SourceFile): ts.Node[] {
  const alias = new Set<string>();
  for (const n of moiNut(sf, ts.isVariableDeclaration) as ts.VariableDeclaration[]) {
    const init = n.initializer;
    if (ts.isIdentifier(n.name) && init !== undefined && ts.isPropertyAccessExpression(init) && BANG.has(init.name.text)) {
      alias.add(n.name.text);
    }
    if (ts.isObjectBindingPattern(n.name)) {
      for (const el of n.name.elements) {
        const goc = el.propertyName ?? el.name;
        if (ts.isIdentifier(goc) && BANG.has(goc.text) && ts.isIdentifier(el.name)) alias.add(el.name.text);
      }
    }
  }
  const laDelegate = (e: ts.Expression) =>
    (ts.isPropertyAccessExpression(e) && BANG.has(e.name.text)) ||
    (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression) && BANG.has(e.argumentExpression.text)) ||
    (ts.isIdentifier(e) && alias.has(e.text));
  return moiNut(sf, (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      return PHUONG_THUC_GHI.has(n.expression.name.text) && laDelegate(n.expression.expression);
    }
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) {
      return SQL_GHI.test(n.getText(sf));
    }
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && QUAN_HE.has(n.name.text) && ts.isObjectLiteralExpression(n.initializer)) {
      return n.initializer.properties.some((p) => p.name !== undefined && ts.isIdentifier(p.name) && GHI_LONG.has(p.name.text));
    }
    return false;
  });
}

/** Lời gọi trong `ham` "mang" cổng: gọi thẳng `cong(`, hoặc gọi hàm cùng file (khác `ham`) mà thân có `cong(`. */
function noiGoiCong(sf: ts.SourceFile, ham: ts.Node, cong: string): ts.CallExpression[] {
  return moiNut(ham, (n) => {
    if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression)) return false;
    if (n.expression.text === cong) return true;
    return timHam(sf, n.expression.text).some((h) => h !== ham && moiNut(h, (m) => laGoi(m, cong)).length > 0);
  }) as ts.CallExpression[];
}

function callbackTransaction(goc: ts.Node): (ts.ArrowFunction | ts.FunctionExpression)[] {
  return moiNut(goc, (n) => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "$transaction")
    .map((n) => (n as ts.CallExpression).arguments[0])
    .filter((a): a is ts.ArrowFunction | ts.FunctionExpression => a !== undefined && (ts.isArrowFunction(a) || ts.isFunctionExpression(a)));
}

function cauDauLaKhoaVoDieuKien(cb: ts.ArrowFunction | ts.FunctionExpression): boolean {
  if (!ts.isBlock(cb.body)) return false;
  const c = cb.body.statements[0];
  return c !== undefined && ts.isExpressionStatement(c) && ts.isAwaitExpression(c.expression) && laGoi(c.expression.expression, "khoaChiaSeBatNoPhaiTra");
}

function truyenOptDongTien(cb: ts.ArrowFunction | ts.FunctionExpression): boolean {
  const goi = cb.parent;
  const opt = ts.isCallExpression(goi) ? goi.arguments[1] : undefined;
  return opt !== undefined && ts.isIdentifier(opt) && opt.text === "OPT_TX_DONG_TIEN";
}

/** Transaction nằm trong nhánh `if (isKindNoPhaiTraGhiTay(…)) { … }` của hàm. */
function trongNhanhNo(cb: ts.Node, ham: ts.Node): boolean {
  for (let con: ts.Node = cb, p = cb.parent; p !== undefined && p !== ham; con = p, p = p.parent) {
    if (ts.isIfStatement(p) && p.thenStatement === con && laGoi(p.expression, "isKindNoPhaiTraGhiTay")) return true;
  }
  return false;
}

/** Tên hàm phụ ghi hộ của file. */
const ghiHoCuaFile = (file: string) =>
  new Set(Object.keys(HAM_GHI_HO).filter((k) => k.startsWith(`${file}#`)).map((k) => k.slice(file.length + 1)));

/** Câu ghi của `ham`: lệnh ghi trực tiếp + lời gọi hàm phụ ghi hộ cùng file. */
function ghiTrongHam(sf: ts.SourceFile, ham: ts.Node, ghiHo: Set<string>): ts.Node[] {
  const tructiep = cauGhi(sf).filter((n) => nam(n, ham));
  const quaPhu = moiNut(ham, (n) => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && ghiHo.has(n.expression.text));
  return [...tructiep, ...quaPhu].sort((a, b) => a.getStart() - b.getStart());
}

/** Vi phạm của một hàm `HAM_GOI_CONG` (rỗng = đạt). */
function viPhamGoiCong(src: string, file: string, tenHam: string, cong: string, ghiHo = ghiHoCuaFile(file)): string[] {
  const sf = sfCua(src, file);
  const ds = timHam(sf, tenHam);
  if (ds.length !== 1) return [`${file}: không thấy đúng một hàm ${tenHam}`];
  const ham = ds[0];
  const ghi = ghiTrongHam(sf, ham, ghiHo);
  if (ghi.length === 0) return [`${file}#${tenHam} không còn ghi CashMovement/ThuNhap — gỡ khỏi HAM_GOI_CONG`];
  const cuaCong = noiGoiCong(sf, ham, cong);
  const loi: string[] = [];
  if (cuaCong.length === 0) loi.push(`${file}#${tenHam}: không gọi ${cong}( (trong hàm hay hàm cùng file nó gọi trực tiếp)`);
  if (!CONG_CAN_KHOA.has(cong)) return loi;

  const cbs = callbackTransaction(ham);
  const theoTx = new Map<ts.ArrowFunction | ts.FunctionExpression, ts.Node[]>();
  for (const g of ghi) {
    const chua = cbs.filter((cb) => nam(g, cb));
    if (chua.length === 0) {
      loi.push(`${file}#${tenHam}: câu ghi dòng ${dong(sf, g)} nằm NGOÀI $transaction`);
      continue;
    }
    const gan = chua.reduce((a, b) => (b.pos >= a.pos ? b : a));
    theoTx.set(gan, [...(theoTx.get(gan) ?? []), g]);
  }
  for (const [cb, ds] of theoTx) {
    const o = `${file}#${tenHam}: transaction dòng ${dong(sf, cb)}`;
    if (!truyenOptDongTien(cb)) loi.push(`${o} không truyền OPT_TX_DONG_TIEN`);
    if (trongNhanhNo(cb, ham)) continue;
    if (!cauDauLaKhoaVoDieuKien(cb)) loi.push(`${o} không mở đầu bằng await khoaChiaSeBatNoPhaiTra( VÔ ĐIỀU KIỆN`);
    const congTrongTx = cuaCong.filter((c) => nam(c, cb));
    if (congTrongTx.length === 0) loi.push(`${o} ghi dòng tiền mà không gọi ${cong}(`);
    else if (congTrongTx[0].getStart() > ds[0].getStart()) loi.push(`${o}: ${cong}( đứng SAU câu ghi dòng ${dong(sf, ds[0])}`);
  }
  return loi;
}

/** Vi phạm của một hàm phụ `HAM_GHI_HO`: export / không còn ghi / được gọi từ hàm chưa khai / bị truyền như giá trị. */
function viPhamGhiHo(src: string, file: string, tenHam: string, daKhai: Set<string>): string[] {
  const sf = sfCua(src, file);
  const ds = timHam(sf, tenHam);
  if (ds.length !== 1) return [`${file}: không thấy đúng một hàm ${tenHam}`];
  const ham = ds[0];
  const loi: string[] = [];
  const coExport =
    (ts.canHaveModifiers(ham) && (ts.getModifiers(ham) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) ||
    moiNut(sf, (n) => ts.isExportSpecifier(n) && (n.propertyName ?? n.name).getText(sf) === tenHam).length > 0;
  if (coExport) loi.push(`${file}#${tenHam}: hàm ghi hộ KHÔNG được export (nơi gọi ngoài file thoát lưới)`);
  const ghiHoKhac = new Set([...ghiHoCuaFile(file)].filter((t) => t !== tenHam));
  if (ghiTrongHam(sf, ham, ghiHoKhac).length === 0) loi.push(`${file}#${tenHam} không còn ghi — gỡ khỏi HAM_GHI_HO`);
  // Tham chiếu tới tên hàm, trừ chính chỗ khai báo (`function x` / `const x = …`).
  const thamChieu = moiNut(
    sf,
    (n) => ts.isIdentifier(n) && n.text === tenHam && tenCuaHam(n.parent) === null && !(ts.isVariableDeclaration(n.parent) && n.parent.name === n)
  );
  const goi = thamChieu.filter((n) => ts.isCallExpression(n.parent) && n.parent.expression === n);
  if (goi.length === 0) loi.push(`${file}#${tenHam}: không còn nơi gọi`);
  if (goi.length !== thamChieu.length) loi.push(`${file}#${tenHam}: bị dùng như giá trị (không phải lời gọi) — lưới không theo được`);
  for (const g of goi) {
    const o = hamChua(g);
    if (!daKhai.has(o)) loi.push(`${file}#${tenHam}: được gọi từ ${o} (dòng ${dong(sf, g)}) chưa khai`);
  }
  return loi;
}

// ── Máy soi hình dạng của ngoại lệ ─────────────────────────────────────────────────────────────

const KIND_CUTOVER = new Set(["CUTOVER_ADJ_IN", "CUTOVER_ADJ_OUT"]);

function thuocTinh(o: ts.Node | undefined, ten: string): ts.Expression | undefined {
  if (o === undefined || !ts.isObjectLiteralExpression(o)) return undefined;
  for (const p of o.properties) {
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === ten) return p.initializer;
  }
  return undefined;
}

/** Mọi giá trị chuỗi có thể của biểu thức: chuỗi, `a ? "X" : "Y"`, `("X" as const)`; dạng khác (biến…) ⇒ null. */
function giaTriChuoi(e: ts.Expression | undefined): string[] | null {
  if (e === undefined) return null;
  if (ts.isStringLiteralLike(e)) return [e.text];
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) return giaTriChuoi(e.expression);
  if (ts.isConditionalExpression(e)) {
    const a = giaTriChuoi(e.whenTrue);
    const b = giaTriChuoi(e.whenFalse);
    return a === null || b === null ? null : [...a, ...b];
  }
  return null;
}

function lenhGhiCuaHam(h: ts.FunctionLikeDeclaration, sf: ts.SourceFile): ts.Node[] {
  return cauGhi(sf).filter((n) => nam(n, h));
}

const tenPhuongThuc = (n: ts.Node) =>
  ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : null;

/** Chỉ `create` dòng `CUTOVER_ADJ_*` (mọi giá trị chuỗi của `kind`) với `date: mocM`. */
function soiChiTaoCutoverNgayM(h: ts.FunctionLikeDeclaration, sf: ts.SourceFile): string | null {
  for (const g of lenhGhiCuaHam(h, sf)) {
    if (tenPhuongThuc(g) !== "create") return `dòng ${dong(sf, g)}: không phải create`;
    const data = thuocTinh((g as ts.CallExpression).arguments[0], "data");
    const kind = giaTriChuoi(thuocTinh(data, "kind"));
    if (kind === null || !kind.every((k) => KIND_CUTOVER.has(k))) return `dòng ${dong(sf, g)}: kind không chỉ là CUTOVER_ADJ_*`;
    const ngay = thuocTinh(data, "date");
    if (ngay === undefined || !ts.isIdentifier(ngay) || ngay.text !== "mocM") return `dòng ${dong(sf, g)}: date không phải mocM`;
  }
  return null;
}

/** Chỉ `updateMany` rào `kind` CUTOVER, `data` chỉ `amount`/`description`. */
function soiChiSuaTienMoTaCutover(h: ts.FunctionLikeDeclaration, sf: ts.SourceFile): string | null {
  for (const g of lenhGhiCuaHam(h, sf)) {
    if (tenPhuongThuc(g) !== "updateMany") return `dòng ${dong(sf, g)}: không phải updateMany`;
    const arg = (g as ts.CallExpression).arguments[0];
    const kind = thuocTinh(thuocTinh(arg, "where"), "kind");
    if (kind === undefined || !kind.getText(sf).includes("KIND_CUTOVER")) return `dòng ${dong(sf, g)}: where không rào kind CUTOVER`;
    const data = thuocTinh(arg, "data");
    if (data === undefined || !ts.isObjectLiteralExpression(data)) return `dòng ${dong(sf, g)}: data không phải object`;
    const khoa = data.properties.map((p) => (p.name !== undefined && ts.isIdentifier(p.name) ? p.name.text : "?"));
    if (!khoa.every((k) => k === "amount" || k === "description")) return `dòng ${dong(sf, g)}: data đổi ngoài amount/description`;
  }
  return null;
}

/** Chỉ `deleteMany()` không điều kiện (xoá toàn bộ bảng). */
function soiChiXoaToanBo(h: ts.FunctionLikeDeclaration, sf: ts.SourceFile): string | null {
  for (const g of lenhGhiCuaHam(h, sf)) {
    if (tenPhuongThuc(g) !== "deleteMany" || (g as ts.CallExpression).arguments.length !== 0) {
      return `dòng ${dong(sf, g)}: không phải deleteMany() toàn bộ`;
    }
  }
  return null;
}

// ── Quét cây ────────────────────────────────────────────────────────────────────────────────────

function moiFileSrc(thuMuc: string): string[] {
  const ra: string[] = [];
  for (const ten of readdirSync(thuMuc)) {
    const day = path.join(thuMuc, ten);
    if (ten === "generated" || ten === "node_modules") continue;
    if (statSync(day).isDirectory()) ra.push(...moiFileSrc(day));
    else if (/\.(ts|tsx)$/.test(ten)) ra.push(day);
  }
  return ra;
}

const KHAI = new Set([
  ...HAM_GOI_CONG.map(([f, h]) => `${f}#${h}`),
  ...Object.keys(HAM_GHI_HO),
  ...Object.keys(NGOAI_LE),
]);

/** `file#hàm` có lệnh ghi trực tiếp dưới `goc/src`, và phần chưa khai. */
function hamGhiLot(goc: string): { ghi: string[]; lot: string[] } {
  const ghi = new Set<string>();
  for (const day of moiFileSrc(path.join(goc, "src"))) {
    const src = readFileSync(day, "utf8");
    if (!/cashMovement|thuNhap|CashMovement|ThuNhap|movements/.test(src)) continue;
    const file = path.relative(goc, day).split(path.sep).join("/");
    for (const n of cauGhi(sfCua(src, file))) ghi.add(`${file}#${hamChua(n)}`);
  }
  const ds = [...ghi].sort();
  return { ghi: ds, lot: ds.filter((k) => !KHAI.has(k)) };
}

const doc = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
const tachKhoa = (k: string) => {
  const i = k.lastIndexOf("#");
  return [k.slice(0, i), k.slice(i + 1)] as const;
};
const daKhaiCuaFile = (file: string) => new Set([...KHAI].filter((k) => k.startsWith(`${file}#`)).map((k) => tachKhoa(k)[1]));

/** Đổi `tu` → `thanh` CHỈ trong thân hàm `tenHam` (theo AST) — hàm khác cùng file giữ nguyên. */
function doiTrongHam(src: string, file: string, tenHam: string, tu: RegExp, thanh: string): string {
  const [h] = timHam(sfCua(src, file), tenHam);
  const a = h.getStart();
  return src.slice(0, a) + src.slice(a, h.end).replace(tu, thanh) + src.slice(h.end);
}

// ── Test ───────────────────────────────────────────────────────────────────────────────────────

describe("đường ghi CashMovement/ThuNhap qua cổng dòng tiền trước M (theo hàm)", () => {
  it("mọi hàm ghi CashMovement/ThuNhap trong src/ đều đã khai (gọi cổng / ghi hộ / ngoại lệ có lý do)", () => {
    const { ghi, lot } = hamGhiLot(ROOT);
    expect(
      lot,
      "Hàm mới ghi CashMovement/ThuNhap: trong transaction mở đầu bằng `await khoaChiaSeBatNoPhaiTra(tx)`, gọi " +
        "`chanDongTienTruocM(tx, …)` TRƯỚC câu ghi, truyền OPT_TX_DONG_TIEN — rồi khai [file, hàm, cổng] vào " +
        "HAM_GOI_CONG; ghi CÓ CHỦ ĐÍCH không qua cổng thì khai NGOAI_LE kèm lý do + máy soi"
    ).toEqual([]);
    // Ngoại lệ phải còn là đường ghi thật — xoá/đổi tên thì gỡ khỏi danh sách.
    for (const k of Object.keys(NGOAI_LE)) expect(ghi, `${k} không còn ghi — gỡ khỏi NGOAI_LE`).toContain(k);
  });

  it.each(HAM_GOI_CONG)("%s#%s gọi %s( — transaction ghi khoá chung câu đầu + OPT_TX_DONG_TIEN", (f, ham, cong) => {
    expect(viPhamGoiCong(doc(f), f, ham, cong)).toEqual([]);
  });

  it.each(Object.keys(HAM_GHI_HO).map((k) => tachKhoa(k)))("%s#%s (ghi hộ) không export, chỉ được gọi từ hàm đã khai", (f, ham) => {
    expect(viPhamGhiHo(doc(f), f, ham, daKhaiCuaFile(f))).toEqual([]);
  });

  it.each(Object.entries(NGOAI_LE).map(([k, v]) => [...tachKhoa(k), v.lyDo] as const))(
    "%s#%s (ngoại lệ) giữ đúng hình dạng câu ghi — %s",
    (f, ham) => {
      const sf = sfCua(doc(f), f);
      const ds = timHam(sf, ham);
      expect(ds, `${f}: không thấy đúng một hàm ${ham}`).toHaveLength(1);
      expect(NGOAI_LE[`${f}#${ham}`].soi(ds[0], sf)).toBeNull();
    }
  );

  it.each(CHUOI_CONG_KHOI_PHUC)("chuỗi cổng khôi phục: %s#%s gọi %s(", (f, ham, goi) => {
    const sf = sfCua(doc(f), f);
    const ds = timHam(sf, ham);
    expect(ds).toHaveLength(1);
    expect(noiGoiCong(sf, ds[0], goi).length, `${f}#${ham} phải gọi ${goi}(`).toBeGreaterThan(0);
  });

  it("khôi phục thùng rác: doTinhTrang( đứng trước vòng dựng lại taoLai(", () => {
    const src = doc("src/lib/thung-rac/khoi-phuc-ban-ghi.ts");
    expect(src.indexOf("await doTinhTrang(")).toBeGreaterThan(-1);
    expect(src.indexOf("await doTinhTrang(")).toBeLessThan(src.indexOf("await taoLai("));
  });

  it("ĐỘT BIẾN: xoá cổng ở MỘT hàm trong khi hàm khác cùng file vẫn gọi ⇒ đỏ đúng hàm đó, hàm khác vẫn xanh", () => {
    for (const [f, ham, cong] of HAM_GOI_CONG) {
      const src = doc(f);
      const sf = sfCua(src, f);
      // Mọi tên "mang" cổng trong thân hàm (cổng + hàm cùng file bọc cổng, vd docLaiVaChanSuaTruocM, traGopSchema).
      const mang = [...new Set(noiGoiCong(sf, timHam(sf, ham)[0], cong).map((c) => (c.expression as ts.Identifier).text))];
      const dotBien = doiTrongHam(src, f, ham, new RegExp(`\\b(${mang.join("|")})\\(`, "g"), "khongCongGi(");
      expect(dotBien, `${f}#${ham}: đột biến phải đổi mã`).not.toBe(src);
      expect(viPhamGoiCong(dotBien, f, ham, cong).length, `${f}#${ham}: bỏ cổng phải bị bắt`).toBeGreaterThan(0);
      for (const [f2, ham2, cong2] of HAM_GOI_CONG.filter(([x, y]) => x === f && y !== ham)) {
        expect(viPhamGoiCong(dotBien, f2, ham2, cong2), `${f2}#${ham2} không bị vạ lây`).toEqual([]);
      }
    }
    // Ca chỉ định của lưới theo hàm: `so-tiet-kiem.ts` bỏ cổng ở xoá sổ, file VẪN còn lời gọi ở tạo/sửa.
    const f = "src/lib/actions/so-tiet-kiem.ts";
    const botXoa = doiTrongHam(doc(f), f, "xoaSoTietKiem", /\bchanDongTienTruocM\(/g, "khongCongGi(");
    expect(botXoa).toMatch(/\bchanDongTienTruocM\(/);
    expect(viPhamGoiCong(botXoa, f, "xoaSoTietKiem", CONG)).toContain(`${f}#xoaSoTietKiem: không gọi ${CONG}( (trong hàm hay hàm cùng file nó gọi trực tiếp)`);
  });

  it("ĐỘT BIẾN: bỏ khoá chung / khoá có điều kiện / bỏ OPT_TX_DONG_TIEN ở hàm gọi cổng trước M ⇒ đỏ", () => {
    for (const [f, ham, cong] of HAM_GOI_CONG.filter(([, , c]) => CONG_CAN_KHOA.has(c))) {
      const src = doc(f);
      const dotBien = {
        botKhoa: doiTrongHam(src, f, ham, /await khoaChiaSeBatNoPhaiTra\(tx\);/g, ""),
        coDieuKien: doiTrongHam(src, f, ham, /await khoaChiaSeBatNoPhaiTra\(tx\);/, "if (laNhap) await khoaChiaSeBatNoPhaiTra(tx);"),
        botOpt: doiTrongHam(src, f, ham, /\bOPT_TX_DONG_TIEN(\s*)\)/g, "undefined$1)"),
      };
      for (const [ten, s] of Object.entries(dotBien)) {
        expect(s, `${f}#${ham}: đột biến ${ten} phải đổi mã`).not.toBe(src);
        expect(viPhamGoiCong(s, f, ham, cong).length, `${f}#${ham}: đột biến ${ten} phải bị bắt`).toBeGreaterThan(0);
      }
    }
  });

  it("ĐỘT BIẾN nguồn giả: cổng ở hàm khác / khoá sau câu khác / có điều kiện / cổng sau câu ghi / ghi ngoài transaction ⇒ đỏ", () => {
    const tx = (than: string, opt = ", OPT_TX_DONG_TIEN") => `  await prisma.$transaction(async (tx) => {\n${than}\n  }${opt});\n`;
    const dung = tx("    await khoaChiaSeBatNoPhaiTra(tx);\n    await chanDongTienTruocM(tx, t);\n    await tx.cashMovement.create({ data });");
    const ham = (ten: string, than: string) => `export async function ${ten}() {\n${than}}\n`;
    expect(viPhamGoiCong(ham("a", dung), "x.ts", "a", CONG, new Set())).toEqual([]);

    const haiHam = ham("a", dung) + ham("b", tx("    await khoaChiaSeBatNoPhaiTra(tx);\n    await tx.thuNhap.deleteMany({ where });"));
    expect(viPhamGoiCong(haiHam, "x.ts", "a", CONG, new Set())).toEqual([]);
    expect(viPhamGoiCong(haiHam, "x.ts", "b", CONG, new Set()).length).toBeGreaterThan(0);

    const sai = {
      sauKhoaThe: tx("    await khoaThe(tx, id);\n    await khoaChiaSeBatNoPhaiTra(tx);\n    await chanDongTienTruocM(tx, t);\n    await tx.cashMovement.create({ data });"),
      coDieuKien: tx("    if (x) await khoaChiaSeBatNoPhaiTra(tx);\n    await chanDongTienTruocM(tx, t);\n    await tx.cashMovement.create({ data });"),
      congSauGhi: tx("    await khoaChiaSeBatNoPhaiTra(tx);\n    await tx.cashMovement.create({ data });\n    await chanDongTienTruocM(tx, t);"),
      thieuOpt: tx("    await khoaChiaSeBatNoPhaiTra(tx);\n    await chanDongTienTruocM(tx, t);\n    await tx.cashMovement.create({ data });", ""),
      ngoaiTx: dung + "  await prisma.cashMovement.delete({ where: { id } });\n",
      congNgoaiTx: "  await chanDongTienTruocM(prisma, t);\n" + tx("    await khoaChiaSeBatNoPhaiTra(tx);\n    await tx.cashMovement.create({ data });"),
      chiChuThich: tx("    await khoaChiaSeBatNoPhaiTra(tx);\n    // await chanDongTienTruocM(tx, t);\n    await tx.cashMovement.create({ data });"),
      txThuHaiKhongCong: dung + tx("    await khoaChiaSeBatNoPhaiTra(tx);\n    await tx.cashMovement.update({ where, data });"),
    };
    for (const [ten, than] of Object.entries(sai)) {
      expect(viPhamGoiCong(ham("a", than), "x.ts", "a", CONG, new Set()).length, `đột biến ${ten} phải bị bắt`).toBeGreaterThan(0);
    }
    // Nhánh 4 kind nợ được miễn khoá chung, nhưng vẫn phải OPT_TX_DONG_TIEN.
    const nhanhNo = (opt: string) =>
      ham("a", `  if (isKindNoPhaiTraGhiTay(data.kind)) {\n${tx("    await tx.cashMovement.create({ data });", opt)}  } else {\n${dung}  }\n`);
    expect(viPhamGoiCong(nhanhNo(", OPT_TX_DONG_TIEN"), "x.ts", "a", CONG, new Set())).toEqual([]);
    expect(viPhamGoiCong(nhanhNo(""), "x.ts", "a", CONG, new Set()).length).toBeGreaterThan(0);
  });

  it("ĐỘT BIẾN: hàm ghi hộ bị export / gọi từ hàm chưa khai / truyền như giá trị ⇒ đỏ", () => {
    const f = "src/lib/actions/cash-movements.ts";
    const src = doc(f);
    const daKhai = daKhaiCuaFile(f);
    expect(viPhamGhiHo(src.replace("async function ghiCoHangRaoCha(", "export async function ghiCoHangRaoCha("), f, "ghiCoHangRaoCha", daKhai).length).toBeGreaterThan(0);
    const goiLa = src + "\nexport async function hamMoi() {\n  await ghiCoHangRaoCha(prisma, id, truoc, data);\n}\n";
    expect(viPhamGhiHo(goiLa, f, "ghiCoHangRaoCha", daKhai).length).toBeGreaterThan(0);
    const giaTri = src + "\nconst chay = [ghiCoHangRaoCha];\n";
    expect(viPhamGhiHo(giaTri, f, "ghiCoHangRaoCha", daKhai).length).toBeGreaterThan(0);
  });

  it("ĐỘT BIẾN: ngoại lệ đổi hình dạng câu ghi ⇒ máy soi đỏ", () => {
    const soi = (src: string, ten: string, k: keyof typeof NGOAI_LE) => {
      const sf = sfCua(src, "x.ts");
      return NGOAI_LE[k].soi(timHam(sf, ten)[0], sf);
    };
    const tao = (data: string) => `async function a() {\n  await tx.cashMovement.create({ data: { ${data} } });\n}`;
    const SUA = "src/lib/actions/sua-tien-truoc-moc.ts#suaSoTienTruocMoc";
    expect(soi(tao('kind: c ? "CUTOVER_ADJ_IN" : "CUTOVER_ADJ_OUT", date: mocM, amount'), "a", SUA)).toBeNull();
    expect(soi(tao('kind: "CUTOVER_ADJ_IN", date: mocM'), "a", SUA)).toBeNull();
    expect(soi(tao('kind: c ? "CUTOVER_ADJ_IN" : "CAPITAL_IN", date: mocM'), "a", SUA)).not.toBeNull();
    expect(soi(tao('kind: "CAPITAL_IN", date: mocM'), "a", SUA)).not.toBeNull();
    expect(soi(tao('kind: k, date: mocM'), "a", SUA)).not.toBeNull();
    expect(soi(tao('kind: "CUTOVER_ADJ_IN", date: ngay'), "a", SUA)).not.toBeNull();
    expect(soi("async function a() {\n  await tx.cashMovement.deleteMany({});\n}", "a", SUA)).not.toBeNull();

    const DC = "src/lib/actions/cash-movements.ts#suaDieuChinhChuyenDoi";
    const sua = (data: string) => `async function a() {\n  await tx.cashMovement.updateMany({ where: { id, kind: { in: [...KIND_CUTOVER] } }, data: { ${data} } });\n}`;
    expect(soi(sua("amount: 1, description: d"), "a", DC)).toBeNull();
    expect(soi(sua("amount: 1, date: d"), "a", DC)).not.toBeNull();
    expect(soi("async function a() {\n  await tx.cashMovement.updateMany({ where: { id }, data: { amount: 1 } });\n}", "a", DC)).not.toBeNull();

    const XOA = "src/lib/actions/data-admin.ts#deleteAllData";
    expect(soi("async function a() {\n  await tx.thuNhap.deleteMany();\n  await tx.cashMovement.deleteMany();\n}", "a", XOA)).toBeNull();
    expect(soi("async function a() {\n  await tx.cashMovement.deleteMany({ where: { date: { lt: m } } });\n}", "a", XOA)).not.toBeNull();
  });

  /**
   * Dạng ghi: mỗi dạng một file tạm trong cây `src/` giả (thư mục tạm hệ điều hành — không chạm `src/` thật) ⇒ lưới
   * coi là hàm lọt. Hàm MỚI dù đã gắn cổng đúng vẫn đỏ vì chưa khai. Dạng đọc KHÔNG được bắt nhầm.
   */
  it("ĐỘT BIẾN: hàm mới / alias / ép phần tử / $executeRaw / SQL thô / ghi lồng quan hệ ⇒ đều bị bắt", () => {
    const ham = (ten: string, than: string) => `export async function ${ten}() {\n  ${than}\n}\n`;
    const dangGhi: Record<string, string> = {
      "ham-moi-co-cong.ts": ham(
        "hamMoi",
        "await prisma.$transaction(async (tx) => {\n    await khoaChiaSeBatNoPhaiTra(tx);\n    await chanDongTienTruocM(tx, t);\n    await tx.cashMovement.create({ data });\n  }, OPT_TX_DONG_TIEN);"
      ),
      "alias-bien.ts": ham("aliasBien", "const c = tx.cashMovement;\n  await c.create({ data: {} });"),
      "alias-pha-cau-truc.ts": ham("aliasPha", "const { thuNhap } = prisma;\n  await thuNhap.upsert({ where: {}, create: {}, update: {} });"),
      "alias-doi-ten.ts": ham("aliasDoiTen", "const { cashMovement: dt } = tx;\n  await dt.deleteMany({ where: {} });"),
      "ep-phan-tu.ts": ham("epPhanTu", 'await tx["cashMovement"].updateMany({ where: {}, data: {} });'),
      "create-many-and-return.ts": ham("taoNhieu", "await db.thuNhap.createManyAndReturn({ data: [] });"),
      "raw-insert.ts": ham("rawInsert", 'await tx.$executeRaw`INSERT INTO "CashMovement" ("id") VALUES (${id})`;'),
      "raw-unsafe.ts": ham("rawUnsafe", 'await prisma.$executeRawUnsafe(`update "ThuNhap" set amount = 1`);'),
      "raw-schema-sql.ts": ham("rawSchema", 'const q = Prisma.sql`DELETE FROM app."CashMovement" WHERE id = ${id}`;\n  await tx.$executeRaw(q);'),
      "long-quan-he.ts": ham("longQuanHe", "await tx.loan.create({ data: { name, movements: { create: [{ date, kind, amount }] } } });"),
      "long-thu-nhap.ts": ham("longThuNhap", "await tx.soTietKiem.update({ where: { id }, data: { thuNhap: { deleteMany: {} } } });"),
      "cap-file.ts": "await prisma.cashMovement.create({ data: {} });\n",
      "method.ts": "export const kho = {\n  async ghi() {\n    await prisma.cashMovement.delete({ where: { id } });\n  },\n};\n",
    };
    const dangDoc: Record<string, string> = {
      "doc.ts": ham("doc", "await prisma.cashMovement.findMany({});\n  const c = tx.thuNhap;\n  await c.findFirst({});"),
      "select.ts": ham("chon", 'await tx.$queryRaw`SELECT 1 FROM "CashMovement" WHERE id = ${id}`;'),
      "enum.ts": ham("enumKind", 'await tx.$executeRaw`ALTER TYPE "CashMovementKind" ADD VALUE \'X\'`;'),
      "loc-quan-he.ts": ham("locQuanHe", "await tx.loan.findMany({ where: { movements: { some: { kind } } }, include: { movements: { where: {} } } });"),
    };
    const goc = mkdtempSync(path.join(os.tmpdir(), "luoi-dong-tien-"));
    try {
      mkdirSync(path.join(goc, "src/gia"), { recursive: true });
      for (const [ten, noiDung] of Object.entries({ ...dangGhi, ...dangDoc })) writeFileSync(path.join(goc, "src/gia", ten), noiDung);
      // File THẬT đã khai + một hàm ghi mới chen vào ⇒ chỉ hàm mới lọt, hàm cũ của file vẫn được nhận.
      const f = "src/lib/actions/so-tiet-kiem.ts";
      mkdirSync(path.dirname(path.join(goc, f)), { recursive: true });
      writeFileSync(path.join(goc, f), doc(f) + "\nexport async function rutBot(id: string) {\n  await prisma.cashMovement.deleteMany({ where: { savingsId: id } });\n}\n");

      const { ghi, lot } = hamGhiLot(goc);
      const mongDoi = [
        "src/gia/ham-moi-co-cong.ts#hamMoi",
        "src/gia/alias-bien.ts#aliasBien",
        "src/gia/alias-pha-cau-truc.ts#aliasPha",
        "src/gia/alias-doi-ten.ts#aliasDoiTen",
        "src/gia/ep-phan-tu.ts#epPhanTu",
        "src/gia/create-many-and-return.ts#taoNhieu",
        "src/gia/raw-insert.ts#rawInsert",
        "src/gia/raw-unsafe.ts#rawUnsafe",
        "src/gia/raw-schema-sql.ts#rawSchema",
        "src/gia/long-quan-he.ts#longQuanHe",
        "src/gia/long-thu-nhap.ts#longThuNhap",
        `src/gia/cap-file.ts#${CAP_FILE}`,
        "src/gia/method.ts#ghi",
        `${f}#rutBot`,
      ].sort();
      expect(lot).toEqual(mongDoi);
      expect(ghi).toEqual(expect.arrayContaining([`${f}#taoSoTietKiem`, `${f}#suaSoTietKiem`, `${f}#xoaSoTietKiem`]));
    } finally {
      rmSync(goc, { recursive: true, force: true });
    }
  });
});
