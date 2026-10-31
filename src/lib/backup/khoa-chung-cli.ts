/**
 * KHOÁ GHI CHUNG giữa tiến trình CLI (script, seed — mọi tiến trình NGOÀI Next dùng
 * `taoPrismaClient`) và lượt phục hồi DB. Khoá tư vấn Postgres số `SO_KHOA_GHI_CHUNG`, cấp
 * DATABASE (nên DB test và DB prod không đụng nhau), trên `pg.Client` RIÊNG — không pool.
 *
 * - CLI: lần GHI đầu tiên ở MỖI DB đích giành `pg_try_advisory_lock_shared(K)` trên DB đó (nhiều CLI
 *   chạy song song được).
 *   Không giành được ⇒ ném `LoiCliDangPhucHoi` (restore đang giữ X). Kết nối giữ khoá mất
 *   (`error`/`end`) ⇒ in lỗi + `process.exit(1)`: khoá đã tuột thì tiến trình chết theo, không ghi
 *   tiếp qua pool Prisma (pool là kết nối KHÁC, không biết khoá đã mất).
 * - Restore: giữ X (`pg_try_advisory_lock(K)`) trên Client riêng; không giành được ⇒ trả danh sách
 *   phiên đang giữ (pid, application_name, backend_start) để báo 409 và cắt phiên mồ côi.
 *
 * File này KHÔNG import `tao-prisma-client.ts` (nó import ngược file này) — người gọi truyền sẵn
 * `pg.ClientConfig` dựng bằng `cauHinhClientKhoa()` ở đó (cùng nghĩa `sslmode`/`schema`/`options`
 * với pool app). Import TƯƠNG ĐỐI hết: chuỗi này được nạp cả từ `prisma/seed.ts` và Playwright.
 *
 * ⚠️ KHÔNG `unref()` socket giữ khoá. Đã đo: cùng `allowExitOnIdle` của pool Prisma, tiến trình THOÁT
 * mã 0 giữa lúc đang chờ lệnh ghi đầu mà không in gì. `$disconnect()` của client nhả luôn khoá (xem
 * `tao-prisma-client.ts`); script quên `$disconnect()` sẽ treo giữ khoá ⇒ restore 409 kèm pid.
 */
import pg from "pg";

/** Số khoá tư vấn K — cố định, mọi tiến trình (app, CLI, restore) cùng một số. */
export const SO_KHOA_GHI_CHUNG = 261_028_001;

/** Tiền tố `application_name` của MỌI kết nối tiến trình CLI (kết nối khoá + pool Prisma), kèm số khoá. */
export function tienToAppCli(): string {
  return `hogikids-cli[${SO_KHOA_GHI_CHUNG}]`;
}

/**
 * Tiền tố `application_name` kết nối giữ X của lượt phục hồi (`/api/restore` gắn đúng chuỗi này). Lối cắt
 * phiên KHÔNG bao giờ cắt phiên mang tiền tố này — cắt là tự tay đứt khoá của lượt phục hồi.
 */
export const TIEN_TO_APP_RESTORE = "hogikids-restore";

/**
 * Một phiên DB đang giữ khoá chung (hoặc phiên CLI còn sống) — chẩn đoán cho câu 409.
 *
 * `usename` = role của phiên; `catDuoc` = cùng role với kết nối đang hỏi (role app) — CHỈ những phiên
 * này lối cắt phiên của app cắt được (`catPhienGiuKhoaChung` lọc `usename = current_user`). Phiên role
 * khác (vd script chạy bằng `supabase_admin`) phải nhờ superuser cắt tay. Postgres giấu `backend_start`
 * của phiên role khác với role thường ⇒ `backendStart` có thể rỗng ở các phiên đó.
 */
export type PhienGiuKhoa = {
  pid: number;
  applicationName: string;
  backendStart: string;
  mode: string;
  usename: string;
  catDuoc: boolean;
};

const SQL_PHIEN_GIU_KHOA = `
  SELECT l.pid, a.application_name, a.backend_start, l.mode, a.usename, (a.usename = current_user) AS cat_duoc
    FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
   WHERE l.locktype = 'advisory' AND l.granted
     AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
     AND l.classid = 0 AND l.objid = $1 AND l.objsubid = 1
     AND l.pid <> pg_backend_pid()`;

