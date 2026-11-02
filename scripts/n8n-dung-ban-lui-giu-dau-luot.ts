/**
 * Dựng BẢN LÙI workflow `tiktok-business-nightly` mà VẪN GIỮ hợp đồng dấu lượt hoá đơn — chỉ đọc/ghi file, KHÔNG
 * import n8n, KHÔNG gọi mạng.
 *
 * Vì sao: đã import bản gửi dấu lượt (`POST /api/ingest/luot-hoa-don-tiktok`) thì cổng chốt sao kê thẻ coi BC đó theo
 * luật dấu lượt. Lùi workflow về bản cũ không gửi dấu ⇒ lượt mới nhất không có dấu bắt đầu ⇒ cổng CHẶN mỗi đêm. Lùi
 * phần kéo chi tiêu/tín dụng mà giữ dấu: lấy bản cũ, thay `keoHoaDon` của nó bằng nguyên KHỐI DẤU LƯỢT HOÁ ĐƠN của
 * bản hiện hành (giữa hai dòng đánh dấu `// ===== BẮT ĐẦU/KẾT THÚC KHỐI DẤU LƯỢT HOÁ ĐƠN =====`), phần còn lại của
 * jsCode giữ nguyên từng ký tự. KHÔNG có đường "xoá dòng dấu SyncLog để cổng mở" — đó là phá cổng.
 *
 * Fail-closed — từ chối (thoát 1) khi không tìm được điểm ghép an toàn:
 *  - bản nguồn khối không có đúng một cặp dòng đánh dấu, hoặc khối không khai `keoHoaDon`;
 *  - bản cũ không có đúng MỘT node Code khai đúng một `async function keoHoaDon(`;
 *  - bản cũ đã có dòng đánh dấu / đã gửi dấu lượt (gọi `/api/ingest/luot-hoa-don-tiktok`) / khai trùng tên mà khối khai
 *    (`LUOT_ID_HOA_DON`, `guiDauLuot`…) ngoài vùng thay — ghép vào là khai đôi hoặc hai đường gửi dấu;
 *  - bản cũ thiếu tên khối dựa vào (`http`, `CONFIG`, `KHOA`, `log`, `tiktokGetText`, `docJson`, `laThieuQuyenFinance`,
 *    `hoaDonLocThoiGian`, `loiLandHoaDon`), hoặc không gọi `keoHoaDon` SAU vị trí khối (hằng `LUOT_ID_HOA_DON` của
 *    khối chỉ có giá trị sau khi dòng khai chạy);
 *  - jsCode sau khi ghép không biên dịch được.
 *
 * Chạy:
 *   git show <ref>:n8n/tiktok-business-nightly.json > /đường/dẫn/ban-cu.json
 *   npx tsx scripts/n8n-dung-ban-lui-giu-dau-luot.ts --vao /đường/dẫn/ban-cu.json --ra /đường/dẫn/ban-lui.json
 *   [--khoi-tu n8n/tiktok-business-nightly.json]   (mặc định: bản hiện hành trong repo)
 * Khối mang luôn PHẠM VI THỜI GIAN trên dấu + đường KÉO BÙ (`dungPhamViHoaDon`, khoá Setting `tiktokBusinessHoaDonTuNgay`)
 * — dấu của bản lùi vẫn khai đúng `filtering` đã gửi GET. Node SQL của bản cũ KHÔNG lấy khoá kéo bù ⇒ bản lùi không kéo
 * bù được (khoá đọc ra undefined ⇒ cửa sổ mặc định); cần kéo bù thì thêm `'tiktokBusinessHoaDonTuNgay'` vào câu SQL của
 * bản lùi trước khi import. Cổng không bị lừa: dấu luôn mang phạm vi THẬT đã hỏi TikTok.
 * Rồi kiểm bằng test (`tests/ingest/n8n-dung-ban-lui-giu-dau-luot.test.ts` chạy cùng hàm trên bản `main` cũ) và import
 * thủ công có duyệt — xem `n8n/huong-dan-cai-dat-workflows.md` mục lùi workflow.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DONG_DAU_KHOI = "// ===== BẮT ĐẦU KHỐI DẤU LƯỢT HOÁ ĐƠN =====";
export const DONG_CUOI_KHOI = "// ===== KẾT THÚC KHỐI DẤU LƯỢT HOÁ ĐƠN =====";
/** Chuỗi URL dấu lượt TRONG NHÁY (lời gọi thật) — chú thích nhắc tới đường dẫn không tính. */
const DUONG_DAU_LUOT = '"/api/ingest/luot-hoa-don-tiktok"';
const KHAI_KEO_HOA_DON = "async function keoHoaDon(";

