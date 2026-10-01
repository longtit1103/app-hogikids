import { Prisma } from "@/generated/prisma/client";

/**
 * Đọc lỗi của Prisma 7 (driver adapter `@prisma/adapter-pg`) — MỘT chỗ duy nhất biết các hình dạng
 * lỗi mà runtime ném ra, để phân loại "hạ tầng hay dữ liệu" và "xung đột ghi, chạy lại được" không
 * mỗi nơi tự đoán một kiểu.
 *
 * Prisma 7 bỏ engine Rust; lỗi `pg` đi qua `convertDriverError` của adapter thành `DriverAdapterError`
 * (`name = "DriverAdapterError"`, `.cause = { kind, originalCode?, originalMessage?, … }`) rồi runtime
 * xử lý theo ĐƯỜNG đi của câu lệnh (đo bằng runtime thật trên pool giả —
 * `tests/helpers/prisma-client-gia-lap-loi-driver.ts`):
 *  - câu ORM: `kind` có mã riêng ⇒ `PrismaClientKnownRequestError` mã đó (P1017, P2034, P2037…);
 *    `kind = "postgres"` (SQLSTATE không có mã riêng) ⇒ P2039. `meta.driverAdapterError` giữ lỗi gốc.
 *  - câu `$queryRaw`/`$executeRaw`: MỌI lỗi, kể cả mất kết nối / hết slot / phiên bị ngắt ⇒ P2010,
 *    nguyên nhân thật chỉ còn ở `meta.driverAdapterError.cause`.
 *  - COMMIT của transaction tương tác: runtime gọi thẳng adapter, KHÔNG bọc ⇒ `DriverAdapterError`
 *    TRẦN thoát ra tới code app.
 *  - lỗi `pg` không mang mã (mất kết nối giữa chừng, hết hạn chờ pool…): adapter không nhận diện
 *    được nên ném trả NGUYÊN `Error` của `pg` — không có `code`, chỉ nhận ra bằng thông điệp.
 */

/** Nguyên nhân adapter gắn vào `DriverAdapterError.cause` (xem `mapDriverError` của adapter-pg). */
export type NguyenNhanAdapter = {
  kind: string;
  /** SQLSTATE gốc của Postgres — có khi lỗi đến từ server, không có khi lỗi socket/TLS. */
  originalCode?: string;
  originalMessage?: string;
  /** Riêng `kind = "postgres"`: adapter chép lại SQLSTATE vào đây. */
  code?: string;
};

function laNguyenNhan(x: unknown): x is NguyenNhanAdapter {
  return typeof x === "object" && x !== null && typeof (x as { kind?: unknown }).kind === "string";
}

/** Đúng phép nhận diện runtime Prisma dùng: theo TÊN, không `instanceof` (lớp nằm ở gói khác). */
function laDriverAdapterError(e: unknown): e is Error & { cause: NguyenNhanAdapter } {
  return e instanceof Error && e.name === "DriverAdapterError" && laNguyenNhan((e as { cause?: unknown }).cause);
}

/**
 * Nguyên nhân tầng driver của một lỗi Prisma 7, dù nó đến TRẦN (COMMIT) hay nằm trong
 * `meta.driverAdapterError` của `PrismaClientKnownRequestError` (P2010 câu raw, P2039, và mọi mã
 * runtime dịch từ `kind`). `undefined` = lỗi không đi qua adapter.
 */
export function nguyenNhanAdapter(e: unknown): NguyenNhanAdapter | undefined {
  if (laDriverAdapterError(e)) return e.cause;
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    const goc = (e.meta as { driverAdapterError?: unknown } | undefined)?.driverAdapterError;
    if (laDriverAdapterError(goc)) return goc.cause;
  }
  return undefined;
}

/** SQLSTATE Postgres của nguyên nhân (`originalCode`, hoặc `code` của `kind = "postgres"`). */
export function maSqlState(n: NguyenNhanAdapter): string | undefined {
  return n.originalCode ?? n.code;
}

/**
 * `kind` là HẠ TẦNG/CẤU HÌNH — đúng bộ `kind` mà trên đường câu ORM runtime dịch ra mã vốn đã tính là
 * hệ thống ở `laLoiHeThong` (P1xxx, P2003, P2021, P2022, P2034, P2036, P2037). Giữ khớp như vậy để
 * cùng MỘT nguyên nhân cho cùng MỘT phán quyết, bất kể câu lệnh đi đường ORM, raw hay COMMIT.
 */
const KIND_HE_THONG: ReadonlySet<string> = new Set([
  "AuthenticationFailed", // P1000
  "DatabaseNotReachable", // P1001
  "DatabaseDoesNotExist", // P1003
  "SocketTimeout", // P1008
  "DatabaseAlreadyExists", // P1009
  "DatabaseAccessDenied", // P1010
  "TlsConnectionError", // P1011
  "ConnectionClosed", // P1017
  "TransactionAlreadyClosed", // P1018
  "ForeignKeyConstraintViolation", // P2003 — lý do xem `laLoiHeThong`
  "RestrictViolation", // P2003
  "TableDoesNotExist", // P2021
  "ColumnNotFound", // P2022
  "TransactionWriteConflict", // P2034
  "GenericJs", // P2036
  "TooManyConnections", // P2037
]);

/**
 * Lớp SQLSTATE (2 ký tự đầu) của lỗi HẠ TẦNG khi adapter trả `kind = "postgres"`:
 * 08 mất/đứt kết nối · 40 transaction bị cuộn (serialize, deadlock) · 53 cạn tài nguyên (hết slot,
 * đĩa, bộ nhớ) · 55 đối tượng chưa sẵn sàng (55P03 hết hạn chờ khoá — `lock_timeout` lúc phục hồi) ·
 * 57 can thiệp vận hành (57P01 phiên bị thu hồi, 57014 hết giờ câu lệnh/bị huỷ) · 58 lỗi hệ thống ·
 * XX lỗi nội bộ Postgres. Các lớp còn lại (23 vi phạm ràng buộc, 22 dữ liệu sai…) là của DÒNG.
 */
