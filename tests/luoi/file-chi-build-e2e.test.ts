/**
 * LƯỚI "FILE CHỈ BUILD E2E" — route/trang/action chỉ-test của e2e cổng ghi trên bản build
 * (`tests/e2e/cong-ghi-prod.spec.ts`) KHÔNG được có mặt trong bản build prod thật, và không được mở đường
 * ghi mới nào.
 *
 * Hai lớp phòng thủ, lưới khoá cả hai cùng các chỗ nối:
 *  1. BUILD: file mang đuôi kép `*.e2e.ts(x)`; `next.config.ts` chỉ thêm `e2e.tsx`/`e2e.ts` vào
 *     `pageExtensions` khi `E2E_CONG_GHI_BUILD=1`. Build thường (Dockerfile/CI/`npm run build`) không đặt
 *     biến ⇒ Next không coi chúng là trang/route, và không file production nào import chúng ⇒ vắng hẳn.
 *  2. RUNTIME: mọi hàm export mở bằng cổng chủ shop như code thật, ngay sau là `if (!e2eCongGhiDangBat()) …`
 *     (thiếu `E2E_CONG_GHI=1` ⇒ 404/từ chối); action đứng chờ barrier tối đa 60s rồi nhả cửa.
 * Restore khô đi qua seam của `/api/restore` (`docRestoreKhoE2e`) — đọc bảng `Symbol.for` mà CHỈ module
 * chỉ-test ghi vào; lưới khoá chuỗi hai bên trùng nhau.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import { viPhamKhongChamDuLieu } from "./luat-route-ingest-va-file-khong-cong";
import {
  coLoiGoi,
  coUseServerBatKy,
  docCay,
  laFileUseServer,
  lietKeExport,
  TEN_CONG_ACTION,
  TEN_CONG_ROUTE,
  TEN_CONG_TRANG,
} from "./phan-tich-cong-bang-ast";

const GOC = path.resolve(__dirname, "../..");
const doc = (rel: string) => readFileSync(path.join(GOC, rel), "utf8");

/** Mọi file `*.e2e.<đuôi>` của repo — mỗi file một lý do. Thêm file mới phải khai ở đây. */
const FILE_CHI_BUILD_E2E: Readonly<Record<string, string>> = {
  "src/app/api/e2e-cong-ghi/route.e2e.ts": "Route chỉ-test: đọc bộ đếm, thả barrier, gọi restore khô.",
  "src/app/e2e-cong-ghi/page.e2e.tsx": "Trang chỉ-test dựng hai nút gọi action.",
  "src/app/e2e-cong-ghi/nut-e2e-cong-ghi.e2e.tsx": "Client component hai nút (không mã server).",
  "src/app/e2e-cong-ghi/actions.e2e.ts": "Server action chỉ-test, ghi qua cửa `vaoCuaGhi` thật.",
};

/** Module chỉ-test dưới `src/lib` (`*-e2e-chi-test.ts`) — chỉ file `.e2e.*` và test được import. */
const MODULE_CHI_TEST = ["src/lib/backup/cong-ghi-e2e-chi-test.ts"];

/**
 * Module mà file `.e2e.*` được import (giá trị): thư viện cổng ghi, cổng phiên/origin, restore route,
 * module chỉ-test. Không có `@/lib/prisma` hay module ghi nào khác.
 */
const NGUON_DUOC_PHEP_FILE_E2E: readonly (string | RegExp)[] = [
  "react",
  "next/navigation",
  "@/lib/backup/cong-ghi-toan-cuc",
  "@/lib/backup/khoa-bao-tri",
  "@/lib/quyen/cong-action",
  "@/lib/quyen/cong-route",
  "@/lib/quyen/cong-trang",
  "@/lib/chan-request-khac-origin",
  "@/app/api/restore/route",
  /^@\/lib\/backup\/[\w-]+-e2e-chi-test$/,
  /^\.\/[\w-]+\.e2e$/,
];

