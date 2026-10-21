import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * LƯỚI AST — đã bật nợ phải trả (M ≠ null) thì SỔ CHI PHÍ KHOÁ ở mọi đường ghi tay (`chan-so-chi-phi-da-khoa.ts`):
 * "Nhập hàng" mọi ngày + MỌI danh mục ngày < M (chỉ còn đổi danh mục/mô tả/kênh khi giữ tiền). Từ M tiền hàng đi
 * DUY NHẤT `PhieuNhapNo` + `SUPPLIER_PAY` (quên cổng là trừ quỹ HAI lần cho cùng lô); trước M quỹ cuối M−1 đã chốt
 * theo tiền thật bằng điều chỉnh mở sổ (quên cổng ở đường thêm/sửa/XOÁ dòng trước M — danh mục nào cũng vậy — là
 * quỹ từ M lệch khỏi tiền thật) — cả hai không test số nào đỏ.
 *
 * Hai lớp (khuôn `khoa-bao-tri-duong-ghi.test.ts`):
 *  1. DANH SÁCH CỐ ĐỊNH các đường ghi phải GỌI `chanSoChiPhiDaKhoa(` (lời gọi thật trong AST, không tính
 *     chữ trong chú thích).
 *  2. Quét toàn `src/`: file nào ghi `Expense` mà KHÔNG nằm trong danh sách hay ngoại lệ có lý do ⇒ đỏ —
 *     đường ghi mới không thể lọt lưới vì quên khai. "Ghi" = (a) `.expense.<create|createMany|
 *     createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany>(`; (b) SQL thô
 *     `INSERT INTO` / `UPDATE` / `DELETE FROM` bảng `"Expense"` (mọi `$executeRaw*`/`$queryRaw*`, không phân
 *     biệt hoa thường); (c) GHI QUA ALIAS (AST): `const e = tx.expense` hay `const { expense } = tx` rồi
 *     `e.create(` / `expense.upsert(` / `e.delete(`. XOÁ cũng là ghi: xoá dòng trước M đổi quỹ đã chốt.
 *     Giới hạn còn lại (chấp nhận): alias qua nhiều tầng (truyền delegate vào hàm khác, gán lại biến), tên
 *     bảng ghép chuỗi động — không có trong `src/` hôm nay; đường đó phải tự khai ở danh sách trên.
 *
 * Lệch spec (ghi vào báo cáo S1): spec liệt kê `src/lib/import/ads-csv.ts` — đó là bộ PARSE thuần, không
 * chạm DB, không ghi gì; đường ghi thật của cửa máy là `ingest/ads-expense-upsert.ts` nên nó thế chỗ.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DUONG_GHI_PHAI_GOI_CONG = [
  "src/lib/actions/expenses.ts", // tạo / sửa / xoá tay (mọi danh mục; "Xoá và dừng lặp lại"; bật lại mẫu)
  "src/lib/actions/chi-phi-nhap-hang.ts", // màn duyệt phiếu nhập ⇒ Expense purchase
  "src/lib/expenses/ensure-recurring-expenses.ts", // bộ sinh định kỳ (đã bật ⇒ bỏ lần < M mọi mẫu + mẫu Nhập hàng)
  "src/lib/thung-rac/do-tinh-trang-khoi-phuc.ts", // khôi phục thùng rác (cổng của khoi-phuc-ban-ghi.ts)
] as const;

/**
 * Chỉ ghi danh mục quảng cáo — ngoại lệ có chủ đích của cổng (lý do ở `NGOAI_LE`); máy soi: MỌI thuộc tính
 * `categoryId:` trong file đều là `ADS_CATEGORY_ID` (đổi danh mục ở đây ⇒ lưới đỏ, phải đi qua cổng).
 */
const CHI_GHI_ADS = ["src/lib/actions/ads-import.ts", "src/lib/ingest/ads-expense-upsert.ts"] as const;

