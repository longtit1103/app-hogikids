/**
 * Chặn restore đè object NGOÀI schema đích trên đường PLAIN (`.sql.gz`). Khác đường
 * custom (`assert-dump-schema.ts`): KHÔNG có `-n <schema>` của pg_restore chốt cứng
 * phía sau, nên đây là hàng rào DUY NHẤT — guard fail-closed, thà từ chối oan.
 */

import {
  maskSingleQuotedStrings,
  stripCopyStdinData,
  stripDollarQuoted,
  stripSqlComments,
  COPY_END_LINE,
} from "./sql-text-scanner-plain-dump";

/**
 * Các schema HỆ THỐNG của Supabase self-host. Dùng làm denylist cho đường plain-gzip
 * (KHÔNG có backstop `-n schema` như đường custom) — bất kỳ tham chiếu qualified tới
 * các schema này (vd `auth.users`, `storage.objects`) hay `DROP SCHEMA auth` đều là
 * dấu hiệu dump full-DB Supabase → TỪ CHỐI để không xoá/đè dữ liệu hệ thống.
 *
 * `export` để test parity đọc được: danh sách này có BẢN SONG SINH bằng bash ở
 * `deploy/restore.sh` (`SYSTEM_SCHEMAS="…"`), hai bên phải khớp tuyệt đối —
 * `tests/unit/backup/system-schemas-twin-shell-vs-ts.test.ts` ép điều đó.
 */
export const SUPABASE_SYSTEM_SCHEMAS = [
  "auth",
  "storage",
  "vault",
  "realtime",
  "graphql",
  "extensions",
  "supabase_functions",
  "_realtime",
  "pgbouncer",
  "net",
  "cron",
  "pgsodium",
  "supabase_migrations",
] as const;

/**
 * Schema "toàn cục" được PHÉP qualify trong DDL/DML mà KHÔNG coi là ngoài đích: pg_dump
 * plain vẫn tham chiếu chúng hợp lệ. (`set_config` nằm trong `pg_catalog` và câu
 * `SELECT pg_catalog.set_config('search_path', '', false)` KHÔNG bắt đầu bằng động từ
 * DDL/DML nên không bao giờ lọt vào guard (e); vẫn allowlist `pg_catalog` cho chắc.)
 */
const QUALIFIER_ALLOWLIST = new Set(["pg_catalog", "information_schema"]);

/**
 * Động từ DDL/DML mà pg_dump plain phát ra ở ĐẦU câu lệnh, theo sau là object
 * schema-qualified. Dùng cho guard (e) — đối xứng với TOC guard.
 */
const DDL_DML_VERBS = "CREATE|ALTER|DROP|TRUNCATE|INSERT|UPDATE|DELETE|COPY|GRANT|REVOKE|COMMENT|LOCK";

/**
 * Các dòng meta-command psql mà `pg_dump -Fp` THẬT phát ra — allowlist HẸP của guard (g).
 * Mọi `\` khác đều bị từ chối.
 *
 *  • `\.` — mốc kết payload `COPY … FROM stdin`. Neo CHÍNH XÁC như `COPY_END_LINE`: COPY
 *    text format chỉ nhận dòng đúng `\.`, nên `  \.` thụt đầu dòng là DỮ LIỆU → phải chặn.
 *  • `\restrict <token>` / `\unrestrict <token>` — bản vá bảo mật PostgreSQL 08/2025
 *    (15.14 / 16.10 / 17.6 / 18.0 trở lên) khiến `pg_dump -Fp` LUÔN bọc file giữa cặp này:
 *    nó BẬT chế độ hạn chế của psql để chính các meta-command bị nhồi vào dữ liệu KHÔNG
 *    chạy được. Tức đây là dòng LÀM TĂNG an toàn, không phải tấn công.
 *
 *    ĐO THẬT 31/07 trên prod: container app (`hogikids-app`, `postgresql-client-15` cài từ
 *    PGDG KHÔNG ghim minor) có `pg_dump 15.18`, và `pg_dump -Fp -n app` của nó phát
 *    `\restrict <token>` ở dòng 5 + `\unrestrict <token>` ở dòng cuối (token trùng nhau,
 *    63 ký tự chữ-số). Trước khi allowlist, guard từ chối MỌI file .sql.gz do chính đời
 *    pg_dump hiện tại sinh ra — từ-chối-oan đúng loại nguy hiểm nhất với đường DR.
 *    (`supabase-db` vẫn là 15.8 nên dump tạo TỪ TRONG container DB chưa có 2 dòng này —
 *    allowlist phải chấp nhận cả hai đời.)
 */