/** Action chỉ-test CỐ Ý ghi NGOÀI cửa ghi (đo lưới cấp op) — khoá `file#tên`, mỗi mục một lý do. */
const ACTION_E2E_NGOAI_CUA: Readonly<Record<string, string>> = {
  "src/app/e2e-cong-ghi/actions.e2e.ts#ghiNgoaiCuaE2e":
    "Đo lưới cấp op trên bản build: ghi không mang ngữ cảnh cửa (như câu ghi lúc render) phải bị chặn khi cờ bật và nhận diện được bằng `laLoiCongGhiDangKhoa`.",
};

const RE_FILE_E2E = /\.e2e\.[cm]?[jt]sx?$/;
const RE_MODULE_CHI_TEST = /-e2e-chi-test\.[cm]?[jt]sx?$/;
/** Specifier trỏ tới file `.e2e.*` hoặc module chỉ-test. */
const RE_SPECIFIER_CHI_TEST = /(?:\.e2e|-e2e-chi-test)(?:\.[cm]?[jt]sx?)?$/;

function lietKe(thuMucRel: string): string[] {
  const ra: string[] = [];
  const di = (rel: string) => {
    if (!existsSync(path.join(GOC, rel))) return;
    for (const e of readdirSync(path.join(GOC, rel), { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "generated") continue;
      const con = `${rel}/${e.name}`;
      if (e.isDirectory()) di(con);
      else if (/\.[cm]?[jt]sx?$/.test(e.name)) ra.push(con);
    }
  };
  di(thuMucRel);
  return ra.sort();
}

/** Mọi file (mọi đuôi) dưới một thư mục, đệ quy — đường dẫn tương đối gốc repo. */
function lietKeMoiFile(thuMucRel: string): string[] {
  if (!existsSync(path.join(GOC, thuMucRel))) return [];
  return readdirSync(path.join(GOC, thuMucRel), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? lietKeMoiFile(`${thuMucRel}/${e.name}`) : [`${thuMucRel}/${e.name}`],
  );
}

/** Mọi specifier import/export/`import()`/`require()` (kể cả chỉ-kiểu) của một file. */
function moiSpecifier(sf: ts.SourceFile): string[] {
  const ra: string[] = [];
  const di = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      ra.push(n.moduleSpecifier.text);
    }
    if (ts.isCallExpression(n) && n.arguments.length > 0 && ts.isStringLiteralLike(n.arguments[0])) {
      const laImport = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      const laRequire = ts.isIdentifier(n.expression) && n.expression.text === "require";
      if (laImport || laRequire) ra.push(n.arguments[0].text);
    }
    ts.forEachChild(n, di);
  };
  di(sf);
  return ra;
}

/** File production (không phải file `.e2e.*`, không phải module chỉ-test) import thứ chỉ-test ⇒ vi phạm. */
function viPhamNapChiTest(file: string, src: string): string[] {
  if (RE_FILE_E2E.test(file) || RE_MODULE_CHI_TEST.test(file)) return [];
  return moiSpecifier(docCay(src, file))
    .filter((s) => RE_SPECIFIER_CHI_TEST.test(s))
    .map((s) => `${file}: import "${s}" — file production không được nạp thứ chỉ-test (kéo nó vào bản build prod)`);
}

const TEN_CONG: readonly string[] = [...TEN_CONG_ACTION, ...TEN_CONG_ROUTE, ...TEN_CONG_TRANG];

/**
 * Số câu "mở bằng cổng phiên" ở đầu thân: câu gọi cổng (action/route/trang) + câu kiểm kết quả
 * `if (!x.ok) return …;` ngay sau (trang không có câu kiểm). 0 = câu đầu không gọi cổng.
 */
function soCauCong(cau: readonly ts.Statement[]): number {
  if (cau.length === 0 || !coLoiGoi(cau[0], TEN_CONG)) return 0;
  const sau = cau[1];
  return sau !== undefined && ts.isIfStatement(sau) && /^!\s*\w+\.ok$/.test(sau.expression.getText()) ? 2 : 1;
}

