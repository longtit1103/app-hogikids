import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { constants as zlibConstants, gunzip, gunzipSync } from "node:zlib";

import { N8N_RO_ROLE, N8N_SETTING_VIEW } from "@/lib/n8n/role-doc-kho-khoa";

import { assertDumpOnlySchema } from "./assert-dump-schema";
import { assertPlainSqlOnlySchema } from "./assert-plain-sql-only-schema";
import {
  giay,
  HAN_CAU_LENH_NHANH_MS,
  HAN_LENH_NHANH_MS,
  HAN_NAP_PHUC_HOI_MS,
  laLoiQuaHan,
  pgOptionsPhanh,
} from "./han-chay-lenh-pg";
import { parsePgUrl } from "./run-pg-dump";

const execFileAsync = promisify(execFile);
const gunzipAsync = promisify(gunzip);

// psql/pg_restore stdout khi nạp có thể dài (danh sách lệnh) — nới maxBuffer.
const MAX_RESTORE_STDOUT = 64 * 1024 * 1024; // 64MB

// Trần bung nén TOÀN PHẦN cho đường plain-gzip (chống gzip-bomb OOM). Dump .sql
// của app hiện chỉ vài MB; 2GiB dư dả cho tăng trưởng nhưng vẫn chặn bomb nở
// hàng chục GB vào RAM.
const MAX_UNZIPPED_BYTES = 2 * 1024 * 1024 * 1024; // 2GiB

/** Số byte đầu (sau giải nén) đủ cho detectRestoreFormat/assertNotArchive. */
const HEAD_BYTES = 512;
// Chỉ đưa 4KiB input NÉN đầu tiên vào zlib khi đọc head: deflate nở tối đa
// ~1032× ⇒ output bị chặn cứng ~4.2MiB bất kể file nén to cỡ nào — không OOM.
const HEAD_COMPRESSED_BYTES = 4096;
// maxOutputLength = chốt an toàn tuyệt đối (8MiB > trần lý thuyết 4.2MiB nên
// file hợp lệ KHÔNG BAO GIỜ chạm; chỉ kích nếu zlib hành xử ngoài dự kiến).
const HEAD_MAX_OUTPUT = 8 * 1024 * 1024;

/**
 * Giải nén CHỈ PHẦN ĐẦU buffer gzip để đọc head — KHÔNG bung cả file vào RAM
 * như `gunzipSync(fileBuf)` trần (gzip-bomb → OOM). `Z_SYNC_FLUSH` cho phép
 * input cắt cụt (4KiB đầu) kết thúc không lỗi; `maxOutputLength` chặn trần
 * output. File hỏng/không phải gzip vẫn throw như gunzipSync thường.
 */
export function gunzipHead(gzBuf: Buffer): Buffer {
  return gunzipSync(gzBuf.subarray(0, HEAD_COMPRESSED_BYTES), {
    finishFlush: zlibConstants.Z_SYNC_FLUSH,
    maxOutputLength: HEAD_MAX_OUTPUT,
  }).subarray(0, HEAD_BYTES);
}

export type RestoreFormat = "custom" | "plain-gzip";

/**
 * Nhận diện định dạng artifact phục hồi TỪ VÀI BYTE ĐẦU (không load cả file).
 *
 * - `pg_dump -Fc` (custom) mở đầu bằng ASCII magic "PGDMP" → "custom".
 * - gzip (`.sql.gz` plain) mở đầu bằng 0x1f 0x8b → "plain-gzip".
 * - Khác → null (từ chối). CHÚ Ý: backup-TOÀN-SERVER `.tar.gz` cũng bắt đầu
 *   bằng 0x1f 0x8b nên detect ra "plain-gzip" — nó chỉ bị loại ở BƯỚC SAU
 *   (`assertNotArchive` chạy SAU gunzip, TRƯỚC mọi thao tác DB).
 */
export function detectRestoreFormat(head: Buffer): RestoreFormat | null {
  if (head.length >= 5 && head.subarray(0, 5).toString("ascii") === "PGDMP") {
    return "custom";
  }
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) {
    return "plain-gzip";
  }
  return null;
}