/** Tên bản cũ PHẢI có sẵn (khối gọi tới) — mỗi mục: mô tả + regex khai báo top-level. */
const TEN_KHOI_DUA_VAO: ReadonlyArray<readonly [string, RegExp]> = [
  ["const http", /^const http = /m],
  ["const CONFIG", /^const CONFIG = /m],
  ["const KHOA", /^const KHOA = /m],
  ["log", /^(?:const log = |function log\()/m],
  ["tiktokGetText", /^async function tiktokGetText\(/m],
  ["docJson", /^function docJson\(/m],
  ["laThieuQuyenFinance", /^function laThieuQuyenFinance\(/m],
  ["const hoaDonLocThoiGian", /^const hoaDonLocThoiGian = /m],
  ["const loiLandHoaDon", /^const loiLandHoaDon = /m],
];

type NodeN8n = { type?: unknown; parameters?: { jsCode?: unknown } };
type Workflow = { nodes?: unknown };

export type KetQuaDungBanLui =
  | { ok: true; workflow: Record<string, unknown>; jsCode: string; vungCu: { tu: number; den: number }; khoi: string }
  | { ok: false; loi: string };

const nodeCode = (wf: unknown): NodeN8n[] => {
  const nodes = (wf as Workflow | null)?.nodes;
  return Array.isArray(nodes)
    ? (nodes as NodeN8n[]).filter((n) => n?.type === "n8n-nodes-base.code" && typeof n.parameters?.jsCode === "string")
    : [];
};

const demChuoi = (s: string, con: string): number => s.split(con).length - 1;

/** Khối dấu lượt (kể cả hai dòng đánh dấu) trong jsCode của bản nguồn; null kèm lý do nếu không đúng một cặp. */
export function catKhoiDauLuot(jsCode: string): { ok: true; khoi: string } | { ok: false; loi: string } {
  if (demChuoi(jsCode, DONG_DAU_KHOI) !== 1 || demChuoi(jsCode, DONG_CUOI_KHOI) !== 1) {
    return { ok: false, loi: "bản nguồn khối phải có ĐÚNG một dòng đánh dấu đầu + một dòng đánh dấu cuối khối dấu lượt" };
  }
  const tu = jsCode.indexOf(DONG_DAU_KHOI);
  const den = jsCode.indexOf(DONG_CUOI_KHOI) + DONG_CUOI_KHOI.length;
  if (den <= tu) return { ok: false, loi: "dòng đánh dấu cuối khối đứng trước dòng đầu" };
  const khoi = jsCode.slice(tu, den);
  if (demChuoi(khoi, KHAI_KEO_HOA_DON) !== 1) return { ok: false, loi: "khối dấu lượt phải khai đúng một keoHoaDon" };
  return { ok: true, khoi };
}

/** Tên khối khai ở cấp cao nhất (dòng không thụt lề) — bản cũ không được khai lại tên nào trong số này. */
function tenKhoiKhai(khoi: string): string[] {
  return [...khoi.matchAll(/^(?:const|let|var|async function|function)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
}

/**
 * Vị trí ngoặc `}` đóng thân hàm bắt đầu từ ngoặc `{` tại `moNgoac` — bỏ qua chuỗi '…' "…" `…` và chú thích (ngoặc
 * trong đó không tính). Template có `${…}` lồng chuỗi chứa backtick không được hỗ trợ — kết quả sai thì bước biên dịch
 * sau ghép bắt được.
 */
function viTriNgoacDong(js: string, moNgoac: number): number {
  let sau = 0;
  for (let i = moNgoac; i < js.length; i++) {
    const c = js[i];
    if (c === "/" && js[i + 1] === "/") {
      const xuong = js.indexOf("\n", i);
      i = xuong < 0 ? js.length : xuong;
    } else if (c === "/" && js[i + 1] === "*") {
      const dong = js.indexOf("*/", i + 2);
      i = dong < 0 ? js.length : dong + 1;
    } else if (c === '"' || c === "'" || c === "`") {
      for (i++; i < js.length && js[i] !== c; i++) if (js[i] === "\\") i++;
    } else if (c === "{") sau++;
    else if (c === "}") {
      sau--;
      if (sau === 0) return i;
    }
  }
  return -1;
}

/** jsCode Code node n8n (thân hàm async, có `await`/`return` cấp cao) biên dịch được — KHÔNG chạy. */
function bienDichDuoc(js: string): string | null {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...a: string[]) => unknown;
  try {
    new AsyncFunction("$input", "$execution", js);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Ghép khối dấu lượt của `banCoKhoi` vào `banCu`: thay `async function keoHoaDon(…) {…}` (kèm JSDoc liền trước nếu
 * có) của bản cũ bằng nguyên khối. Trả workflow mới (bản sao sâu của bản cũ, chỉ đổi jsCode node đó) + vùng đã thay.
 */
export function dungBanLuiGiuDauLuot(banCu: unknown, banCoKhoi: unknown): KetQuaDungBanLui {
  const nguon = nodeCode(banCoKhoi).filter((n) => (n.parameters?.jsCode as string).includes(DONG_DAU_KHOI));
  if (nguon.length !== 1) return { ok: false, loi: "bản nguồn khối phải có đúng một node Code chứa khối dấu lượt" };
  const kh = catKhoiDauLuot(nguon[0].parameters?.jsCode as string);
  if (!kh.ok) return kh;
  const khoi = kh.khoi;

  const cacNodeCu = nodeCode(banCu);
  const dich = cacNodeCu.filter((n) => (n.parameters?.jsCode as string).includes(KHAI_KEO_HOA_DON));
  if (dich.length !== 1) return { ok: false, loi: `bản cũ phải có đúng một node Code khai '${KHAI_KEO_HOA_DON}'` };
  const cu = dich[0].parameters?.jsCode as string;
  if (cu.includes(DONG_DAU_KHOI) || cu.includes(DONG_CUOI_KHOI)) {
    return { ok: false, loi: "bản cũ đã có khối dấu lượt — không cần dựng bản lùi (import thẳng bản đó)" };
  }
  if (cu.includes(DUONG_DAU_LUOT)) {
    return { ok: false, loi: `bản cũ đã tự gửi dấu lượt (${DUONG_DAU_LUOT}) theo cách khác — ghép thêm là hai đường gửi dấu` };
  }
  if (demChuoi(cu, KHAI_KEO_HOA_DON) !== 1) return { ok: false, loi: `bản cũ phải khai đúng một '${KHAI_KEO_HOA_DON}'` };

  // Vùng thay: JSDoc liền trước (nếu có) + khai báo hàm tới ngoặc đóng.
  const viTriHam = cu.indexOf(KHAI_KEO_HOA_DON);
  const moNgoac = cu.indexOf("{", viTriHam + KHAI_KEO_HOA_DON.length);
  const dongNgoac = moNgoac < 0 ? -1 : viTriNgoacDong(cu, moNgoac);
  if (dongNgoac < 0) return { ok: false, loi: "không tìm được ngoặc đóng thân keoHoaDon của bản cũ" };
  let tu = viTriHam;
  const truoc = cu.slice(0, viTriHam);
  if (truoc.endsWith("*/\n")) {
    const moChuThich = truoc.lastIndexOf("/**");
    if (moChuThich >= 0 && !truoc.slice(moChuThich, -3).includes("*/")) tu = moChuThich;
  }
  const den = dongNgoac + 1;
  const ngoaiVung = cu.slice(0, tu) + cu.slice(den);

  for (const ten of tenKhoiKhai(khoi)) {
    if (ten === "keoHoaDon") continue;
    if (new RegExp(`(?:const|let|var|function)\\s+${ten.replace(/\$/g, "\\$")}\\b`).test(ngoaiVung)) {
      return { ok: false, loi: `bản cũ đã khai '${ten}' ngoài keoHoaDon — ghép khối là khai đôi` };
    }
  }
  const thieu = TEN_KHOI_DUA_VAO.filter(([, re]) => !re.test(ngoaiVung)).map(([ten]) => ten);
  if (thieu.length > 0) return { ok: false, loi: `bản cũ thiếu tên khối dấu lượt dựa vào: ${thieu.join(", ")}` };
  if (!cu.slice(den).includes("await keoHoaDon(")) {
    return { ok: false, loi: "bản cũ không gọi keoHoaDon SAU vị trí khối — hằng của khối chưa có giá trị lúc gọi" };
  }

  const jsCode = cu.slice(0, tu) + khoi + cu.slice(den);
  const loiBienDich = bienDichDuoc(jsCode);
  if (loiBienDich !== null) return { ok: false, loi: `jsCode sau khi ghép không biên dịch được: ${loiBienDich}` };
  if (demChuoi(jsCode, DUONG_DAU_LUOT) !== 1) return { ok: false, loi: "sau khi ghép phải có đúng một đường gửi dấu lượt" };

  const workflow = structuredClone(banCu) as Record<string, unknown>;
  const nodeMoi = nodeCode(workflow).find((n) => n.parameters?.jsCode === cu);
  if (!nodeMoi?.parameters) return { ok: false, loi: "không định vị lại được node Code trong bản sao" };
  nodeMoi.parameters.jsCode = jsCode;
  return { ok: true, workflow, jsCode, vungCu: { tu, den }, khoi };
}

function docThamSo(argv: readonly string[]): { vao: string; ra: string; khoiTu: string } | string {
  const lay = (co: string): string | undefined => {
    const i = argv.indexOf(co);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const vao = lay("--vao");
  const ra = lay("--ra");
  if (!vao || !ra) return "thiếu --vao <bản cũ.json> hoặc --ra <bản lùi.json>";
  return { vao, ra, khoiTu: lay("--khoi-tu") ?? "n8n/tiktok-business-nightly.json" };
}

function docJsonFile(p: string): unknown {
  return JSON.parse(readFileSync(p, "utf8")) as unknown;
}

function main(): number {
  const ts = docThamSo(process.argv.slice(2));
  if (typeof ts === "string") {
    console.error(`[n8n-ban-lui] ${ts}`);
    return 2;
  }
  if (path.resolve(ts.ra) === path.resolve(ts.khoiTu) || path.resolve(ts.ra) === path.resolve(ts.vao)) {
    console.error("[n8n-ban-lui] --ra phải là file MỚI, không ghi đè bản nguồn khối hay bản cũ");
    return 2;
  }
  if (existsSync(ts.ra)) {
    console.error(`[n8n-ban-lui] ${ts.ra} đã tồn tại — chọn đường dẫn khác (không ghi đè)`);
    return 2;
  }
  let banCu: unknown;
  let banCoKhoi: unknown;
  try {
    banCu = docJsonFile(ts.vao);
    banCoKhoi = docJsonFile(ts.khoiTu);
  } catch (e) {
    console.error(`[n8n-ban-lui] không đọc được file JSON: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const kq = dungBanLuiGiuDauLuot(banCu, banCoKhoi);
  if (!kq.ok) {
    console.error(`[n8n-ban-lui] TỪ CHỐI: ${kq.loi}`);
    return 1;
  }
  writeFileSync(ts.ra, `${JSON.stringify(kq.workflow, null, 2)}\n`, "utf8");
  console.log(
    `[n8n-ban-lui] Đã ghi ${ts.ra}: thay keoHoaDon của bản cũ (${kq.vungCu.den - kq.vungCu.tu} ký tự) bằng khối dấu ` +
      `lượt (${kq.khoi.length} ký tự); phần còn lại giữ nguyên. CHƯA import — chạy test rồi import có duyệt.`,
  );
  return 0;
}

// Chỉ tự chạy khi gọi trực tiếp — Vitest `import` file này để lấy hàm thuần.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
