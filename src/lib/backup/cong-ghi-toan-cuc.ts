/**
 * CỔNG GHI TOÀN CỤC trong tiến trình app — lượt phục hồi DB loại trừ MỌI đường ghi, có cưỡng chế.
 *
 * Hai lớp, cùng một cờ (`dangPhucHoi()` ở `khoa-bao-tri.ts` — KHÔNG có cờ thứ hai):
 *  1. CỬA theo request/action (lớp chính): kiểm cờ rồi TĂNG bộ đếm trong CÙNG một đoạn đồng bộ, giảm
 *     ở `finally`. Request đã vào trước cờ chạy TRỌN (land → transform không bị cắt giữa chừng) và
 *     lượt phục hồi CHỜ nó (`choDrain`) trước khi chụp bản lùi. Request tới sau cờ bị từ chối ngay
 *     (route 503 + `Retry-After`, action `{ ok: false, error: LOI_DANG_PHUC_HOI }`), không xếp hàng.
 *  2. LƯỚI PHỤ cấp op (`canOpGhi`, gắn vào client Prisma ở `tao-prisma-client.ts`): op GHI (model +
 *     raw, phân loại fail-closed) không mang ngữ cảnh cửa ⇒ khi cờ bật NÉM `LoiCongGhiDangKhoa`; khi
 *     cờ tắt thì đếm như "op lẻ" suốt thời gian chạy để drain chờ. `$transaction` lẻ mở trước cờ được
 *     đếm + gắn ngữ cảnh suốt tx (`bocTransactionLe`) — callback extension không biết op thuộc tx nào.
 *
 * Lối MIỄN (`chayMienCong`): restore, `markBronzeBacklog`, SyncLog ERROR — ghi được cả khi cờ bật để
 * request bị cắt vẫn để lại dấu (backlog/ERROR) thay vì mất im lặng; và TRẢ lease việc nặng
 * (`traKhoaViecNang`) — câu đó chỉ xoá đúng token của người gọi, chặn nó là để lease kẹt tới hết hạn.
 * CHỈ module trong danh sách cho phép được gọi (lưới import `tests/backup/cong-ghi-mien.test.ts`).
 *
 * ⚠️ Mọi trạng thái neo `globalThis[Symbol.for("hogikids.congGhi")]`: Next nạp module thành NHIỀU bản
 * sao trong cùng tiến trình (bundle server action ≠ bundle route handler) — biến module tách đôi bộ
 * đếm và route đọc 0 trong khi action đang ghi (đo trên `next build && next start`).
 *
 * ⚠️ ALS: mọi `run` đều `als.run(ctx, async () => await fn())`, KHÔNG `als.run(ctx, fn)` — PrismaPromise
 * LƯỜI, trả thẳng nó ra khỏi `run` thì lệnh thực thi NGOÀI ngữ cảnh (đo: ghi backlog qua lối miễn bị
 * chặn).
 *
 * Import TƯƠNG ĐỐI: file này được nạp từ `tao-prisma-client.ts`, mà file đó nạp cả từ `prisma/seed.ts`
 * và Playwright (không chắc resolve alias `@/`).
 */
import { AsyncLocalStorage } from "node:async_hooks";

// Đọc cờ qua `dangPhucHoiChoCongGhi` (cùng nghĩa `dangPhucHoi`) — lý do ở docstring hàm đó.
import { dangPhucHoiChoCongGhi as dangPhucHoi, LOI_DANG_PHUC_HOI, phanHoi503DangPhucHoi } from "./khoa-bao-tri";

/** Lý do của một lối miễn — để log/đọc code biết lối đó sinh ra cho việc gì. */
export type LyDoMien = "restore" | "backlog" | "sync-log-error" | "tra-khoa-viec-nang";