const PG_DUMP_META_ALLOW = [
  COPY_END_LINE,
  /^\\restrict [A-Za-z0-9_]+$/,
  /^\\unrestrict [A-Za-z0-9_]+$/,
];

/**
 * Quét SQL plain (đường .sql.gz — KHÔNG có `-n schema` chốt cứng nên guard phải MẠNH).
 * Từ chối khi:
 *  (a) CREATE/DROP/ALTER SCHEMA <tên> với tên ≠ target (nghi dump full-DB);
 *  (b) tham chiếu qualified tới schema HỆ THỐNG Supabase (vd `auth.users`, `storage.objects`,
 *      `vault.secrets`) — thảm hoạ đè/xoá dữ liệu hệ thống chung;
 *  (c) meta-command `\connect` / `\c` (có thể chuyển sang DB khác, thoát khỏi -d đích);
 *  (d) câu lệnh `SET search_path` — `pg_dump` plain THẬT KHÔNG BAO GIỜ phát ra câu này
 *      (nó dùng `SELECT pg_catalog.set_config('search_path', '', false)`), nên bất kỳ
 *      `SET search_path` nào trong dump là BẤT THƯỜNG: có thể là file bị chỉnh tay để
 *      kèm `SET search_path = auth;` rồi ghi UNQUALIFIED (không `auth.`) — bypass guard
 *      (b) vì (b) chỉ bắt tham chiếu CÓ qualifier. Fail-closed: từ chối luôn, không cố
 *      phân biệt vô hại/ác ý.
 *  (e) ĐỐI XỨNG với TOC guard: object schema-qualified nhắm schema ≠ đích (KHÔNG chỉ
 *      schema hệ thống ở (b)). Chặn dump plain tiền-migration của DB `public` cũ (vd
 *      `CREATE TABLE public."Order" …`) — thứ (a)+(b) đều bỏ lọt vì không có CREATE
 *      SCHEMA và `public` không phải schema hệ thống (H3). Chỉ xét qualifier ĐẦU TIÊN
 *      của mỗi câu (object đang bị ghi) — tham chiếu schema khác trong THÂN view/function
 *      KHÔNG bị chặn (đúng như TOC guard chỉ xét namespace của chính object).
 *  (f) DẠNG HÀM của (d): `set_config('search_path', <khác rỗng>, …)`. `pg_dump` plain
 *      THẬT chỉ phát ra `set_config('search_path', '', false)` (chuỗi RỖNG = ép mọi object
 *      phải qualified). Guard (d) chỉ bắt câu lệnh `SET search_path`, KHÔNG bắt lời gọi hàm
 *      → dump chỉnh tay dùng `SELECT set_config('search_path','auth',false);` rồi ghi
 *      UNQUALIFIED sẽ né cả (b) (chuỗi 'auth' bị nháy nên không soi được) lẫn (e) (SELECT
 *      không phải verb ghi). Fail-closed: CHỈ cho đúng dạng chuỗi rỗng `''`.
 *  (g) meta-command psql CÒN LẠI (`\!`, `\copy … TO PROGRAM`, `\i`, `\o|sh`, `\g|sh`, `\setenv`,
 *      `\lo_import`…). Guard (c) chỉ bắt `\connect`/`\c`. psql thực thi lệnh `\…` trong file nạp
 *      bằng `-f` và không tắt được ⇒ đây là đường CHẠY LỆNH trên máy chủ, không chỉ là đè schema.
 *      Chỉ ALLOWLIST đúng các dạng `pg_dump` plain THẬT phát ra (xem `PG_DUMP_META_ALLOW`).
 *  (h) chuỗi nháy đơn/kép TRẢI QUA XUỐNG DÒNG ở NGOÀI khối COPY (ném từ `lexSqlLine`).
 *      Kẻ tấn công dùng nó để giấu một mốc `COPY … FROM stdin;` GIẢ: chế độ bỏ-payload mở
 *      tới dòng `\.` và xoá cả vùng đó khỏi bản soi ⇒ (b)/(e)/(g) mù trong khi psql vẫn chạy
 *      các câu ở giữa. Fail-closed như đã làm với `SET search_path`.
 *
 *      GIỚI HẠN ĐÃ BIẾT (chấp nhận): pg_dump CÓ THỂ phát ra chuỗi đa dòng nếu DB chứa literal
 *      có ký tự xuống dòng ngoài khối COPY — thực tế chỉ gặp ở `COMMENT ON … IS '…\n…'` hoặc
 *      DEFAULT/CHECK nhiều dòng. Repo này không sinh dạng đó (Prisma không phát COMMENT ON;
 *      đã đối chiếu dump plain THẬT của prod 31/07, cả bản schema-only lẫn bản có dữ liệu:
 *      KHÔNG dòng nào lệch parity nháy). ⚠️ LỐI THOÁT ĐỔI TỪ 22/09/2026: câu cũ ở đây viết "gặp
 *      từ-chối-oan thì nạp bản `.dump` custom" — KHÔNG CÒN ĐÚNG, vì `deploy/restore.sh` nhánh custom
 *      nay cũng bung dump ra rồi chạy chính guard này. Lối thoát bây giờ là chạy
 *      `BO_QUA_KIEM_NOI_DUNG_DUMP=1 bash deploy/restore.sh …` (in cảnh báo, giữ guard TOC +
 *      `pg_restore -n <schema>` chốt cứng). Vẫn KHÔNG nới guard này — nới là mở lại đúng lỗ hổng trên.
 *      Ca đã ĐO gây từ-chối-oan: `COMMENT ON … IS '…\n…'` mà Supabase Studio ghi khi điền ô
 *      "Description" — repo không sinh, nhưng người sửa tay thì có.
 *  (i) `COPY … FROM PROGRAM` / `COPY … TO PROGRAM` — đường CHẠY LỆNH Ở TẦNG SQL. Guard (g) chỉ bắt
 *      META-COMMAND `\copy … TO PROGRAM` (có dấu `\`); dạng SQL thuần KHÔNG có dấu `\` nào nên
 *      lọt sạch qua (g). `pg_dump` plain xuất dữ liệu bằng `COPY … FROM stdin`, KHÔNG BAO GIỜ phát
 *      ra `FROM/TO PROGRAM`.
 *  (j) Câu lệnh ĐẶC QUYỀN (`CREATE EXTENSION`, `CREATE/ALTER/DROP ROLE|USER`, `ALTER SYSTEM`,
 *      `CREATE … LANGUAGE`, `SECURITY DEFINER`). Dump schema-scoped (`pg_dump -n <schema>`) không
 *      sinh ra chúng; chúng chỉ có trong dump full-DB hoặc file chế tác. Đây là lớp BỔ SUNG cho
 *      (a)/(b)/(e) — denylist luôn thua allowlist về độ chặt, xem ghi chú tại chỗ.
 */
