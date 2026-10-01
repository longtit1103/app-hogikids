import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { BANG_QUYEN_MONG_DOI, BEARER_ROUTE_INGEST } from "./bang-quyen-mong-doi";
import { mucBangThua, viPhamFileAction, viPhamFileRoute, viPhamFileTrang, type TuyChonLuoi } from "./luat-cong-bat-buoc";
import {
  NGUON_DUOC_PHEP_FILE_DAC_BIET,
  phanLoaiFileApp,
  viPhamKhongChamDuLieu,
  viPhamRouteIngest,
} from "./luat-route-ingest-va-file-khong-cong";

/**
 * Tự kiểm lưới "cổng bắt buộc" bằng MẪU ĐỘT BIẾN cho các cách lách lưới "có cổng đầu thân": cổng không
 * quyền, sai module, cổng giả trùng tên, tham số mặc định chạy mã, file `.js`/`page.ts`, file đặc biệt
 * Next đọc DB, route ingest không bearer. Mỗi mẫu PHẢI làm lưới đỏ; mẫu đúng PHẢI xanh. Nhóm cuối đột
 * biến chính mã thật của repo (đọc file, sửa chuỗi trong bộ nhớ) để chắc bảng quyền thật bắt được.
 */

const GOC = path.resolve(__dirname, "../..");
const docThat = (rel: string): string | null => (existsSync(path.join(GOC, rel)) ? readFileSync(path.join(GOC, rel), "utf8") : null);

const F = "src/lib/actions/mau.ts";
const R = "src/app/api/mau/route.ts";
const P = "src/app/(app)/mau/page.tsx";
const IMPORT_ACTION = `import { congAction, congChuShopAction } from "@/lib/quyen/cong-action";`;
const IMPORT_ROUTE = `import { congRoute, congChuShopRoute } from "@/lib/quyen/cong-route";`;
const IMPORT_TRANG = `import { yeuCauQuyenTrang, yeuCauChuShopTrang } from "@/lib/quyen/cong-trang";`;
const GATE_CHI_PHI = [`  const c = await congAction("chi-phi:sua");`, `  if (!c.ok) return c;`];

function tuyChon(bang: TuyChonLuoi["bang"], them: Partial<TuyChonLuoi> = {}): TuyChonLuoi {
  return { allowKhongCong: {}, bang, docFile: () => null, ...them };
}
const action = (p: TuyChonLuoi, ...dong: string[]) =>
  viPhamFileAction(F, [`"use server";`, IMPORT_ACTION, ...dong].join("\n"), p);
const actionTho = (p: TuyChonLuoi, ...dong: string[]) => viPhamFileAction(F, [`"use server";`, ...dong].join("\n"), p);
const trang = (p: TuyChonLuoi, ...dong: string[]) =>
  viPhamFileTrang(P, [IMPORT_TRANG, ...dong].join("\n"), { ...p, trangKhongCong: {} });
const route = (p: TuyChonLuoi, ...dong: string[]) => viPhamFileRoute(R, [IMPORT_ROUTE, ...dong].join("\n"), p);

describe("bảng quyền — cổng không quyền chỉ hợp lệ khi bảng khai CHI_DANG_NHAP", () => {
  const coCong = (goi: string) => [`export async function sua(id: string) {`, `  const c = await ${goi};`, `  if (!c.ok) return c;`, `  return 1;`, `}`];

  it("`congAction()` đứng trước mutation mà bảng khai quyền ⇒ đỏ", () => {
    expect(action(tuyChon({ [`${F}#sua`]: "chi-phi:sua" }), ...coCong("congAction()"))).toEqual([
      `${F}#sua: cổng thực tế CHI_DANG_NHAP ≠ bảng chi-phi:sua`,
    ]);
  });

  it("bảng khai CHI_DANG_NHAP ⇒ `congAction()` xanh; nhưng cổng có quyền thì lệch ⇒ đỏ", () => {
    expect(action(tuyChon({ [`${F}#sua`]: "CHI_DANG_NHAP" }), ...coCong("congAction()"))).toEqual([]);
    expect(action(tuyChon({ [`${F}#sua`]: "CHI_DANG_NHAP" }), ...coCong(`congAction("chi-phi:sua")`))).toHaveLength(1);
  });

  it("trang `yeuCauQuyenTrang(path)` (không quyền) thay cho quyền module / thay cổng chủ shop ⇒ đỏ", () => {
    const dong = [`export default async function P() {`, `  await yeuCauQuyenTrang("/mau");`, `  return null;`, `}`];
    expect(trang(tuyChon({ [`${P}#default`]: "don-hang:xem" }), ...dong)).toEqual([
      `${P}#default: cổng thực tế CHI_DANG_NHAP ≠ bảng don-hang:xem`,
    ]);
    expect(trang(tuyChon({ [`${P}#default`]: "CHU_SHOP" }), ...dong)).toEqual([
      `${P}#default: cổng thực tế CHI_DANG_NHAP ≠ bảng CHU_SHOP`,
    ]);
    expect(trang(tuyChon({ [`${P}#default`]: "CHI_DANG_NHAP" }), ...dong)).toEqual([]);
  });

  it("`undefined` / spread làm đối số quyền ⇒ đỏ (không gập được thành hằng)", () => {
    const bang = { [`${F}#sua`]: "chi-phi:sua" } as const;
    expect(action(tuyChon(bang), ...coCong("congAction(undefined)"))).toHaveLength(1);
    expect(action(tuyChon(bang), ...coCong("congAction(...ds)"))).toHaveLength(1);
  });
});