/**
 * Ngữ cảnh ALS. Mọi loại đều có cờ `dong` = lượt sinh ra ngữ cảnh đã KẾT THÚC (request: cửa đã `ra()`;
 * miễn: `fn` đã xong; tx lẻ: tx đã COMMIT/ROLLBACK). Ngữ cảnh đóng thành VÔ HIỆU, không còn cho op đi
 * qua: ALS chảy theo mọi việc async sinh bên trong (kể cả việc thả trôi, `void f()`, timer), nên không
 * đóng thì việc thả trôi mang "giấy thông hành" mãi mãi — đi qua cổng cả khi cờ bật mà không được đếm.
 */
type NguCanhRequest = { loai: "request"; dong: boolean };
type NguCanhMien = { loai: "mien"; lyDo: LyDoMien; dong: boolean };
type NguCanhTxLe = { loai: "tx-le"; dong: boolean };
type NguCanh = NguCanhRequest | NguCanhMien | NguCanhTxLe;

type TrangThaiCong = {
  als: AsyncLocalStorage<NguCanh>;
  soRequest: number;
  soOpLe: number;
  nguoiCho: Set<() => void>;
  dangDrain: boolean;
};

const KHOA_GLOBAL = Symbol.for("hogikids.congGhi");

function trangThai(): TrangThaiCong {
  const g = globalThis as unknown as Record<symbol, TrangThaiCong | undefined>;
  return (g[KHOA_GLOBAL] ??= {
    als: new AsyncLocalStorage<NguCanh>(),
    soRequest: 0,
    soOpLe: 0,
    nguoiCho: new Set(),
    dangDrain: false,
  });
}

/** Ngữ cảnh còn HIỆU LỰC của đoạn mã hiện tại (bỏ mọi ngữ cảnh đã đóng). */
function nguCanhSong(st: TrangThaiCong): NguCanh | undefined {
  const ctx = st.als.getStore();
  if (!ctx || ctx.dong) return undefined;
  return ctx;
}

/** Nhãn bền của `LoiCongGhiDangKhoa` — `Symbol.for` nên mọi bản sao module cùng thấy một symbol. */
const NHAN_LOI_CONG_GHI = Symbol.for("hogikids.loiCongGhi");

/**
 * Op ghi bị cổng chặn (cờ phục hồi bật, không ngữ cảnh cửa/miễn). Thông điệp = `LOI_DANG_PHUC_HOI`.
 *
 * ⚠️ NHẬN DIỆN bằng `laLoiCongGhiDangKhoa(e)`, KHÔNG `instanceof`: lỗi được dựng bởi bản module mà
 * singleton Prisma (neo `globalThis`) nạp lúc tạo client, còn nơi bắt lỗi dùng class của bản sao trong
 * bundle CỦA NÓ (Next nạp module thành nhiều bản — xem đầu file) ⇒ `instanceof` chéo bản = false.
 * Vì vậy class KHÔNG export giá trị — chỉ export KIỂU (`export type` bên dưới): ngoài module không có
 * giá trị class nào để `instanceof`/so `constructor`/`prototype` (kể cả qua alias import); tsc từ chối
 * mọi chỗ dùng nó như giá trị.
 */
class LoiCongGhiDangKhoa extends Error {
  readonly [NHAN_LOI_CONG_GHI] = true;
  constructor(public readonly noi: string) {
    super(LOI_DANG_PHUC_HOI);
    this.name = "LoiCongGhiDangKhoa";
  }
}

export type { LoiCongGhiDangKhoa };

/** Lỗi có phải do cổng ghi chặn không — đúng cả khi lỗi dựng ở bản module khác (nhãn `Symbol.for`). */
export function laLoiCongGhiDangKhoa(e: unknown): e is LoiCongGhiDangKhoa {
  return typeof e === "object" && e !== null && (e as Record<symbol, unknown>)[NHAN_LOI_CONG_GHI] === true;
}

function baoDrain(st: TrangThaiCong): void {
  if (st.soRequest < 0 || st.soOpLe < 0) {
    console.error(`[cong-ghi] bộ đếm âm (request=${st.soRequest}, op=${st.soOpLe}) — lỗi lập trình.`);
  }
  for (const kiem of [...st.nguoiCho]) kiem();
}

