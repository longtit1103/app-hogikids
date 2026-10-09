import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { ANH_XA_ACTION_HANH_DONG } from "@/lib/nhat-ky/hanh-dong";

import { ALLOWLIST_WRAPPER_CU } from "./allowlist-wrapper-cu";
import { BANG_QUYEN_MONG_DOI, BEARER_ROUTE_INGEST, ROUTE_CONG_KHAI } from "./bang-quyen-mong-doi";
import {
  mucBangThua,
  phanLoaiAction,
  viPhamFileAction,
  viPhamFileRoute,
  viPhamFileTrang,
  type LoaiQua,
  type TuyChonLuoi,
} from "./luat-cong-bat-buoc";
import {
  NGUON_DUOC_PHEP_FILE_DAC_BIET,
  phanLoaiFileApp,
  viPhamKhongChamDuLieu,
  viPhamRouteIngest,
} from "./luat-route-ingest-va-file-khong-cong";
import {
  coDinhDanh,
  coUseServerBatKy,
  docCay,
  laAsync,
  laFileMaNguon,
  laFileUseServer,
  lietKeExport,
} from "./phan-tich-cong-bang-ast";

/**
 * LƯỚI TĨNH "cổng bắt buộc" (spec phân quyền §8.1). Đọc MÃ NGUỒN (cây cú pháp TypeScript, xem
 * `phan-tich-cong-bang-ast.ts`) thay vì import: một trang/action/route quên gọi cổng vẫn biên dịch và
 * chạy xanh mọi test hành vi — chỉ lưới này thấy được.
 *
 * Luật: cổng là CÂU LỆNH ĐẦU TIÊN của thân TỪNG hàm export (action, từng handler route, component
 * trang/layout mặc định), import từ ĐÚNG module `@/lib/quyen/cong-*`, kết quả cổng action/route được
 * kiểm ngay câu sau, và ĐỐI SỐ cổng khớp bảng quyền mong đợi (`bang-quyen-mong-doi.ts`). Không tham
 * số mặc định chạy mã. Route ingest mở bằng hàm kiểm bearer; route công khai + file đặc biệt Next
 * không chạm lớp dữ liệu. Mọi ngoại lệ khai đích danh `"<file>#<tên>"` hoặc đường dẫn file, mỗi mục
 * một lý do. Luật thuần ở `luat-cong-bat-buoc.ts`; mẫu đột biến ở đây và
 * `cong-bat-buoc-tu-kiem-dot-bien.test.ts`.
 */
const GOC = path.resolve(__dirname, "../..");

/**
 * Action được phép KHÔNG gọi cổng — khoá theo `"<file>#<tên>"` (hàm trùng tên ở file khác KHÔNG được
 * miễn). Chỉ giữ cửa phiên — nơi người gọi CHƯA có (hoặc chưa được dùng) phiên hợp lệ.
 */
export const ALLOW_ACTION_KHONG_CONG: Readonly<Record<string, string>> = {
  "src/lib/actions/auth.ts#login": "Cửa TẠO phiên — người gọi chưa có phiên để qua cổng.",
  "src/lib/actions/auth.ts#logout": "Phải chạy được khi phiên hỏng/đang phải đổi mật khẩu (allowlist cứng spec §3.3).",
  "src/lib/actions/doi-mat-khau-lan-dau.ts#doiMatKhauLanDau":
    "Chạy khi `phaiDoiMatKhau` = true — ba cổng đều từ chối trạng thái này (spec §3.3); tự đọc `docNguoiDungPhien()` + đòi đúng cờ đó.",
};