/** Câu là chốt `if (!e2eCongGhiDangBat()) return …;` hoặc `if (!e2eCongGhiDangBat()) notFound();`. */
function laChotE2e(dau: ts.Statement | undefined): boolean {
  if (!dau || !ts.isIfStatement(dau) || dau.elseStatement) return false;
  const dk = dau.expression;
  const dungDieuKien =
    ts.isPrefixUnaryExpression(dk) &&
    dk.operator === ts.SyntaxKind.ExclamationToken &&
    ts.isCallExpression(dk.operand) &&
    ts.isIdentifier(dk.operand.expression) &&
    dk.operand.expression.text === "e2eCongGhiDangBat" &&
    dk.operand.arguments.length === 0;
  if (!dungDieuKien) return false;
  const nhanh = ts.isBlock(dau.thenStatement) && dau.thenStatement.statements.length === 1 ? dau.thenStatement.statements[0] : dau.thenStatement;
  if (ts.isReturnStatement(nhanh)) return true;
  return (
    ts.isExpressionStatement(nhanh) &&
    ts.isCallExpression(nhanh.expression) &&
    ts.isIdentifier(nhanh.expression.expression) &&
    nhanh.expression.expression.text === "notFound"
  );
}

/**
 * Vi phạm "gác như code thật" của một file `.e2e.*` (bỏ qua file `"use client"` — không có mã server):
 * mọi hàm export mở bằng cổng phiên, NGAY SAU đó là chốt `E2E_CONG_GHI`. Cổng đúng loại/đúng bảng quyền
 * do lưới `cong-bat-buoc.test.ts` kiểm.
 */
function viPhamChotRuntime(file: string, src: string): string[] {
  const sf = docCay(src, file);
  if (sf.statements.some((s) => ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression) && s.expression.text === "use client")) {
    return coUseServerBatKy(sf) ? [`${file}: file "use client" lại có "use server"`] : [];
  }
  const ds = lietKeExport(sf);
  const viPham = ds.khac.map((d) => `${file}: export dạng lạ — ${d}`);
  const coImportChot = sf.statements.some((s) => {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) return false;
    if (!/^@\/lib\/backup\/[\w-]+-e2e-chi-test$/.test(s.moduleSpecifier.text)) return false;
    const rang = s.importClause?.namedBindings;
    return rang !== undefined && ts.isNamedImports(rang) && rang.elements.some((e) => e.name.text === "e2eCongGhiDangBat" && !e.propertyName);
  });
  if (!coImportChot) viPham.push(`${file}: thiếu import \`e2eCongGhiDangBat\` từ module chỉ-test`);
  for (const ham of ds.ham) {
    const ten = `${file}#${ham.macDinh ? "default" : ham.ten}`;
    const cau = ham.node.body?.statements ?? [];
    const n = soCauCong(cau);
    if (n === 0) viPham.push(`${ten}: câu đầu phải là cổng phiên (như code thật)`);
    else if (!laChotE2e(cau[n])) viPham.push(`${ten}: ngay sau cổng phải là chốt \`if (!e2eCongGhiDangBat()) …\``);
  }
  return viPham;
}

/**
 * Action chỉ-test: câu ngay sau cổng + chốt là `const cua = vaoCuaGhi();` và có `cua.ra()` trong `finally`
 * — trừ action khai đích danh ở `ngoaiCua` (cố ý ghi ngoài cửa để đo lưới cấp op).
 */
function viPhamCuaAction(file: string, src: string, ngoaiCua: Readonly<Record<string, string>> = {}): string[] {
  const sf = docCay(src, file);
  const viPham: string[] = [];
  for (const ham of lietKeExport(sf).ham) {
    if (Object.hasOwn(ngoaiCua, `${file}#${ham.ten}`)) continue;
    const cau = ham.node.body?.statements ?? [];
    const cauCua = cau[soCauCong(cau) + 1];
    const moCua =
      cauCua !== undefined &&
      ts.isVariableStatement(cauCua) &&
      cauCua.declarationList.declarations.some(
        (d) =>
          ts.isIdentifier(d.name) &&
          d.name.text === "cua" &&
          d.initializer !== undefined &&
          ts.isCallExpression(d.initializer) &&
          ts.isIdentifier(d.initializer.expression) &&
          d.initializer.expression.text === "vaoCuaGhi",
      );
    const raTrongFinally = cau.some(
      (c) => ts.isTryStatement(c) && c.finallyBlock !== undefined && /\bcua\.ra\(\)/.test(c.finallyBlock.getText(sf)),
    );
    if (!moCua || !raTrongFinally) {
      viPham.push(`${file}#${ham.ten}: ngay sau cổng + chốt phải mở \`const cua = vaoCuaGhi();\` và \`cua.ra()\` trong finally`);
    }
  }
  return viPham;
}