// Tiền tố hợp lệ của một dump SQL plain (pg_dump text) hoặc script SQL thường.
// So khớp CASE-INSENSITIVE (đã upper-case đầu vào) để rộng lượng vừa phải.
const SQL_PREFIXES = [
  "--", // comment / header pg_dump plain ("-- PostgreSQL database dump")
  "SET ",
  "CREATE ",
  "BEGIN",
  "ALTER ",
  "COMMENT",
  "\\CONNECT", // psql meta-command \connect
  "SELECT ",
];

/**
 * Chốt an toàn C1 — gọi SAU gunzip, TRƯỚC mọi thao tác DB.
 *
 * Ném lỗi nếu buffer là TAR (magic ASCII "ustar" @offset 257 = backup-TOÀN-SERVER
 * `.tar.gz`) HOẶC nội dung không giống SQL. Lý do sống-còn: `.tar.gz` toàn-server
 * có magic gzip giống `.sql.gz` plain; nếu KHÔNG chặn ở đây, đường plain-gzip sẽ
 * `DROP SCHEMA public CASCADE` RỒI mới fail nạp → xoá schema dở, đúng lúc cần
 * phục hồi. Vì vậy phải throw TRƯỚC khi bất kỳ DROP/DDL nào đụng DB.
 */
export function assertNotArchive(unzippedHead: Buffer): void {
  // TAR: "ustar" tại offset 257 (POSIX ustar / GNU tar magic).
  if (
    unzippedHead.length >= 262 &&
    unzippedHead.subarray(257, 262).toString("ascii") === "ustar"
  ) {
    throw new Error(
      "File .tar.gz backup-toàn-server KHÔNG dùng để phục hồi 1 DB — xem hướng dẫn deploy (deploy/restore.sh).",
    );
  }

  // Nội dung phải "trông giống SQL": bỏ khoảng trắng đầu rồi so tiền tố.
  // Dùng latin1 để đọc byte thô (không lỗi multibyte); nội dung nhị phân/tar
  // không-ustar sẽ không khớp tiền tố nào → bị loại.
  const text = unzippedHead.toString("latin1").replace(/^\s+/, "");
  const upper = text.toUpperCase();
  const looksLikeSql = SQL_PREFIXES.some((prefix) => upper.startsWith(prefix));
  if (!looksLikeSql) {
    throw new Error(
      "Nội dung file không phải SQL hợp lệ để phục hồi — file có thể hỏng hoặc sai định dạng.",
    );
  }
}

/**
 * Dựng lệnh + args phục hồi từ DATABASE_URL. DÙNG LẠI `parsePgUrl` của
 * run-pg-dump (KHÔNG nhân bản logic parse — DRY). Hàm THUẦN, unit-test không cần
 * Postgres.
 *
 * - custom → `pg_restore --clean --if-exists --no-owner --no-privileges --exit-on-error …`
 *   (--clean --if-exists tự drop+tạo lại object; KHÔNG drop database;
 *   --exit-on-error để fail loud khi restore hỏng một phần).
 * - plain-gzip → `psql … -v ON_ERROR_STOP=1` (nạp SQL đã gunzip + ĐÃ qua
 *   assertNotArchive; dọn schema do runRestore làm riêng vì dump plain không --clean).
 */
export function restoreArgsFromUrl(
  dbUrl: string,
  format: RestoreFormat,
): { cmd: string; args: string[]; env: { PGPASSWORD: string } } {
  const { host, port, user, db, password, schema } = parsePgUrl(dbUrl);
  const conn = ["-h", host, "-p", port, "-U", user, "-d", db];

  if (format === "custom") {
    return {
      cmd: "pg_restore",
      // --exit-on-error: pg_restore mặc định BỎ QUA lỗi từng object và exit 0 →
      // restore hỏng một phần vẫn báo {ok:true}. Cờ này ép dừng + exit khác 0 ở
      // lỗi ĐẦU TIÊN (→ catch của route trả 500). An toàn với restore hợp lệ:
      // --clean --if-exists drop object thiếu KHÔNG lỗi, dump sạch vào DB cùng
      // version không sinh lỗi nào, nên cờ chỉ kích khi restore thật sự hỏng.
      // -n <schema>: giới hạn restore CHỈ trong schema đích từ URL (KHÔNG hardcode
      // public/app) — cùng chốt an toàn với assertDumpOnlySchema ở runRestore.
      args: [
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-privileges",
        "--exit-on-error",
        "-n",
        schema,
        ...conn,
      ],
      env: { PGPASSWORD: password },
    };
  }

  return {
    cmd: "psql",
    args: [...conn, "-v", "ON_ERROR_STOP=1"],
    env: { PGPASSWORD: password },
  };
}

