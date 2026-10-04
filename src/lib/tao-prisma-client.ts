import { PrismaPg } from "@prisma/adapter-pg";

// Đường dẫn TƯƠNG ĐỐI, không alias "@/": file này được nạp cả từ `prisma/seed.ts` và bộ e2e
// (Playwright không chắc resolve alias — xem `tests/e2e/global-setup.ts`).
import { PrismaClient } from "../generated/prisma/client";

/**
 * NƠI DUY NHẤT dựng `PrismaClient` (Prisma 7). Mọi chỗ cần client — singleton app
 * (`src/lib/prisma.ts`), seed, script, helper test — đều đi qua `taoPrismaClient()`; KHÔNG
 * `new PrismaClient()` trần ở đâu khác.
 *
 * Vì sao phải có: Prisma 7 bỏ engine Rust, nối Postgres bằng driver `pg` qua `@prisma/adapter-pg`.
 * Driver `pg` KHÔNG hiểu các tham số URL riêng của Prisma 6 — đáng kể nhất là `?schema=app`. Để
 * nguyên URL cho `pg` thì:
 *  - câu ORM vẫn đúng schema NẾU adapter được khai `{ schema }` (nó ghép tên bảng `"app"."Order"`);
 *  - nhưng mọi câu `$queryRaw`/`$executeRaw` viết tên bảng TRẦN (`"Setting"`, `"Loan" … FOR UPDATE`)
 *    sẽ rơi về `search_path` mặc định (`"$user", public`) — sai schema, hoặc tệ hơn trúng một bảng
 *    trùng tên ở `public`.
 * ⇒ Dịch `?schema=` thành CẢ HAI: tuỳ chọn `schema` của adapter (câu ORM) và `search_path` gửi ngay
 * lúc mở kết nối qua tham số khởi động `options=-c search_path=…` (câu raw) — đúng hành vi Prisma 6
 * (engine cũ tự `SET search_path` theo `?schema=`).
 *
 * Múi giờ PHIÊN được ép `TimeZone=UTC` cùng lúc đó: cột `timestamp` (không múi) của app giữ giờ UTC,
 * và mọi phép `now()`/ép kiểu `timestamptz ↔ timestamp` trong câu raw đổi theo múi của phiên. Để phiên
 * rơi về mặc định của server (`postgresql.conf`, hoặc `PGTZ`/ALTER ROLE ai đó đặt) là để số liệu lệch
 * 7 tiếng lặng lẽ khi hạ tầng đổi. DB prod vốn đã UTC — ép ở đây chỉ biến giả định thành hợp đồng.
 *
 * Tham số pool kiểu Prisma 6 trong URL (`connection_limit`, `pool_timeout`, `connect_timeout`,
 * `max_idle_connection_lifetime`, `max_connection_lifetime`) được dịch sang tuỳ chọn tương ứng của
 * `pg.Pool` — URL đang dùng ở `.env` các máy giữ nguyên nghĩa, và helper khoá test
 * (`tests/helpers/khoa-doc-quyen-db-test.ts`, `motKetNoi`) vẫn ép được 1 kết nối sống lâu.
 *
 * `sslmode` được dịch TƯỜNG MINH sang tuỳ chọn `ssl` của `pg` (xem `SSL_THEO_SSLMODE`) thay vì để
 * `pg-connection-string` tự hiểu: bản đó đọc `require` thành KIỂM chứng chỉ đầy đủ (Prisma 6: mã hoá,
 * KHÔNG kiểm) ⇒ DB chứng chỉ tự ký từ chối nối; còn giá trị Prisma 6 hiểu mà `pg` không làm được
 * (`prefer` = thử TLS rồi lùi về rõ) thì từ chối thẳng thay vì đổi nghĩa im lặng.
 */

/** Tên schema Postgres khi URL không khai `?schema=` — mặc định của Prisma 6. */
const SCHEMA_MAC_DINH = "public";