/**
 * File GHI Expense nhưng không qua cổng — mỗi dòng một lý do. Thêm vào đây là quyết định có chủ ý.
 */
const NGOAI_LE: Record<string, string> = {
  "src/lib/ingest/ads-expense-upsert.ts":
    "cửa máy ADS_API tự động — chủ shop chốt 12/10 giữ nguyên: số nền tảng tự báo (và chốt lại ngày cũ), chặn ngày " +
    "< M là Lãi/Lỗ thiếu chi phí ads thật; chỉ ghi danh mục ads (CHI_GHI_ADS)",
  "src/lib/actions/ads-import.ts":
    "import file ads THỦ CÔNG — lọc dòng < M (laNgayTruocMocM) sau khoá chung, không ghi/xoá dòng < M (chủ shop chốt " +
    "bỏ dòng + báo số, không từ chối cả file như cổng); khoá chung câu đầu + lọc M khoá ở `DUONG_LOC_TRUOC_M` của " +
    "`khoa-chung-bat-cho-duong-ghi-nhap-hang.test.ts`; chỉ ghi danh mục ads (CHI_GHI_ADS)",
  "src/lib/actions/khoan-vay.ts":
    "chỉ ghi danh mục Lãi vay (`interest`), đi CÙNG ngày với `CashMovement` trả gốc của kỳ — ngày < M bị chặn bằng " +
    "`chanDongTienTruocM` (lưới `khoa-duong-ghi-dong-tien-truoc-m`; LAI_VAY_QUA_CONG_DONG_TIEN)",
  "src/lib/actions/tat-toan-thau-chi.ts":
    "chỉ ghi danh mục Lãi vay (`interest`), đi CÙNG ngày với `CashMovement` tất toán — ngày < M bị chặn bằng " +
    "`chanDongTienTruocM` (lưới `khoa-duong-ghi-dong-tien-truoc-m`; LAI_VAY_QUA_CONG_DONG_TIEN)",
  "src/lib/thung-rac/khoi-phuc-ban-ghi.ts": "cổng nằm ở `doTinhTrang` (do-tinh-trang-khoi-phuc.ts) gọi trước câu ghi",
  "src/lib/actions/sua-tien-truoc-moc.ts":
    "lối sửa số tiền dòng < M DUY NHẤT (chủ shop) — cổng từ chối mọi đổi số tiền < M vì quỹ cuối M−1 đã chốt; lối này " +
    "TỰ BÙ: cùng transaction thêm `CUTOVER_ADJ_*` ±Δ ngày M (dòng ≥ ngày mở sổ) nên quỹ từ M không đổi; không đổi " +
    "ngày/thẻ/danh mục; loại Nhập hàng + refId phiếu nhập, ADS_API, lãi vay `LOAN:`, dòng có thẻ; khoá chung " +
    "câu đầu + đọc M/D0 trong transaction khoá ở `DUONG_BU_CUTOVER` của `khoa-chung-bat-cho-duong-ghi-nhap-hang.test.ts`",
  "src/lib/actions/data-admin.ts":
    "xoá TOÀN BỘ dữ liệu giao dịch (thao tác quản trị) — cùng transaction xoá luôn mốc bật M, sổ quỹ, điều chỉnh " +
    "mở sổ và hồ sơ nợ, nên không còn số dư đã chốt nào để lệch",
};

/**
 * Ngoại lệ Expense lãi vay: lãi luôn CÙNG ngày với dòng gốc của kỳ / tất toán, nên ngày < M bị chặn ở cổng dòng tiền
 * `chanDongTienTruocM` (hàm nào gọi, khoá câu đầu ra sao: lưới `khoa-duong-ghi-dong-tien-truoc-m.test.ts`).
 */
const LAI_VAY_QUA_CONG_DONG_TIEN = ["src/lib/actions/khoan-vay.ts", "src/lib/actions/tat-toan-thau-chi.ts"] as const;