describe("bảng quyền — sai module, thiếu mục, mục thừa", () => {
  const coCong = (doiSo: string) => [
    `export async function xoaVay(id: string) {`,
    `  const c = await congAction(${doiSo});`,
    `  if (!c.ok) return c;`,
    `  await prisma.loan.delete({ where: { id } });`,
    `}`,
  ];
  const bang = { [`${F}#xoaVay`]: "tai-chinh-so-quy:sua" } as const;

  it("`congAction(\"don-hang:xem\")` trước `prisma.loan.delete` ⇒ đỏ; đúng quyền ⇒ xanh", () => {
    expect(action(tuyChon(bang), ...coCong(`"don-hang:xem"`))).toEqual([
      `${F}#xoaVay: cổng thực tế don-hang:xem ≠ bảng tai-chinh-so-quy:sua`,
    ]);
    expect(action(tuyChon(bang), ...coCong(`"tai-chinh-so-quy:sua"`))).toEqual([]);
  });

  it("export chưa có mục trong bảng ⇒ đỏ", () => {
    expect(action(tuyChon({}), ...coCong(`"tai-chinh-so-quy:sua"`))).toEqual([
      `${F}#xoaVay: thiếu mục trong bảng quyền mong đợi (tests/luoi/bang-quyen-mong-doi.ts)`,
    ]);
  });

  it("mục bảng không còn export ⇒ đỏ", () => {
    expect(mucBangThua({ "a#x": "CHU_SHOP", "a#y": "CHU_SHOP" }, ["a#x"])).toEqual(["a#y"]);
  });

  it("mảng quyền so như TẬP: đổi thứ tự xanh; thiếu/thừa phần tử hoặc chuỗi-vs-mảng ⇒ đỏ", () => {
    const b = { [`${F}#xoaVay`]: ["chi-phi:sua", "tai-chinh-so-quy:sua"] } as const;
    expect(action(tuyChon(b), ...coCong(`["tai-chinh-so-quy:sua", "chi-phi:sua"]`))).toEqual([]);
    expect(action(tuyChon(b), ...coCong(`["tai-chinh-so-quy:sua", "chi-phi:sua", "don-hang:xem"]`))).toHaveLength(1);
    expect(action(tuyChon(b), ...coCong(`["tai-chinh-so-quy:sua"]`))).toHaveLength(1);
    expect(action(tuyChon(bang), ...coCong(`["tai-chinh-so-quy:sua"]`))).toHaveLength(1);
  });

  it("hằng quyền: const cùng file / import / tái xuất đều gập đúng; `let`, tham số, lời gọi hàm ⇒ đỏ", () => {
    const docFile = (rel: string): string | null =>
      ({
        "src/lib/quyen-mau.ts": `export const Q_VAY = Object.freeze(["tai-chinh-so-quy:sua"] as const);\nexport const Q_SAI = "don-hang:xem";`,
        "src/lib/tai-xuat.ts": `export { Q_VAY as Q_KHAC, Q_SAI } from "@/lib/quyen-mau";`,
      })[rel] ?? null;
    const b = tuyChon({ [`${F}#xoaVay`]: ["tai-chinh-so-quy:sua"] }, { docFile });
    const voi = (...dau: string[]) => (doiSo: string) => action(b, ...dau, ...coCong(doiSo));
    expect(voi(`const Q = ["tai-chinh-so-quy:sua"] as const;`)("Q")).toEqual([]);
    expect(voi(`import { Q_VAY } from "@/lib/quyen-mau";`)("Q_VAY")).toEqual([]);
    expect(voi(`import { Q_KHAC } from "@/lib/tai-xuat";`)("Q_KHAC")).toEqual([]);
    expect(voi(`import { Q_SAI } from "@/lib/tai-xuat";`)("[Q_SAI]")).toHaveLength(1);
    expect(voi(`let Q = ["tai-chinh-so-quy:sua"];`)("Q")).toHaveLength(1);
    expect(voi(`import { layQuyen } from "@/lib/quyen-mau";`)("layQuyen()")).toHaveLength(1);
    // Tham số trùng tên const cấp file: giá trị THẬT là của người gọi, không phải hằng.
    const thamSo = action(
      b,
      `const Q = ["tai-chinh-so-quy:sua"] as const;`,
      `export async function xoaVay(Q: string[]) {`,
      `  const c = await congAction(Q);`,
      `  if (!c.ok) return c;`,
      `}`,
    );
    expect(thamSo).toEqual([`${F}#xoaVay: đối số cổng dùng tham số \`Q\` của hàm (giá trị từ người gọi)`]);
  });

  it("route/trang: sai quyền so bảng ⇒ đỏ; cổng chủ shop thay bằng cổng quyền ⇒ đỏ", () => {
    const get = (goi: string) => [`export async function GET() {`, `  const c = await ${goi};`, `  if (!c.ok) return c.response;`, `  return new Response("ok");`, `}`];
    expect(route(tuyChon({ [`${R}#GET`]: "ton-kho:xem" }), ...get(`congRoute("don-hang:xem")`))).toHaveLength(1);
    expect(route(tuyChon({ [`${R}#GET`]: "CHU_SHOP" }), ...get(`congRoute("cai-dat:sua")`))).toHaveLength(1);
    expect(route(tuyChon({ [`${R}#GET`]: "CHU_SHOP" }), ...get(`congChuShopRoute()`))).toEqual([]);
  });
});

