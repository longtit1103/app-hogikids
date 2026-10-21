import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * LƯỚI AST — mọi transaction ghi `Expense` qua cổng khoá sổ chi phí (`chanSoChiPhiDaKhoa`) giữ khoá SHARED với bước
 * bật nợ phải trả (`khoaChiaSeBatNoPhaiTra`) LÀ CÂU ĐẦU TIÊN, trước cổng và mọi khoá dòng.
 *
 * Ca đua cần chặn: bước bật giữ EXCLUSIVE, kiểm "không còn Nhập hàng ngày ≥ M", chốt quỹ cuối M−1 bằng điều
 * chỉnh mở sổ rồi ghi Setting M. Đường ghi không giữ khoá chung đọc M = null (bước bật chưa commit) rồi
 * thêm/sửa/xoá sau lưng nó ⇒ bước bật vẫn thành công mà dòng lọt (Nhập hàng ngày ≥ M: quỹ trừ hai lần; dòng BẤT
 * KỲ ngày < M: quỹ lệch điều chỉnh vừa chốt). Khoá chung đứng SAU khoá dòng thẻ thì khoá chéo với bước bật (nó chèn
 * `KySaoKeThe` cần KEY SHARE trên dòng thẻ đang `FOR UPDATE`) ⇒ phải là câu đầu.
 *
 * Luật soi (AST, không tính chú thích/chuỗi), trên file GIỮ transaction của mỗi đường ghi:
 *  - mọi lời gọi `chanSoChiPhiDaKhoa(` (hay hàm cổng bọc nó, vd `doTinhTrang`) nằm TRONG callback `$transaction`;
 *  - callback đó có câu ĐẦU là `await khoaChiaSeBatNoPhaiTra(…)` (dạng `if (…) await …` chỉ còn hợp lệ ở hàm bật lại
 *    mẫu — không ghi Expense);
 *  - transaction đó truyền `OPT_TX_DONG_TIEN` (timeout chừa đủ ngân sách 10s chờ khoá chung; mặc định 5s của
 *    Prisma cắt ngang lời hứa "chờ tối đa 10 giây");
 *  - hàm GHI Expense (`DUONG_KHOA_VO_DIEU_KIEN`): MỌI transaction trong hàm mở đầu bằng khoá VÔ ĐIỀU KIỆN — luật
 *    "trước M" áp MỌI danh mục, nên không còn ca "biết chắc không chạm sổ đã khoá" trước khi đọc M;
 *  - hàm bật lại mẫu định kỳ (`DUONG_BAT_MAU_NHAP_HANG`) đổi tập mẫu Nhập hàng đang chạy mà bước bật kiểm ⇒
 *    MỌI transaction trong hàm mở đầu bằng khoá (được phép `if` mẫu Nhập hàng), CÓ gọi cổng và truyền
 *    `OPT_TX_DONG_TIEN`;
 *  - hàm ghi Expense LỌC dòng < M thay vì gọi cổng (`DUONG_LOC_TRUOC_M`, import file ads): khoá vô điều kiện câu
 *    đầu, đọc M trong transaction sau khoá, gọi hàm lọc dựa trên `laNgayTruocMocM`.
 *  - hàm ĐỔI số tiền dòng < M kèm BÙ điều chỉnh mở sổ thay vì gọi cổng (`DUONG_BU_CUTOVER`, lối "Sửa số tiền trước
 *    mốc"): khoá vô điều kiện câu đầu, đọc M và ngày mở sổ D0 trong transaction sau khoá, ghi dòng bù trong CÙNG
 *    transaction, truyền `OPT_TX_DONG_TIEN`.
 * Lưới không soi BIỂU THỨC điều kiện của `if (…)` (đảo/hẹp điều kiện vẫn qua AST) — phần đó do test hành vi giữ.
 * Hành vi thật (chờ khoá rồi từ chối) khoá bằng `tests/unit/no-phai-tra/khe-dua-nhap-hang-va-buoc-bat.integration.test.ts`.
 */

/** Tên hàm cổng khoá sổ chi phí. */
const CONG = "chanSoChiPhiDaKhoa";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** File gọi cổng ⇒ file giữ transaction + tên hàm cổng được gọi TRONG transaction đó. */
const DUONG_GHI_NHAP_HANG: Record<string, { giuTx: string; cong: string }> = {
  "src/lib/actions/expenses.ts": { giuTx: "src/lib/actions/expenses.ts", cong: CONG },
  "src/lib/actions/chi-phi-nhap-hang.ts": { giuTx: "src/lib/actions/chi-phi-nhap-hang.ts", cong: CONG },
  "src/lib/expenses/ensure-recurring-expenses.ts": { giuTx: "src/lib/expenses/ensure-recurring-expenses.ts", cong: CONG },
  // Cổng nằm ở helper `doTinhTrang`; transaction (và khoá) ở `khoiPhucBanGhiDaXoa`.
  "src/lib/thung-rac/do-tinh-trang-khoi-phuc.ts": { giuTx: "src/lib/thung-rac/khoi-phuc-ban-ghi.ts", cong: "doTinhTrang" },
};

/**
 * Đổi tập "mẫu định kỳ Nhập hàng đang chạy" mà bước bật kiểm (`CON_MAU_DINH_KY_NHAP_HANG`) ⇒ mọi transaction
 * trong hàm mở đầu bằng khoá chung, gọi cổng `chanSoChiPhiDaKhoa`, truyền `OPT_TX_DONG_TIEN` (file → tên hàm).
 * Hành vi thật: ca (5)(6)(7) của `khe-dua-nhap-hang-va-buoc-bat.integration.test.ts`.
 */
const DUONG_BAT_MAU_NHAP_HANG: Record<string, string> = {
  "src/lib/actions/expenses.ts": "batLaiDinhKy",
};

/**
 * Hàm GHI Expense qua cổng: luật "trước M" áp mọi danh mục (và sửa/xoá còn xét bản đọc lại sau khoá — danh mục /
 * ngày cũ đọc ngoài transaction có thể đã cũ) ⇒ MỌI transaction trong hàm mở đầu bằng khoá chung VÔ ĐIỀU KIỆN
 * (không `if`), gọi cổng (`cong`) và truyền `OPT_TX_DONG_TIEN`. Hành vi thật: ca (8)(9)(14)(15) của
 * `khe-dua-nhap-hang-va-buoc-bat.integration.test.ts`. [file, tên hàm, cổng gọi trong transaction].
 */
const DUONG_KHOA_VO_DIEU_KIEN: [string, string, string][] = [
  ["src/lib/actions/expenses.ts", "createExpense", CONG],
  ["src/lib/actions/expenses.ts", "updateExpense", CONG],
  ["src/lib/actions/expenses.ts", "deleteExpense", CONG],
  ["src/lib/actions/chi-phi-nhap-hang.ts", "ghiChiPhiNhapHang", CONG],
  ["src/lib/expenses/ensure-recurring-expenses.ts", "sinhCoKhoaChung", CONG],
  ["src/lib/thung-rac/khoi-phuc-ban-ghi.ts", "khoiPhucBanGhiDaXoa", "doTinhTrang"],
];

/**
 * Hàm GHI Expense KHÔNG qua cổng (cổng từ chối cả lượt) mà tự LỌC bỏ dòng ngày < M rồi ghi phần còn lại — chủ shop
 * chốt cho import file ads: dòng < M bỏ qua + đếm, dòng ≥ M nhập y cũ. Luật: MỌI transaction trong hàm mở đầu bằng
 * khoá chung VÔ ĐIỀU KIỆN, đọc M bằng `docMocM(<tx>)` (SAU khoá — đọc ngoài transaction là đọc M cũ khi bước bật
 * chưa commit), và gọi hàm lọc `hamLoc(` — hàm lọc (cùng file) phải gọi `laNgayTruocMocM(`. KHÔNG ép
 * `OPT_TX_DONG_TIEN`: import giữ hạn 60s riêng (chờ khoá ads của lượt ingest đêm), đã phủ ngân sách 10s chờ khoá
 * chung. Hành vi thật (lọc, không xoá ADS_API < M, chờ bước bật rồi lọc theo M mới): `tests/ads-import.test.ts`.
 * [file, tên hàm, hàm lọc].
 */
const DUONG_LOC_TRUOC_M: [string, string, string][] = [["src/lib/actions/ads-import.ts", "importAdsExpenses", "boDongTruocMocM"]];

/**
 * Hàm ĐỔI số tiền Expense ngày < M mà KHÔNG gọi cổng (cổng từ chối mọi đổi số tiền < M) vì TỰ BÙ: cùng transaction
 * thêm `CUTOVER_ADJ_*` ±Δ ngày M ⇒ quỹ từ M giữ nguyên. Luật: MỌI transaction trong hàm mở đầu bằng khoá chung VÔ ĐIỀU
 * KIỆN (bước bật đang chạy ⇒ chờ nó commit), đọc M bằng `daBatNoPhaiTra(<tx>)` và D0 bằng `ngayMoSo(<tx>)` SAU khoá
 * (D0 đọc ngoài transaction / M đọc ngoài transaction là quyết định bù trên số cũ), có câu ghi dòng bù
 * `<tx>.cashMovement.create(` và truyền `OPT_TX_DONG_TIEN`. Hành vi thật (bất biến quỹ, D0, đua):
 * `tests/unit/no-phai-tra/sua-tien-truoc-moc.integration.test.ts`. [file, tên hàm].
 */
const DUONG_BU_CUTOVER: [string, string][] = [["src/lib/actions/sua-tien-truoc-moc.ts", "suaSoTienTruocMoc"]];

const doc = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
const sf =(src: string, ten: string) => ts.createSourceFile(ten, src, ts.ScriptTarget.Latest, true);

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

/** Lời gọi `$transaction(cb, OPT_TX_DONG_TIEN)` — đối số thứ hai đúng tên hằng dùng chung. */
function truyenOptDongTien(cb: ts.ArrowFunction | ts.FunctionExpression): boolean {
  const goi = cb.parent;
  if (!ts.isCallExpression(goi)) return false;
  const opt = goi.arguments[1];
  return opt !== undefined && ts.isIdentifier(opt) && opt.text === "OPT_TX_DONG_TIEN";
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
    if (!truyenOptDongTien(gan)) {
      loi.push(`${ten}: transaction chứa ${cong}( (dòng ${goc.getLineAndCharacterOfPosition(gan.getStart()).line + 1}) không truyền OPT_TX_DONG_TIEN`);
    }
  }
  return loi;
}

