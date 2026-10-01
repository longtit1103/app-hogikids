import ts from "typescript";

import {
  docCay,
  EXPORT_CAU_HINH,
  kiemCongDauThan,
  laAsync,
  lietKeExport,
  loiGoiCongDauThan,
  MODULE_CONG_ACTION,
  MODULE_CONG_ROUTE,
  MODULE_CONG_TRANG,
  PHUONG_THUC_HTTP,
  TEN_CONG_ACTION,
  TEN_CONG_ROUTE,
  TEN_CONG_TRANG,
  type CachTraVe,
  type HamExport,
} from "./phan-tich-cong-bang-ast";
import { thamSoMacDinhTacDong, viPhamNguonDinhDanh } from "./phan-tich-nguon-cong-va-tham-so-ast";
import { cungGiaTriCong, giaTriCongThat, moTaGiaTriCong, type DocFile, type GiaTriCong } from "./phan-tich-doi-so-cong-ast";

/**
 * LUẬT THUẦN của lưới "cổng bắt buộc" cho action / route có cổng / trang — nhận chuỗi mã, trả danh
 * sách vi phạm. Hai file test dùng chung: `cong-bat-buoc.test.ts` (cây thật + mẫu cũ) và
 * `cong-bat-buoc-tu-kiem-dot-bien.test.ts` (mẫu đột biến). Phần ngoài ba cổng (ingest, route công
 * khai, file đặc biệt Next) ở `luat-route-ingest-va-file-khong-cong.ts`.
 */

/** Giá trị mong đợi trong bảng: như `GiaTriCong`, thêm `KHONG_CONG` cho mục đã khai allowlist miễn cổng. */
export type CongMongDoi = GiaTriCong | "KHONG_CONG";
export type BangQuyen = Readonly<Record<string, CongMongDoi>>;

export type TuyChonLuoi = {
  /** Action miễn cổng, khoá `"<file>#<tên>"`. */
  allowKhongCong: Readonly<Record<string, string>>;
  /** Bảng quyền mong đợi, khoá `"<file>#<tên>"` (trang: `"<file>#default"`). */
  bang: BangQuyen;
  /** Đọc file khác (để gập hằng quyền import từ module khác). */
  docFile: DocFile;
};

type LoaiCong = { ten: readonly string[]; module: string; traVe: CachTraVe };
const CONG_ACTION: LoaiCong = { ten: TEN_CONG_ACTION, module: MODULE_CONG_ACTION, traVe: "ketQua" };
const CONG_ROUTE: LoaiCong = { ten: TEN_CONG_ROUTE, module: MODULE_CONG_ROUTE, traVe: "response" };
const CONG_TRANG: LoaiCong = { ten: TEN_CONG_TRANG, module: MODULE_CONG_TRANG, traVe: "khong-kiem" };

const moduleTheoTen = (l: LoaiCong): Record<string, string> => Object.fromEntries(l.ten.map((t) => [t, l.module]));

/** Đối số cổng THẬT so với bảng. `null` = khớp. */
function viPhamBang(khoa: string, fn: ts.FunctionDeclaration, file: string, p: TuyChonLuoi): string | null {
  if (!Object.hasOwn(p.bang, khoa)) return `${khoa}: thiếu mục trong bảng quyền mong đợi (tests/luoi/bang-quyen-mong-doi.ts)`;
  const mongDoi = p.bang[khoa];
  const call = loiGoiCongDauThan(fn);
  if (!call) return `${khoa}: không đọc được lời gọi cổng`;
  const that = giaTriCongThat(fn, call, file, p.docFile);
  if (!that.ok) return `${khoa}: ${that.lyDo}`;
  if (mongDoi === "KHONG_CONG" || !cungGiaTriCong(that.v, mongDoi)) {
    return `${khoa}: cổng thực tế ${moTaGiaTriCong(that.v)} ≠ bảng ${mongDoi === "KHONG_CONG" ? mongDoi : moTaGiaTriCong(mongDoi)}`;
  }
  return null;
}

/** Hàm đã có cổng đầu thân: kiểm thêm tham số mặc định + đối số so bảng. */
function viPhamHamCoCong(khoa: string, fn: ts.FunctionDeclaration, file: string, loai: LoaiCong, p: TuyChonLuoi): string[] {
  const viPham = thamSoMacDinhTacDong(fn).map((l) => `${khoa}: ${l}`);
  const loiCong = kiemCongDauThan(fn, loai.ten, loai.traVe);
  if (loiCong !== null) return [...viPham, `${khoa}: ${loiCong}`];
  const loiBang = viPhamBang(khoa, fn, file, p);
  return loiBang ? [...viPham, loiBang] : viPham;
}

function viPhamMienCong(khoa: string, p: TuyChonLuoi): string[] {
  if (p.bang[khoa] !== "KHONG_CONG") return [`${khoa}: miễn cổng (allowlist) nhưng bảng quyền không khai KHONG_CONG`];
  return [];
}

// ─── Action ────────────────────────────────────────────────────────────────────────────────────────

export type LoaiQua = "cong" | "allowlist";
export type KetQuaPhanLoai = { loai: LoaiQua } | { loai: null; lyDo: string };