/**
 * Hạn cho một lệnh pg client.
 *
 * - `hanCauLenhMs` bỏ trống = KHÔNG đặt `statement_timeout` ở tầng DB — dành cho bước NẠP, nơi một
 *   `COPY`/`CREATE INDEX` hợp lệ chạy rất lâu.
 * - `coTheNapDo` = lệnh này CÓ ghi vào DB, nên bị dừng giữa chừng là có thể để lại dữ liệu nạp dở.
 *   CHỈ bước nạp thật mới được bật: mấy lệnh còn lại (đọc mục lục trong file, một câu SELECT hỏi
 *   quyền, câu DROP mà lỗi lan ra trước khi xoá) không thể làm dữ liệu dở, mà doạ "có thể đã nạp
 *   dở" cho chúng là đẩy chủ shop đi lùi về bản `pre-restore-*.dump` một cách vô cớ.
 */
type HanLenh = { hanMs: number; hanCauLenhMs?: number; coTheNapDo?: true };

/** Hạn cho nhóm câu một dòng (hỏi quyền, DROP SCHEMA, GRANT) và bước đọc mục lục dump. */
const HAN_NHANH: HanLenh = { hanMs: HAN_LENH_NHANH_MS, hanCauLenhMs: HAN_CAU_LENH_NHANH_MS };

/** Hạn cho bước nạp thật (`pg_restore` / `psql -f`) — bước DUY NHẤT ghi được dữ liệu dở. */
const HAN_NAP: HanLenh = { hanMs: HAN_NAP_PHUC_HOI_MS, coTheNapDo: true };

/**
 * Chạy 1 lệnh pg client, gói lỗi thành message rõ ràng (kèm stderr), trả stdout.
 *
 * MỌI lệnh pg của đường phục hồi PHẢI đi qua đây — đó là chỗ duy nhất đặt được phanh:
 *  - `timeout`: hết hạn thì `execFile` bắn SIGTERM, `await` bật lỗi ra, `finally` của route mới trả
 *    được khoá bảo trì. Không có nó thì một lệnh treo là app kẹt chế độ chỉ-đọc tới lúc restart.
 *    Đây là phanh DUY NHẤT của bước nạp (`pg_restore`, `psql -f`).
 *  - `PGOPTIONS`: đặt `lock_timeout` (và `statement_timeout` cho câu ngắn) ngay lúc mở kết nối —
 *    ⚠️ chỉ ăn với `psql -c "<câu ngắn>"`, tức các bước hỏi quyền / `DROP SCHEMA` / `GRANT`. Đúng
 *    ba bước đó lại là chỗ cần nhất: câu DROP phải giành ACCESS EXCLUSIVE trên cả schema, và nhờ
 *    `lock_timeout` mà nó báo "chờ khoá" TRƯỚC KHI xoá bất cứ thứ gì. Với `pg_restore -l`,
 *    `pg_restore <dump>` và `psql -f <dump>` thì đây là NO-OP — chúng tự chạy
 *    `SET statement_timeout = 0; SET lock_timeout = 0;` (đo thật prod 01/08/2026, xem
 *    `pgOptionsPhanh()` trong `han-chay-lenh-pg.ts`). Vẫn truyền cho mọi lệnh vì đặt có điều kiện
 *    chỉ thêm nhánh chứ không thêm phanh. Ghi đè `PGOPTIONS` sẵn có của tiến trình là CỐ Ý: phanh
 *    không được phép tuỳ môi trường.
 */