/**
 * Mặc định đặt cho khớp Prisma 6 thay vì mặc định của `pg` (docs nâng cấp Prisma 7, mục connection
 * pool): `pg` mặc định KHÔNG có hạn chờ kết nối (0 = chờ mãi) và đóng kết nối rảnh sau 10s.
 *  - Chờ kết nối: Prisma 6 có `pool_timeout` 10s (chờ lấy kết nối từ pool) + `connect_timeout` 5s
 *    (bắt tay). `pg` gộp cả hai vào MỘT hạn `connectionTimeoutMillis` ⇒ lấy 10s — vẫn hữu hạn (không
 *    treo vô hạn khi Tailscale chập), không gắt hơn Prisma 6 ở bước chờ pool.
 *  - Rảnh: Prisma 6 giữ kết nối rảnh 300s.
 */
const HAN_CHO_KET_NOI_GIAY_MAC_DINH = 10;
const TUOI_RANH_GIAY_MAC_DINH = 300;

/** Tên schema phải là định danh Postgres thường (chữ thường/số/gạch dưới) — ghép thẳng vào `search_path`. */
const DINH_DANH_SCHEMA = /^[a-z_][a-z0-9_]*$/;

/** Tham số URL chỉ Prisma hiểu — bóc khỏi URL trước khi giao cho `pg` (và dịch sang tuỳ chọn pool). */
const THAM_SO_RIENG_PRISMA = [
  "schema",
  "connection_limit",
  "pool_timeout",
  "connect_timeout",
  "max_idle_connection_lifetime",
  "max_connection_lifetime",
  "options",
  "sslmode",
] as const;

/**
 * `sslmode` → tuỳ chọn `ssl` của `pg`, giữ ngữ nghĩa Prisma 6 (Prisma 6 mặc định `sslaccept=accept_invalid_certs`):
 *  - `disable`     = không TLS.
 *  - `require`     = TLS, KHÔNG kiểm chứng chỉ (như Prisma 6 — chỉ chống nghe lén, không chống giả mạo).
 *  - `verify-full` = TLS + kiểm chứng chỉ theo kho CA hệ thống + khớp tên máy (mặc định của Node `tls`).
 * KHÔNG khai `sslmode` ⇒ không TLS (Prisma 6 là `prefer`: thử TLS, lùi về rõ — `pg` không có chế độ đó). Mạng
 * prod/dev là mạng docker nội bộ / Tailscale nên giữ như vậy; DB đi qua Internet (vd Supabase cloud) PHẢI khai
 * `sslmode=require` hoặc `verify-full` (docs/huong-dan-clone-and-go.md).
 */
const SSL_THEO_SSLMODE = {
  disable: false,
  require: { rejectUnauthorized: false },
  "verify-full": { rejectUnauthorized: true },
} as const satisfies Record<string, CauHinhSsl>;

/** Tuỳ chọn `ssl` giao cho `pg.Pool`: `false` = không TLS. */
export type CauHinhSsl = false | { rejectUnauthorized: boolean };

/**
 * Tham số URL mà `pg-connection-string` biến thành tuỳ chọn `ssl` RIÊNG — ĐÈ lên `ssl` dịch từ `sslmode` ở
 * trên (tham số trong URL thắng field cấu hình), và đường dẫn file hiểu theo thư mục chạy chứ không theo thư
 * mục schema như Prisma 6. Chưa dùng ở đâu ⇒ từ chối thay vì để nghĩa trôi; cần thì mở rộng nhà máy.
 */
const THAM_SO_SSL_CHUA_HO_TRO = ["ssl", "sslcert", "sslkey", "sslrootcert", "uselibpqcompat"] as const;

/**
 * Tham số URL của Prisma 6 mà `pg` KHÔNG hiểu và không có tuỳ chọn tương đương để dịch: để nguyên thì
 * `pg` lặng lẽ bỏ qua — người khai tưởng có hiệu lực (vd `socket_timeout`, `sslidentity`) nhưng thật ra
 * không. Từ chối thẳng (fail-closed) để người sửa URL biết mà gỡ hoặc cấu hình cách khác.
 */
const THAM_SO_PRISMA_KHONG_HO_TRO = [
  "socket_timeout",
  "pgbouncer",
  "statement_cache_size",
  "sslaccept",
  "sslidentity",
  "sslpassword",
] as const;