/** Mô phỏng luật khớp file của Turbopack (`next-core/src/app_structure.rs`): tách tên ở dấu chấm ĐẦU. */
function nextNhanLaTrangHoacRoute(tenFile: string, pageExtensions: readonly string[]): boolean {
  const i = tenFile.indexOf(".");
  if (i < 0) return false;
  const stem = tenFile.slice(0, i);
  const duoi = tenFile.slice(i + 1);
  return ["page", "route", "layout"].includes(stem) && pageExtensions.includes(duoi);
}

async function pageExtensionsVoi(bien: string | undefined): Promise<string[]> {
  const cu = process.env.E2E_CONG_GHI_BUILD;
  try {
    if (bien === undefined) delete process.env.E2E_CONG_GHI_BUILD;
    else process.env.E2E_CONG_GHI_BUILD = bien;
    vi.resetModules();
    const m = (await import("../../next.config")) as { default: { pageExtensions?: string[] } };
    return [...(m.default.pageExtensions ?? [])];
  } finally {
    if (cu === undefined) delete process.env.E2E_CONG_GHI_BUILD;
    else process.env.E2E_CONG_GHI_BUILD = cu;
  }
}

const FILE_SRC = lietKe("src");
const FILE_E2E = FILE_SRC.filter((f) => RE_FILE_E2E.test(f));

afterEach(() => {
  vi.resetModules();
});

