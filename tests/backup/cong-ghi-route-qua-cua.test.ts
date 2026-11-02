/**
 * LƯỚI TĨNH: mọi route handler GHI DB đi qua cửa ĐẾM `routeQuaCua` — chỉ kiểm cờ (`chanRouteKhiDangPhucHoi`)
 * thì request vào TRƯỚC cờ vẫn đang ghi khi lượt phục hồi chụp bản lùi / drop schema.
 *
 * Luật cho từng handler export (GET/POST/…): câu lệnh CUỐI là `return …` mà biểu thức chứa lời gọi
 * `routeQuaCua(…)` (vd `return routeQuaCua(() => xuLyPost(req))` hoặc
 * `return noStore(await routeQuaCua(…))`). Các câu trước đó chỉ là cổng/bearer/kiểm origin.
 * Handler miễn khai theo `file#METHOD` kèm lý do; mục miễn thừa cũng đỏ.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const GOC = process.cwd();
const PHUONG_THUC = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

const MIEN: Readonly<Record<string, string>> = {
  "src/app/api/restore/route.ts#POST": "Chính lượt phục hồi — tự giữ lease → X → cờ, KHÔNG được đếm vào drain của chính nó.",
  "src/app/api/restore/cat-phien/route.ts#POST":
    "Chỉ `pg_terminate_backend` một phiên CLI giữ khoá ghi chung — không ghi dữ liệu app; nhật ký best-effort, từ chối khi cờ phục hồi bật.",
  "src/app/api/export/bao-cao/route.ts#GET": "Chỉ đọc (xuất Excel).",
  "src/app/api/export/gia-von/route.ts#GET": "Chỉ đọc (xuất Excel).",
  "src/app/api/export/so-quy/route.ts#GET": "Chỉ đọc (xuất Excel).",
  "src/app/api/export/ton-kho/route.ts#GET": "Chỉ đọc (xuất Excel).",
  "src/app/api/uploads/[name]/route.ts#GET": "Chỉ đọc file logo công khai.",
  "src/app/api/ingest/meta-token/route.ts#GET":
    "Chỉ đọc kho token; CỐ Ý không chặn khi phục hồi (Meta không xoay vòng token — chặn chỉ mất một đêm ads).",
  "src/app/api/e2e-cong-ghi/route.e2e.ts#GET": "CHỈ build e2e cổng ghi — chỉ đọc bộ đếm cổng ghi (RAM), không chạm DB.",
  "src/app/api/e2e-cong-ghi/route.e2e.ts#POST":
    "CHỈ build e2e cổng ghi — thả barrier (RAM) hoặc gọi thẳng `POST` của `/api/restore` (restore khô): lượt phục hồi " +
    "không được tự đếm vào drain của chính nó, cùng lý do route restore được miễn.",
};

function lietKeRoute(thuMuc: string): string[] {
  const ra: string[] = [];
  for (const ten of readdirSync(thuMuc)) {
    const p = path.join(thuMuc, ten);
    if (statSync(p).isDirectory()) ra.push(...lietKeRoute(p));
    // `route.e2e.ts`: route chỉ-test của bản build e2e cổng ghi (`pageExtensions`, `next.config.ts`) — vẫn soi.
    else if (/^route(\.e2e)?\.(ts|tsx|js|mjs)$/.test(ten)) ra.push(p);
  }
  return ra;
}

function coGoiRouteQuaCua(n: ts.Node): boolean {
  let co = false;
  const di = (x: ts.Node): void => {
    if (co) return;
    if (ts.isCallExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === "routeQuaCua") {
      co = true;
      return;
    }
    ts.forEachChild(x, di);
  };
  di(n);
  return co;
}

/** Vi phạm của một file route (khoá `file#METHOD`). Hàm thuần — dùng cho cả cây thật lẫn mẫu đột biến. */
function viPhamRouteQuaCua(file: string, ma: string, mien: Readonly<Record<string, string>>): string[] {
  const sf = ts.createSourceFile(file, ma, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const viPham: string[] = [];
  if (/\bchanRouteKhiDangPhucHoi\b/.test(ma)) viPham.push(`${file}: còn dùng chanRouteKhiDangPhucHoi (chỉ kiểm, không đếm)`);
  for (const st of sf.statements) {
    if (!ts.isFunctionDeclaration(st) || !st.name || !PHUONG_THUC.has(st.name.text)) continue;
    const laExport = st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!laExport) continue;
    const khoa = `${file}#${st.name.text}`;
    if (Object.hasOwn(mien, khoa)) continue;
    const cau = st.body?.statements ?? [];
    const cuoi = cau[cau.length - 1];
    if (!cuoi || !ts.isReturnStatement(cuoi) || !cuoi.expression || !coGoiRouteQuaCua(cuoi.expression)) {
      viPham.push(`${khoa}: câu cuối phải là \`return …routeQuaCua(…)…\``);
      continue;
    }
    // Không câu nào TRƯỚC cửa được gọi `prisma` trực tiếp (ghi trước cửa = không được đếm).
    for (const c of cau.slice(0, -1)) {
      if (/\bprisma\b/.test(c.getText(sf))) viPham.push(`${khoa}: chạm \`prisma\` trước cửa ghi`);
    }
  }
  return viPham;
}