describe("cổng phải đến từ đúng module `@/lib/quyen/cong-*`", () => {
  const bang = { [`${F}#sua`]: "chi-phi:sua" } as const;
  const than = [`export async function sua() {`, ...GATE_CHI_PHI, `  return 1;`, `}`];

  it("import cổng từ module khác (cổng giả) ⇒ đỏ", () => {
    expect(actionTho(tuyChon(bang), `import { congAction } from "./cong-gia";`, ...than)).toEqual([
      `${F}: \`congAction\` import từ "./cong-gia" — cổng/hàm kiểm thật chỉ ở "@/lib/quyen/cong-action"`,
      `${F}: \`congAction\` được gọi mà không import từ "@/lib/quyen/cong-action"`,
    ]);
  });

  it("khai báo cục bộ trùng tên cổng (const/function/tham số) ⇒ đỏ", () => {
    for (const cucBo of [`const congAction = async (_q?: string) => ({ ok: true as const });`, `async function congAction() { return { ok: true }; }`]) {
      const v = actionTho(tuyChon(bang), cucBo, ...than);
      expect(v.some((l) => l.includes("khai báo cục bộ")), cucBo).toBe(true);
    }
    expect(
      action(tuyChon(bang), `export async function sua(congAction: () => Promise<{ ok: true }>) {`, ...GATE_CHI_PHI, `}`),
    ).toEqual([`${F}: \`congAction\` khai báo cục bộ (\`congAction: () => Promise<{ ok: true }>\`) — che cổng/hàm kiểm thật`]);
  });

  it("import đổi tên / chỉ-kiểu / mặc định / namespace ⇒ đỏ", () => {
    expect(
      actionTho(tuyChon(bang), `import { congChuShopAction as congAction } from "@/lib/quyen/cong-action";`, ...than).some((l) =>
        l.includes("tên đổi"),
      ),
    ).toBe(true);
    const co = (dong: string, doan: string) => actionTho(tuyChon(bang), dong, ...than).some((l) => l.includes(doan));
    expect(co(`import type { congAction } from "@/lib/quyen/cong-action";`, "import chỉ-kiểu")).toBe(true);
    expect(co(`import congAction from "@/lib/quyen/cong-action";`, "import mặc định")).toBe(true);
    expect(co(`import * as congAction from "@/lib/quyen/cong-action";`, "namespace import")).toBe(true);
  });

  it("gọi cổng không import (dựa vào biến toàn cục) ⇒ đỏ", () => {
    expect(actionTho(tuyChon(bang), ...than)).toEqual([`${F}: \`congAction\` được gọi mà không import từ "@/lib/quyen/cong-action"`]);
  });

  it("route/trang import cổng từ module của loại khác ⇒ đỏ", () => {
    const get = [`export async function GET() {`, `  const c = await congRoute("ton-kho:xem");`, `  if (!c.ok) return c.response;`, `}`];
    const b = tuyChon({ [`${R}#GET`]: "ton-kho:xem" });
    expect(viPhamFileRoute(R, [`import { congRoute } from "@/lib/quyen/cong-action";`, ...get].join("\n"), b)[0]).toContain(
      `import từ "@/lib/quyen/cong-action" — cổng/hàm kiểm thật chỉ ở "@/lib/quyen/cong-route"`,
    );
    expect(viPhamFileRoute(R, [IMPORT_ROUTE, ...get].join("\n"), b)).toEqual([]);
    const pg = [`export default async function P() {`, `  await yeuCauQuyenTrang("/mau", "don-hang:xem");`, `}`];
    const bp = { ...tuyChon({ [`${P}#default`]: "don-hang:xem" }), trangKhongCong: {} };
    expect(viPhamFileTrang(P, [IMPORT_TRANG, ...pg].join("\n"), bp)).toEqual([]);
    expect(viPhamFileTrang(P, [`import { yeuCauQuyenTrang } from "@/lib/quyen/cong-trang-gia";`, ...pg].join("\n"), bp)[0]).toContain(
      `import từ "@/lib/quyen/cong-trang-gia"`,
    );
  });
});

