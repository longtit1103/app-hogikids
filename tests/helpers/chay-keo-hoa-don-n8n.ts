/**
 * Chạy THẬT `keoHoaDon` của workflow `tiktok-business-nightly` (khối dấu lượt hoá đơn + các hàm node nó dựa vào) cắt
 * nguyên văn từ một jsCode, với `http` / `tiktokGetText` giả. Dùng chung cho suite workflow hiện hành và suite bản lùi
 * dựng bằng `scripts/n8n-dung-ban-lui-giu-dau-luot.ts` — cùng một bộ giả, hai bản jsCode phải cho cùng hợp đồng dấu.
 */

/** Cắt nguyên văn một khai báo hàm (kể cả `async function`) bằng cách đếm ngoặc — cùng cách các suite workflow khác. */
export function catHam(js: string, ten: string): string {
  const viTri = js.indexOf(`function ${ten}(`);
  if (viTri < 0) throw new Error(`jsCode phải khai báo function ${ten}`);
  const dau = js.slice(0, viTri).endsWith("async ") ? viTri - "async ".length : viTri;
  const moNgoac = js.indexOf("{", viTri);
  let sau = 0;
  for (let i = moNgoac; i < js.length; i++) {
    if (js[i] === "{") sau++;
    else if (js[i] === "}") {
      sau--;
      if (sau === 0) return js.slice(dau, i + 1);
    }
  }
  throw new Error(`function ${ten} thiếu ngoặc đóng`);
}

/** Hằng top-level một dòng (`const TEN = …;`). */
export function catHang(js: string, ten: string): string {
  const m = new RegExp(`^const ${ten} = [^\\n]+;$`, "m").exec(js);
  if (m === null) throw new Error(`jsCode phải khai báo hằng ${ten}`);
  return m[0];
}

/** Một sự kiện theo đúng thứ tự xảy ra: GET trang (kèm `filtering` gửi TikTok), POST land trang hoá đơn, hoặc POST dấu lượt. */
export type SuKien =
  | { loai: "get"; page: number; filtering: unknown }
  | { loai: "land"; body: Record<string, unknown> }
  | { loai: "dau"; url: string; body: Record<string, unknown> };

export const URL_APP = "https://app.test";

/** Cửa sổ mặc định workflow dựng (`hoaDonLocThoiGian`) — lượt đêm 01:15 ngày 31/10/2026: 10 ngày tới 00:00 hôm nay. */
export const LOC_MAC_DINH = JSON.stringify({ start_time: "2026-10-21 00:00:00", end_time: "2026-10-31 00:00:00" });

const tokenErr = (source: string, detail: string) => new Error(`${source} token: ${detail}`);

/**
 * Dựng `keoHoaDon` từ `js`. `traTrang(page)` trả text TikTok (hoặc ném); `land(page)` = số dòng app land (−1 ⇒ POST
 * land hỏng); `dauHong` = giai đoạn dấu mà `http` ném; `executionId` = `$execution.id`; `hoaDonLocThoiGian` = cửa sổ
 * mặc định ngoài khối (mặc định `LOC_MAC_DINH`); `khoa` = khoá bảng Setting (`KHOA`, vd `tiktokBusinessHoaDonTuNgay`).
 */
export function dungKeoHoaDon(
  js: string,
  o: {
    traTrang: (page: number) => string;
    land?: (page: number) => number;
    dauHong?: "bat-dau" | "ket-thuc";
    executionId?: unknown;
    hoaDonLocThoiGian?: string;
    khoa?: Record<string, unknown>;
  },
) {
  const suKien: SuKien[] = [];
  const loiLandHoaDon: string[] = [];
  let pageDangGet = 0;
  const tiktokGetText = async (_p: string, qs: { page: number; filtering: unknown }) => {
    pageDangGet = qs.page;
    suKien.push({ loai: "get", page: qs.page, filtering: qs.filtering });
    return o.traTrang(qs.page);
  };
  const http = async (req: { url: string; body: Record<string, unknown>; headers: Record<string, string> }) => {
    if (req.headers.Authorization !== "Bearer s") throw new Error("thiếu bearer");
    if (req.url === `${URL_APP}/api/ingest/raw`) {
      const n = o.land ? o.land(pageDangGet) : 1;
      if (n < 0) throw new Error("502 Bad Gateway");
      suKien.push({ loai: "land", body: req.body });
      return { ok: true, stats: { landed: n } };
    }
    if (req.body.giaiDoan === o.dauHong) throw new Error("502 Bad Gateway");
    suKien.push({ loai: "dau", url: req.url, body: req.body });
    return { ok: true };
  };
  const nguon = [
    catHang(js, "LUOT_ID_HOA_DON"),
    catHang(js, "PHAM_VI_HOA_DON_MUI_GIO"),
    catHang(js, "KEO_BU_HOA_DON_TRAN_NGAY"),
    catHam(js, "dungPhamViHoaDon"),
    catHang(js, "PHAM_VI_HOA_DON"),
    catHang(js, "THIEU_QUYEN_FINANCE"),
    catHam(js, "laThieuQuyenFinance"),
    catHam(js, "docJson"),
    catHam(js, "guiDauLuot"),
    catHam(js, "soNguyenPageInfo"),
    catHam(js, "landTrangHoaDon"),
    catHam(js, "keoHoaDon"),
  ].join("\n\n");
  const keoHoaDon = new Function(
    "$execution",
    "http",
    "CONFIG",
    "KHOA",
    "log",
    "tiktokGetText",
    "tokenErr",
    "hoaDonLocThoiGian",
    "loiLandHoaDon",
    `"use strict";\n${nguon}\nreturn keoHoaDon;`,
  )(
    { id: "executionId" in o ? o.executionId : 104563 },
    http,
    { appUrl: URL_APP, ingestSecret: "s" },
    o.khoa ?? {},
    () => {},
    tiktokGetText,
    tokenErr,
    o.hoaDonLocThoiGian ?? LOC_MAC_DINH,
    loiLandHoaDon,
  ) as (bc: string) => Promise<unknown[]>;
  const dau = () => suKien.flatMap((e) => (e.loai === "dau" ? [e.body] : []));
  const get = () => suKien.flatMap((e) => (e.loai === "get" ? [e] : []));
  return { keoHoaDon, suKien, dau, get, loiLandHoaDon };
}