async function runPgClient(
  cmd: string,
  args: string[],
  env: { PGPASSWORD: string },
  han: HanLenh,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      env: { ...process.env, ...env, PGOPTIONS: pgOptionsPhanh(han.hanCauLenhMs) },
      maxBuffer: MAX_RESTORE_STDOUT,
      encoding: "utf8",
      timeout: han.hanMs,
    });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string };
    if (e.code === "ENOENT") {
      throw new Error(
        `Không tìm thấy lệnh ${cmd} — image app phải cài postgresql-client-15 khớp supabase-db.`,
      );
    }
    const stderr = e.stderr ? e.stderr.toString().trim() : "";
    // SIGTERM thường không để lại stderr, nên không tách nhánh thì câu báo ra "… thất bại (Command
    // failed)" — người đọc không biết là treo hay hỏng dữ liệu. Nói thẳng "quá hạn".
    //
    // Vế sau tuỳ `coTheNapDo`, KHÔNG dùng chung một câu. Có 6 chỗ gọi: 2 bước NẠP (`HAN_NAP` —
    // `pg_restore <dump>` và `psql -f <sql>`) và 4 câu ngắn (`HAN_NHANH`) — `pg_restore -l` chỉ đọc
    // mục lục trong FILE (còn không mở kết nối DB), `coQuyenTaoSchema` là một SELECT thuần,
    // `donSchemaChoDumpPlain` tuy có DROP nhưng cả chuỗi nằm trong MỘT câu `psql -c` (transaction
    // ngầm) nên bị dừng là quay lui sạch, và `capLaiQuyenDocChoN8n` là GRANT chạy SAU khi nạp xong.
    //
    // Vì thế vế không-cờ nói về CHÍNH LỆNH ĐÓ chứ không dám khẳng định trạng thái cả DB: bước GRANT
    // quá hạn thì schema vừa nạp xong hẳn hoi, câu "chưa có gì bị đổi trong DB" sẽ là nói dối. Doạ
    // ngược lại — "có thể đã nạp dở" cho mấy câu ngắn — cũng hỏng: nó xui chủ shop đi lùi về bản
    // `pre-restore-*.dump` trong khi thử lại là xong.
    if (laLoiQuaHan(e)) {
      const nguyenNhan = han.coTheNapDo
        ? "DB không phản hồi hoặc có phiên khác giữ khoá; dữ liệu có thể đã nạp dở"
        : "lệnh này không ghi dữ liệu nên bản đang có còn nguyên vẹn, thử lại được";
      throw new Error(
        `${cmd} quá hạn ${giay(han.hanMs)} và đã bị dừng — ${nguyenNhan}${stderr ? `: ${stderr}` : "."}`,
      );
    }
    throw new Error(`${cmd} thất bại${stderr ? `: ${stderr}` : ` (${e.message})`}`);
  }
}

/** Đường dẫn file tạm ngẫu nhiên trong os.tmpdir(). */
function tempPath(suffix: string): string {
  return join(tmpdir(), `hogikids-restore-${randomBytes(8).toString("hex")}${suffix}`);
}

/**
 * Role đang nối có quyền TẠO schema trong DB đích không (quyền `CREATE` trên DATABASE).
 *
 * ĐO THẬT trên prod 29/07: role app (`hogikids`) trả `has_database_privilege(...,'CREATE') = false`
 * — nó SỞ HỮU schema `app` nên DROP được, nhưng TẠO LẠI thì không. Nghĩa là bất kỳ đường phục hồi
 * nào lỡ `DROP SCHEMA` rồi mới trông chờ tạo lại sẽ kết thúc bằng: schema đã mất, lệnh tạo bị từ
 * chối, DB trống trơn — đúng vào lúc chủ shop cần cứu dữ liệu nhất. Nên phải HỎI TRƯỚC KHI DROP.
 */
async function coQuyenTaoSchema(dbUrl: string): Promise<boolean> {
  const { cmd, args, env } = restoreArgsFromUrl(dbUrl, "plain-gzip");
  const stdout = await runPgClient(
    cmd,
    [...args, "-At", "-c", "SELECT has_database_privilege(current_user, current_database(), 'CREATE')"],
    env,
    HAN_NHANH,
  );
  return stdout.trim() === "t";
}

/** Dump plain có tự phát `CREATE SCHEMA <đích>` không (pg_dump -Fp luôn có; file chỉnh tay thì chưa chắc). */
function dumpTuTaoSchema(sql: string, schema: string): boolean {
  return new RegExp(`\\bCREATE\\s+SCHEMA\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?${schema}"?`, "i").test(sql);
}