describe("tham số mặc định chạy mã TRƯỚC cổng ⇒ đỏ", () => {
  const bang = { [`${F}#sua`]: "chi-phi:sua", [`${F}#logout`]: "KHONG_CONG" } as const;

  it("`_t = xoa(id)` ở action có cổng ⇒ đỏ; mặc định hằng ⇒ xanh", () => {
    expect(action(tuyChon(bang), `export async function sua(id: string, _t = xoa(id)) {`, ...GATE_CHI_PHI, `}`)).toEqual([
      `${F}#sua: tham số mặc định chạy mã trước cổng — \`_t = xoa(id)\``,
    ]);
    expect(action(tuyChon(bang), `export async function sua(id: string, n = 5, s = "x") {`, ...GATE_CHI_PHI, `}`)).toEqual([]);
  });

  it("mặc định trong bóc tách / `new` / await / template gắn thẻ / gán ⇒ đỏ", () => {
    for (const thamSo of ["{ a = xoa() }: { a?: number }", "d = new Date()", "x = await y", "t = sql`DELETE`", "z = (g = 1)"]) {
      expect(action(tuyChon(bang), `export async function sua(${thamSo}) {`, ...GATE_CHI_PHI, `}`), thamSo).toHaveLength(1);
    }
  });

  it("action miễn cổng, route handler, trang cũng bị soi", () => {
    const allow = { [`${F}#logout`]: "lý do" };
    expect(action(tuyChon(bang, { allowKhongCong: allow }), `export async function logout(_x = xoaHet()) { return 1; }`)).toHaveLength(1);
    expect(
      route(tuyChon({ [`${R}#GET`]: "ton-kho:xem" }), `export async function GET(req: Request, _x = xoa()) {`, `  const c = await congRoute("ton-kho:xem");`, `  if (!c.ok) return c.response;`, `}`),
    ).toHaveLength(1);
    expect(
      trang(tuyChon({ [`${P}#default`]: "don-hang:xem" }), `export default async function P(_p = xoa()) {`, `  await yeuCauQuyenTrang("/mau", "don-hang:xem");`, `}`),
    ).toHaveLength(1);
  });
});