/** Có LỜI GỌI `tenCong(...)` thật trong mã (AST), không tính chú thích/chuỗi. */
function coGoiCong(src: string, tenFile = "x.ts", tenCong = "chanSoChiPhiDaKhoa"): boolean {
  const sf = ts.createSourceFile(tenFile, src, ts.ScriptTarget.Latest, true);
  let co = false;
  const di = (n: ts.Node) => {
    if (co) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === tenCong) {
      co = true;
      return;
    }
    ts.forEachChild(n, di);
  };
  di(sf);
  return co;
}

/** Mọi thuộc tính `categoryId: …` của file (AST) đều là định danh `ADS_CATEGORY_ID`; có ít nhất một. */
function chiDanhMucAds(src: string, tenFile = "x.ts"): boolean {
  const sf = ts.createSourceFile(tenFile, src, ts.ScriptTarget.Latest, true);
  const giaTri: string[] = [];
  const di = (n: ts.Node) => {
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === "categoryId") giaTri.push(n.initializer.getText(sf));
    if (ts.isShorthandPropertyAssignment(n) && n.name.text === "categoryId") giaTri.push("categoryId");
    ts.forEachChild(n, di);
  };
  di(sf);
  return giaTri.length > 0 && giaTri.every((g) => g === "ADS_CATEGORY_ID");
}

const PHUONG_THUC_GHI = [
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
] as const;

/** (a) gọi thẳng delegate `.expense.<ghi>(`. */
const GHI_TRUC_TIEP = new RegExp(`\\.expense\\.(${PHUONG_THUC_GHI.join("|")})\\(`);
/** (b) SQL thô ghi bảng Expense — cả `"app"."Expense"`; `"ExpenseCategory"` không khớp (dấu nháy đóng). */
const GHI_SQL_THO = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:"?app"?\s*\.\s*)?"Expense"/i;

/** (c) ghi qua ALIAS của delegate `expense` (AST): `const e = x.expense` / `const { expense } = x`. */
function ghiQuaAlias(src: string, tenFile: string): boolean {
  const sf = ts.createSourceFile(tenFile, src, ts.ScriptTarget.Latest, true);
  const alias = new Set<string>();
  const thuAlias = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const init = n.initializer;
      if (ts.isIdentifier(n.name) && ts.isPropertyAccessExpression(init) && init.name.text === "expense") {
        alias.add(n.name.text);
      }
      if (ts.isObjectBindingPattern(n.name)) {
        for (const el of n.name.elements) {
          const goc = el.propertyName ?? el.name;
          if (ts.isIdentifier(goc) && goc.text === "expense" && ts.isIdentifier(el.name)) alias.add(el.name.text);
        }
      }
    }
    ts.forEachChild(n, thuAlias);
  };
  thuAlias(sf);
  if (alias.size === 0) return false;
  let co = false;
  const timGoi = (n: ts.Node) => {
    if (co) return;
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      alias.has(n.expression.expression.text) &&
      (PHUONG_THUC_GHI as readonly string[]).includes(n.expression.name.text)
    ) {
      co = true;
      return;
    }
    ts.forEachChild(n, timGoi);
  };
  timGoi(sf);
  return co;
}

/** File có ghi bảng `Expense` theo bất kỳ dạng nào ở (a)(b)(c). */
function ghiExpense(src: string, tenFile = "x.ts"): boolean {
  return GHI_TRUC_TIEP.test(src) || GHI_SQL_THO.test(src) || ghiQuaAlias(src, tenFile);
}

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

const doc = (f: string) => readFileSync(path.join(ROOT, f), "utf8");