/**
 * Dọn schema đích cho đường plain-gzip (dump plain không có `--clean` nên phải tự dọn).
 *
 * HAI CHỐT SỐNG-CÒN, đều rút từ đo thật 29/07:
 *  1. HỎI QUYỀN TRƯỚC KHI DROP (xem `coQuyenTaoSchema`). Không đủ quyền mà cứ drop = mất sạch
 *     schema rồi mới báo lỗi. Từ chối sớm thì dữ liệu còn nguyên.
 *  2. KHÔNG tự `CREATE SCHEMA` khi chính dump đã có câu đó: `psql -v ON_ERROR_STOP=1` sẽ chết ở
 *     "schema đã tồn tại" NGAY SAU KHI ta vừa drop — cũng mất sạch. `pg_dump -Fp -n app` LUÔN phát
 *     `CREATE SCHEMA app;` (đo trên dump thật) nên đây là ca THƯỜNG, không phải ca hiếm.
 *
 * ⚠️ CHỈ gọi SAU khi mọi guard nội dung đã pass và SAU khi đã có bản lùi pre-restore.
 */
async function donSchemaChoDumpPlain(dbUrl: string, schema: string, sql: string): Promise<void> {
  if (!(await coQuyenTaoSchema(dbUrl))) {
    throw new Error(
      `Role DB của app không có quyền tạo lại schema "${schema}", mà nạp file .sql.gz thì bắt buộc ` +
        `phải xoá rồi dựng lại cả schema. ĐÃ DỪNG TRƯỚC KHI XOÁ — dữ liệu còn nguyên. Dùng file ` +
        `.dump (custom) ở màn này, hoặc chạy deploy/restore.sh trên máy chủ bằng role quản trị.`,
    );
  }
  const donDep = dumpTuTaoSchema(sql, schema)
    ? `DROP SCHEMA IF EXISTS "${schema}" CASCADE;` // dump tự tạo lại — ta tạo thêm là đụng nhau
    : `DROP SCHEMA IF EXISTS "${schema}" CASCADE; CREATE SCHEMA "${schema}";`;
  const { cmd, args, env } = restoreArgsFromUrl(dbUrl, "plain-gzip");
  // `HAN_NHANH`: câu DROP tự nó chạy chớp nhoáng, nhưng nó phải giành ACCESS EXCLUSIVE trên cả
  // schema — đúng chỗ dễ treo nhất. `lock_timeout` trong PGOPTIONS bắn lỗi "chờ khoá" trước, và
  // lỗi đó lan ra TRƯỚC KHI có bất kỳ thứ gì bị xoá.
  await runPgClient(cmd, [...args, "-c", donDep], env, HAN_NHANH);
}



/**
 * Câu SQL trả lại ĐÚNG 2 quyền đọc mà lượt phục hồi vừa xoá. Hàm THUẦN để test đọc được câu phát ra
 * mà không cần Postgres.
 *
 * Vì sao cần: nhánh custom chạy `--clean --if-exists` nên bảng `Setting` bị xoá rồi dựng lại (ACL
 * chết theo bảng cũ), `--no-privileges` lại bỏ luôn câu GRANT nằm sẵn trong dump; nhánh plain thì
 * xoá cả schema. Sau mỗi lượt phục hồi, các workflow n8n chết ở node lấy khoá trong khi app vẫn đăng
 * nhập bình thường — ingest, ads và webhook tắt câm, không có báo động nào.
 *
 * Chỉ 2 câu, không rộng hơn: role này cố ý chỉ được đọc đúng 1 bảng. `GRANT CONNECT` cấp ở mức
 * DATABASE nên không mất khi xoá schema ⇒ không cấp lại ở đây.
 *
 * Hai cổng bên trong:
 *  - `pg_roles`: máy dev / DB test không có role này ⇒ bỏ qua im lặng. Phục hồi dữ liệu quan trọng
 *    hơn quyền đọc của n8n; làm cả lượt phục hồi thất bại vì một role không tồn tại là đổi một sự cố
 *    nhỏ lấy một sự cố lớn.
 *  - `to_regclass`: nạp bản dump quá cũ (chưa có bảng `Setting`) ⇒ bỏ qua câu cấp quyền đó thay vì
 *    làm hỏng cả bước.
 */