/** Action đã qua cổng nhưng KHÔNG cần dòng nhật ký — chỉ đọc/kiểm thử, không thay đổi dữ liệu. */
export const ALLOW_ACTION_KHONG_NHAT_KY: Readonly<Record<string, string>> = {
  "src/lib/actions/ads-import.ts#previewAdsImport": "Chỉ phân tích file tải lên, chưa ghi.",
  "src/lib/actions/data-admin.ts#coDuLieuGiaoDich": "Chỉ đếm dòng các bảng giao dịch.",
  "src/lib/actions/data-admin.ts#demChiPhiKhongDungLai": "Chỉ đếm/cộng chi phí nhập tay.",
  "src/lib/actions/data-admin.ts#demDonMoCoi": "Chỉ đếm đơn mồ côi.",
  "src/lib/actions/data-admin.ts#demAdsMoCoi": "Chỉ đếm chi tiêu ads mồ côi.",
  "src/lib/actions/cost-price.ts#previewCostImport": "Chỉ so file với giá vốn hiện có, chưa ghi.",
  "src/lib/actions/shopee-wallet-import.ts#previewShopeeWalletImport": "Chỉ phân tích file ví, chưa ghi.",
  "src/lib/actions/n8n-ket-noi.ts#kiemTraKetNoiN8n": "Đọc kho + GET danh sách workflow, không ghi.",
  "src/lib/actions/settings-khoa-ket-noi.ts#kiemTraKetNoiNguon": "Đọc kho + gọi thử nguồn ngoài, không ghi.",
  "src/lib/actions/settings-channels.ts#countRecomputableOrders": "Chỉ đếm đơn.",
  "src/lib/actions/sync.ts#getLatestSync": "Chỉ đọc SyncLog.",
  "src/lib/actions/sync.ts#getTienDoDongBoNgay": "Chỉ đọc SyncLog (tiến độ lượt Đồng bộ ngay).",
  "src/lib/actions/uoc-tinh-sao-ke.ts#docUocTinhSaoKe": "Chỉ đọc: dư nợ ước tính của thẻ tại một ngày (form chốt sao kê), không ghi.",
  "src/lib/actions/bat-no-phai-tra.ts#docChenhLechTaiM":
    "Chỉ đọc: chênh lệch quỹ app ↔ tiền thật tại ngày bật nợ phải trả (bước 2 màn xác nhận), không ghi.",
  "src/lib/actions/khoang-ngay.ts#luuLuaChonKhoangNgay":
    "Không đọc/ghi DB — chỉ ghi cookie tuỳ chọn khoảng ngày của chính trình duyệt.",
};

/**
 * Export (giá trị) DUY NHẤT được có ở `src/lib/session.ts` — cookie phiên + epoch thu hồi. KHÔNG có hàm
 * "chỉ đòi đăng nhập" nào: kiểm phiên/quyền đi qua ba cổng `@/lib/quyen/cong-*` (spec §3.4).
 */
const EXPORT_SESSION_DUOC_PHEP: readonly string[] = [
  "sinhMocPhien",
  "thuHoiPhienCuaNguoi",
  "thuHoiMoiPhienMoiNguoi",
  "getSession",
  "createSession",
  "destroySession",
  "docGhiNhoCuaPhien",
];

/** Mục allowlist được phép trỏ tới action chưa tồn tại (phase sau mới viết). */
const CHUA_TON_TAI_DUOC_PHEP = new Set<string>();

/**
 * Trang/layout dưới `src/app` được phép KHÔNG gọi cổng trang — mỗi mục một lý do (bảng quyền khai
 * `KHONG_CONG`). Lưới còn cấm các file này import thẳng `@/lib/prisma` (không cổng thì không tự đọc DB).
 */
const TRANG_KHONG_CONG: Readonly<Record<string, string>> = {
  "src/app/layout.tsx": "Layout gốc bọc cả trang công khai (đăng nhập, 404) — chỉ khung HTML + metadata.",
  "src/app/(auth)/dang-nhap/page.tsx": "Trang đăng nhập — người gọi chưa có phiên (tự đẩy đi khi đã có).",
  "src/app/(auth)/doi-mat-khau-lan-dau/page.tsx":
    "Trang của người còn cờ `phaiDoiMatKhau` — cả ba cổng trang đều đẩy họ về đây nên dùng cổng là vòng chuyển hướng; tự đọc `docNguoiDungPhien()`, không tự đọc DB.",
  "src/app/(app)/chi-phi/page.tsx": "Bookmark cũ → redirect thẳng `/tai-chinh?tab=so-chi-phi` (xem ca 2b).",
};

/** Trang trong `TRANG_KHONG_CONG` chỉ làm đúng một việc `redirect()` — ca 2b kiểm cho chắc. */
const TRANG_CHI_CHUYEN_HUONG = ["src/app/(app)/chi-phi/page.tsx"];

/** Route dưới thư mục này KHÔNG qua ba cổng mà qua bearer — từng handler khai ở `BEARER_ROUTE_INGEST`. */
const THU_MUC_INGEST = "src/app/api/ingest/";