/** Ảnh chụp bộ đếm — chẩn đoán (409 drain quá hạn) và test. */
export function docBoDem(): { soRequest: number; soOpLe: number; dangPhucHoi: boolean; dangDrain: boolean } {
  const st = trangThai();
  return { soRequest: st.soRequest, soOpLe: st.soOpLe, dangPhucHoi: dangPhucHoi(), dangDrain: st.dangDrain };
}

// ───────────── Cửa cho SERVER ACTION (không bọc thân hàm) ─────────────

/** Kết quả trả về khi cửa từ chối — cùng hình với 88 điểm `dangPhucHoi()` cũ của action. */
export type TuChoiCuaGhi = { ok: false; error: string };

export type CuaGhi = { ok: true; ra: () => void } | { ok: false; loi: TuChoiCuaGhi };

/**
 * Vào cửa ghi — dùng cho server action, KHÔNG cần bọc thân hàm vào closure (lưới tiền soi theo tên
 * hàm + vị trí `$transaction` trong chính hàm đó):
 *
 *     const cua = vaoCuaGhi();
 *     if (!cua.ok) return cua.loi;
 *     try { …thân cũ… } finally { cua.ra(); }
 *
 * - Cờ phục hồi bật ⇒ `{ ok: false, loi }` NGAY (không xếp hàng).
 * - Đã có ngữ cảnh còn hiệu lực (action gọi lồng action/hàm có cửa, hoặc trong lối miễn) ⇒ đi qua,
 *   `ra()` không làm gì: lượt ngoài đã được đếm; từ chối lượt trong là cắt dở lượt ngoài đã vào.
 * - Còn lại: tăng đếm + gắn ngữ cảnh bằng `als.enterWith` cho PHẦN CÒN LẠI của hàm gọi (mọi `await`
 *   sau đó mang ngữ cảnh). `enterWith` rò ngữ cảnh ra đoạn đồng bộ của NGƯỜI GỌI — vô hại vì: (a) mỗi
 *   request HTTP là một gốc async riêng nên không rò sang request khác; (b) `ra()` ĐÓNG ngữ cảnh, phần
 *   rò thành vô hiệu (op sau đó bị đối xử như op lẻ). Test `cong-ghi-cua-action` chứng minh.
 *
 * `ra()` idempotent; PHẢI nằm trong `finally` (thiếu ⇒ drain chờ tới quá hạn, restore 409 mãi).
 */
export function vaoCuaGhi(): CuaGhi {
  const st = trangThai();
  if (nguCanhSong(st)) return { ok: true, ra: () => {} };
  if (dangPhucHoi()) return { ok: false, loi: { ok: false, error: LOI_DANG_PHUC_HOI } };
  // Kiểm cờ + tăng đếm cùng đoạn đồng bộ — không `await` nào chen vào giữa.
  st.soRequest++;
  const ctx: NguCanhRequest = { loai: "request", dong: false };
  st.als.enterWith(ctx);
  let daRa = false;
  return {
    ok: true,
    ra: () => {
      if (daRa) return;
      daRa = true;
      ctx.dong = true;
      st.soRequest--;
      baoDrain(st);
    },
  };
}

// ───────────── Cửa cho ROUTE HANDLER (bọc closure, ALS.run) ─────────────

/**
 * Cửa cho route handler: cờ bật ⇒ 503 + `Retry-After: 60` ngay; không thì đếm + chạy `fn` TRỌN trong
 * ngữ cảnh request (`als.run`, không rò). Dùng sau câu bearer/cổng đầu handler:
 *
 *     export async function POST(req: Request) {
 *       const unauthorized = requireIngestSecret(req);
 *       if (unauthorized) return unauthorized;
 *       return routeQuaCua(() => xuLyPost(req));
 *     }
 *
 * Lồng trong ngữ cảnh còn hiệu lực ⇒ chạy thẳng (không đếm hai lần, không từ chối lượt đã vào).
 */