/** Cấu hình giao cho `PrismaPg`: phần `pg.PoolConfig` + tên schema cho adapter. */
export type CauHinhKetNoiPg = {
  schema: string;
  pool: {
    connectionString: string;
    options: string;
    max?: number;
    ssl: CauHinhSsl;
    connectionTimeoutMillis: number;
    idleTimeoutMillis: number;
    maxLifetimeSeconds: number;
    allowExitOnIdle: boolean;
  };
};

function soGiayKhongAm(u: URL, ten: string): number | undefined {
  const tho = u.searchParams.get(ten);
  if (tho === null) return undefined;
  const so = Number(tho);
  if (!Number.isInteger(so) || so < 0) {
    throw new Error(`Tham số URL database "${ten}=${tho}" không hợp lệ — phải là số nguyên ≥ 0.`);
  }
  return so;
}

/**
 * Dịch URL kiểu Prisma 6 (`postgresql://…/db?schema=app&connection_limit=…`) sang cấu hình `pg`.
 * Hàm thuần — không mở kết nối nào.
 */
export function cauHinhKetNoiTuUrl(url: string): CauHinhKetNoiPg {
  const u = new URL(url);

  const khongHoTro = THAM_SO_PRISMA_KHONG_HO_TRO.filter((ten) => u.searchParams.has(ten));
  if (khongHoTro.length > 0) {
    throw new Error(
      `Tham số URL database ${khongHoTro.map((t) => `"${t}"`).join(", ")} chỉ Prisma 6 hiểu — driver \`pg\` (Prisma 7) sẽ bỏ qua im lặng. Gỡ khỏi URL (hoặc cấu hình tương đương cho \`pg\`) rồi chạy lại.`,
    );
  }

  const sslChuaHoTro = THAM_SO_SSL_CHUA_HO_TRO.filter((ten) => u.searchParams.has(ten));
  if (sslChuaHoTro.length > 0) {
    throw new Error(
      `Tham số URL database ${sslChuaHoTro.map((t) => `"${t}"`).join(", ")} chưa được hỗ trợ — chỉ dùng \`sslmode=disable|require|verify-full\` (chứng chỉ theo kho CA hệ thống).`,
    );
  }
  const sslmode = u.searchParams.get("sslmode");
  if (sslmode !== null && !Object.hasOwn(SSL_THEO_SSLMODE, sslmode)) {
    throw new Error(
      `Tham số URL database "sslmode=${sslmode}" không hợp lệ — driver \`pg\` (Prisma 7) chỉ dịch đúng nghĩa ` +
        "`disable` (không TLS), `require` (TLS, không kiểm chứng chỉ — như Prisma 6) hoặc `verify-full` (TLS + kiểm chứng chỉ). " +
        "`prefer`/`allow` (thử TLS rồi lùi về kết nối rõ) không làm được — chọn hẳn một trong ba.",
    );
  }
  const sslDich: CauHinhSsl = sslmode === null ? false : SSL_THEO_SSLMODE[sslmode as keyof typeof SSL_THEO_SSLMODE];
  // Bản sao: `pg` giữ tham chiếu object `ssl` theo kết nối — không chia sẻ hằng giữa các pool.
  const ssl: CauHinhSsl = sslDich === false ? false : { ...sslDich };

  const schema = u.searchParams.get("schema") ?? SCHEMA_MAC_DINH;
  if (!DINH_DANH_SCHEMA.test(schema)) {
    throw new Error(
      `Tham số URL database "schema=${schema}" không hợp lệ — chỉ nhận chữ thường, số, gạch dưới.`,
    );
  }

  const gioiHanKetNoi = soGiayKhongAm(u, "connection_limit");
  if (gioiHanKetNoi === 0) {
    throw new Error('Tham số URL database "connection_limit=0" không hợp lệ — pool cần ít nhất 1 kết nối.');
  }
  const hanChoGiay =
    soGiayKhongAm(u, "pool_timeout") ?? soGiayKhongAm(u, "connect_timeout") ?? HAN_CHO_KET_NOI_GIAY_MAC_DINH;
  const tuoiRanhGiay = soGiayKhongAm(u, "max_idle_connection_lifetime") ?? TUOI_RANH_GIAY_MAC_DINH;
  const tuoiToiDaGiay = soGiayKhongAm(u, "max_connection_lifetime") ?? 0;

  // `options` sẵn có trong URL (nếu ai khai) được GIỮ và nối thêm `search_path` + `TimeZone` — phải
  // bóc khỏi URL vì `pg` cho tham số trong connection string ĐÈ lên field cấu hình cùng tên. Hai tham số
  // của app đứng SAU: Postgres áp `-c` theo thứ tự, cái sau thắng ⇒ không ai lỡ tay đè được.
  const optionsSanCo = u.searchParams.get("options")?.trim();
  const options = [optionsSanCo, `-c search_path=${schema}`, "-c TimeZone=UTC"].filter(Boolean).join(" ");

  for (const ten of THAM_SO_RIENG_PRISMA) u.searchParams.delete(ten);

  return {
    schema,
    pool: {
      connectionString: u.toString(),
      options,
      ...(gioiHanKetNoi !== undefined ? { max: gioiHanKetNoi } : {}),
      // Luôn khai tường minh (kể cả `false`): để `undefined` thì `pg` tự đọc `PGSSLMODE` của môi trường.
      ssl,
      // Prisma 6 và `pg` cùng hiểu 0 = không giới hạn ⇒ dịch thẳng giây → mili giây.
      connectionTimeoutMillis: hanChoGiay * 1000,
      idleTimeoutMillis: tuoiRanhGiay * 1000,
      maxLifetimeSeconds: tuoiToiDaGiay,
      // Kết nối rảnh KHÔNG giữ tiến trình sống — như engine Prisma 6: script/seed quên `$disconnect()`
      // vẫn thoát được thay vì treo tới hết tuổi rảnh (300s). Server Next vẫn sống nhờ HTTP server.
      allowExitOnIdle: true,
    },
  };
}