export function sqlCapQuyenDocN8n(schema: string): string {
  // Từ 2026-08-21 role đọc VIEW "${N8N_SETTING_VIEW}" thay bảng "Setting" gốc — view loại 2 khoá
  // hạ tầng (n8nApiKey/n8nDbRoPassword) khỏi tầm mắt n8n (xem role-doc-kho-khoa.ts).
  return `DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${N8N_RO_ROLE}') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA "${schema}" TO ${N8N_RO_ROLE}';
    IF to_regclass('"${schema}"."${N8N_SETTING_VIEW}"') IS NOT NULL THEN
      EXECUTE 'GRANT SELECT ON "${schema}"."${N8N_SETTING_VIEW}" TO ${N8N_RO_ROLE}';
    END IF;
  END IF;
END
$$;`;
}

/**
 * Cấp lại quyền đọc kho khoá cho n8n SAU KHI phục hồi xong. Dùng lại đúng đường psql của file này
 * (`restoreArgsFromUrl` + `runPgClient`) — file này không dùng Prisma ở bất kỳ đâu, mọi thao tác DB
 * đều qua `execFile` + pg client, nên không mở kết nối mới.
 *
 * Lỗi ở bước này KHÔNG được làm lượt phục hồi báo thất bại: dữ liệu đã nạp xong rồi, mà thông báo
 * thất bại của route lại chỉ người dùng đi lùi về bản `pre-restore-*.dump` — tức là xui họ vứt bỏ
 * đúng dữ liệu vừa cứu được, vì một quyền đọc. Ghi ra log container kèm nguyên 2 câu để chạy tay.
 */
async function capLaiQuyenDocChoN8n(dbUrl: string, schema: string): Promise<void> {
  const { cmd, args, env } = restoreArgsFromUrl(dbUrl, "plain-gzip"); // nhánh này = psql
  try {
    await runPgClient(cmd, [...args, "-c", sqlCapQuyenDocN8n(schema)], env, HAN_NHANH);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `Phục hồi xong nhưng KHÔNG cấp lại được quyền đọc cho ${N8N_RO_ROLE} (${message}). ` +
        `Workflow n8n sẽ chết ở node lấy khoá cho tới khi chạy tay 2 câu: ` +
        `GRANT USAGE ON SCHEMA "${schema}" TO ${N8N_RO_ROLE}; ` +
        `GRANT SELECT ON "${schema}"."Setting" TO ${N8N_RO_ROLE};`,
    );
  }
}

/**
 * Phục hồi DB từ buffer file backup. THỨ TỰ LÀ SỐNG-CÒN (C1):
 * detect → (plain-gzip) gunzip head → assertNotArchive → CHỈ SAU ĐÓ đụng DB.
 *
 * Chạy TRONG container app (`postgresql-client-15` trong image), nối Postgres
 * qua `-h supabase-db` lấy thẳng từ DATABASE_URL. `--clean/--if-exists` (custom)
 * và `DROP SCHEMA` (plain) thao tác trên OBJECT, KHÔNG drop database.
 *
 * Sau khi nạp XONG, cấp lại 2 quyền đọc của role chỉ-đọc n8n (USAGE trên schema + SELECT bảng
 * `Setting`) — cả `--clean --if-exists` lẫn `DROP SCHEMA` đều xoá sạch ACL, mà các workflow n8n đọc
 * kho khoá bằng role đó. Bước này không được làm lượt phục hồi thất bại.
 *
 * `truocKhiPhaHuy` — CHỐT FENCING CUỐI CÙNG, gọi đúng một lần ngay trước lệnh đầu tiên làm hỏng dữ
 * liệu (`pg_restore --clean` ở nhánh custom, `DROP SCHEMA` ở nhánh plain). Người gọi ném lỗi trong
 * callback nếu lượt này đã mất khoá bảo trì; ném ở đó là AN TOÀN vì mọi bước trước nó chỉ đọc file,
 * bung nén, kiểm nội dung và ghi file tạm. Cho phép ASYNC (và cả hai điểm gọi đều `await`): ngoài
 * khoá bảo trì trong RAM, route còn gia hạn khoá việc nặng nằm trong DB tại chốt này — một câu ghi
 * Prisma bắt buộc phải chờ xong rồi mới được phá huỷ, không thì chốt thành vô nghĩa.
 *
 * Vì sao chốt của route KHÔNG đủ và phải có thêm chốt ở đây: giữa chốt route và lệnh phá huỷ còn
 * `writeFile` (đĩa), `gunzipAsync` (zlib) và `pg_restore -l` — mấy bước này KHÔNG có hạn ở tầng
 * Node, treo đủ lâu là TTL nhả cờ, lượt khác giành được khoá rồi lượt này tỉnh dậy vẫn drop + nạp
 * chồng lên. `BIEN_NGOAI_LENH_MS` chỉ là số cộng vào TTL, nó KHÔNG phải timeout thật.
 *
 * Ngược lại, một khi chuỗi phá huỷ đã bắt đầu thì TUYỆT ĐỐI không fence giữa chừng nữa: dừng giữa
 * lúc schema đang thay dở còn tệ hơn chạy cho xong. Vì thế nhánh plain phải ghi file tạm TRƯỚC
 * `DROP SCHEMA`, không phải sau.
 */