describe("file chỉ build e2e — cây thật", () => {
  it("(a) build thường: pageExtensions = mặc định Next, KHÔNG có đuôi e2e; chỉ `E2E_CONG_GHI_BUILD=1` mới thêm", async () => {
    const MAC_DINH = ["tsx", "ts", "jsx", "js"];
    for (const bien of [undefined, "", "0", "true", "1 "]) {
      const ext = await pageExtensionsVoi(bien);
      expect(ext, `E2E_CONG_GHI_BUILD=${JSON.stringify(bien)}`).toEqual(MAC_DINH);
      expect(ext.some((e) => /e2e/.test(e))).toBe(false);
    }
    expect(await pageExtensionsVoi("1")).toEqual([...MAC_DINH, "e2e.tsx", "e2e.ts"]);
  });

  it("(a2) theo luật khớp file của Next: file e2e KHÔNG là trang/route ở build thường, LÀ trang/route ở build e2e", async () => {
    const thuong = await pageExtensionsVoi(undefined);
    const e2e = await pageExtensionsVoi("1");
    const ten = FILE_E2E.map((f) => path.posix.basename(f));
    expect(ten.filter((t) => nextNhanLaTrangHoacRoute(t, thuong))).toEqual([]);
    expect(ten.filter((t) => nextNhanLaTrangHoacRoute(t, e2e)).sort()).toEqual(["page.e2e.tsx", "route.e2e.ts"]);
    // Đối chứng: file trang/route thật vẫn được nhận ở cả hai bản.
    expect(nextNhanLaTrangHoacRoute("page.tsx", thuong) && nextNhanLaTrangHoacRoute("route.ts", e2e)).toBe(true);
  });

  it("(b) mọi file `*.e2e.*` nằm dưới src/app và được khai đích danh; mục khai còn tồn tại", () => {
    expect(FILE_E2E).toEqual(Object.keys(FILE_CHI_BUILD_E2E).sort());
    for (const [f, lyDo] of Object.entries(FILE_CHI_BUILD_E2E)) {
      expect(f.startsWith("src/app/"), f).toBe(true);
      expect(lyDo.length, `${f} thiếu lý do`).toBeGreaterThan(10);
    }
    // Ngoài src/ cũng không được có (scripts/prisma là tiến trình CLI, không qua pageExtensions).
    expect([...lietKe("scripts"), ...lietKe("prisma")].filter((f) => RE_FILE_E2E.test(f))).toEqual([]);
  });

  it("(b2) module chỉ-test dưới src/lib khớp danh sách", () => {
    expect(FILE_SRC.filter((f) => RE_MODULE_CHI_TEST.test(f))).toEqual([...MODULE_CHI_TEST].sort());
  });

  it("(c) file `*.e2e.*` chỉ import module chỉ-test / thư viện cổng / restore route — không prisma, không import động", () => {
    const viPham = FILE_E2E.flatMap((f) => viPhamKhongChamDuLieu(f, doc(f), NGUON_DUOC_PHEP_FILE_E2E));
    expect(viPham).toEqual([]);
  });

  it("(d) không file production nào (src/scripts/prisma) nạp file `.e2e.*` hay module chỉ-test", () => {
    const viPham = [...FILE_SRC, ...lietKe("scripts"), ...lietKe("prisma")].flatMap((f) => viPhamNapChiTest(f, doc(f)));
    expect(viPham).toEqual([]);
  });

  it("(e) mọi hàm export của file `.e2e.*` (trừ client component) mở bằng cổng phiên, ngay sau là chốt `E2E_CONG_GHI`", () => {
    expect(FILE_E2E.flatMap((f) => viPhamChotRuntime(f, doc(f)))).toEqual([]);
    const chiTest = doc(MODULE_CHI_TEST[0]);
    expect(chiTest).toMatch(/export function e2eCongGhiDangBat\(\): boolean \{\n\s*return process\.env\.E2E_CONG_GHI === "1";\n\}/);
  });

  it("(f) action chỉ-test: chỉ trong file `.e2e.ts`, ghi qua cửa `vaoCuaGhi` thật (mở + nhả trong finally)", () => {
    const fileAction = FILE_E2E.filter((f) => laFileUseServer(docCay(doc(f), f)));
    expect(fileAction).toEqual(["src/app/e2e-cong-ghi/actions.e2e.ts"]);
    expect(fileAction.flatMap((f) => viPhamCuaAction(f, doc(f), ACTION_E2E_NGOAI_CUA))).toEqual([]);
    for (const khoa of Object.keys(ACTION_E2E_NGOAI_CUA)) {
      const [f, ten] = khoa.split("#");
      expect(doc(f), `${khoa} không còn — xoá khỏi ACTION_E2E_NGOAI_CUA`).toMatch(new RegExp(`export async function ${ten}\\b`));
    }
  });

  it("(g) seam restore khô: đọc ĐÚNG bảng `Symbol.for` của module chỉ-test, chỉ khi `E2E_CONG_GHI=1`", () => {
    const ten = /export const TEN_KHOA_RESTORE_KHO_E2E = "([^"]+)";/.exec(doc(MODULE_CHI_TEST[0]))?.[1];
    expect(ten).toBeTruthy();
    const restore = doc("src/app/api/restore/route.ts");
    expect(restore.split(`Symbol.for("${ten}")`).length - 1, "restore route đọc bảng đúng một chỗ").toBe(1);
    // Chốt biến là câu ĐẦU thân seam.
    expect(restore).toMatch(
      /function docRestoreKhoE2e\(request: Request\): \{ hanDrainMs: number \} \| Response \| null \{\n\s*if \(process\.env\.E2E_CONG_GHI !== "1"\) return null;/,
    );
    // Request đã đăng ký mà hạn lạ ⇒ seam trả Response (400) và POST trả ngay — không rơi về lối thật.
    expect(restore).toMatch(/const khoE2e = docRestoreKhoE2e\(request\);\n\s*if \(khoE2e instanceof Response\) return khoE2e;/);
    expect(moiSpecifier(docCay(restore, "route.ts")).filter((s) => RE_SPECIFIER_CHI_TEST.test(s))).toEqual([]);
  });

  it("(g2) trần hạn drain của restore khô = hạn drain của lượt thật (một giá trị, hai chỗ khai)", () => {
    const hanThat = /^const HAN_DRAIN_GHI_MS = ([\d_]+);$/m.exec(doc("src/app/api/restore/route.ts"))?.[1];
    const tranKho = /^export const HAN_DRAIN_KHO_TOI_DA_MS = ([\d_]+);$/m.exec(doc(MODULE_CHI_TEST[0]))?.[1];
    expect(hanThat, "không đọc được HAN_DRAIN_GHI_MS ở restore route").toBeTruthy();
    expect(Number(tranKho?.replaceAll("_", ""))).toBe(Number(hanThat?.replaceAll("_", "")));
  });

  it("(h) build thường không đặt biến build e2e: Dockerfile, CI, compose, deploy, package.json", () => {
    const nguon = [
      "Dockerfile",
      "docker-compose.yml",
      ".dockerignore",
      "package.json",
      ...readdirSync(path.join(GOC, ".github/workflows")).map((f) => `.github/workflows/${f}`),
      ...lietKeMoiFile("deploy").filter((f) => !f.endsWith(".md")),
    ].filter((f) => existsSync(path.join(GOC, f)));
    expect(nguon.length).toBeGreaterThanOrEqual(5);
    const nhac = nguon.filter((f) => /\bE2E_CONG_GHI/.test(doc(f)));
    expect(nhac, "biến e2e cổng ghi lọt vào đường build/deploy thật").toEqual([]);
    const pkg = JSON.parse(doc("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts.build).toBe("next build");
    expect(pkg.scripts["test:e2e:prod:cong-ghi"]).toBe("playwright test -c playwright.cong-ghi-prod.config.ts");
    // Dockerfile build bằng chính `npm run build` (không tự chèn biến qua ARG/ENV).
    expect(doc("Dockerfile")).toMatch(/npm run build/);
  });
});

// ─── Tự kiểm: mẫu đột biến — lưới phải ĐỎ đúng chỗ ────────────────────────────────────────────────

describe("file chỉ build e2e — mẫu đột biến", () => {
  const R = "src/app/api/x/route.e2e.ts";
  const IMPORT_CHOT = `import { e2eCongGhiDangBat } from "@/lib/backup/cong-ghi-e2e-chi-test";`;

  it("file e2e import prisma / module ghi khác / import động ⇒ đỏ", () => {
    expect(viPhamKhongChamDuLieu(R, `import { prisma } from "@/lib/prisma";`, NGUON_DUOC_PHEP_FILE_E2E)).not.toEqual([]);
    expect(viPhamKhongChamDuLieu(R, `import { createExpense } from "@/lib/actions/expenses";`, NGUON_DUOC_PHEP_FILE_E2E)).not.toEqual([]);
    expect(viPhamKhongChamDuLieu(R, `const m = await import("@/lib/prisma");`, NGUON_DUOC_PHEP_FILE_E2E)).not.toEqual([]);
    expect(viPhamKhongChamDuLieu(R, `${IMPORT_CHOT}\nimport { docBoDem } from "@/lib/backup/cong-ghi-toan-cuc";`, NGUON_DUOC_PHEP_FILE_E2E)).toEqual([]);
  });

  it("file production nạp module chỉ-test / file e2e ⇒ đỏ; chính file e2e thì được", () => {
    const P = "src/lib/actions/mau.ts";
    expect(viPhamNapChiTest(P, `import { thaBarrierE2e } from "@/lib/backup/cong-ghi-e2e-chi-test";`)).toHaveLength(1);
    expect(viPhamNapChiTest(P, `export * from "../../app/x/actions.e2e";`)).toHaveLength(1);
    expect(viPhamNapChiTest(P, `const m = await import("@/lib/backup/cong-ghi-e2e-chi-test");`)).toHaveLength(1);
    expect(viPhamNapChiTest(R, `import { thaBarrierE2e } from "@/lib/backup/cong-ghi-e2e-chi-test";`)).toEqual([]);
  });

  it("hàm export thiếu cổng phiên / thiếu chốt `E2E_CONG_GHI` ngay sau cổng ⇒ đỏ", () => {
    const CONG = `  const c = await congChuShopRoute();\n  if (!c.ok) return c.response;\n`;
    const dung = `${IMPORT_CHOT}\nexport async function GET() {\n${CONG}  if (!e2eCongGhiDangBat()) return khongCo();\n  return new Response("x");\n}`;
    expect(viPhamChotRuntime(R, dung)).toEqual([]);
    // Trang: cổng không có câu kiểm, chốt đứng ngay sau.
    const trang = `${IMPORT_CHOT}\nexport default async function P() {\n  await yeuCauChuShopTrang("/x");\n  if (!e2eCongGhiDangBat()) notFound();\n  return null;\n}`;
    expect(viPhamChotRuntime("src/app/x/page.e2e.tsx", trang)).toEqual([]);
    const khongCong = `${IMPORT_CHOT}\nexport async function GET() {\n  if (!e2eCongGhiDangBat()) return khongCo();\n}`;
    expect(viPhamChotRuntime(R, khongCong)).toEqual([`${R}#GET: câu đầu phải là cổng phiên (như code thật)`]);
    const thieu = `${IMPORT_CHOT}\nexport async function POST() {\n${CONG}  thaBarrierE2e();\n  if (!e2eCongGhiDangBat()) return khongCo();\n}`;
    expect(viPhamChotRuntime(R, thieu)).toEqual([`${R}#POST: ngay sau cổng phải là chốt \`if (!e2eCongGhiDangBat()) …\``]);
    const nguoc = `${IMPORT_CHOT}\nexport async function GET() {\n${CONG}  if (e2eCongGhiDangBat()) return khongCo();\n}`;
    expect(viPhamChotRuntime(R, nguoc)).toHaveLength(1);
    const khongImport = `export async function GET() {\n${CONG}  if (!e2eCongGhiDangBat()) return khongCo();\n}`;
    expect(viPhamChotRuntime(R, khongImport)).toHaveLength(1);
  });

  it("action e2e không qua cửa / không nhả trong finally ⇒ đỏ; ghi ngoài cửa chỉ qua khi khai đích danh", () => {
    const A = "src/app/x/actions.e2e.ts";
    const MO = `  const c = await congChuShopAction();\n  if (!c.ok) return c;\n  if (!e2eCongGhiDangBat()) return TAT;\n`;
    const dung = `"use server";\nexport async function a() {\n${MO}  const cua = vaoCuaGhi();\n  if (!cua.ok) return cua.loi;\n  try { return 1; } finally { cua.ra(); }\n}`;
    expect(viPhamCuaAction(A, dung)).toEqual([]);
    const ngoai = `"use server";\nexport async function b() {\n${MO}  return ghiThuE2e("x", "y");\n}`;
    expect(viPhamCuaAction(A, ngoai)).toHaveLength(1);
    expect(viPhamCuaAction(A, ngoai, { [`${A}#b`]: "lý do" })).toEqual([]);
    expect(viPhamCuaAction(A, dung.replace("const cua = vaoCuaGhi();", "const cua = { ok: true, ra() {} };"))).toHaveLength(1);
    expect(viPhamCuaAction(A, dung.replace("finally { cua.ra(); }", "finally { }"))).toHaveLength(1);
  });

  it("luật khớp file: `page.e2e.tsx` chỉ là trang khi có đuôi `e2e.tsx`; `page.test.tsx` không bao giờ", () => {
    expect(nextNhanLaTrangHoacRoute("page.e2e.tsx", ["tsx", "ts"])).toBe(false);
    expect(nextNhanLaTrangHoacRoute("page.e2e.tsx", ["tsx", "e2e.tsx"])).toBe(true);
    expect(nextNhanLaTrangHoacRoute("page.test.tsx", ["tsx", "e2e.tsx"])).toBe(false);
    expect(nextNhanLaTrangHoacRoute("nut.e2e.tsx", ["e2e.tsx"])).toBe(false);
  });
});