type DongPhien = {
  pid: number;
  application_name: string | null;
  backend_start: Date | null;
  mode: string;
  usename: string | null;
  cat_duoc: boolean | null;
};

function sangPhien(x: DongPhien): PhienGiuKhoa {
  return {
    pid: x.pid,
    applicationName: x.application_name ?? "",
    backendStart: x.backend_start ? x.backend_start.toISOString() : "",
    mode: x.mode,
    usename: x.usename ?? "",
    catDuoc: x.cat_duoc === true,
  };
}

/** Phiên KHÁC đang giữ khoá K (shared hoặc X) trên DB của `client`. */
export async function docPhienDangGiuKhoaChung(client: pg.Client): Promise<PhienGiuKhoa[]> {
  const r = await client.query<DongPhien>(SQL_PHIEN_GIU_KHOA, [SO_KHOA_GHI_CHUNG]);
  return r.rows.map(sangPhien);
}

/** Phiên CLI (khoá hoặc pool) còn sống trên DB của `client` — trừ chính nó. */
async function docPhienCliConSong(client: pg.Client): Promise<PhienGiuKhoa[]> {
  const r = await client.query<Omit<DongPhien, "mode"> & { state: string | null }>(
    `SELECT pid, application_name, backend_start, state, usename, (usename = current_user) AS cat_duoc
       FROM pg_stat_activity
      WHERE datname = current_database() AND application_name LIKE $1 AND pid <> pg_backend_pid()`,
    [`${tienToAppCli()}%`],
  );
  return r.rows.map((x) => sangPhien({ ...x, mode: `phien:${x.state ?? "?"}` }));
}

// ───────────── Phía restore: khoá độc quyền X ─────────────

/** Khoá X đang giữ của một lượt phục hồi. */
export type KhoaDocQuyenRestore = {
  /** pid phía server của kết nối giữ X (chẩn đoán). */
  pid: number;
  /**
   * Còn giữ X không — soi `pg_locks` theo pid của CHÍNH kết nối khoá. Lỗi truy vấn / kết nối đã mất
   * ⇒ `false` (không biết = coi như mất; mọi điểm gọi đứng trước lệnh phá huỷ).
   */
  conGiu: () => Promise<boolean>;
  /** Nhả X (đóng kết nối). Không ném. */
  nha: () => Promise<void>;
};

export type KetQuaGiuDocQuyen = { ok: true; khoa: KhoaDocQuyenRestore } | { ok: false; nguoiGiu: PhienGiuKhoa[] };

/**
 * Restore giành X. Không chờ khoá (try) — CLI đang giữ shared thì báo ngay ai đang giữ.
 *
 * Giành được X rồi còn CHỜ (có hạn) tới khi KHÔNG còn phiên CLI nào: CLI vừa mất kết nối khoá có
 * thể còn một lệnh ghi đang bay trên pool tới khi nó kịp `exit(1)` — đo được 1 dòng commit SAU lúc
 * cắt ở 4/5 lượt khi không chờ. Quá hạn ⇒ nhả X, trả danh sách phiên CLI còn sống (409).
 */