describe("mọi đuôi mã nguồn (.js/.jsx/.mjs, page.ts) nằm trong lưới", () => {
  it("xếp loại file dưới src/app theo tên, bất kể đuôi", () => {
    expect(phanLoaiFileApp("src/app/(app)/x/page.ts")).toBe("trang");
    expect(phanLoaiFileApp("src/app/(app)/x/page.js")).toBe("trang");
    expect(phanLoaiFileApp("src/app/(app)/x/page.jsx")).toBe("trang");
    expect(phanLoaiFileApp("src/app/(app)/layout.mjs")).toBe("trang");
    expect(phanLoaiFileApp("src/app/api/x/route.js")).toBe("route");
    expect(phanLoaiFileApp("src/app/api/x/route.mjs")).toBe("route");
    expect(phanLoaiFileApp("src/app/(auth)/dang-nhap/login-form.tsx")).toBe("module");
    expect(phanLoaiFileApp("src/app/globals.css")).toBeNull();
    expect(phanLoaiFileApp("src/app/favicon.ico")).toBeNull();
  });

  it("action `.js` / `.mjs` không cổng ⇒ đỏ; trang `.jsx` không cổng ⇒ đỏ", () => {
    const src = `"use server";\nexport async function xoa() { await prisma.expense.deleteMany({}); }`;
    for (const f of ["src/lib/actions/x.js", "src/lib/actions/x.mjs", "src/lib/actions/x.cjs"]) {
      expect(viPhamFileAction(f, src, tuyChon({})), f).toEqual([`${f}#xoa: câu lệnh đầu tiên không phải cổng`]);
    }
    const pj = "src/app/(app)/x/page.jsx";
    const khongCong = `export default async function P() {\n  const d = await prisma.order.findMany();\n  return <div>{d.length}</div>;\n}`;
    expect(viPhamFileTrang(pj, khongCong, { ...tuyChon({}), trangKhongCong: {} })).toEqual([
      `${pj}#default: câu lệnh đầu tiên không phải cổng`,
    ]);
  });
});