/**
 * Adapter cho trường hợp THIẾU URL: không ném lúc dựng (module `src/lib/prisma.ts` được nạp cả lúc
 * `next build` — ảnh Docker build KHÔNG có `DATABASE_URL`, Prisma 6 cũng chỉ báo lỗi lúc truy vấn),
 * nhưng ném ngay ở lần kết nối đầu tiên. TUYỆT ĐỐI không để `pg` tự đoán đích: thiếu connection
 * string thì `pg` rơi về `PGHOST`/`localhost` — nối nhầm DB khác mà không ai hay.
 */
class AdapterThieuUrl extends PrismaPg {
  constructor(private readonly thongBao: string) {
    super({});
  }

  override async connect(): Promise<never> {
    throw new Error(this.thongBao);
  }
}

/** Tuỳ chọn thêm cho script đo/kiểm: `logTruyVan` bật sự kiện `query` để gắn `client.$on("query", …)`. */
export type TuyChonTaoClient = { logTruyVan: true };

/**
 * Dựng `PrismaClient` nối tới `url` (URL kiểu Prisma 6, mang `?schema=`). `url` rỗng/thiếu ⇒ client
 * dựng được nhưng mọi truy vấn ném lỗi rõ ràng (xem `AdapterThieuUrl`). App KHÔNG truyền `tuyChon`.
 */
export function taoPrismaClient(url: string | undefined): PrismaClient;
export function taoPrismaClient(url: string | undefined, tuyChon: TuyChonTaoClient): PrismaClient<"query">;
export function taoPrismaClient(url: string | undefined, tuyChon?: TuyChonTaoClient): PrismaClient<"query"> | PrismaClient {
  const log = tuyChon?.logTruyVan ? ([{ emit: "event", level: "query" }] as const) : undefined;
  if (!url) {
    return new PrismaClient({
      adapter: new AdapterThieuUrl(
        "Chưa có URL database (DATABASE_URL trống) — từ chối kết nối. Script chạy ngoài container phải tự nạp .env (vd `npx tsx --env-file=.env …`).",
      ),
      ...(log ? { log: [...log] } : {}),
    });
  }
  const { schema, pool } = cauHinhKetNoiTuUrl(url);
  return new PrismaClient({ adapter: new PrismaPg(pool, { schema }), ...(log ? { log: [...log] } : {}) });
}