export async function giuDocQuyenRestore(cauHinh: pg.ClientConfig, hanChoPhienCliMs = 10_000): Promise<KetQuaGiuDocQuyen> {
  const client = new pg.Client(cauHinh);
  // Lỗi socket sau khi đã giành: KHÔNG để thành `uncaughtException` giết cả app — `conGiu()` sẽ trả
  // false ở chốt kế tiếp.
  client.on("error", (e) => console.error("[khoa-ghi-chung] kết nối giữ X của lượt phục hồi lỗi:", e.message));
  await client.connect();
  try {
    const r = await client.query<{ ok: boolean; pid: number }>(
      "SELECT pg_try_advisory_lock($1) AS ok, pg_backend_pid() AS pid",
      [SO_KHOA_GHI_CHUNG],
    );
    if (!r.rows[0].ok) {
      const nguoiGiu = await docPhienDangGiuKhoaChung(client);
      await client.end().catch(() => {});
      return { ok: false, nguoiGiu };
    }
    const pid = r.rows[0].pid;
    const het = Date.now() + hanChoPhienCliMs;
    for (;;) {
      const conSong = await docPhienCliConSong(client);
      if (conSong.length === 0) break;
      if (Date.now() > het) {
        await client.end().catch(() => {});
        return { ok: false, nguoiGiu: conSong };
      }
      await new Promise((res) => setTimeout(res, 50));
    }
    const conGiu = async (): Promise<boolean> => {
      try {
        const k = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks
            WHERE pid = pg_backend_pid() AND locktype = 'advisory' AND classid = 0 AND objid = $1
              AND objsubid = 1 AND mode = 'ExclusiveLock' AND granted`,
          [SO_KHOA_GHI_CHUNG],
        );
        return k.rows[0].n === 1;
      } catch {
        return false;
      }
    };
    return { ok: true, khoa: { pid, conGiu, nha: () => client.end().catch(() => {}) } };
  } catch (e) {
    await client.end().catch(() => {});
    throw e;
  }
}

/**
 * Cắt MỘT phiên đang chặn lượt phục hồi — lối gỡ phiên CLI mồ côi (Mac ngủ giữ kết nối tới ~2h11' vì
 * cluster `tcp_keepalives_* = 0`). Cắt được khi `pid` cùng role (`usename = current_user` — role app
 * chỉ cắt được phiên cùng role, không đụng Supabase/n8n), cùng DB, VÀ là một trong:
 *  - phiên mang tiền tố `application_name` CLI — kết nối khoá HOẶC kết nối POOL của script: sau khi
 *    giành X, `giuDocQuyenRestore` còn chờ mọi phiên CLI tắt và trả chính các phiên pool đó trong 409,
 *    nên nút cắt phải cắt được chúng, không thì chủ shop kẹt tới khi Mac thức;
 *  - phiên đang giữ khoá chung ở mode SHARED (CLI không gắn tên).
 * TUYỆT ĐỐI không cắt: phiên giữ K ở mode EXCLUSIVE (X của một lượt phục hồi — kể cả trong khe giữa
 * lúc giành X và lúc bật cờ) và phiên mang tiền tố `TIEN_TO_APP_RESTORE`.
 *
 * `backendStart` (ISO, từ danh sách 409) có ⇒ phải khớp — pid cũ có thể đã thuộc về phiên mới. So ở độ
 * chính xác mili giây: danh sách 409 đi qua `Date` của JS (mất phần micro giây của Postgres).
 *
 * Kết quả: `da-cat`; `khac-role` = phiên còn sống trên DB nhưng thuộc role KHÁC (app không có quyền cắt
 * — người vận hành phải cắt bằng superuser); `khong-chan` = pid không còn là phiên chặn phục hồi (đã
 * thoát / pid đã đổi chủ / không giữ khoá) — không làm gì.
 */
export type KetQuaCatPhien = { ketQua: "da-cat" } | { ketQua: "khac-role"; usename: string } | { ketQua: "khong-chan" };

export async function catPhienGiuKhoaChung(
  cauHinh: pg.ClientConfig,
  pid: number,
  backendStart?: string,
): Promise<KetQuaCatPhien> {
  if (!Number.isInteger(pid) || pid <= 0) return { ketQua: "khong-chan" };
  const client = new pg.Client(cauHinh);
  client.on("error", () => {});
  await client.connect();
  try {
    const r = await client.query<{ cat: boolean | null }>(
      `SELECT pg_terminate_backend(a.pid, 5000) AS cat
         FROM pg_stat_activity a
        WHERE a.pid = $1 AND a.pid <> pg_backend_pid() AND a.usename = current_user
          AND a.datname = current_database()
          AND ($5::timestamptz IS NULL OR date_trunc('milliseconds', a.backend_start) = $5::timestamptz)
          AND COALESCE(a.application_name, '') NOT LIKE $3
          AND (COALESCE(a.application_name, '') LIKE $4
               OR EXISTS (SELECT 1 FROM pg_locks l
                           WHERE l.pid = a.pid AND l.locktype = 'advisory' AND l.granted AND l.mode = 'ShareLock'
                             AND l.classid = 0 AND l.objid = $2 AND l.objsubid = 1))
          AND NOT EXISTS (SELECT 1 FROM pg_locks l
                           WHERE l.pid = a.pid AND l.locktype = 'advisory' AND l.mode = 'ExclusiveLock'
                             AND l.classid = 0 AND l.objid = $2 AND l.objsubid = 1)`,
      [pid, SO_KHOA_GHI_CHUNG, `${TIEN_TO_APP_RESTORE}%`, `${tienToAppCli()}%`, backendStart ?? null],
    );
    if (r.rows[0]?.cat === true) return { ketQua: "da-cat" };
    // Không cắt: phân biệt "phiên role khác" (còn sống, app không đủ quyền) với "không còn chặn" — câu
    // báo "đã tự thoát" cho phiên role khác là sai sự thật và dẫn chủ shop bấm vô ích.
    const k = await client.query<{ usename: string | null }>(
      `SELECT usename FROM pg_stat_activity
        WHERE pid = $1 AND datname = current_database() AND usename IS DISTINCT FROM current_user`,
      [pid],
    );
    if (k.rows.length > 0) return { ketQua: "khac-role", usename: k.rows[0].usename ?? "" };
    return { ketQua: "khong-chan" };
  } finally {
    await client.end().catch(() => {});
  }
}

// ───────────── Phía CLI: khoá shared, giành ở lần ghi đầu ─────────────

/**
 * Trạng thái khoá CLI THEO DB ĐÍCH (khoá tư vấn có phạm vi DATABASE): một tiến trình có thể dựng nhiều
 * client tới nhiều DB (vd `scripts/setup-clone/tao-role-n8n-ro.ts`) — một lời hứa cho cả tiến trình thì
 * ghi ở DB thứ hai thấy "đã giữ" mà thật ra KHÔNG có khoá trên DB đó. Mỗi đích một kết nối khoá + tập
 * client ("chủ") đang dùng nó; `$disconnect` của một client chỉ bỏ client đó, khoá nhả khi tập rỗng —
 * client phụ ngắt sớm không nhả khoá giữa một transaction của client khác.
 */
type TrangThaiDongKhoa = { chu: Set<object>; dangDongChuDong: boolean };
type MucKhoaCli = TrangThaiDongKhoa & { hua: Promise<pg.Client> };
type TrangThaiKhoaCli = { theoDich: Map<string, MucKhoaCli> };
const KHOA_TRANG_THAI = Symbol.for("hogikids.congGhi.khoaCli.theoDich");

function trangThaiCli(): TrangThaiKhoaCli {
  const g = globalThis as unknown as Record<symbol, TrangThaiKhoaCli | undefined>;
  return (g[KHOA_TRANG_THAI] ??= { theoDich: new Map() });
}

/** Danh tính DB đích của một cấu hình — `host:port/database` (phạm vi của khoá tư vấn). */
export function dichKhoaCli(cauHinh: pg.ClientConfig): string {
  if (cauHinh.connectionString) {
    const u = new URL(cauHinh.connectionString);
    return `${u.hostname}:${u.port || "5432"}/${decodeURIComponent(u.pathname.replace(/^\//, ""))}`;
  }
  return `${cauHinh.host ?? "localhost"}:${cauHinh.port ?? 5432}/${cauHinh.database ?? ""}`;
}

/** CLI không giành được khoá chung — một lượt phục hồi đang giữ độc quyền. */
export class LoiCliDangPhucHoi extends Error {
  constructor() {
    super("Đang phục hồi dữ liệu (khoá ghi chung bị giữ độc quyền) — script dừng, chạy lại sau khi phục hồi xong.");
    this.name = "LoiCliDangPhucHoi";
  }
}

async function dongChuDong(muc: TrangThaiDongKhoa, client: pg.Client | null): Promise<void> {
  muc.dangDongChuDong = true;
  await client?.end().catch(() => {});
}

/** Mở kết nối riêng + giành shared ở đích `dich`; `muc` là mục trạng thái của chính đích đó. */
async function gianhKhoaTaiDich(cauHinh: pg.ClientConfig, dich: string, muc: TrangThaiDongKhoa): Promise<pg.Client> {
  const st = trangThaiCli();
  const client = new pg.Client(cauHinh);
  // Chỉ "mất khoá" khi ĐÃ giữ: lỗi/`end` lúc đang nối hoặc đang hỏi khoá đi theo lời hứa bị từ chối
  // (pg vẫn bắn `end` sau một lần nối hỏng — không chặn thì tiến trình chết trước khi kịp báo lỗi).
  let daGiu = false;
  const matKhoa = (lyDo: string) => {
    if (muc.dangDongChuDong || !daGiu) return;
    console.error(`[khoa-ghi-chung] mất kết nối giữ khoá ${dich} (${lyDo}) — dừng tiến trình để không ghi tiếp.`);
    process.exit(1);
  };
  client.on("error", (e) => matKhoa(`error: ${e.message}`));
  client.on("end", () => matKhoa("end"));
  const boMuc = () => {
    if (st.theoDich.get(dich) === muc) st.theoDich.delete(dich);
  };
  let ok = false;
  try {
    await client.connect();
    const r = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock_shared($1) AS ok", [SO_KHOA_GHI_CHUNG]);
    ok = r.rows[0].ok;
  } catch (e) {
    await dongChuDong(muc, client);
    boMuc();
    throw e;
  }
  if (ok) {
    daGiu = true;
    return client;
  }
  await dongChuDong(muc, client);
  boMuc();
  throw new LoiCliDangPhucHoi();
}

/**
 * Giành khoá shared MỘT lần cho mỗi DB đích (nhớ lời hứa theo đích) và ghi `chu` (client Prisma gọi)
 * vào tập người dùng khoá. Gọi trước MỖI lần ghi; lần đầu ở một đích mở kết nối. Mất kết nối giữ khoá
 * ⇒ `process.exit(1)` (fail-closed). Giành trượt ⇒ ném `LoiCliDangPhucHoi`, lần ghi sau thử lại từ đầu.
 */
export function giuKhoaChungCli(cauHinh: pg.ClientConfig, chu: object): Promise<pg.Client> {
  const st = trangThaiCli();
  const dich = dichKhoaCli(cauHinh);
  const co = st.theoDich.get(dich);
  if (co) {
    co.chu.add(chu);
    return co.hua;
  }
  const trangThai: TrangThaiDongKhoa = { chu: new Set([chu]), dangDongChuDong: false };
  // `Object.assign` giữ NGUYÊN đối tượng `trangThai` (lời hứa đọc/ghi cờ đóng chủ động trên chính nó).
  const muc: MucKhoaCli = Object.assign(trangThai, { hua: gianhKhoaTaiDich(cauHinh, dich, trangThai) });
  st.theoDich.set(dich, muc);
  return muc.hua;
}

/**
 * Kết nối giữ khoá CLI nếu ĐÃ giành (không tự giành) — để báo pid chẩn đoán. Không truyền `cauHinh` ⇒
 * đích đầu tiên đang giữ (tiến trình một DB).
 */
export async function clientKhoaCliNeuCo(cauHinh?: pg.ClientConfig): Promise<pg.Client | null> {
  const st = trangThaiCli();
  const muc = cauHinh ? st.theoDich.get(dichKhoaCli(cauHinh)) : st.theoDich.values().next().value;
  return muc ? muc.hua.catch(() => null) : null;
}

/**
 * `chu` thôi dùng khoá ở đích của `cauHinh` (qua `$disconnect`). Khoá chỉ nhả — đóng chủ động, không
 * kích `exit(1)` — khi KHÔNG còn client nào của đích đó đang dùng.
 */
export async function nhaKhoaChungCli(cauHinh: pg.ClientConfig, chu: object): Promise<void> {
  const st = trangThaiCli();
  const dich = dichKhoaCli(cauHinh);
  const muc = st.theoDich.get(dich);
  if (!muc) return;
  muc.chu.delete(chu);
  if (muc.chu.size > 0) return;
  st.theoDich.delete(dich);
  const client = await muc.hua.catch(() => null);
  await dongChuDong(muc, client);
}