/** Một action (đã biết là `export async function` không default) qua lưới bằng đường nào. */
export function phanLoaiAction(file: string, ham: HamExport, p: Pick<TuyChonLuoi, "allowKhongCong">): KetQuaPhanLoai {
  const loiCong = kiemCongDauThan(ham.node, TEN_CONG_ACTION, "ketQua");
  if (loiCong === null) return { loai: "cong" };
  if (Object.hasOwn(p.allowKhongCong, `${file}#${ham.ten}`)) return { loai: "allowlist" };
  return { loai: null, lyDo: loiCong };
}

/** Vi phạm của MỘT file `"use server"`: export sai hình, nguồn cổng, từng action (cổng + bảng). */
export function viPhamFileAction(file: string, src: string, p: TuyChonLuoi): string[] {
  const sf = docCay(src, file);
  const ds = lietKeExport(sf);
  const viPham = [
    ...ds.khac.map((d) => `${file}: export sai hình — ${d}`),
    ...ds.hang.map((h) => `${file}: export const ${h.ten} — Server Action phải là \`export async function\``),
    ...viPhamNguonDinhDanh(sf, moduleTheoTen(CONG_ACTION)).map((l) => `${file}: ${l}`),
  ];
  for (const ham of ds.ham) {
    const khoa = `${file}#${ham.ten}`;
    if (ham.macDinh || !laAsync(ham.node)) {
      viPham.push(`${khoa}: phải là \`export async function <tên>\` (không default, có async)`);
      continue;
    }
    if (phanLoaiAction(file, ham, p).loai === "allowlist") {
      viPham.push(...thamSoMacDinhTacDong(ham.node).map((l) => `${khoa}: ${l}`), ...viPhamMienCong(khoa, p));
      continue;
    }
    viPham.push(...viPhamHamCoCong(khoa, ham.node, file, CONG_ACTION, p));
  }
  return viPham;
}

// ─── Route có cổng ─────────────────────────────────────────────────────────────────────────────────

/** Export của file route: chỉ handler HTTP (function) + hằng cấu hình Next. */
export function viPhamExportRoute(file: string, ds: ReturnType<typeof lietKeExport>): string[] {
  return [
    ...ds.khac.map((d) => `${file}: export sai hình — ${d}`),
    ...ds.hang.filter((h) => !EXPORT_CAU_HINH.has(h.ten)).map((h) => `${file}: export const ${h.ten} — handler phải là function`),
    ...ds.ham
      .filter((h) => h.macDinh || !PHUONG_THUC_HTTP.has(h.ten))
      .map((h) => `${file}#${h.ten}: route chỉ được export handler HTTP`),
  ];
}

/** Vi phạm của MỘT route cần cổng: từng handler mở bằng cổng route, đối số khớp bảng. */
export function viPhamFileRoute(file: string, src: string, p: TuyChonLuoi): string[] {
  const sf = docCay(src, file);
  const ds = lietKeExport(sf);
  const viPham = [...viPhamExportRoute(file, ds), ...viPhamNguonDinhDanh(sf, moduleTheoTen(CONG_ROUTE)).map((l) => `${file}: ${l}`)];
  for (const ham of ds.ham.filter((h) => !h.macDinh && PHUONG_THUC_HTTP.has(h.ten))) {
    viPham.push(...viPhamHamCoCong(`${file}#${ham.ten}`, ham.node, file, CONG_ROUTE, p));
  }
  return viPham;
}

// ─── Trang / layout ────────────────────────────────────────────────────────────────────────────────

/** Vi phạm của MỘT page/layout: component mặc định mở bằng cổng trang (hoặc miễn tên), đối số khớp bảng. */
export function viPhamFileTrang(
  file: string,
  src: string,
  p: TuyChonLuoi & { trangKhongCong: Readonly<Record<string, string>> },
): string[] {
  const sf = docCay(src, file);
  const ds = lietKeExport(sf);
  const khoa = `${file}#default`;
  const viPham = [
    ...ds.khac.map((d) => `${file}: export sai hình — ${d}`),
    ...ds.hang.filter((h) => !EXPORT_CAU_HINH.has(h.ten)).map((h) => `${file}: export const ${h.ten} — ngoài cấu hình Next`),
    ...viPhamNguonDinhDanh(sf, moduleTheoTen(CONG_TRANG)).map((l) => `${file}: ${l}`),
  ];
  const macDinh = ds.ham.filter((h) => h.macDinh);
  if (macDinh.length !== 1) viPham.push(`${file}: phải có đúng một \`export default async function\``);
  for (const ham of ds.ham) {
    if (!ham.macDinh) {
      // `generateMetadata` & co chạy KHÔNG qua component mặc định ⇒ không được hưởng cổng của nó.
      viPham.push(`${file}#${ham.ten}: trang chỉ được export component mặc định`);
      continue;
    }
    if (Object.hasOwn(p.trangKhongCong, file)) {
      viPham.push(...thamSoMacDinhTacDong(ham.node).map((l) => `${khoa}: ${l}`), ...viPhamMienCong(khoa, p));
      continue;
    }
    viPham.push(...viPhamHamCoCong(khoa, ham.node, file, CONG_TRANG, p));
  }
  return viPham;
}

/** Mục bảng không còn export tương ứng (bảng phải đúng bằng tập export, không dư). */
export function mucBangThua(bang: Readonly<Record<string, unknown>>, khoaCanKhai: Iterable<string>): string[] {
  const co = new Set(khoaCanKhai);
  return Object.keys(bang).filter((k) => !co.has(k));
}