describe("file đặc biệt Next không chạm lớp dữ liệu", () => {
  const og = "src/app/(app)/tai-chinh/opengraph-image.tsx";
  const kiem = (src: string) => viPhamKhongChamDuLieu(og, src, NGUON_DUOC_PHEP_FILE_DAC_BIET);

  it("tên file đặc biệt được nhận diện", () => {
    for (const ten of ["opengraph-image.tsx", "twitter-image.tsx", "icon.tsx", "icon2.tsx", "apple-icon.tsx", "sitemap.ts", "robots.ts", "default.tsx", "loading.tsx", "error.tsx", "global-error.tsx", "template.tsx", "not-found.tsx"]) {
      expect(phanLoaiFileApp(`src/app/(app)/${ten}`), ten).toBe("dac-biet");
    }
  });

  it("import prisma / query / lib nghiệp vụ / import() động / globalThis.prisma ⇒ đỏ", () => {
    expect(kiem(`import { prisma } from "@/lib/prisma";\nexport default async function I() { return prisma.order.count(); }`)).toContain(
      `${og}: import "@/lib/prisma" — file không cổng không được chạm lớp dữ liệu`,
    );
    expect(kiem(`import { listOrders } from "@/lib/queries/orders";\nexport default async function I() { return listOrders(); }`)).toHaveLength(1);
    expect(kiem(`import { calcPnl } from "@/lib/reports/pnl";`)).toHaveLength(1);
    expect(kiem(`import { BangLai } from "@/components/finance/bang-lai";`)).toHaveLength(1);
    expect(kiem(`export default async function I() { const m = await import("@/lib/prisma"); return m; }`)).toHaveLength(1);
    expect(kiem(`export default async function I() { return (globalThis as any).prisma.order.count(); }`)).toHaveLength(1);
  });

  it("khung giao diện (react/next/ui/format) và import chỉ-kiểu ⇒ xanh", () => {
    expect(
      kiem(
        [
          `import Link from "next/link";`,
          `import { ImageResponse } from "next/og";`,
          `import { Skeleton } from "@/components/ui/skeleton";`,
          `import { formatVnd } from "@/lib/format";`,
          `import type { Order } from "@prisma/client";`,
          `export default function L() { return null; }`,
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

describe("route ingest: hàm kiểm bearer là câu đầu handler", () => {
  const I = "src/app/api/ingest/moi/route.ts";
  const IMPORT_INGEST = `import { requireIngestSecret } from "@/lib/ingest/ingest-auth";`;
  const bearer = { [`${I}#POST`]: "requireIngestSecret" } as const;
  const kiem = (...dong: string[]) => viPhamRouteIngest(I, dong.join("\n"), bearer);
  const dung = [`  const unauthorized = requireIngestSecret(req);`, `  if (unauthorized) return unauthorized;`];

  it("mẫu đúng xanh (kể cả `return noStore(x)`)", () => {
    expect(kiem(IMPORT_INGEST, `export async function POST(req: Request) {`, ...dung, `  return new Response("ok");`, `}`)).toEqual([]);
    expect(
      kiem(IMPORT_INGEST, `export async function POST(req: Request) {`, `  const u = requireIngestSecret(req);`, `  if (u) { return noStore(u); }`, `}`),
    ).toEqual([]);
  });

  it("route dưới api/ingest KHÔNG bearer ⇒ đỏ", () => {
    expect(kiem(`export async function POST(req: Request) {`, `  await prisma.order.deleteMany({});`, `}`)).toEqual([
      `${I}#POST: câu lệnh đầu tiên không phải \`const x = requireIngestSecret(req);\``,
    ]);
  });

  it("bearer SAU truy vấn, không trả kết quả, kiểm request khác ⇒ đỏ", () => {
    expect(kiem(IMPORT_INGEST, `export async function POST(req: Request) {`, `  await prisma.x.delete({});`, ...dung, `}`)).toHaveLength(1);
    expect(kiem(IMPORT_INGEST, `export async function POST(req: Request) {`, `  const u = requireIngestSecret(req);`, `  if (!u) return u;`, `}`)).toHaveLength(1);
    expect(kiem(IMPORT_INGEST, `export async function POST(req: Request) {`, `  const u = requireIngestSecret(req);`, `  await prisma.x.delete({});`, `}`)).toHaveLength(1);
    expect(
      kiem(IMPORT_INGEST, `export async function POST(req: Request) {`, `  const u = requireIngestSecret(new Request("http://x", { headers: { authorization: "Bearer " + process.env.INGEST_SECRET } }));`, `  if (u) return u;`, `}`),
    ).toHaveLength(1);
  });

  it("hàm bearer giả (import nơi khác / tự khai) hoặc sai loại so bảng ⇒ đỏ", () => {
    expect(kiem(`import { requireIngestSecret } from "./gia";`, `export async function POST(req: Request) {`, ...dung, `}`)[0]).toContain(
      `import từ "./gia"`,
    );
    expect(kiem(`const requireIngestSecret = (_r: Request) => null;`, `export async function POST(req: Request) {`, ...dung, `}`)[0]).toContain(
      "khai báo cục bộ",
    );
    const sai = viPhamRouteIngest(
      I,
      [`import { requireTokenVaultSecret } from "@/lib/ingest/token-vault-auth";`, `export async function POST(req: Request) {`, `  const u = requireTokenVaultSecret(req);`, `  if (u) return u;`, `}`].join("\n"),
      bearer,
    );
    expect(sai).toHaveLength(1);
  });

  it("handler ingest chưa khai trong BEARER_ROUTE_INGEST ⇒ đỏ", () => {
    expect(viPhamRouteIngest(I, [IMPORT_INGEST, `export async function GET(req: Request) {`, ...dung, `}`].join("\n"), bearer)).toEqual([
      `${I}#GET: thiếu mục trong BEARER_ROUTE_INGEST`,
    ]);
  });

  it("route công khai import module chưa khai ⇒ đỏ", () => {
    const U = "src/app/api/uploads/[name]/route.ts";
    expect(viPhamKhongChamDuLieu(U, `import { prisma } from "@/lib/prisma";`, ["node:path"])[0]).toContain(`import "@/lib/prisma"`);
    expect(viPhamKhongChamDuLieu(U, `import path from "node:path";`, ["node:path"])).toEqual([]);
  });
});

describe("đột biến trên MÃ THẬT của repo — bảng quyền thật phải bắt", () => {
  const LUOI = tuyChon(BANG_QUYEN_MONG_DOI, { docFile: docThat });
  const docBat = (rel: string): string => {
    const s = docThat(rel);
    if (s === null) throw new Error(`thiếu ${rel}`);
    return s;
  };
  /** Thay đúng MỘT chỗ (đột biến phải trúng đích, không lan). */
  const thay1 = (s: string, a: string, b: string): string => {
    expect(s.split(a).length - 1, `chuỗi đột biến "${a}" phải xuất hiện đúng 1 lần`).toBe(1);
    return s.replace(a, b);
  };
  const ham = (s: string, ten: string) => s.indexOf(`export async function ${ten}(`);
  /** Thay chỗ đầu tiên của `a` SAU khai báo hàm `ten`. */
  const thayTrongHam = (s: string, ten: string, a: string, b: string): string => {
    const i = ham(s, ten);
    expect(i, ten).toBeGreaterThanOrEqual(0);
    const j = s.indexOf(a, i);
    expect(j, `${ten}: không thấy "${a}"`).toBeGreaterThan(i);
    return s.slice(0, j) + b + s.slice(j + a.length);
  };

  it("mã thật nguyên vẹn ⇒ xanh (đối chứng)", () => {
    const f = "src/lib/actions/cash-movements.ts";
    expect(viPhamFileAction(f, docBat(f), LUOI)).toEqual([]);
  });

  it("deleteCashMovement hạ cổng xuống `tai-chinh-dong-tien:xem` ⇒ đỏ", () => {
    const f = "src/lib/actions/cash-movements.ts";
    const s = thayTrongHam(docBat(f), "deleteCashMovement", `congAction("tai-chinh-dong-tien:sua")`, `congAction("tai-chinh-dong-tien:xem")`);
    expect(viPhamFileAction(f, s, LUOI)).toEqual([
      `${f}#deleteCashMovement: cổng thực tế tai-chinh-dong-tien:xem ≠ bảng tai-chinh-dong-tien:sua`,
    ]);
  });

  it("ghiKyTraNo dùng cổng Dòng tiền thay Sổ quỹ ⇒ đỏ", () => {
    const f = "src/lib/actions/khoan-vay.ts";
    const s = thayTrongHam(docBat(f), "ghiKyTraNo", `congAction("tai-chinh-so-quy:sua")`, `congAction("tai-chinh-dong-tien:sua")`);
    expect(viPhamFileAction(f, s, LUOI)).toHaveLength(1);
  });

  it("createExpense bỏ quyền (`congAction()`) ⇒ đỏ", () => {
    const f = "src/lib/actions/expenses.ts";
    const s = thayTrongHam(docBat(f), "createExpense", `congAction("chi-phi:sua")`, `congAction()`);
    expect(viPhamFileAction(f, s, LUOI)).toEqual([`${f}#createExpense: cổng thực tế CHI_DANG_NHAP ≠ bảng chi-phi:sua`]);
  });

  it("trang /quan-tri đổi cổng chủ shop sang cổng chỉ-đăng-nhập ⇒ đỏ", () => {
    const f = "src/app/(app)/quan-tri/page.tsx";
    const s = docBat(f).replaceAll("yeuCauChuShopTrang", "yeuCauQuyenTrang");
    expect(viPhamFileTrang(f, s, { ...LUOI, trangKhongCong: {} })).toEqual([
      `${f}#default: cổng thực tế CHI_DANG_NHAP ≠ bảng CHU_SHOP`,
    ]);
  });

  it("export gia-von hạ cổng xuống module khác ⇒ đỏ", () => {
    const f = "src/app/api/export/gia-von/route.ts";
    const s = thay1(docBat(f), `congRoute("san-pham:xem")`, `congRoute("don-hang:xem")`);
    expect(viPhamFileRoute(f, s, LUOI)).toHaveLength(1);
  });

  it("route ingest/raw mất dòng bearer ⇒ đỏ", () => {
    const f = "src/app/api/ingest/raw/route.ts";
    const s = thay1(docBat(f), "  const unauthorized = requireIngestSecret(req);\n  if (unauthorized) return unauthorized;\n", "");
    expect(viPhamRouteIngest(f, s, BEARER_ROUTE_INGEST)).toContain(
      `${f}#POST: câu lệnh đầu tiên không phải \`const x = requireIngestSecret(req);\``,
    );
  });

  it("thùng rác: hằng quyền đổi ở module gốc ⇒ bảng bắt qua tái xuất", () => {
    const goc = "src/lib/thung-rac/quyen-thung-rac.ts";
    const f = "src/app/(app)/tai-chinh/thung-rac/page.tsx";
    const docDotBien = (rel: string) =>
      rel === goc ? thay1(docBat(goc), `  "tai-chinh-so-quy:sua",\n]);`, `  "tai-chinh-so-quy:sua",\n  "don-hang:xem",\n]);`) : docThat(rel);
    expect(viPhamFileTrang(f, docBat(f), { ...LUOI, trangKhongCong: {} })).toEqual([]);
    expect(viPhamFileTrang(f, docBat(f), { ...LUOI, docFile: docDotBien, trangKhongCong: {} })).toHaveLength(1);
  });
});