describe("route ghi đi qua cửa đếm `routeQuaCua`", () => {
  const files = lietKeRoute(path.join(GOC, "src/app/api")).map((f) => path.relative(GOC, f).split(path.sep).join("/"));

  it("cây thật: mọi handler (trừ mục miễn) mở cửa bằng routeQuaCua", () => {
    expect(files.length).toBeGreaterThanOrEqual(11);
    const viPham = files.flatMap((f) => viPhamRouteQuaCua(f, readFileSync(path.join(GOC, f), "utf8"), MIEN));
    expect(viPham).toEqual([]);
  });

  it("đủ 11 handler ghi đã qua cửa (đếm để không ai gỡ hàng loạt mà lưới vẫn xanh)", () => {
    let dem = 0;
    for (const f of files) {
      const sf = ts.createSourceFile(f, readFileSync(path.join(GOC, f), "utf8"), ts.ScriptTarget.Latest, true);
      for (const st of sf.statements) {
        if (ts.isFunctionDeclaration(st) && st.name && PHUONG_THUC.has(st.name.text) && !Object.hasOwn(MIEN, `${f}#${st.name.text}`)) dem++;
      }
    }
    expect(dem).toBeGreaterThanOrEqual(11);
  });

  it("mục miễn không thừa (handler còn tồn tại)", () => {
    for (const khoa of Object.keys(MIEN)) {
      const [f, m] = khoa.split("#");
      expect(readFileSync(path.join(GOC, f), "utf8"), khoa).toMatch(new RegExp(`export async function ${m}\\b`));
    }
  });
});

describe("lưới tự kiểm bằng mẫu đột biến", () => {
  const F = "src/app/api/mau/route.ts";
  it("mẫu đúng: không vi phạm", () => {
    const ma = `export async function POST(req: Request) {
      const u = requireIngestSecret(req);
      if (u) return u;
      return routeQuaCua(() => xuLyPost(req));
    }
    export async function GET(req: Request) {
      return noStore(await routeQuaCua(() => xuLyGet()));
    }`;
    expect(viPhamRouteQuaCua(F, ma, {})).toEqual([]);
  });

  it("gỡ cửa (chỉ kiểm cờ) ⇒ đỏ", () => {
    const ma = `export async function POST(req: Request) {
      const d = chanRouteKhiDangPhucHoi();
      if (d) return d;
      return xuLyPost(req);
    }`;
    const v = viPhamRouteQuaCua(F, ma, {});
    expect(v).toContain(`${F}: còn dùng chanRouteKhiDangPhucHoi (chỉ kiểm, không đếm)`);
    expect(v).toContain(`${F}#POST: câu cuối phải là \`return …routeQuaCua(…)…\``);
  });

  it("ghi prisma TRƯỚC cửa ⇒ đỏ", () => {
    const ma = `export async function POST(req: Request) {
      await prisma.setting.create({ data: { key: "x", value: "y" } });
      return routeQuaCua(() => xuLyPost(req));
    }`;
    expect(viPhamRouteQuaCua(F, ma, {})).toEqual([`${F}#POST: chạm \`prisma\` trước cửa ghi`]);
  });

  it("handler mới không cửa ⇒ đỏ; khai miễn ⇒ qua", () => {
    const ma = `export async function DELETE() { return new Response("x"); }`;
    expect(viPhamRouteQuaCua(F, ma, {})).toHaveLength(1);
    expect(viPhamRouteQuaCua(F, ma, { [`${F}#DELETE`]: "lý do" })).toEqual([]);
  });
});