export async function routeQuaCua(fn: () => Promise<Response>): Promise<Response> {
  const st = trangThai();
  if (nguCanhSong(st)) return fn();
  if (dangPhucHoi()) return phanHoi503DangPhucHoi();
  st.soRequest++;
  const ctx: NguCanhRequest = { loai: "request", dong: false };
  try {
    return await st.als.run(ctx, async () => await fn());
  } finally {
    ctx.dong = true;
    st.soRequest--;
    baoDrain(st);
  }
}

// ───────────── Lối miễn ─────────────

/**
 * Chạy `fn` trong lối miễn — op ghi đi qua kể cả khi cờ bật, KHÔNG đếm (lượt phục hồi không chờ chính
 * nó). CHỈ module trong danh sách cho phép được gọi (lưới import). Miễn trừ chỉ sống tới khi `fn` xong:
 * việc async thả trôi bên trong mà chạy SAU đó bị đối xử như op lẻ (đóng ngữ cảnh — xem `NguCanh`).
 */
export function chayMienCong<T>(lyDo: LyDoMien, fn: () => Promise<T>): Promise<T> {
  const ctx: NguCanhMien = { loai: "mien", lyDo, dong: false };
  return trangThai().als.run(ctx, async () => {
    try {
      return await fn();
    } finally {
      ctx.dong = true;
    }
  });
}

// ───────────── Lưới phụ cấp op (gắn vào client Prisma) ─────────────

/**
 * Cổng cho MỘT op ghi (người gọi đã phân loại bằng `laOpGhi`): trong ngữ cảnh ⇒ chạy; cờ bật ⇒ ném
 * `LoiCongGhiDangKhoa`; không ⇒ đếm op lẻ suốt lúc chạy.
 */
export async function canOpGhi<T>(noi: string, chay: () => Promise<T>): Promise<T> {
  const st = trangThai();
  if (nguCanhSong(st)) return chay();
  if (dangPhucHoi()) throw new LoiCongGhiDangKhoa(noi);
  st.soOpLe++;
  try {
    return await chay();
  } finally {
    st.soOpLe--;
    baoDrain(st);
  }
}

/**
 * Bọc `$transaction` của client — tx được đếm như op lẻ suốt thời gian chạy + gắn ngữ cảnh `tx-le` riêng
 * cho mọi op bên trong (kể cả op ghi chạy SAU khi cờ bật — tx đã mở phải chạy trọn, drain chờ nó
 * COMMIT). Áp cho:
 *  - tx LẺ (không ngữ cảnh) mở khi cờ tắt;
 *  - tx mở trong ngữ cảnh REQUEST còn sống — kể cả khi cờ đã bật (request vào trước cờ được chạy trọn).
 *    Đếm thêm vô hại (drain đằng nào cũng chờ request), nhưng là chốt GỐC cho lỗi "cửa đóng sớm": action
 *    trả promise tx mà quên `await` thì `finally { cua.ra() }` chạy ngay, request hết được đếm và ngữ
 *    cảnh request đóng trong khi tx còn chạy — tx vẫn được đếm tới COMMIT, op trong tx vẫn qua nhờ ngữ
 *    cảnh `tx-le` của chính nó. Lưới AST `return await` trong action chỉ còn là lớp phụ.
 * Đi thẳng (không đếm, giữ ngữ cảnh): trong lối miễn (miễn không đếm — lượt phục hồi không chờ chính nó)
 * hoặc trong tx lẻ khác (tx ngoài đã đếm). Không ngữ cảnh + cờ đã bật ⇒ chạy không ngữ cảnh: op ghi đầu
 * tiên trong tx ném.
 */
export function bocTransactionLe(goc: (...a: unknown[]) => Promise<unknown>): (...a: unknown[]) => Promise<unknown> {
  return (...a: unknown[]): Promise<unknown> => {
    const st = trangThai();
    const song = nguCanhSong(st);
    if (song ? song.loai !== "request" : dangPhucHoi()) return goc(...a);
    st.soOpLe++;
    const ctx: NguCanhTxLe = { loai: "tx-le", dong: false };
    return st.als
      .run(ctx, async () => {
        try {
          return await goc(...a);
        } finally {
          ctx.dong = true; // việc thả trôi trong tx chạy SAU khi tx kết thúc không còn mang ngữ cảnh
        }
      })
      .finally(() => {
        st.soOpLe--;
        baoDrain(st);
      });
  };
}