export function assertPlainSqlOnlySchema(rawSql: string, schema: string): void {
  // Chuẩn hoá xuống dòng NGAY TỪ ĐẦU: file CRLF để lại `\r` cuối dòng làm lệch mọi mốc
  // neo-cuối-dòng (`^\.$`, `… FROM stdin;$`) ⇒ payload COPY không được bỏ và dump thật bị
  // từ chối oan. Làm một lần ở đây thay vì rải `\r` handling khắp các guard.
  const sql = rawSql.replace(/\r\n?/g, "\n");

  // Bỏ payload COPY MỘT LẦN rồi dùng lại cho (b)/(e)/(f)/(g) — đây cũng là nơi guard (h)
  // ném lỗi, nên mọi guard phía sau đều soi trên bản đã đảm bảo "không có chuỗi đa dòng".
  const noCopy = stripCopyStdinData(sql);

  // (a) CREATE/DROP/ALTER SCHEMA <tên> ≠ target. Bao cả IF [NOT] EXISTS.
  const schemaDdl =
    /\b(CREATE|DROP|ALTER)\s+SCHEMA\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?"?([a-zA-Z_][\w$]*)"?/gi;
  for (const m of sql.matchAll(schemaDdl)) {
    const [, verb, name] = m;
    if (name !== schema) {
      throw new Error(
        `SQL ${verb.toUpperCase()} SCHEMA '${name}' ≠ '${schema}' — TỪ CHỐI (nghi dump full-DB / đè schema hệ thống).`,
      );
    }
  }

  // (b) Câu lệnh GHI/XOÁ nhắm tới schema HỆ THỐNG Supabase (vd `TRUNCATE storage.objects`,
  // `CREATE TABLE auth.users(...)`, `DELETE FROM vault.secrets`). Gate bằng ĐỘNG TỪ mutating
  // + khoảng đệm KHÔNG chứa nháy/`;`/xuống-dòng: pg_dump gói dữ liệu text trong nháy, nên
  // `auth.` xuất hiện trong CHUỖI dữ liệu (URL/prose) bị chặn ở dấu nháy → không false-positive;
  // còn qualifier THẬT (`verb … auth.users`) nằm ngoài nháy nên vẫn bắt được. Qualifier hệ
  // thống trong plain dump là KHÔNG nháy (tên toàn chữ thường, không phải từ khoá).
  const VERBS =
    "DROP|CREATE|ALTER|TRUNCATE|DELETE\\s+FROM|INSERT\\s+INTO|UPDATE|COPY|GRANT|REVOKE|COMMENT\\s+ON|LOCK|REINDEX|REFRESH|CLUSTER";
  // Soi bản đã bỏ payload COPY + che chuỗi nháy (data tab-phân-tách / chuỗi có thể chứa
  // `sys.` giống qualifier). GIỮ thân dollar-quote để vẫn bắt DO-block / function body ghi
  // schema hệ thống (vd `DO $$ BEGIN DELETE FROM auth.users; END $$;`).
  const scanSys = maskSingleQuotedStrings(noCopy);
  for (const sys of SUPABASE_SYSTEM_SCHEMAS) {
    if (sys === schema) continue; // nếu schema đích trùng tên (không xảy ra với app) thì bỏ.
    // Khoảng đệm `[^;'"]*?` KHÔNG loại `\n`: câu lệnh trải nhiều dòng (verb dòng trên,
    // qualifier dòng dưới) trong một file .sql.gz chỉnh tay vẫn phải bị bắt. Ranh giới câu
    // vẫn là `;`/nháy nên qualifier THẬT (ngoài nháy) trong cùng câu mới match.
    const dangerous = new RegExp(`\\b(?:${VERBS})\\b[^;'"]*?\\b${sys}\\.`, "i");
    if (dangerous.test(scanSys)) {
      throw new Error(
        `SQL thao tác trên schema hệ thống Supabase '${sys}' — TỪ CHỐI để không đè dữ liệu hệ thống.`,
      );
    }
  }

  // (c) Meta-command \connect / \c — chuyển sang DB khác, thoát khỏi `-d` đích. Các meta-command
  // khác do (g) chặn. Dump schema hợp lệ không có câu nào trong hai nhóm này.
  if (/^\s*\\c(?:onnect)?\b/im.test(sql)) {
    throw new Error("SQL chứa meta-command \\connect — TỪ CHỐI (có thể chuyển sang DB khác).");
  }

  // (d) `SET search_path` — chỉ khớp ở ĐẦU câu lệnh (đầu chuỗi, hoặc ngay sau `;`/xuống
  // dòng) để KHÔNG khớp vào bên trong chuỗi dữ liệu có nháy (vd note khách hàng chứa chữ
  // "set search_path"). pg_dump plain THẬT không bao giờ phát ra SET search_path (dùng
  // set_config) nên đây là dấu hiệu file bị chỉnh sửa/giả mạo. Soi bản đã bỏ thân dollar-quote
  // (thân function KHÔNG chạy lúc restore; bỏ trước để scanner theo-dõi-nháy không bị desync vì
  // nháy lẻ trong thân $$…$$) rồi bỏ comment (không né bằng `SET/**​/search_path`).
  if (
    /(?:^|;|\r?\n)[ \t]*SET\s+(?:(?:SESSION|LOCAL)\s+)?search_path\b/i.test(
      stripSqlComments(stripDollarQuoted(sql)),
    )
  ) {
    throw new Error(
      "SQL chứa câu lệnh SET search_path — pg_dump plain THẬT dùng pg_catalog.set_config('search_path', '', false), KHÔNG BAO GIỜ phát ra SET search_path — TỪ CHỐI (nghi file bị chỉnh sửa để né guard schema hệ thống).",
    );
  }

  // (e) Đối xứng với TOC guard. Che dữ liệu (COPY payload + thân dollar-quote + chuỗi
  // nháy đơn) TRƯỚC khi soi, để `.`/`;` trong note đơn/URL không bị hiểu nhầm là câu
  // lệnh. Neo mỗi match ở ĐẦU câu (đầu chuỗi hoặc ngay sau `;`) và lấy qualifier `schema.`
  // ĐẦU TIÊN đứng trước nháy/`;`/xuống-dòng — chính là namespace của object đang bị ghi.
  const scan = maskSingleQuotedStrings(stripDollarQuoted(noCopy));
  // Neo verb ở ĐẦU CÂU (`^` per-line hoặc ngay sau `;`); cho phép whitespace LIÊN-DÒNG
  // giữa mốc câu↔verb (`[ \t\r\n]*`) và giữa verb↔qualifier (`[^;'"]*?`) để câu ghi object
  // trải nhiều dòng (verb dòng trên, `schema.object` dòng dưới) không lọt. Ranh giới câu
  // vẫn là `;`/nháy; dữ liệu (COPY/dollar/nháy) đã bị che ở `scan` nên không soi nhầm.
  const foreignQualifier = new RegExp(
    `(?:^|;)[ \\t\\r\\n]*(?:${DDL_DML_VERBS})\\b[^;'"]*?"?([a-zA-Z_][\\w$]*)"?\\.`,
    "gim",
  );
  for (const m of scan.matchAll(foreignQualifier)) {
    const ns = m[1];
    if (ns === schema || QUALIFIER_ALLOWLIST.has(ns)) continue;
    throw new Error(
      `SQL thao tác object schema '${ns}' ≠ '${schema}' — TỪ CHỐI (nghi dump full-DB / schema ngoài đích).`,
    );
  }

  // (f) `set_config('search_path', <khác rỗng>, …)` — dạng HÀM của (d). Soi trên bản đã bỏ
  // payload COPY + thân dollar-quote (set_config trong thân function chỉ chạy khi GỌI hàm,
  // KHÔNG chạy lúc restore → không phải vector; bỏ để tránh false-positive) + bỏ comment (né
  // `set_config/**​/(…)`), KHÔNG che nháy đơn (cần đọc literal đối số). Bắt cả
  // `pg_catalog.set_config(...)` (khớp từ `set_config(`). Chỉ chấp nhận đối số thứ 2 = chuỗi
  // rỗng `''`; mọi giá trị khác (literal 'auth' hoặc biểu thức `current_setting(...)`) → TỪ CHỐI.
  const setConfigSearchPath = /set_config\s*\(\s*'search_path'\s*,\s*([^)]*?)\s*(?:,|\))/gi;
  const fScan = stripSqlComments(stripDollarQuoted(noCopy));
  for (const m of fScan.matchAll(setConfigSearchPath)) {
    if (m[1] !== "''") {
      throw new Error(
        "SQL chứa set_config('search_path', …) với giá trị KHÁC chuỗi rỗng — pg_dump plain THẬT chỉ dùng set_config('search_path', '', false) — TỪ CHỐI (nghi file bị chỉnh sửa để né guard schema hệ thống).",
      );
    }
  }

  // (g) Meta-command psql CÒN LẠI. `psql -f <file>` (và cả stdin) THỰC THI mọi lệnh `\…`, KHÔNG
  // có cờ nào tắt được: `\!` chạy shell (container app chạy root), `\copy … TO PROGRAM 'cmd'` cũng
  // chạy shell, `\i` nạp thêm file, `\o | sh` / `\g | sh` đổ output vào shell. Guard (c) chỉ bắt
  // `\connect`/`\c` nên các dạng còn lại lọt sạch. Mọi `\` KHÔNG nằm trong allowlist hẹp
  // `PG_DUMP_META_ALLOW` (sau khi đã che dữ liệu) đều BẤT THƯỜNG → từ chối.
  //
  // BẮT BUỘC soi trên bản ĐÃ bỏ payload COPY: trong khối dữ liệu, `\N` (NULL marker) và `\\`
  // (escape) là DỮ LIỆU cực phổ biến — áp thẳng lên SQL thô sẽ TỪ CHỐI OAN mọi dump thật, đúng
  // loại lỗi mà file này coi là nguy hiểm hơn cả bỏ lọt (tập cho vận hành viên thói quen tắt guard).
  // Bỏ luôn thân dollar-quote (psql theo dõi `$$` nên `\` trong đó KHÔNG là meta-command), bỏ
  // comment, và che chuỗi nháy đơn (regex kiểu '^\d+$' là dữ liệu hợp lệ — repo có sẵn dạng này
  // trong migration của bảng Setting).
  //
  // KHÔNG neo đầu dòng: psql nhận meta-command ở mọi vị trí ngoài chuỗi/comment, nên `SELECT 1 \g
  // | sh` (backslash GIỮA dòng) sẽ lọt nếu chỉ soi `^[ \t]*\\`. Fail-closed = "không còn `\` lạ".
  const gScan = maskSingleQuotedStrings(stripSqlComments(stripDollarQuoted(noCopy)));
  for (const line of gScan.split("\n")) {
    if (!line.includes("\\")) continue;
    if (PG_DUMP_META_ALLOW.some((allowed) => allowed.test(line))) continue;
    throw new Error(
      `SQL chứa meta-command psql (${JSON.stringify(line.trim().slice(0, 40))}) — psql thực thi ` +
        `lệnh \\… khi nạp file và KHÔNG tắt được; pg_dump plain THẬT chỉ phát ra \\. , \\restrict ` +
        `và \\unrestrict — TỪ CHỐI (nghi file bị chỉnh sửa để chạy lệnh trên máy chủ).`,
    );
  }

  // Bản soi cho (i)/(j) — phải soi HAI bản, không một:
  //
  //  • `ijScan` GIỮ thân dollar-quote: `DO $$ BEGIN COPY t FROM PROGRAM 'id'; END $$;` CHẠY THẬT
  //    lúc restore, bỏ thân là mù đúng ca đó. Guard (b) chọn cùng cách vì cùng lý do.
  //  • `gScan` (đã tính ở guard (g)) BỎ thân dollar-quote.
  //
  // 🔴 VÌ SAO PHẢI CÓ CẢ HAI (đo 22/09/2026 — bản đầu chỉ dùng `ijScan` và ĐÃ THỦNG):
  // `stripSqlComments` KHÔNG theo dõi dollar-quote, nên một dấu `/*` đặt trong thân `$$…$$` mở
  // comment và NUỐT mọi câu tới `*/`. Văn bản dưới đây làm `ijScan` chỉ còn `SELECT $$   $$;`:
  //
  //     SELECT $$ /* $$;
  //     COPY (SELECT 1) TO PROGRAM 'touch /tmp/PWNED';
  //     CREATE ROLE ke_gian SUPERUSER LOGIN;
  //     SELECT $$ */ $$;
  //
  // Twin bash bắt được (lexer của nó theo dõi `dtag`), bản TS thì không ⇒ đúng lớp LỆCH SONG SINH
  // mà đợt này phải đóng. `gScan` miễn nhiễm vì nó `stripDollarQuoted` TRƯỚC khi bỏ comment.
  // Soi cả hai = hợp hai vùng phủ; không thêm từ-chối-oan vì cả hai đều đã bỏ comment và che nháy.
  const ijScan = maskSingleQuotedStrings(stripSqlComments(noCopy));
  const banSoiIJ = [ijScan, gScan];

  // (i) `COPY … FROM PROGRAM 'cmd'` / `COPY … TO PROGRAM 'cmd'` — chạy lệnh hệ điều hành dưới
  // quyền server. Guard (g) KHÔNG bắt được: dạng SQL thuần không có ký tự `\` nào.
  //
  // Vì sao neo vào `FROM|TO` chứ không từ chối MỌI chữ "PROGRAM": cú pháp PostgreSQL chỉ cho
  // `PROGRAM` đứng ngay sau `FROM`/`TO` của câu `COPY` (và từ khoá này KHÔNG nháy được). Ngược lại,
  // từ chối mọi từ "PROGRAM" sẽ cắt nhầm dump HỢP LỆ của một DB có cột/bảng tên `program` — kiểu
  // từ-chối-oan mà file này coi là nguy hiểm hơn bỏ lọt (nó chỉ nổ đúng lúc chủ shop cần phục hồi).
  // Comment đã bị bỏ và chuỗi nháy đã bị che nên `FROM/**/PROGRAM` hay chữ "from program" trong dữ
  // liệu đều không né/không oan.
  //
  // ⚠️ GIỚI HẠN ĐÃ BIẾT, ĐỪNG ĐUA REGEX (đo 22/09/2026): mọi guard ở đây che chuỗi nháy đơn trước
  // khi soi, nên câu lệnh giấu trong ĐỐI SỐ của `EXECUTE` là vô hình với (i) VÀ (j) ở CẢ HAI bản —
  // `DO $$ BEGIN EXECUTE 'COPY (SELECT 1) TO PROG' || 'RAM ''…'''; END $$;` chạy thật mà không guard
  // nào đỏ. Bỏ che nháy để bắt nó = từ chối oan mọi dump có chữ đó trong DỮ LIỆU, tức đánh đổi sai
  // chiều. ⇒ (i)/(j) là lớp chống TAI NẠN và chống dump-sai-hình-dạng, KHÔNG phải hàng rào chống kẻ
  // tấn công chủ động. Hàng rào cho kẻ tấn công chủ động là TÍNH XÁC THỰC CỦA FILE (kho backup đã
  // mã hoá `age` từ Đợt 2) — đừng tin nhầm lớp này làm việc của lớp kia.
  if (banSoiIJ.some((ban) => /\b(?:FROM|TO)\s+PROGRAM\b/i.test(ban))) {
    throw new Error(
      "SQL chứa COPY … FROM/TO PROGRAM — đây là đường CHẠY LỆNH trên máy chủ; pg_dump plain THẬT " +
        "chỉ dùng COPY … FROM stdin — TỪ CHỐI (nghi file bị chỉnh sửa).",
    );
  }

  // (j) Câu lệnh ĐẶC QUYỀN. Dump của chính repo này không sinh ra chúng (đo 22/09/2026: 0 câu
  // `CREATE EXTENSION` trong `prisma/migrations/`; hàm duy nhất `set_setting_updated_at` KHÔNG
  // `SECURITY DEFINER`; mọi dump đều `-n <schema>` — `run-pg-dump.ts`).
  // ⚠️ `scripts/kiem-chot-chan-nhan-dump-cua-chinh-minh.ts` KHÔNG phải cổng tự động: `Dockerfile:14`
  // chỉ ghi lệnh trong COMMENT, phải chạy TAY sau khi dựng ảnh; và nó dùng `-Fp --schema-only` nên
  // không chạm bề mặt bung-từ-`.dump`. Thêm migration có `SECURITY DEFINER` thì chỉ lượt chạy tay
  // đó mới bắt — đừng coi là lưới an toàn thường trực.
  //
  // `CREATE … LANGUAGE` phải neo `CREATE` liền trước để KHÔNG bắt nhầm mệnh đề `LANGUAGE plpgsql`
  // đứng cuối mọi `CREATE FUNCTION`.
  const CAU_LENH_DAC_QUYEN: Array<[RegExp, string]> = [
    [/\bCREATE\s+EXTENSION\b/i, "CREATE EXTENSION"],
    [/\b(?:CREATE|ALTER|DROP)\s+(?:ROLE|USER)\b/i, "CREATE/ALTER/DROP ROLE"],
    [/\bALTER\s+SYSTEM\b/i, "ALTER SYSTEM"],
    [
      /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TRUSTED\s+)?(?:PROCEDURAL\s+)?LANGUAGE\b/i,
      "CREATE LANGUAGE",
    ],
    [/\bSECURITY\s+DEFINER\b/i, "SECURITY DEFINER"],
  ];
  for (const [re, ten] of CAU_LENH_DAC_QUYEN) {
    if (banSoiIJ.some((ban) => re.test(ban))) {
      throw new Error(
        `SQL chứa câu lệnh đặc quyền ${ten} — dump schema-scoped (pg_dump -n <schema>) KHÔNG BAO ` +
          `GIỜ phát ra câu này — TỪ CHỐI (nghi dump full-DB hoặc file chế tác).`,
      );
    }
  }
}