// ─── Đọc cây repo ─────────────────────────────────────────────────────────────────────────────────

function lietKe(thuMucRel: string, loc: (rel: string) => boolean): string[] {
  const ketQua: string[] = [];
  const di = (rel: string) => {
    for (const e of readdirSync(path.join(GOC, rel), { withFileTypes: true })) {
      const con = `${rel}/${e.name}`;
      if (e.isDirectory()) di(con);
      else if (loc(con)) ketQua.push(con);
    }
  };
  di(thuMucRel);
  return ketQua.sort();
}

const doc = (rel: string) => readFileSync(path.join(GOC, rel), "utf8");
const docNeuCo = (rel: string): string | null => (existsSync(path.join(GOC, rel)) ? doc(rel) : null);
const FILE_SRC = lietKe("src", laFileMaNguon);
const FILE_ACTION = lietKe("src/lib/actions", laFileMaNguon).filter((f) => laFileUseServer(docCay(doc(f), f)));

const FILE_APP = lietKe("src/app", laFileMaNguon);
const FILE_TRANG = FILE_APP.filter((f) => phanLoaiFileApp(f) === "trang");
const FILE_ROUTE = FILE_APP.filter((f) => phanLoaiFileApp(f) === "route");
const FILE_DAC_BIET = FILE_APP.filter((f) => phanLoaiFileApp(f) === "dac-biet");

const LUOI: TuyChonLuoi = { allowKhongCong: ALLOW_ACTION_KHONG_CONG, bang: BANG_QUYEN_MONG_DOI, docFile: docNeuCo };

type Action = { khoa: string; ten: string; loai: LoaiQua | null };

function docMoiAction(): Action[] {
  return FILE_ACTION.flatMap((file) =>
    lietKeExport(docCay(doc(file), file))
      .ham.filter((h) => !h.macDinh && laAsync(h.node))
      .map((ham) => ({
        khoa: `${file}#${ham.ten}`,
        ten: ham.ten,
        loai: phanLoaiAction(file, ham, { allowKhongCong: ALLOW_ACTION_KHONG_CONG }).loai,
      })),
  );
}

/** Khoá (`file#tên`) của mọi export mà bảng quyền phải khai: action, handler route có cổng, trang. */
function moiKhoaCanKhai(): string[] {
  const route = FILE_ROUTE.filter((f) => !f.startsWith(THU_MUC_INGEST) && !Object.hasOwn(ROUTE_CONG_KHAI, f)).flatMap((f) =>
    lietKeExport(docCay(doc(f), f)).ham.map((h) => `${f}#${h.ten}`),
  );
  return [...docMoiAction().map((a) => a.khoa), ...route, ...FILE_TRANG.map((f) => `${f}#default`)];
}

// ─── Lưới trên cây thật ───────────────────────────────────────────────────────────────────────────