/** Đường ghi Expense dưới `goc/src` chưa khai (không trong danh sách, không ngoại lệ). Path tương đối `goc`. */
function duongGhiLot(goc: string): { ghi: string[]; lot: string[] } {
  const ghi = moiFileSrc(path.join(goc, "src"))
    .map((f) => path.relative(goc, f).split(path.sep).join("/"))
    .filter((f) => ghiExpense(readFileSync(path.join(goc, f), "utf8"), f));
  const lot = ghi.filter((f) => !(DUONG_GHI_PHAI_GOI_CONG as readonly string[]).includes(f) && !(f in NGOAI_LE));
  return { ghi, lot };
}

describe("đường ghi Expense gọi cổng khoá sổ chi phí khi đã bật", () => {
  it.each(DUONG_GHI_PHAI_GOI_CONG.map((f) => [f] as const))("%s gọi chanSoChiPhiDaKhoa(", (f) => {
    expect(coGoiCong(doc(f), f), `${f} phải gọi chanSoChiPhiDaKhoa( trước câu ghi Expense`).toBe(true);
  });

  it.each(CHI_GHI_ADS.map((f) => [f] as const))("%s (ngoại lệ) chỉ ghi danh mục ads", (f) => {
    expect(f in NGOAI_LE).toBe(true);
    expect(chiDanhMucAds(doc(f), f), `${f} ghi danh mục khác ads ⇒ phải đi qua cổng khoá sổ`).toBe(true);
  });

  it.each(LAI_VAY_QUA_CONG_DONG_TIEN.map((f) => [f] as const))("%s (ngoại lệ lãi vay) gọi chanDongTienTruocM(", (f) => {
    expect(f in NGOAI_LE).toBe(true);
    expect(coGoiCong(doc(f), f, "chanDongTienTruocM"), `${f} phải chặn ngày < M bằng chanDongTienTruocM(`).toBe(true);
    const botCong = doc(f).replace(/chanDongTienTruocM\(/g, "khongCongGi(");
    expect(coGoiCong(botCong, f, "chanDongTienTruocM"), `đột biến bỏ cổng ở ${f} phải bị bắt`).toBe(false);
  });

  it("ĐỘT BIẾN: file ads ghi danh mục khác / dạng rút gọn ⇒ máy soi đỏ", () => {
    expect(chiDanhMucAds("await tx.expense.create({ data: { categoryId: ADS_CATEGORY_ID } });")).toBe(true);
    expect(chiDanhMucAds("await tx.expense.create({ data: { categoryId: 'fixed' } });")).toBe(false);
    expect(chiDanhMucAds("await tx.expense.create({ data: { categoryId: ADS_CATEGORY_ID } });\nconst x = { categoryId };")).toBe(false);
    expect(chiDanhMucAds("const x = 1;")).toBe(false);
  });

  it("mọi file ghi Expense trong src/ đều thuộc danh sách hoặc ngoại lệ có lý do", () => {
    const { ghi, lot } = duongGhiLot(ROOT);
    expect(lot, "Đường ghi Expense mới: gọi chanSoChiPhiDaKhoa( rồi khai vào DUONG_GHI_PHAI_GOI_CONG").toEqual([]);
    // Ngoại lệ phải còn là đường ghi thật — xoá file/đổi tên thì gỡ khỏi danh sách.
    for (const f of Object.keys(NGOAI_LE)) expect(ghi, `${f} không còn ghi Expense — gỡ khỏi NGOAI_LE`).toContain(f);
  });

  it("khôi phục thùng rác dựng lại Expense SAU `doTinhTrang` (nơi giữ cổng)", () => {
    const src = doc("src/lib/thung-rac/khoi-phuc-ban-ghi.ts");
    expect(src.indexOf("await doTinhTrang(")).toBeGreaterThan(-1);
    expect(src.indexOf("await doTinhTrang(")).toBeLessThan(src.indexOf("await taoLai(tx, banGhi)"));
  });

  it("ĐỘT BIẾN: bỏ lời gọi ở bất kỳ file nào trong danh sách ⇒ lưới đỏ; chỉ còn trong chú thích ⇒ vẫn đỏ", () => {
    for (const f of DUONG_GHI_PHAI_GOI_CONG) {
      const src = doc(f);
      const botGoi = src.replace(/chanSoChiPhiDaKhoa\(/g, "khongGoiGi(");
      expect(coGoiCong(botGoi, f), `đột biến ở ${f} phải bị bắt`).toBe(false);
    }
    expect(coGoiCong("// await chanSoChiPhiDaKhoa(tx, d)\nconst x = 'chanSoChiPhiDaKhoa(';")).toBe(false);
  });

  /**
   * ĐỘT BIẾN dạng ghi: mỗi dạng một FILE TẠM trong cây `src/` giả (thư mục tạm của hệ điều hành — không
   * chạm `src/` thật, không đụng test song song) ⇒ lưới phải coi là đường ghi lọt. Dạng đọc (findMany,
   * `"ExpenseCategory"`, `SELECT … FROM "Expense"`) KHÔNG được bắt nhầm.
   */
  it("ĐỘT BIẾN: createManyAndReturn / upsert / delete / alias / $executeRaw INSERT|UPDATE|DELETE \"Expense\" ⇒ đều bị bắt", () => {
    const dangGhi: Record<string, string> = {
      "create-many-and-return.ts": "await prisma.expense.createManyAndReturn({ data: [] });",
      "update-many-and-return.ts": "await tx.expense.updateManyAndReturn({ where: {}, data: {} });",
      "upsert.ts": "await db.expense.upsert({ where: { id }, create: {}, update: {} });",
      "alias-bien.ts": "const e = tx.expense;\nawait e.create({ data: {} });",
      "alias-pha-cau-truc.ts": "const { expense } = prisma;\nawait expense.upsert({ where: {}, create: {}, update: {} });",
      "alias-doi-ten.ts": "const { expense: chiPhi } = tx;\nawait chiPhi.updateMany({ where: {}, data: {} });",
      "raw-insert.ts": 'await tx.$executeRaw`INSERT INTO "Expense" ("id") VALUES (${id})`;',
      "raw-update.ts": "await tx.$executeRaw`UPDATE \"Expense\" SET \"categoryId\" = 'purchase'`;",
      "raw-unsafe-thuong.ts": 'await prisma.$executeRawUnsafe(`update "Expense" set amount = 1`);',
      "raw-schema.ts": 'await tx.$executeRaw`INSERT INTO app."Expense" ("id") VALUES (${id})`;',
      "delete.ts": "await tx.expense.delete({ where: { id } });",
      "delete-many.ts": "await prisma.expense.deleteMany({ where: { categoryId: 'purchase' } });",
      "alias-delete.ts": "const e = tx.expense;\nawait e.delete({ where: { id } });",
      "raw-delete.ts": 'await tx.$executeRaw`DELETE FROM "Expense" WHERE id = ${id}`;',
    };
    const dangDoc: Record<string, string> = {
      "doc.ts": "await prisma.expense.findMany({});\nconst e = tx.expense;\nawait e.findFirst({});",
      "danh-muc.ts": 'await tx.$executeRaw`UPDATE "ExpenseCategory" SET name = ${ten}`;',
      "select.ts": 'await tx.$queryRaw`SELECT 1 FROM "Expense" WHERE id = ${id}`;',
    };
    const goc = mkdtempSync(path.join(os.tmpdir(), "luoi-nhap-hang-"));
    try {
      mkdirSync(path.join(goc, "src/gia"), { recursive: true });
      for (const [ten, noiDung] of Object.entries({ ...dangGhi, ...dangDoc })) {
        writeFileSync(path.join(goc, "src/gia", ten), noiDung);
      }
      const { lot } = duongGhiLot(goc);
      expect(lot.sort()).toEqual(Object.keys(dangGhi).map((t) => `src/gia/${t}`).sort());
    } finally {
      rmSync(goc, { recursive: true, force: true });
    }
  });
});