/**
 * Vi phạm của hàm `tenHam`: không có transaction, hoặc có transaction không mở đầu bằng khoá chung / không gọi
 * cổng `cong` / không truyền `OPT_TX_DONG_TIEN`.
 */
function viPhamHam(src: string, ten: string, tenHam: string, cong = CONG): string[] {
  const ham = moiNut(sf(src, ten), (n) => ts.isFunctionDeclaration(n) && n.name?.text === tenHam);
  if (ham.length !== 1) return [`${ten}: không thấy đúng một hàm ${tenHam}`];
  const cbs = callbackTransaction(ham[0]);
  if (cbs.length === 0) return [`${ten}: ${tenHam} không có $transaction`];
  const loi: string[] = [];
  if (cbs.some((cb) => !cauDauLaKhoa(cb))) loi.push(`${ten}: transaction của ${tenHam} không mở đầu bằng await khoaChiaSeBatNoPhaiTra(`);
  if (cbs.some((cb) => moiNut(cb, (n) => laGoi(n, cong)).length === 0)) {
    loi.push(`${ten}: transaction của ${tenHam} không gọi ${cong}(`);
  }
  if (cbs.some((cb) => !truyenOptDongTien(cb))) loi.push(`${ten}: transaction của ${tenHam} không truyền OPT_TX_DONG_TIEN`);
  return loi;
}