describe("lưới cổng bắt buộc — cây src/", () => {
  it("(1) không còn wrapper chỉ-đòi-đăng-nhập: allowlist rỗng, session.ts chỉ export đúng tập hàm phiên", () => {
    expect(ALLOWLIST_WRAPPER_CU, "allowlist wrapper cũ phải RỖNG — mọi đường qua ba cổng").toEqual([]);
    // `session.ts` là nơi hai wrapper từng sống: export mới nào ở đây (kể cả khôi phục wrapper cũ) phải
    // được khai đích danh ở `export-session-duoc-phep.ts` — không thì lưới đỏ.
    const ds = lietKeExport(docCay(doc("src/lib/session.ts"), "src/lib/session.ts"));
    const exportGiaTri = [...ds.ham.map((h) => h.ten), ...ds.hang.map((h) => h.ten)].sort();
    expect(ds.khac, "session.ts có export dạng lạ (re-export/default)").toEqual([]);
    expect(exportGiaTri).toEqual([...EXPORT_SESSION_DUOC_PHEP].sort());
  });

  it("(2) mọi page/layout (mọi đuôi .ts/.tsx/.js/.jsx…) mở bằng cổng trang khớp bảng quyền, hoặc khai tên", () => {
    expect(FILE_TRANG.length).toBeGreaterThanOrEqual(15);
    expect(FILE_TRANG, "layout (app) phải nằm trong tập kiểm").toContain("src/app/(app)/layout.tsx");
    expect(FILE_TRANG, "trang ngoài (app) cũng phải nằm trong tập kiểm").toContain("src/app/(auth)/dang-nhap/page.tsx");
    const viPham = FILE_TRANG.flatMap((f) => viPhamFileTrang(f, doc(f), { ...LUOI, trangKhongCong: TRANG_KHONG_CONG }));
    expect(viPham).toEqual([]);
  });

  it("(2a) trang miễn cổng còn tồn tại và không tự đọc DB", () => {
    for (const f of Object.keys(TRANG_KHONG_CONG)) {
      expect(existsSync(path.join(GOC, f)), `${f} không còn — xoá khỏi TRANG_KHONG_CONG`).toBe(true);
      expect(doc(f), `${f} miễn cổng mà import prisma`).not.toMatch(/from\s+["']@\/lib\/prisma["']/);
    }
  });

  it("(2b) trang 'chỉ redirect' thật sự chỉ redirect — không import gì ngoài next/navigation", () => {
    for (const f of TRANG_CHI_CHUYEN_HUONG) {
      const cay = docCay(doc(f), f);
      expect(coDinhDanh(cay, ["redirect"]), f).toBe(true);
      const nguon = cay.statements
        .filter(ts.isImportDeclaration)
        .map((s) => (ts.isStringLiteral(s.moduleSpecifier) ? s.moduleSpecifier.text : "?"));
      expect(nguon, `${f} import thêm module — không còn là trang chỉ-redirect`).toEqual(["next/navigation"]);
    }
  });

  it("(2c) file đặc biệt Next (loading/error/not-found/icon/opengraph-image/sitemap…) không chạm lớp dữ liệu", () => {
    expect(FILE_DAC_BIET, "loading (app) phải nằm trong tập kiểm").toContain("src/app/(app)/loading.tsx");
    expect(FILE_DAC_BIET).toContain("src/app/not-found.tsx");
    const viPham = FILE_DAC_BIET.flatMap((f) => viPhamKhongChamDuLieu(f, doc(f), NGUON_DUOC_PHEP_FILE_DAC_BIET));
    expect(viPham).toEqual([]);
  });

  it("(3) mọi file \"use server\": export đúng hình, cổng đúng nguồn, từng action mở bằng cổng khớp bảng quyền, hoặc allowlist", () => {
    expect(docMoiAction().length).toBeGreaterThanOrEqual(50);
    const viPham = FILE_ACTION.flatMap((f) => viPhamFileAction(f, doc(f), LUOI));
    expect(viPham).toEqual([]);
  });

  it("(3c) không có \"use server\" ngoài src/lib/actions — action đặt chỗ khác sẽ nằm ngoài lưới", () => {
    const viPham = FILE_SRC.filter((f) => !f.startsWith("src/lib/actions/") && coUseServerBatKy(docCay(doc(f), f)));
    expect(viPham).toEqual([]);
  });

  it("(3d) mục allowlist action trỏ tới action có thật và vẫn cần miễn (đã có cổng ⇒ xoá mục)", () => {
    const theoKhoa = new Map(docMoiAction().map((a) => [a.khoa, a]));
    const thua = Object.keys(ALLOW_ACTION_KHONG_CONG).filter(
      (k) => (!theoKhoa.has(k) && !CHUA_TON_TAI_DUOC_PHEP.has(k)) || theoKhoa.get(k)?.loai === "cong",
    );
    const thuaNhatKy = Object.keys(ALLOW_ACTION_KHONG_NHAT_KY).filter((k) => !theoKhoa.has(k));
    expect(thua, "mục ALLOW_ACTION_KHONG_CONG thừa — xoá").toEqual([]);
    expect(thuaNhatKy, "mục ALLOW_ACTION_KHONG_NHAT_KY không còn action — xoá").toEqual([]);
  });

  it("(3e) bảng quyền mong đợi không có mục thừa; KHONG_CONG chỉ cho mục có allowlist", () => {
    const canKhai = moiKhoaCanKhai();
    expect(canKhai.length).toBeGreaterThanOrEqual(90);
    expect(mucBangThua(BANG_QUYEN_MONG_DOI, canKhai), "mục bảng quyền không còn export tương ứng — xoá").toEqual([]);
    const mien = new Set([
      ...Object.keys(ALLOW_ACTION_KHONG_CONG),
      ...Object.keys(TRANG_KHONG_CONG).map((f) => `${f}#default`),
    ]);
    const khongCongLac = Object.entries(BANG_QUYEN_MONG_DOI)
      .filter(([k, v]) => v === "KHONG_CONG" && !mien.has(k))
      .map(([k]) => k);
    expect(khongCongLac, "KHONG_CONG mà không có allowlist lý do").toEqual([]);
  });

  it("(4) mọi route (ngoài ingest + route công khai khai tên): TỪNG handler mở bằng cổng route khớp bảng quyền", () => {
    const canCong = FILE_ROUTE.filter((f) => !f.startsWith(THU_MUC_INGEST) && !Object.hasOwn(ROUTE_CONG_KHAI, f));
    expect(canCong.length).toBeGreaterThanOrEqual(6);
    const viPham = canCong.flatMap((f) => viPhamFileRoute(f, doc(f), LUOI));
    expect(viPham).toEqual([]);
  });

  it("(4a) route ingest: TỪNG handler mở bằng hàm kiểm bearer khai ở BEARER_ROUTE_INGEST; không mục thừa", () => {
    const ingest = FILE_ROUTE.filter((f) => f.startsWith(THU_MUC_INGEST));
    expect(ingest.length).toBeGreaterThanOrEqual(9);
    expect(ingest.flatMap((f) => viPhamRouteIngest(f, doc(f), BEARER_ROUTE_INGEST))).toEqual([]);
    const coThat = ingest.flatMap((f) => lietKeExport(docCay(doc(f), f)).ham.map((h) => `${f}#${h.ten}`));
    expect(mucBangThua(BEARER_ROUTE_INGEST, coThat), "mục BEARER_ROUTE_INGEST thừa").toEqual([]);
  });

  it("(4b) route công khai khai theo FILE: còn tồn tại, chỉ import đúng module đã khai", () => {
    for (const [f, { lyDo, nguonDuocPhep }] of Object.entries(ROUTE_CONG_KHAI)) {
      expect(FILE_ROUTE, `${f} không còn — xoá khỏi ROUTE_CONG_KHAI`).toContain(f);
      expect(lyDo.length, `${f} thiếu lý do`).toBeGreaterThan(10);
      expect(viPhamKhongChamDuLieu(f, doc(f), nguonDuocPhep)).toEqual([]);
    }
  });

  it("(5) action đi qua cổng có mã nhật ký, hoặc khai rõ là không cần nhật ký", () => {
    const viPham = docMoiAction()
      .filter((a) => a.loai === "cong")
      .filter((a) => !Object.hasOwn(ANH_XA_ACTION_HANH_DONG, a.ten) && !Object.hasOwn(ALLOW_ACTION_KHONG_NHAT_KY, a.khoa))
      .map((a) => a.khoa);
    expect(viPham, "thêm vào ANH_XA_ACTION_HANH_DONG (src/lib/nhat-ky/hanh-dong.ts)").toEqual([]);
  });

  it("(6) không file client nào import exportTabToExcel (xuất Excel 100 % qua route server)", () => {
    const viPham = FILE_SRC.filter((f) => {
      const ma = doc(f);
      return /^["']use client["']/m.test(ma) && coDinhDanh(docCay(ma, f), ["exportTabToExcel"]);
    });
    expect(viPham).toEqual([]);
  });
});

// ─── Chính lưới: đột biến bằng chuỗi mẫu — lưới phải ĐỎ đúng chỗ ──────────────────────────────────

describe("lưới cổng bắt buộc — tự kiểm bằng mẫu đột biến", () => {
  const F = "src/lib/actions/mau.ts";
  const R = "src/app/api/mau/route.ts";
  const P = "src/app/(moi)/x/page.tsx";
  const opts: TuyChonLuoi = {
    allowKhongCong: {},
    bang: {
      [`${F}#coCong`]: "chi-phi:sua",
      [`${F}#a`]: "CHU_SHOP",
      [`${F}#logout`]: "KHONG_CONG",
      [`${R}#GET`]: "ton-kho:xem",
      [`${P}#default`]: "don-hang:xem",
    },
    docFile: () => null,
  };
  const IMPORT_ACTION = `import { congAction, congChuShopAction } from "@/lib/quyen/cong-action";`;
  const IMPORT_ROUTE = `import { congRoute } from "@/lib/quyen/cong-route";`;
  const IMPORT_TRANG = `import { yeuCauQuyenTrang } from "@/lib/quyen/cong-trang";`;
  const action = (...dong: string[]) => viPhamFileAction(F, [`"use server";`, IMPORT_ACTION, ...dong].join("\n"), opts);
  const route = (src: string) => viPhamFileRoute(R, `${IMPORT_ROUTE}\n${src}`, opts);
  const trang = (src: string) =>
    viPhamFileTrang(P, `${IMPORT_TRANG}\n${src}`, { ...opts, trangKhongCong: {} });

  it("mẫu chuẩn qua: `const c = await congAction(…); if (!c.ok) return c;`", () => {
    expect(
      action(
        `export async function coCong(id: string) {`,
        `  const c = await congAction("chi-phi:sua");`,
        `  if (!c.ok) return c;`,
        `  await prisma.expense.delete({ where: { id } });`,
        `  return { ok: true };`,
        `}`,
      ),
    ).toEqual([]);
    expect(action(`export async function a() { if (!(await congChuShopAction()).ok) { return LOI; } return 1; }`)).toEqual([]);
  });

  it("thân không cổng ⇒ đỏ; cổng chỉ trong comment/chuỗi không tính", () => {
    const v = action(
      `export async function khongCong(id: string) {`,
      `  // const c = await congAction("x"); if (!c.ok) return c;`,
      `  const s = "await congAction()";`,
      `  await prisma.expense.delete({ where: { id } });`,
      `}`,
    );
    expect(v).toEqual([`${F}#khongCong: câu lệnh đầu tiên không phải cổng`]);
  });

  it("hàm MỘT DÒNG không mượn được cổng của hàm sau nó; hàm sau vẫn được liệt kê", () => {
    const v = action(
      `export async function xoaHet() { await prisma.expense.deleteMany({}); return 1; }`,
      `export async function coCong() {`,
      `  const c = await congAction("chi-phi:sua");`,
      `  if (!c.ok) return c;`,
      `  return 1;`,
      `}`,
    );
    expect(v).toEqual([`${F}#xoaHet: câu lệnh đầu tiên không phải cổng`]);
  });

  it("gọi cổng mà BỎ kết quả ⇒ đỏ", () => {
    expect(action(`export async function a() {`, `  await congAction("chi-phi:sua");`, `  await prisma.expense.delete({});`, `}`)).toHaveLength(1);
    expect(
      action(`export async function a() {`, `  const c = await congAction("chi-phi:sua");`, `  await prisma.expense.delete({});`, `}`),
    ).toEqual([`${F}#a: kết quả cổng không được kiểm ngay (\`if (!c.ok) return c;\`)`]);
    // Kiểm nhầm biến / trả nhầm thứ khác cũng đỏ.
    expect(action(`export async function a() {`, `  const c = await congAction();`, `  if (!d.ok) return c;`, `}`)).toHaveLength(1);
    expect(action(`export async function a() {`, `  const c = await congAction();`, `  if (!c.ok) return { ok: true };`, `}`)).toHaveLength(1);
    expect(action(`export async function a() {`, `  const c = await congAction();`, `  if (c.ok) return c;`, `}`)).toHaveLength(1);
  });

  it("cổng gọi SAU mutation ⇒ đỏ", () => {
    const v = action(
      `export async function a(id: string) {`,
      `  await prisma.expense.delete({ where: { id } });`,
      `  const c = await congAction("chi-phi:sua");`,
      `  if (!c.ok) return c;`,
      `}`,
    );
    expect(v).toEqual([`${F}#a: câu lệnh đầu tiên không phải cổng`]);
  });

  it("export dạng khác `async function` trong file use server ⇒ đỏ (kể cả default/re-export/không async)", () => {
    const v = action(
      `export const lachLuoi = async () => 1;`,
      `export default async function macDinh() { const c = await congAction(); if (!c.ok) return c; }`,
      `export { x };`,
      `export * from "./khac";`,
      `export function dongBo() { const c = congAction(); }`,
      `export type T = number;`,
      `export interface I { a: 1 }`,
      `export type { U } from "./u";`,
    );
    expect(v).toEqual([
      `${F}: export sai hình — export { x };`,
      `${F}: export sai hình — export * from "./khac";`,
      `${F}: export const lachLuoi — Server Action phải là \`export async function\``,
      `${F}#macDinh: phải là \`export async function <tên>\` (không default, có async)`,
      `${F}#dongBo: phải là \`export async function <tên>\` (không default, có async)`,
    ]);
  });

  it("hàm kiểm đăng nhập tự viết (không thuộc ba cổng) đứng đầu thân KHÔNG thay được cổng", () => {
    expect(action(`export async function cu() {`, `  await kiemDangNhap();`, `  return 1;`, `}`)).toEqual([
      `${F}#cu: câu lệnh đầu tiên không phải cổng`,
    ]);
    expect(action(`export async function cu() {`, `  const id = await docIdPhien();`, `  if (!id) return null;`, `}`)).toHaveLength(1);
  });

  it("allowlist action khoá theo `file#tên` — cùng tên ở file khác KHÔNG được miễn", () => {
    const src = [`"use server";`, IMPORT_ACTION, `export async function logout() { return 1; }`].join("\n");
    const allow = { [`${F}#logout`]: "lý do" };
    expect(viPhamFileAction(F, src, { ...opts, allowKhongCong: allow })).toEqual([]);
    expect(viPhamFileAction("src/lib/actions/khac.ts", src, { ...opts, allowKhongCong: allow })).toHaveLength(1);
  });

  it("route: kiểm TỪNG handler — file có GET gác mà POST không gác ⇒ đỏ đúng POST", () => {
    const src = [
      `export const dynamic = "force-dynamic";`,
      `export async function GET() {`,
      `  const c = await congRoute("ton-kho:xem");`,
      `  if (!c.ok) return c.response;`,
      `  return new Response("ok");`,
      `}`,
      `export async function POST() { await prisma.x.delete({}); return new Response("ok"); }`,
    ].join("\n");
    expect(route(src)).toEqual([`${R}#POST: câu lệnh đầu tiên không phải cổng`]);
    // Trả `c` thay vì `c.response` ⇒ đỏ; export const handler ⇒ đỏ.
    const traSai = [`export async function GET() {`, `  const c = await congRoute();`, `  if (!c.ok) return c;`, `}`].join("\n");
    expect(route(traSai)).toHaveLength(1);
    expect(route(`export const GET = boc(async () => 1);`)).toHaveLength(1);
  });

  it("trang: component mặc định mở bằng cổng; export phụ (generateMetadata) ⇒ đỏ", () => {
    const dat = `export default async function P() {\n  const nd = await yeuCauQuyenTrang("/x", "don-hang:xem");\n  return null;\n}`;
    expect(trang(dat)).toEqual([]);
    const khong = `export default async function P() {\n  const d = await prisma.order.findMany();\n  return null;\n}`;
    expect(trang(khong)).toEqual([`${P}#default: câu lệnh đầu tiên không phải cổng`]);
    const meta = `${dat}\nexport async function generateMetadata() { return {}; }`;
    expect(trang(meta)).toHaveLength(1);
    expect(trang(`const P = async () => null;\nexport default P;`)).toHaveLength(2);
  });

  it("định danh nhắc trong comment/chuỗi không tính là dùng; gọi/import thật thì tính", () => {
    const ten = ["exportTabToExcel"];
    expect(coDinhDanh(docCay(` * Xưa dùng \`exportTabToExcel()\`.\n// exportTabToExcel()\nconst s = "exportTabToExcel";`), ten)).toBe(false);
    expect(coDinhDanh(docCay(`exportTabToExcel(sheets);`), ten)).toBe(true);
    expect(coDinhDanh(docCay(`import { exportTabToExcel } from "@/lib/reports/export-excel";`), ten)).toBe(true);
  });

  it("directive `use server`: cấp file vs inline", () => {
    expect(laFileUseServer(docCay(`"use server";\nexport async function a() {}`))).toBe(true);
    expect(laFileUseServer(docCay(`import x from "y";\n"use server";`))).toBe(false);
    expect(coUseServerBatKy(docCay(`export function F() { async function a() { "use server"; } }`))).toBe(true);
    expect(coUseServerBatKy(docCay(`const s = "use server";`))).toBe(false);
  });
});
