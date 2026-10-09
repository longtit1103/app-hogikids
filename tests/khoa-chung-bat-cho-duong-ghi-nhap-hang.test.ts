import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * LƯỚI AST — mọi transaction CÓ THỂ ghi `Expense` "Nhập hàng" (`purchase`) giữ khoá SHARED với bước bật nợ
 * phải trả (`khoaChiaSeBatNoPhaiTra`) LÀ CÂU ĐẦU TIÊN, trước cổng `chanNhapHangSauM` và mọi khoá dòng.
 *
 * Ca đua cần chặn: bước bật giữ EXCLUSIVE, kiểm "không còn Nhập hàng ngày ≥ M" rồi ghi Setting M. Đường ghi
 * không giữ khoá chung đọc M = null (bước bật chưa commit), chèn Nhập hàng ngày ≥ M ⇒ bước bật vẫn thành
 * công mà dòng lọt (quỹ trừ hai lần, phiếu Y giải thích sai). Khoá chung đứng SAU khoá dòng thẻ thì khoá
 * chéo với bước bật (nó chèn `KySaoKeThe` cần KEY SHARE trên dòng thẻ đang `FOR UPDATE`) ⇒ phải là câu đầu.
 *
 * Luật soi (AST, không tính chú thích/chuỗi), trên file GIỮ transaction của mỗi đường ghi:
 *  - mọi lời gọi `chanNhapHangSauM(` (hay hàm cổng bọc nó, vd `doTinhTrang`) nằm TRONG callback `$transaction`;
 *  - callback đó có câu ĐẦU là `await khoaChiaSeBatNoPhaiTra(…)` hoặc `if (…) await khoaChiaSeBatNoPhaiTra(…)`
 *    (dạng có điều kiện: chỉ khi biết chắc trước transaction là danh mục Nhập hàng).
 * Hành vi thật (chờ khoá rồi từ chối) khoá bằng `tests/unit/no-phai-tra/khe-dua-nhap-hang-va-buoc-bat.integration.test.ts`.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** File gọi cổng ⇒ file giữ transaction + tên hàm cổng được gọi TRONG transaction đó. */
const DUONG_GHI_NHAP_HANG: Record<string, { giuTx: string; cong: string }> = {
  "src/lib/actions/expenses.ts": { giuTx: "src/lib/actions/expenses.ts", cong: "chanNhapHangSauM" },
  "src/lib/actions/chi-phi-nhap-hang.ts": { giuTx: "src/lib/actions/chi-phi-nhap-hang.ts", cong: "chanNhapHangSauM" },
  "src/lib/expenses/ensure-recurring-expenses.ts": {
    giuTx: "src/lib/expenses/ensure-recurring-expenses.ts",
    cong: "chanNhapHangSauM",
  },
  // Cổng nằm ở helper `doTinhTrang`; transaction (và khoá) ở `khoiPhucBanGhiDaXoa`.
  "src/lib/thung-rac/do-tinh-trang-khoi-phuc.ts": { giuTx: "src/lib/thung-rac/khoi-phuc-ban-ghi.ts", cong: "doTinhTrang" },
};

/** Gọi `chanNhapHangSauM` nhưng KHÔNG BAO GIỜ ghi Nhập hàng — mỗi dòng một lý do (kiểm bằng máy bên dưới). */
const CHI_GHI_ADS: Record<string, string> = {
  "src/lib/actions/ads-import.ts": "import file ads — chỉ ghi danh mục ads (`ADS_CATEGORY_ID`)",
  "src/lib/ingest/ads-expense-upsert.ts": "cửa máy ADS_API — chỉ ghi danh mục ads (`ADS_CATEGORY_ID`)",
};

const doc = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
const sf = (src: string, ten: string) => ts.createSourceFile(ten, src, ts.ScriptTarget.Latest, true);

function laGoi(n: ts.Node, ten: string): n is ts.CallExpression {
  return ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === ten;
}