// ───────────── Phân loại op ─────────────

const OP_DOC_MODEL = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);
const OP_RAW_TRA_VE = new Set(["$queryRaw", "$queryRawUnsafe"]);

const TU_KHOA_GHI =
  /\b(insert|update|delete|merge|truncate|alter|drop|create|grant|revoke|copy|call|do|lock|vacuum|reindex|cluster|refresh|comment|security|nextval|setval|set_config|pg_advisory_lock|pg_advisory_xact_lock|pg_advisory_lock_shared|pg_advisory_xact_lock_shared|pg_try_advisory_lock|pg_try_advisory_xact_lock|pg_try_advisory_lock_shared|pg_try_advisory_xact_lock_shared|pg_terminate_backend|pg_cancel_backend|lo_import|lo_unlink|dblink)\b/i;

/** SQL chỉ đọc ⇔ bắt đầu SELECT/WITH và KHÔNG chứa từ khoá ghi nào (fail-closed: nghi ngờ ⇒ ghi). */
export function laSqlChiDoc(sql: string): boolean {
  const sach = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .toLowerCase();
  if (!/^(select|with)\b/.test(sach)) return false;
  return !TU_KHOA_GHI.test(sach);
}

/** Lấy chuỗi SQL từ args raw: `$queryRawUnsafe(sql, ...)` ⇒ [sql,...]; tagged ⇒ Sql/TemplateStrings. */
export function layChuoiSql(args: unknown): string | null {
  if (typeof args === "string") return args;
  if (Array.isArray(args)) {
    if (args.length > 0 && typeof args[0] === "string") return args[0];
    if (args.length > 0 && Array.isArray(args[0])) return (args[0] as string[]).join(" ? ");
    return null;
  }
  if (args && typeof args === "object") {
    const o = args as { sql?: unknown; strings?: unknown; text?: unknown };
    if (typeof o.sql === "string") return o.sql;
    if (typeof o.text === "string") return o.text;
    if (Array.isArray(o.strings)) return (o.strings as string[]).join(" ? ");
  }
  return null;
}

/**
 * Op có phải GHI không. Model: mọi op NGOÀI danh sách đọc (op lạ = ghi). Raw: `$queryRaw*` chỉ là đọc
 * khi SQL chỉ-đọc; `$executeRaw*` và mọi op raw lạ = ghi.
 */
export function laOpGhi(model: string | undefined, operation: string, args: unknown): boolean {
  if (model !== undefined) return !OP_DOC_MODEL.has(operation);
  if (OP_RAW_TRA_VE.has(operation)) {
    const sql = layChuoiSql(args);
    return sql === null ? true : !laSqlChiDoc(sql);
  }
  return true;
}

// ───────────── Drain ─────────────

/**
 * Chờ bộ đếm request = 0 VÀ op lẻ = 0, có hạn. `true` = sạch, `false` = quá hạn. Gọi SAU khi đã bật
 * cờ (cờ chặn writer mới ở cửa; drain chỉ chờ lượt đã vào) — đảo thứ tự là writer mới lọt giữa lúc
 * drain báo sạch và lúc bật cờ.
 */
export function choDrain(hanMs: number): Promise<boolean> {
  const st = trangThai();
  const rong = () => st.soRequest <= 0 && st.soOpLe <= 0;
  if (rong()) return Promise.resolve(true);
  st.dangDrain = true;
  return new Promise((resolve) => {
    const xong = (ok: boolean) => {
      clearTimeout(hen);
      st.nguoiCho.delete(kiem);
      st.dangDrain = st.nguoiCho.size > 0;
      resolve(ok);
    };
    const kiem = () => {
      if (rong()) xong(true);
    };
    const hen = setTimeout(() => xong(false), hanMs);
    st.nguoiCho.add(kiem);
  });
}