const LOP_SQLSTATE_HE_THONG: ReadonlySet<string> = new Set(["08", "40", "53", "55", "57", "58", "XX"]);

/**
 * 42501 = thiếu quyền. Lớp 42 phần lớn là lỗi câu lệnh, nhưng riêng mã này là DB dựng thiếu quyền —
 * đúng kiểu sự cố sau một lượt phục hồi, dính MỌI dòng như nhau.
 */
const MA_SQLSTATE_HE_THONG: ReadonlySet<string> = new Set(["42501"]);

/** Nguyên nhân tầng driver có phải sự cố HẠ TẦNG/CẤU HÌNH (không phải lỗi của dữ liệu đang ghi)? */
export function laNguyenNhanHeThong(n: NguyenNhanAdapter): boolean {
  if (KIND_HE_THONG.has(n.kind)) return true;
  if (n.kind !== "postgres") return false;
  const ma = maSqlState(n);
  if (!ma) return false;
  return MA_SQLSTATE_HE_THONG.has(ma) || LOP_SQLSTATE_HE_THONG.has(ma.slice(0, 2).toUpperCase());
}

/**
 * Thông điệp các `Error` KHÔNG MÃ mà `pg`/`pg-pool` ném khi kết nối hỏng — adapter không nhận diện
 * được nên chúng thoát ra nguyên dạng (đối chiếu mã nguồn `pg/lib/client.js`, `pg-pool/index.js`):
 * "Connection terminated" / "Connection terminated unexpectedly" / "Connection terminated due to
 * connection timeout", "Client has encountered a connection error and is not queryable", "Client was
 * closed and is not queryable", "timeout exceeded when trying to connect", "timeout expired"
 * (bắt tay quá hạn), "Query read timeout", "Cannot use a pool after calling end on the pool".
 */
const THONG_DIEP_LOI_KET_NOI_PG =
  /^(Connection terminated\b|Client has encountered a connection error and is not queryable|Client was closed and is not queryable|timeout exceeded when trying to connect|timeout expired$|Query read timeout|Cannot use a pool after calling end on the pool)/;

/**
 * Mã lỗi mạng của Node mà adapter KHÔNG dịch (nó chỉ dịch ECONNREFUSED/ECONNRESET/ETIMEDOUT/ENOTFOUND
 * khi có đủ `syscall` + `errno`) — lọt tới đây là lỗi socket thô.
 */
const MA_LOI_MANG_NODE: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EPIPE",
]);

/** Lỗi `pg`/socket thô (không qua adapter) báo kết nối DB hỏng. */
export function laLoiKetNoiPgTho(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const ma = (e as { code?: unknown }).code;
  if (typeof ma === "string" && MA_LOI_MANG_NODE.has(ma)) return true;
  return THONG_DIEP_LOI_KET_NOI_PG.test(e.message);
}

/** SQLSTATE của xung đột ghi: 40001 serialization_failure, 40P01 deadlock_detected. */
const MA_XUNG_DOT_GHI: ReadonlySet<string> = new Set(["40001", "40P01"]);

/**
 * Transaction bị Postgres cuộn lại TRỌN vì xung đột ghi (serialize/deadlock) — chạy lại từ đầu là an
 * toàn và đúng cách xử lý. Bắt đủ ba hình dạng: P2034 (câu ORM), P2010 kèm nguyên nhân 40001/40P01
 * (câu raw, vd `SELECT … FOR UPDATE` giành khoá), và `DriverAdapterError` TRẦN khi xung đột nổ ra lúc
 * COMMIT — ca điển hình của Serializable, trước đây lọt khỏi vòng thử lại thành trang 500.
 *
 * CỐ Ý HẸP: mất kết nối lúc COMMIT KHÔNG thuộc nhóm này — khi đó không biết transaction đã commit hay
 * chưa, chạy lại có thể ghi đôi.
 */
export function laXungDotGhi(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2034") return true;
  const n = nguyenNhanAdapter(e);
  if (!n) return false;
  if (n.kind === "TransactionWriteConflict") return true;
  const ma = maSqlState(n);
  return ma !== undefined && MA_XUNG_DOT_GHI.has(ma);
}

/**
 * Ràng buộc UNIQUE bị vi phạm, đọc từ nguyên nhân adapter của lỗi trùng khoá (P2002 câu ORM, P2010
 * câu raw, hoặc lỗi trần lúc COMMIT). `undefined` = không phải trùng khoá đi qua adapter.
 *
 * Prisma 7 KHÔNG còn `meta.target` (mảng tên cột của engine Prisma 6). adapter-pg dựng
 * `cause.constraint` từ lỗi `pg`: có tên ràng buộc ⇒ `{ index }` (Postgres gửi tên kèm 23505),
 * không có tên ⇒ `{ fields }` bóc từ dòng DETAIL "Key (a, b)=…".
 */
export function rangBuocTrungKhoa(e: unknown): { index?: string; fields?: string[] } | undefined {
  const n = nguyenNhanAdapter(e);
  if (!n || n.kind !== "UniqueConstraintViolation") return undefined;
  const c = (n as { constraint?: unknown }).constraint;
  if (typeof c !== "object" || c === null) return {};
  const { index, fields } = c as { index?: unknown; fields?: unknown };
  return {
    ...(typeof index === "string" ? { index } : {}),
    ...(Array.isArray(fields) && fields.every((f) => typeof f === "string") ? { fields: fields as string[] } : {}),
  };
}