function moiNut(goc: ts.Node, loc: (n: ts.Node) => boolean): ts.Node[] {
  const ra: ts.Node[] = [];
  const di = (n: ts.Node) => {
    if (loc(n)) ra.push(n);
    ts.forEachChild(n, di);
  };
  di(goc);
  return ra;
}

/** Callback (thân khối) truyền vào `<x>.$transaction(…)`. */
function callbackTransaction(goc: ts.Node): (ts.ArrowFunction | ts.FunctionExpression)[] {
  return moiNut(goc, (n) => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "$transaction")
    .map((n) => (n as ts.CallExpression).arguments[0])
    .filter((a): a is ts.ArrowFunction | ts.FunctionExpression => a !== undefined && (ts.isArrowFunction(a) || ts.isFunctionExpression(a)));
}

/** Câu `await khoaChiaSeBatNoPhaiTra(…)`. */
function laCauKhoa(c: ts.Statement | undefined): boolean {
  return (
    c !== undefined &&
    ts.isExpressionStatement(c) &&
    ts.isAwaitExpression(c.expression) &&
    laGoi(c.expression.expression, "khoaChiaSeBatNoPhaiTra")
  );
}

/** Câu đầu là khoá, hoặc `if (…) <khoá>` / `if (…) { <khoá>; … }`. */
function cauDauLaKhoa(fn: ts.ArrowFunction | ts.FunctionExpression): boolean {
  if (!ts.isBlock(fn.body)) return false;
  const dau = fn.body.statements[0];
  if (laCauKhoa(dau)) return true;
  if (dau !== undefined && ts.isIfStatement(dau) && dau.elseStatement === undefined) {
    const t = dau.thenStatement;
    return ts.isBlock(t) ? laCauKhoa(t.statements[0]) : laCauKhoa(t);
  }
  return false;
}

/** Vi phạm của MỘT file giữ transaction: danh sách câu mô tả, rỗng = đạt. */
function viPham(src: string, ten: string, cong: string): string[] {
  const goc = sf(src, ten);
  const loi: string[] = [];
  const goiCong = moiNut(goc, (n) => laGoi(n, cong));
  if (goiCong.length === 0) loi.push(`${ten}: không thấy lời gọi ${cong}(`);
  const cbs = callbackTransaction(goc);
  for (const g of goiCong) {
    const chua = cbs.filter((cb) => g.pos >= cb.pos && g.end <= cb.end);
    if (chua.length === 0) {
      loi.push(`${ten}: ${cong}( ở dòng ${goc.getLineAndCharacterOfPosition(g.getStart()).line + 1} nằm NGOÀI $transaction`);
      continue;
    }
    // Callback trong cùng (gần nhất) là transaction thật của lời gọi.
    const gan = chua.reduce((a, b) => (b.pos >= a.pos ? b : a));
    if (!cauDauLaKhoa(gan)) {
      loi.push(
        `${ten}: transaction chứa ${cong}( (dòng ${goc.getLineAndCharacterOfPosition(gan.getStart()).line + 1}) không mở đầu bằng await khoaChiaSeBatNoPhaiTra(`
      );
    }
  }
  return loi;
}