/** Như `viPhamHam` + câu đầu MỌI transaction là khoá VÔ ĐIỀU KIỆN (`await khoaChiaSeBatNoPhaiTra(…)`, không `if`). */
function viPhamHamKhoaVoDieuKien(src: string, ten: string, tenHam: string, cong = CONG): string[] {
  const loi = viPhamHam(src, ten, tenHam, cong);
  const ham = moiNut(sf(src, ten), (n) => ts.isFunctionDeclaration(n) && n.name?.text === tenHam);
  if (ham.length !== 1) return loi;
  const cbs = callbackTransaction(ham[0]);
  if (cbs.some((cb) => !ts.isBlock(cb.body) || !laCauKhoa(cb.body.statements[0]))) {
    loi.push(`${ten}: transaction của ${tenHam} không mở đầu bằng khoá VÔ ĐIỀU KIỆN`);
  }
  return loi;
}

/** Vi phạm luật `DUONG_LOC_TRUOC_M` của hàm `tenHam` (lọc bằng `hamLoc`). */
function viPhamLocTruocM(src: string, ten: string, tenHam: string, hamLoc: string): string[] {
  const goc = sf(src, ten);
  const ham = moiNut(goc, (n) => ts.isFunctionDeclaration(n) && n.name?.text === tenHam);
  if (ham.length !== 1) return [`${ten}: không thấy đúng một hàm ${tenHam}`];
  const cbs = callbackTransaction(ham[0]);
  if (cbs.length === 0) return [`${ten}: ${tenHam} không có $transaction`];
  const loi: string[] = [];
  for (const cb of cbs) {
    if (!ts.isBlock(cb.body) || !laCauKhoa(cb.body.statements[0])) {
      loi.push(`${ten}: transaction của ${tenHam} không mở đầu bằng khoá VÔ ĐIỀU KIỆN`);
    }
    const thamSoTx = cb.parameters[0]?.name;
    const tenTx = thamSoTx !== undefined && ts.isIdentifier(thamSoTx) ? thamSoTx.text : null;
    const docMTrongTx = moiNut(cb, (n) => laGoi(n, "docMocM")).some((g) => {
      const a = (g as ts.CallExpression).arguments[0];
      return a !== undefined && ts.isIdentifier(a) && a.text === tenTx;
    });
    if (!docMTrongTx) loi.push(`${ten}: transaction của ${tenHam} không đọc M bằng docMocM(${tenTx ?? "tx"}) sau khoá`);
    if (moiNut(cb, (n) => laGoi(n, hamLoc)).length === 0) loi.push(`${ten}: transaction của ${tenHam} không gọi ${hamLoc}(`);
  }
  const loc = moiNut(goc, (n) => ts.isFunctionDeclaration(n) && n.name?.text === hamLoc);
  if (loc.length !== 1 || moiNut(loc[0], (n) => laGoi(n, "laNgayTruocMocM")).length === 0) {
    loi.push(`${ten}: hàm lọc ${hamLoc} không gọi laNgayTruocMocM(`);
  }
  return loi;
}