export async function runRestore(
  fileBuf: Buffer,
  opts: { truocKhiPhaHuy?: () => void | Promise<void> } = {},
): Promise<{ format: RestoreFormat }> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error("DATABASE_URL chưa được cấu hình — không thể phục hồi.");
  }

  // (1) Nhận diện — CHƯA đụng DB. Không hợp lệ → throw ngay.
  const format = detectRestoreFormat(fileBuf.subarray(0, 512));
  if (format === null) {
    throw new Error("File backup không hợp lệ (chỉ nhận .dump hoặc .sql.gz)");
  }

  const { schema } = parsePgUrl(dbUrl);
  const { cmd, args, env } = restoreArgsFromUrl(dbUrl, format);

  // (2) custom (.dump `pg_dump -Fc`): liệt kê TOC + assertDumpOnlySchema TRƯỚC khi
  // đụng DB — chặn dump full-DB/hệ thống Supabase đè schema đích. pg_restore
  // --clean --if-exists tự drop + tạo lại object. KHÔNG DROP SCHEMA thủ công.
  //
  // GIỚI HẠN ĐÃ BIẾT, CỐ Ý CHẤP NHẬN (đừng "sửa" lại bằng cách drop schema):
  // đo thật 29/07 — `pg_restore --clean --if-exists -n app -f -` trên dump thật KHÔNG phát ra dòng
  // `DROP SCHEMA`/`CREATE SCHEMA` nào (bỏ `-n` thì có cả hai): cờ `-n` khiến pg_restore BỎ QUA entry
  // SCHEMA, còn `--clean` chỉ drop đúng object CÓ trong TOC. Hệ quả: bảng/cột sinh ra SAU thời điểm
  // sao lưu (migration mới) sống sót và trộn vào bản vừa phục hồi.
  // ĐÃ THỬ dọn bằng `DROP SCHEMA … CASCADE; CREATE SCHEMA …` và PHẢI GỠ BỎ: role app trên prod
  // (`hogikids`) đo được `has_database_privilege(…,'CREATE') = false` — nó sở hữu schema nên DROP
  // trót lọt nhưng TẠO LẠI thì bị từ chối ⇒ mọi lượt phục hồi sẽ xoá sạch schema rồi chết giữa
  // chừng. Muốn "thay sạch" thật thì phải cấp quyền CREATE cho role app (quyết định vận hành, chưa
  // làm) hoặc phục hồi bằng `deploy/restore.sh` trên máy chủ với role quản trị.
  if (format === "custom") {
    const dumpPath = tempPath(".dump");
    try {
      await writeFile(dumpPath, fileBuf);
      // `-l` chỉ đọc mục lục trong FILE, không mở kết nối DB — nhưng vẫn đi qua `runPgClient` để
      // một file hỏng khiến pg_restore quay vòng cũng bị dừng theo hạn, và để câu báo lỗi đồng bộ.
      const stdout = await runPgClient("pg_restore", ["-l", dumpPath], env, HAN_NHANH);
      assertDumpOnlySchema(stdout, schema); // throw ở đây = KHÔNG đụng DB.
      // Chuẩn bị xong (ghi file tạm + đọc mục lục + kiểm nội dung), tất cả đều KHÔNG đụng dữ liệu.
      // Chốt cuối trước lệnh phá huỷ: `--clean` bắt đầu drop object từ đây.
      await opts.truocKhiPhaHuy?.();
      await runPgClient(cmd, [...args, dumpPath], env, HAN_NAP);
      // Cấp lại quyền NGAY sau khi nạp, TRƯỚC khi dọn file tạm. `unlink` không có hạn ở tầng Node,
      // để nó chen vào giữa là mở thêm một cửa sổ mà lượt này có thể mất khoá rồi mới chạy GRANT
      // lên schema của lượt khác. Nạp lỗi thì lỗi lan ra ngay và GRANT không chạy — đúng ý cũ:
      // phục hồi hỏng thì đừng đụng thêm gì vào DB.
      await capLaiQuyenDocChoN8n(dbUrl, schema);
    } finally {
      await unlink(dumpPath).catch(() => {});
    }
    return { format };
  }

  // (3) plain-gzip (.sql.gz): gunzip HEAD bounded → assertNotArchive → bung full
  // (có trần chống gzip-bomb) → assertPlainSqlOnlySchema TRƯỚC mọi thao tác DB.
  // Nếu bất kỳ guard nào throw (TAR toàn-server / không-SQL / CREATE SCHEMA khác
  // đích) → propagate, DB NGUYÊN VẸN (chưa chạy DROP SCHEMA).
  assertNotArchive(gunzipHead(fileBuf)); // throw ở đây = KHÔNG đụng DB, CHƯA bung full.
  let unzipped: Buffer;
  try {
    unzipped = await gunzipAsync(fileBuf, { maxOutputLength: MAX_UNZIPPED_BYTES });
  } catch (err) {
    // Vượt trần = nghi gzip-bomb → message tiếng Việt rõ thay vì ERR_BUFFER_TOO_LARGE.
    if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      throw new Error("File .sql.gz bung nén vượt trần 2GiB — nghi gzip-bomb, từ chối phục hồi.");
    }
    throw err;
  }
  const sqlText = unzipped.toString("utf8");
  assertPlainSqlOnlySchema(sqlText, schema); // guard toàn nội dung.

  const sqlPath = tempPath(".sql");
  try {
    // Ghi file tạm TRƯỚC `DROP SCHEMA`, không phải sau: `writeFile` không có hạn ở tầng Node, để nó
    // nằm giữa lệnh xoá và lệnh nạp nghĩa là một cú treo đĩa sẽ dừng đúng giữa chuỗi phá huỷ —
    // schema đã sạch mà dữ liệu chưa vào. Nay mọi việc không-đụng-dữ-liệu đều xong trước chốt.
    await writeFile(sqlPath, unzipped);

    // Chốt cuối trước lệnh phá huỷ (xem `truocKhiPhaHuy`). Đặt trước `donSchemaChoDumpPlain` chứ
    // không phải trong nó: hàm đó mở đầu bằng một câu SELECT hỏi quyền rồi mới `DROP SCHEMA`, mà
    // chốt phải nằm trước cả cụm để không có đường nào lọt.
    await opts.truocKhiPhaHuy?.();

    // Dọn sạch ĐÚNG schema đích (từ URL, KHÔNG hardcode public) — dump plain không
    // có --clean. CHỈ chạy SAU cả 2 guard ở trên, và chỉ khi role đủ quyền dựng lại
    // schema (nếu không thì dừng TRƯỚC khi xoá — xem `donSchemaChoDumpPlain`).
    await donSchemaChoDumpPlain(dbUrl, schema, sqlText);
    await runPgClient(cmd, [...args, "-f", sqlPath], env, HAN_NAP);
    // GRANT ngay sau nạp, trước `unlink` — cùng lý do như nhánh custom ở trên.
    await capLaiQuyenDocChoN8n(dbUrl, schema);
  } finally {
    await unlink(sqlPath).catch(() => {});
  }
  return { format };
}