/** Mọi lời gọi `chanNhapHangSauM` của file chỉ truyền `categoryId: ADS_CATEGORY_ID`. */
function chiGoiVoiDanhMucAds(src: string, ten: string): boolean {
  const goi = moiNut(sf(src, ten), (n) => laGoi(n, "chanNhapHangSauM")) as ts.CallExpression[];
  return (
    goi.length > 0 &&
    goi.every((g) => {
      const d = g.arguments[1];
      if (d === undefined || !ts.isObjectLiteralExpression(d)) return false;
      const p = d.properties.find((x) => ts.isPropertyAssignment(x) && ts.isIdentifier(x.name) && x.name.text === "categoryId");
      return p !== undefined && ts.isPropertyAssignment(p) && ts.isIdentifier(p.initializer) && p.initializer.text === "ADS_CATEGORY_ID";
    })
  );
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

describe("đường ghi Nhập hàng giữ khoá chung với bước bật (câu đầu transaction)", () => {
  it("mọi file gọi chanNhapHangSauM( đều được phân loại: ghi Nhập hàng (phải khoá) hoặc chỉ ads (lý do)", () => {
    const goi = moiFileSrc(path.join(ROOT, "src"))
      .map((f) => path.relative(ROOT, f).split(path.sep).join("/"))
      .filter((f) => f !== "src/lib/no-phai-tra/chan-nhap-hang-sau-m.ts")
      .filter((f) => moiNut(sf(doc(f), f), (n) => laGoi(n, "chanNhapHangSauM")).length > 0)
      .sort();
    expect(goi, "File mới gọi cổng Nhập hàng: khai vào DUONG_GHI_NHAP_HANG (và giữ khoá) hoặc CHI_GHI_ADS").toEqual(
      [...Object.keys(DUONG_GHI_NHAP_HANG), ...Object.keys(CHI_GHI_ADS)].sort()
    );
  });

  it.each(Object.entries(DUONG_GHI_NHAP_HANG))("%s ⇒ transaction mở đầu bằng khoaChiaSeBatNoPhaiTra(", (_f, { giuTx, cong }) => {
    expect(viPham(doc(giuTx), giuTx, cong)).toEqual([]);
  });

  it.each(Object.entries(CHI_GHI_ADS))("%s chỉ gọi cổng với danh mục ads (ngoại lệ: %s)", (f) => {
    expect(chiGoiVoiDanhMucAds(doc(f), f), `${f} gọi chanNhapHangSauM với danh mục khác ads ⇒ phải giữ khoá chung`).toBe(true);
  });

  it("ĐỘT BIẾN: bỏ khoá ở bất kỳ file giữ transaction nào ⇒ lưới đỏ", () => {
    for (const { giuTx, cong } of Object.values(DUONG_GHI_NHAP_HANG)) {
      const botKhoa = doc(giuTx).replace(/khoaChiaSeBatNoPhaiTra\(/g, "khongKhoaGi(");
      expect(viPham(botKhoa, giuTx, cong).length, `đột biến bỏ khoá ở ${giuTx} phải bị bắt`).toBeGreaterThan(0);
    }
  });

  it("ĐỘT BIẾN: khoá đứng SAU câu khác, cổng ngoài transaction, khoá chỉ trong chú thích ⇒ đều bị bắt", () => {
    const sauKhoaThe =
      "await prisma.$transaction(async (tx) => {\n  await khoaThe(tx, id);\n  await khoaChiaSeBatNoPhaiTra(tx);\n  await chanNhapHangSauM(tx, d);\n});";
    const ngoaiTx = "await khoaChiaSeBatNoPhaiTra(tx);\nawait chanNhapHangSauM(prisma, d);";
    const chuThich = "await prisma.$transaction(async (tx) => {\n  // await khoaChiaSeBatNoPhaiTra(tx);\n  await chanNhapHangSauM(tx, d);\n});";
    for (const src of [sauKhoaThe, ngoaiTx, chuThich]) expect(viPham(src, "x.ts", "chanNhapHangSauM").length).toBeGreaterThan(0);
    const dung = "await prisma.$transaction(async (tx) => {\n  if (d.categoryId === 'purchase') await khoaChiaSeBatNoPhaiTra(tx);\n  await chanNhapHangSauM(tx, d);\n});";
    expect(viPham(dung, "x.ts", "chanNhapHangSauM")).toEqual([]);
    expect(chiGoiVoiDanhMucAds("await chanNhapHangSauM(tx, { categoryId: 'purchase', date });", "x.ts")).toBe(false);
  });
});