/** Lời gọi `ten(<tenTx>)` có trong `goc` — đối số đầu đúng định danh transaction. */
function goiVoiTx(goc: ts.Node, ten: string, tenTx: string | null): boolean {
  return moiNut(goc, (n) => laGoi(n, ten)).some((g) => {
    const a = (g as ts.CallExpression).arguments[0];
    return a !== undefined && ts.isIdentifier(a) && a.text === tenTx;
  });
}

/** Vi phạm luật `DUONG_BU_CUTOVER` của hàm `tenHam`. */
function viPhamBuCutover(src: string, ten: string, tenHam: string): string[] {
  const ham = moiNut(sf(src, ten), (n) => ts.isFunctionDeclaration(n) && n.name?.text === tenHam);
  if (ham.length !== 1) return [`${ten}: không thấy đúng một hàm ${tenHam}`];
  const cbs = callbackTransaction(ham[0]);
  if (cbs.length === 0) return [`${ten}: ${tenHam} không có $transaction`];
  const loi: string[] = [];
  for (const cb of cbs) {
    if (!ts.isBlock(cb.body) || !laCauKhoa(cb.body.statements[0])) {
      loi.push(`${ten}: transaction của ${tenHam} không mở đầu bằng khoá VÔ ĐIỀU KIỆN`);
    }
    const thamSoTx = cb.parameters[0]?.name;
    const tenTx = thamSoTx !== undefined && ts.isIdentifier(thamSoTx) ? thamSoTx.text : null;
    if (!goiVoiTx(cb, "daBatNoPhaiTra", tenTx)) loi.push(`${ten}: ${tenHam} không đọc M bằng daBatNoPhaiTra(${tenTx ?? "tx"})`);
    if (!goiVoiTx(cb, "ngayMoSo", tenTx)) loi.push(`${ten}: ${tenHam} không đọc ngày mở sổ bằng ngayMoSo(${tenTx ?? "tx"})`);
    const ghiBu = moiNut(
      cb,
      (n) =>
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "create" &&
        ts.isPropertyAccessExpression(n.expression.expression) &&
        n.expression.expression.name.text === "cashMovement" &&
        ts.isIdentifier(n.expression.expression.expression) &&
        n.expression.expression.expression.text === tenTx
    );
    if (ghiBu.length === 0) loi.push(`${ten}: ${tenHam} không ghi dòng bù ${tenTx ?? "tx"}.cashMovement.create( trong transaction`);
    if (!truyenOptDongTien(cb)) loi.push(`${ten}: transaction của ${tenHam} không truyền OPT_TX_DONG_TIEN`);
  }
  return loi;
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

describe("đường ghi chi phí giữ khoá chung với bước bật (câu đầu transaction)", () => {
  it("mọi file gọi chanSoChiPhiDaKhoa( đều khai ở DUONG_GHI_NHAP_HANG (và giữ khoá)", () => {
    const goi = moiFileSrc(path.join(ROOT, "src"))
      .map((f) => path.relative(ROOT, f).split(path.sep).join("/"))
      .filter((f) => f !== "src/lib/no-phai-tra/chan-so-chi-phi-da-khoa.ts")
      .filter((f) => moiNut(sf(doc(f), f), (n) => laGoi(n, CONG)).length > 0)
      .sort();
    expect(goi, "File mới gọi cổng khoá sổ chi phí: khai vào DUONG_GHI_NHAP_HANG (và giữ khoá)").toEqual(
      Object.keys(DUONG_GHI_NHAP_HANG).sort()
    );
  });

  it.each(Object.entries(DUONG_GHI_NHAP_HANG))("%s ⇒ transaction mở đầu bằng khoaChiaSeBatNoPhaiTra(", (_f, { giuTx, cong }) => {
    expect(viPham(doc(giuTx), giuTx, cong)).toEqual([]);
  });

  it.each(Object.entries(DUONG_BAT_MAU_NHAP_HANG))("%s#%s ⇒ transaction mở đầu bằng khoaChiaSeBatNoPhaiTra(", (f, ham) => {
    expect(viPhamHam(doc(f), f, ham)).toEqual([]);
  });

  it.each(DUONG_KHOA_VO_DIEU_KIEN)("%s#%s ⇒ transaction mở đầu bằng khoá vô điều kiện + gọi cổng %s", (f, ham, cong) => {
    expect(viPhamHamKhoaVoDieuKien(doc(f), f, ham, cong)).toEqual([]);
  });

  it("ĐỘT BIẾN: hàm ghi bỏ khoá / khoá có điều kiện / bỏ cổng / bỏ OPT_TX_DONG_TIEN ⇒ lưới đỏ", () => {
    for (const [f, ham, cong] of DUONG_KHOA_VO_DIEU_KIEN) {
      const src = doc(f);
      // Chỉ cắt trong thân hàm đích (tới dấu đóng hàm cấp cao nhất) — hàm khác cùng file không được che đột biến.
      const batDau = src.search(new RegExp(`(?:export )?async function ${ham}\\(`));
      const ketThuc = src.indexOf("\n}\n", batDau) + 3;
      expect(batDau, `${f}: không thấy hàm ${ham}`).toBeGreaterThan(-1);
      const doiTrongHam = (tu: RegExp, thanh: string) =>
        src.slice(0, batDau) + src.slice(batDau, ketThuc).replace(tu, thanh) + src.slice(ketThuc);
      const dotBien = {
        botKhoa: doiTrongHam(/await khoaChiaSeBatNoPhaiTra\(tx\);/g, ""),
        coDieuKien: doiTrongHam(/await khoaChiaSeBatNoPhaiTra\(tx\);/, "if (laNhap) await khoaChiaSeBatNoPhaiTra(tx);"),
        botCong: doiTrongHam(new RegExp(`${cong}\\(`, "g"), "khongCongGi("),
        botOpt: doiTrongHam(/,\s*OPT_TX_DONG_TIEN\s*\)/g, ")"),
      };
      for (const [ten, s] of Object.entries(dotBien)) {
        expect(s, `${f}#${ham}: đột biến ${ten} phải đổi mã`).not.toBe(src);
        expect(viPhamHamKhoaVoDieuKien(s, f, ham, cong).length, `${f}#${ham}: đột biến ${ten} phải bị bắt`).toBeGreaterThan(0);
      }
    }
  });

  it.each(DUONG_LOC_TRUOC_M)("%s#%s ⇒ khoá chung vô điều kiện câu đầu, đọc M trong transaction, lọc bằng %s", (f, ham, hamLoc) => {
    expect(viPhamLocTruocM(doc(f), f, ham, hamLoc)).toEqual([]);
  });

  it("ĐỘT BIẾN: đường lọc trước M bỏ khoá / khoá có điều kiện / bỏ lọc / đọc M ngoài transaction / lọc không so M ⇒ lưới đỏ", () => {
    for (const [f, ham, hamLoc] of DUONG_LOC_TRUOC_M) {
      const src = doc(f);
      const trongHam = (ten: string) => {
        const batDau = src.search(new RegExp(`(?:export )?(?:async )?function ${ten}\\(`));
        expect(batDau, `${f}: không thấy hàm ${ten}`).toBeGreaterThan(-1);
        return [batDau, src.indexOf("\n}\n", batDau) + 3] as const;
      };
      const doiTrong = (ten: string, tu: RegExp, thanh: string) => {
        const [a, b] = trongHam(ten);
        return src.slice(0, a) + src.slice(a, b).replace(tu, thanh) + src.slice(b);
      };
      const dotBien = {
        botKhoa: doiTrong(ham, /await khoaChiaSeBatNoPhaiTra\(tx\);/g, ""),
        coDieuKien: doiTrong(ham, /await khoaChiaSeBatNoPhaiTra\(tx\);/, "if (laNhap) await khoaChiaSeBatNoPhaiTra(tx);"),
        botLoc: doiTrong(ham, new RegExp(`${hamLoc}\\(`, "g"), "khongLocGi("),
        docMNgoaiTx: doiTrong(ham, /docMocM\(tx\)/g, "docMocM()"),
        locKhongSoM: doiTrong(hamLoc, /laNgayTruocMocM\(/g, "khongSoGi("),
      };
      for (const [ten, s] of Object.entries(dotBien)) {
        expect(s, `${f}#${ham}: đột biến ${ten} phải đổi mã`).not.toBe(src);
        expect(viPhamLocTruocM(s, f, ham, hamLoc).length, `${f}#${ham}: đột biến ${ten} phải bị bắt`).toBeGreaterThan(0);
      }
    }
  });

  it.each(DUONG_BU_CUTOVER)("%s#%s ⇒ khoá chung vô điều kiện câu đầu, đọc M + D0 trong transaction, ghi dòng bù cùng transaction", (f, ham) => {
    expect(viPhamBuCutover(doc(f), f, ham)).toEqual([]);
  });

  it("ĐỘT BIẾN: đường bù bỏ khoá / khoá có điều kiện / đọc M hay D0 ngoài transaction / bỏ dòng bù / bỏ OPT_TX_DONG_TIEN ⇒ lưới đỏ", () => {
    for (const [f, ham] of DUONG_BU_CUTOVER) {
      const src = doc(f);
      const dotBien = {
        botKhoa: src.replace(/await khoaChiaSeBatNoPhaiTra\(tx\);/g, ""),
        coDieuKien: src.replace(/await khoaChiaSeBatNoPhaiTra\(tx\);/, "if (laNhap) await khoaChiaSeBatNoPhaiTra(tx);"),
        docMNgoaiTx: src.replace(/daBatNoPhaiTra\(tx\)/g, "daBatNoPhaiTra()"),
        docD0NgoaiTx: src.replace(/ngayMoSo\(tx\)/g, "ngayMoSo()"),
        botDongBu: src.replace(/tx\.cashMovement\.create\(/g, "khongGhiGi("),
        botOpt: src.replace(/,\s*OPT_TX_DONG_TIEN\s*\)/g, ")"),
      };
      for (const [ten, s] of Object.entries(dotBien)) {
        expect(s, `${f}#${ham}: đột biến ${ten} phải đổi mã`).not.toBe(src);
        expect(viPhamBuCutover(s, f, ham).length, `${f}#${ham}: đột biến ${ten} phải bị bắt`).toBeGreaterThan(0);
      }
    }
  });

  it("ĐỘT BIẾN: bỏ khoá hoặc bỏ OPT_TX_DONG_TIEN ở bất kỳ file giữ transaction nào ⇒ lưới đỏ", () => {
    for (const { giuTx, cong } of Object.values(DUONG_GHI_NHAP_HANG)) {
      const botKhoa = doc(giuTx).replace(/khoaChiaSeBatNoPhaiTra\(/g, "khongKhoaGi(");
      expect(viPham(botKhoa, giuTx, cong).length, `đột biến bỏ khoá ở ${giuTx} phải bị bắt`).toBeGreaterThan(0);
      const botOpt = doc(giuTx).replace(/,\s*OPT_TX_DONG_TIEN\s*\)/g, ")");
      expect(viPham(botOpt, giuTx, cong).length, `đột biến bỏ OPT_TX_DONG_TIEN ở ${giuTx} phải bị bắt`).toBeGreaterThan(0);
    }
  });

  it("ĐỘT BIẾN: bỏ khoá / bỏ cổng / bỏ OPT_TX_DONG_TIEN, hoặc đọc mẫu trong transaction TRƯỚC khoá, ở hàm bật lại mẫu ⇒ lưới đỏ", () => {
    for (const [f, ham] of Object.entries(DUONG_BAT_MAU_NHAP_HANG)) {
      const botKhoa = doc(f).replace(/khoaChiaSeBatNoPhaiTra\(/g, "khongKhoaGi(");
      expect(viPhamHam(botKhoa, f, ham).length, `đột biến bỏ khoá ở ${f}#${ham} phải bị bắt`).toBeGreaterThan(0);
      const botCong = doc(f).replace(/chanSoChiPhiDaKhoa\(/g, "khongCongGi(");
      expect(viPhamHam(botCong, f, ham).length, `đột biến bỏ cổng ở ${f}#${ham} phải bị bắt`).toBeGreaterThan(0);
      const botOpt = doc(f).replace(/, OPT_TX_DONG_TIEN\)/g, ")");
      expect(viPhamHam(botOpt, f, ham).length, `đột biến bỏ OPT_TX_DONG_TIEN ở ${f}#${ham} phải bị bắt`).toBeGreaterThan(0);
    }
    const docTruocKhoa =
      "async function batLai() {\n  await prisma.$transaction(async (tx) => {\n    const nhom = await tx.recurringExpense.findUnique(q);\n    if (nhom.categoryId === 'purchase') await khoaChiaSeBatNoPhaiTra(tx);\n  });\n}";
    expect(viPhamHam(docTruocKhoa, "x.ts", "batLai").length).toBeGreaterThan(0);
  });

  it("ĐỘT BIẾN: khoá đứng SAU câu khác, cổng ngoài transaction, khoá chỉ trong chú thích ⇒ đều bị bắt", () => {
    const sauKhoaThe =
      "await prisma.$transaction(async (tx) => {\n  await khoaThe(tx, id);\n  await khoaChiaSeBatNoPhaiTra(tx);\n  await chanSoChiPhiDaKhoa(tx, d);\n});";
    const ngoaiTx = "await khoaChiaSeBatNoPhaiTra(tx);\nawait chanSoChiPhiDaKhoa(prisma, d);";
    const chuThich = "await prisma.$transaction(async (tx) => {\n  // await khoaChiaSeBatNoPhaiTra(tx);\n  await chanSoChiPhiDaKhoa(tx, d);\n});";
    for (const src of [sauKhoaThe, ngoaiTx, chuThich]) expect(viPham(src, "x.ts", CONG).length).toBeGreaterThan(0);
    const dung = "await prisma.$transaction(async (tx) => {\n  if (d.categoryId === 'purchase') await khoaChiaSeBatNoPhaiTra(tx);\n  await chanSoChiPhiDaKhoa(tx, d);\n}, OPT_TX_DONG_TIEN);";
    expect(viPham(dung, "x.ts", CONG)).toEqual([]);
  });
});
