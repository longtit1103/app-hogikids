import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { assertDumpOnlySchema } from "@/lib/backup/assert-dump-schema";
import { assertPlainSqlOnlySchema } from "@/lib/backup/assert-plain-sql-only-schema";

// Fixture DÙNG CHUNG với twin shell (tests/unit/backup/restore-sh-guard.test.ts) — hai bản guard
// phải cho cùng phán quyết trên cùng một file, nên chúng phải soi cùng byte.
const fixture = (name: string) =>
  readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures/restore", name),
    "utf8",
  );

// TOC THẬT chụp từ `pg_dump -n app -Fc` → `pg_restore -l` (Postgres 15/18). Format:
// "<id>; <tableoid> <oid> <DESC…> <namespace> <tag> <owner>". DESC có thể ĐA TỪ
// (TABLE DATA / SEQUENCE OWNED BY / SEQUENCE SET), tag cũng đa từ (CONSTRAINT: "Order Order_pkey").
// Đây là regression cho Finding 1: parse cũ coi DESC là 1 token nên đọc nhầm schema.
const TOC_APP = `;
; Archive created at 2026-07-16 02:15:06 +07
;     dbname: postgres
;     Format: CUSTOM
;
; Selected TOC Entries:
;
6; 2615 16384 SCHEMA - app postgres
221; 1259 16386 TABLE app Order postgres
220; 1259 16385 SEQUENCE app Order_id_seq postgres
3873; 0 0 SEQUENCE OWNED BY app Order_id_seq postgres
223; 1259 16396 TABLE app Variant postgres
222; 1259 16395 SEQUENCE app Variant_id_seq postgres
3874; 0 0 SEQUENCE OWNED BY app Variant_id_seq postgres
224; 1259 16407 VIEW app v_order postgres
3705; 2604 16389 DEFAULT app Order id postgres
3706; 2604 16399 DEFAULT app Variant id postgres
3863; 0 16386 TABLE DATA app Order postgres
3865; 0 16396 TABLE DATA app Variant postgres
3875; 0 0 SEQUENCE SET app Order_id_seq postgres
3876; 0 0 SEQUENCE SET app Variant_id_seq postgres
3708; 2606 16394 CONSTRAINT app Order Order_pkey postgres
3711; 2606 16404 CONSTRAINT app Variant Variant_pkey postgres
3713; 2606 16406 CONSTRAINT app Variant Variant_sku_key postgres
3709; 1259 16411 INDEX app idx_order_note postgres
`;
const TOC_MIXED = TOC_APP + "999; 1259 99999 TABLE public LeakedThing postgres\n";
const TOC_OTHER_SCHEMA = `6; 2615 1 SCHEMA - auth supabase_admin
1; 1259 2 TABLE auth users supabase_auth_admin
`;

describe("assertDumpOnlySchema", () => {
  it("chấp nhận TOC app THẬT (TABLE DATA / SEQUENCE SET / SEQUENCE OWNED BY / CONSTRAINT đa từ)", () => {
    expect(() => assertDumpOnlySchema(TOC_APP, "app")).not.toThrow();
  });
  it("từ chối khi có object schema public", () => {
    expect(() => assertDumpOnlySchema(TOC_MIXED, "app")).toThrow(/public/);
  });
  it("từ chối SCHEMA/TABLE thuộc auth (dump full-DB Supabase)", () => {
    expect(() => assertDumpOnlySchema(TOC_OTHER_SCHEMA, "app")).toThrow(/auth/);
  });
  it("public mode (Pha 0) chấp nhận TOC public", () => {
    const toc = "215; 1259 1 TABLE public Order hogikids\n6; 2615 2 SCHEMA - public hogikids\n";
    expect(() => assertDumpOnlySchema(toc, "public")).not.toThrow();
  });
});

describe("assertPlainSqlOnlySchema", () => {
  it("từ chối CREATE SCHEMA khác target", () => {
    expect(() => assertPlainSqlOnlySchema("CREATE SCHEMA auth;\n", "app")).toThrow(/auth/);
  });
  it("từ chối DROP SCHEMA auth CASCADE", () => {
    expect(() => assertPlainSqlOnlySchema("DROP SCHEMA auth CASCADE;\n", "app")).toThrow(/auth/);
  });
  it("từ chối ALTER SCHEMA khác target", () => {
    expect(() =>
      assertPlainSqlOnlySchema("ALTER SCHEMA storage RENAME TO x;\n", "app"),
    ).toThrow(/storage/);
  });
  it("từ chối TRUNCATE bảng schema hệ thống", () => {
    expect(() => assertPlainSqlOnlySchema("TRUNCATE storage.objects;\n", "app")).toThrow(
      /storage/,
    );
  });
  it("từ chối CREATE TABLE trong schema hệ thống", () => {
    expect(() => assertPlainSqlOnlySchema("CREATE TABLE auth.users();\n", "app")).toThrow(/auth/);
  });
  it("từ chối DELETE FROM vault.secrets", () => {
    expect(() =>
      assertPlainSqlOnlySchema("DELETE FROM vault.secrets WHERE id = 1;\n", "app"),
    ).toThrow(/vault/);
  });
  it("từ chối ALTER TABLE trong schema hệ thống", () => {
    expect(() =>
      assertPlainSqlOnlySchema("ALTER TABLE auth.users ADD COLUMN x text;\n", "app"),
    ).toThrow(/auth/);
  });
  it("từ chối meta-command \\connect", () => {
    expect(() => assertPlainSqlOnlySchema("\\connect otherdb\n", "app")).toThrow(/connect/i);
  });
  it("chấp nhận SQL chỉ đụng schema target", () => {
    const sql =
      'CREATE TABLE app."Order" (id bigint);\n' +
      'INSERT INTO app."Order" VALUES (1);\n' +
      "ALTER TABLE app.\"Order\" ADD COLUMN note text;\n";
    expect(() => assertPlainSqlOnlySchema(sql, "app")).not.toThrow();
  });
  it("KHÔNG false-positive khi dữ liệu chứa chuỗi giống schema hệ thống", () => {
    // 'auth.' trong nháy đơn (giá trị dữ liệu) & tên miền ".net." KHÔNG được coi là qualifier.
    const sql =
      "INSERT INTO app.\"Order\" (note) VALUES ('login at auth.example.com');\n" +
      "INSERT INTO app.\"Order\" (note) VALUES ('visit www.shop.net today');\n";
    expect(() => assertPlainSqlOnlySchema(sql, "app")).not.toThrow();
  });
  // --- (g) meta-command psql. `psql -f` THỰC THI mọi lệnh `\…` và không tắt được, nên file .sql.gz
  // là đường CHẠY LỆNH trên máy chủ chứ không chỉ đè schema. Guard (c) chỉ bắt \connect/\c ⇒ các
  // dạng dưới đây từng lọt hết. `pg_dump` plain THẬT chỉ phát ra dòng `\.` kết payload COPY — nó
  // KHÔNG BAO GIỜ phát ra `\copy`, nên cho `\copy` qua không bảo vệ dump hợp lệ nào.
  it("(g) từ chối \\copy — pg_dump plain THẬT không bao giờ phát ra (nó dùng COPY … FROM stdin)", () => {
    expect(() =>
      assertPlainSqlOnlySchema('\\copy app."Order" FROM stdin;\n', "app"),
    ).toThrow(/meta-command/i);
  });
  it("(g) từ chối \\! id (chạy shell trên máy chủ)", () => {
    expect(() => assertPlainSqlOnlySchema("\\! id\n", "app")).toThrow(/meta-command/i);
  });
  it("(g) từ chối \\copy … TO PROGRAM 'id'", () => {
    expect(() =>
      assertPlainSqlOnlySchema("\\copy (SELECT 1) TO PROGRAM 'id'\n", "app"),
    ).toThrow(/meta-command/i);
  });
  it("(g) từ chối \\i (nạp thêm file khác)", () => {
    expect(() => assertPlainSqlOnlySchema("\\i /tmp/x.sql\n", "app")).toThrow(/meta-command/i);
  });
  it("(g) từ chối \\o | sh (đổ output vào shell)", () => {
    expect(() => assertPlainSqlOnlySchema("\\o | sh -c 'id'\n", "app")).toThrow(/meta-command/i);
  });
  it("(g) từ chối meta-command GIỮA câu (SELECT 1 \\g | sh) — không neo đầu dòng được", () => {
    expect(() => assertPlainSqlOnlySchema("SELECT 1 \\g | sh -c 'id'\n", "app")).toThrow(
      /meta-command/i,
    );
  });
  it("(g) từ chối \\setenv và \\lo_import", () => {
    expect(() => assertPlainSqlOnlySchema("\\setenv PGPASSWORD hack\n", "app")).toThrow(
      /meta-command/i,
    );
    expect(() => assertPlainSqlOnlySchema("\\lo_import /etc/passwd\n", "app")).toThrow(
      /meta-command/i,
    );
  });
  it("(g) từ chối \\! thụt đầu dòng", () => {
    expect(() => assertPlainSqlOnlySchema("   \\! id\n", "app")).toThrow(/meta-command/i);
  });

  // Chống TỪ CHỐI OAN — quan trọng hơn cả nhóm trên: over-reject dump thật sẽ tập cho vận hành
  // viên thói quen tắt guard. Trong payload COPY, `\N` (NULL) và `\\` là DỮ LIỆU.
  it("(g) CHẤP NHẬN dump THẬT: COPY … FROM stdin + data có \\N và \\\\ + dòng \\.", () => {
    const sql =
      "-- PostgreSQL database dump\n" +
      "SET statement_timeout = 0;\n" +
      "SELECT pg_catalog.set_config('search_path', '', false);\n" +
      'CREATE TABLE app."Order" (id bigint NOT NULL, note text, ghi text);\n' +
      'COPY app."Order" (id, note, ghi) FROM stdin;\n' +
      "1\tghi chu\t\\N\n" +
      "\\N\tnull o cot dau\tC:\\\\duong\\\\dan\n" +
      "\\.\n" +
      'ALTER TABLE ONLY app."Order" ADD CONSTRAINT "Order_pkey" PRIMARY KEY (id);\n';
    expect(() => assertPlainSqlOnlySchema(sql, "app")).not.toThrow();
  });
  it("(g) CHẤP NHẬN đúng dump đó ở bản CRLF (dòng \\. còn \\r)", () => {
    const sql =
      'COPY app."Order" (id, note) FROM stdin;\r\n\\N\tnull o cot dau\r\n\\.\r\n' +
      'ALTER TABLE app."Order" ADD COLUMN extra text;\r\n';
    expect(() => assertPlainSqlOnlySchema(sql, "app")).not.toThrow();
  });
  it("(g) KHÔNG false-positive: regex '^\\\\d+$' trong chuỗi nháy đơn", () => {
    expect(() =>
      assertPlainSqlOnlySchema('CREATE INDEX i ON app."Setting" ((value ~ \'^\\d+$\'));\n', "app"),
    ).not.toThrow();
  });
  it("(g) KHÔNG false-positive: đường dẫn Windows trong comment", () => {
    expect(() =>
      assertPlainSqlOnlySchema(
        '-- duong dan C:\\temp\\x\nCREATE TABLE app."Order" (id bigint);\n',
        "app",
      ),
    ).not.toThrow();
  });
  it("(g) KHÔNG false-positive: \\! nằm trong thân $$…$$ (psql không thực thi)", () => {
    const sql =
      "CREATE FUNCTION app.f() RETURNS void AS $$ BEGIN /* \\! id */ END $$ LANGUAGE plpgsql;\n";
    expect(() => assertPlainSqlOnlySchema(sql, "app")).not.toThrow();
  });
  it("(g) fail-closed: dollar-quote MỞ KHÔNG ĐÓNG không che được \\! id sau đó", () => {
    expect(() => assertPlainSqlOnlySchema("SELECT $$ x;\n\\! id\n", "app")).toThrow(
      /meta-command/i,
    );
  });
  it("(g) fail-closed: khối COPY thiếu dòng \\. thì \\! id sau đó vẫn bị chặn", () => {
    expect(() =>
      assertPlainSqlOnlySchema('COPY app."Order" (id) FROM stdin;\n1\n\\! id\n', "app"),
    ).toThrow(/meta-command/i);
  });
  it("từ chối SET search_path = auth;", () => {
    expect(() => assertPlainSqlOnlySchema("SET search_path = auth;\n", "app")).toThrow(
      /search_path/i,
    );
  });
  it("từ chối set search_path to public; (chữ thường, cú pháp TO)", () => {
    expect(() =>
      assertPlainSqlOnlySchema("set search_path to public;\n", "app"),
    ).toThrow(/search_path/i);
  });
  it("KHÔNG false-positive khi chuỗi dữ liệu trong nháy chứa chữ 'set search_path'", () => {
    const sql =
      "INSERT INTO app.\"Order\" (note) VALUES ('please set search_path in my notes');\n";
    expect(() => assertPlainSqlOnlySchema(sql, "app")).not.toThrow();
  });

  // --- Finding 2 (H3): guard (e) đối xứng với TOC guard — object schema-qualified
  // nhắm schema ≠ đích bị TỪ CHỐI, KỂ CẢ schema thường (public) mà (a)+(b) bỏ lọt.
  it("(H3) từ chối object schema public khi đích là app (dump public tiền-migration)", () => {
    expect(() =>
      assertPlainSqlOnlySchema('CREATE TABLE public."Order" (id bigint NOT NULL);\n', "app"),
    ).toThrow(/public/);
  });
  it("chấp nhận dump app-only (nhiều dạng câu qualifier app.) khi đích là app", () => {
    const sql =
      'CREATE TABLE app."Order" (id bigint);\n' +
      'ALTER TABLE ONLY app."Order" ADD CONSTRAINT "Order_pkey" PRIMARY KEY (id);\n' +
      'CREATE INDEX idx_order_note ON app."Order" (note);\n' +
      'INSERT INTO app."Order" VALUES (1);\n';
    expect(() => assertPlainSqlOnlySchema(sql, "app")).not.toThrow();
  });
  it("chấp nhận qualifier public. khi đích là public (tương thích ngược Pha 0)", () => {
    const sql =
      'CREATE TABLE public."Order" (id bigint);\n' + 'INSERT INTO public."Order" VALUES (1);\n';
    expect(() => assertPlainSqlOnlySchema(sql, "public")).not.toThrow();
  });
  it("KHÔNG false-positive: public./auth./storage. trong dữ liệu nháy đơn (đích app)", () => {
    const sql =
      "INSERT INTO app.\"Order\" (note) VALUES ('ship to public.square');\n" +
      "INSERT INTO app.\"Order\" (note) VALUES ('see storage.googleapis.com/x');\n" +
      // `;` trong chuỗi cũng KHÔNG được coi là ranh giới câu lệnh.
      "INSERT INTO app.\"Order\" (note) VALUES ('call auth.example.com; DROP public.x');\n";
    expect(() => assertPlainSqlOnlySchema(sql, "app")).not.toThrow();
  });
  it("KHÔNG false-positive: dòng dữ liệu COPY bắt đầu bằng động từ + qualifier (đích app)", () => {
    const sql =
      'COPY app."Order" (note, id) FROM stdin;\n' +
      "DROP public.x here is only a note value\t1\n" +
      "ship to storage.objects please\t2\n" +
      "\\.\n" +
      'ALTER TABLE app."Order" ADD COLUMN extra text;\n';
    expect(() => assertPlainSqlOnlySchema(sql, "app")).not.toThrow();
  });
  it("từ chối COPY vào schema public (đích app)", () => {
    expect(() =>
      assertPlainSqlOnlySchema('COPY public."Order" (id) FROM stdin;\n1\n\\.\n', "app"),
    ).toThrow(/public/);
  });
  it("từ chối qualifier schema có nháy \"public\".\"Order\" (né qualifier) khi đích app", () => {
    expect(() =>
      assertPlainSqlOnlySchema('CREATE TABLE "public"."Order" (id bigint);\n', "app"),
    ).toThrow(/public/);
  });

  // --- Newline bypass: động từ và schema-qualifier TÁCH DÒNG (file .sql.gz chỉnh tay).
  // Đường plain KHÔNG có backstop `pg_restore -n` nên đây là chốt DUY NHẤT; guard cũ dùng
  // char-class loại `\n` nên khoảng đệm không vượt xuống dòng → lọt. Phải fail-closed.
  it("từ chối verb tách dòng khỏi schema hệ thống (TRUNCATE\\n auth.users)", () => {
    expect(() => assertPlainSqlOnlySchema("TRUNCATE\n  auth.users;\n", "app")).toThrow(/auth/);
  });
  it("từ chối verb tách dòng khỏi storage.objects (DROP TABLE\\n storage.objects)", () => {
    expect(() =>
      assertPlainSqlOnlySchema("DROP TABLE\n  storage.objects CASCADE;\n", "app"),
    ).toThrow(/storage/);
  });
  it("từ chối verb tách dòng khỏi vault.secrets (DELETE\\n FROM vault.secrets)", () => {
    expect(() =>
      assertPlainSqlOnlySchema("DELETE FROM\n  vault.secrets WHERE id = 1;\n", "app"),
    ).toThrow(/vault/);
  });
  it("từ chối object public tách dòng khỏi verb (guard e: CREATE TABLE\\n public.\"Order\")", () => {
    expect(() =>
      assertPlainSqlOnlySchema('CREATE TABLE\n  public."Order" (id bigint);\n', "app"),
    ).toThrow(/public/);
  });
  it("từ chối GRANT tách dòng khỏi object public (guard e)", () => {
    expect(() =>
      assertPlainSqlOnlySchema('GRANT ALL\n  ON public."Order" TO r;\n', "app"),
    ).toThrow(/public/);
  });
  it("từ chối dump giả mạo thực tế (set_config + TRUNCATE\\n auth + CREATE app)", () => {
    const sql =
      "SET statement_timeout = 0;\n" +
      "SELECT pg_catalog.set_config('search_path', '', false);\n" +
      "TRUNCATE\n  auth.users;\n" +
      'CREATE TABLE app."Order" (id bigint);\n';
    expect(() => assertPlainSqlOnlySchema(sql, "app")).toThrow(/auth/);
  });
  it("KHÔNG false-positive: câu app hợp lệ trải nhiều dòng (pg_dump thật)", () => {
    const sql =
      'CREATE TABLE app."Order" (\n    id bigint NOT NULL,\n    note text\n);\n' +
      'ALTER TABLE ONLY app."Order"\n    ADD CONSTRAINT "Order_pkey" PRIMARY KEY (id);\n';
    expect(() => assertPlainSqlOnlySchema(sql, "app")).not.toThrow();
  });

  // --- Finding B2 (M5): guard (f) — set_config('search_path', <khác rỗng>) là DẠNG HÀM
  // của SET search_path mà guard (d) KHÔNG bắt. Chỉ chấp nhận dạng chuỗi rỗng '' hợp lệ.
  it("(f) từ chối SELECT set_config('search_path', 'auth', false) — né guard (d)", () => {
    expect(() =>
      assertPlainSqlOnlySchema("SELECT set_config('search_path', 'auth', false);\n", "app"),
    ).toThrow(/rỗng/i);
  });
  it("(f) từ chối cả dạng qualified pg_catalog.set_config(...'auth')", () => {
    expect(() =>
      assertPlainSqlOnlySchema("SELECT pg_catalog.set_config('search_path', 'auth', false);\n", "app"),
    ).toThrow(/rỗng/i);
  });
  it("(f) từ chối đối số KHÔNG phải literal (current_setting) — fail-closed", () => {
    expect(() =>
      assertPlainSqlOnlySchema(
        "SELECT set_config('search_path', current_setting('x'), false);\n",
        "app",
      ),
    ).toThrow(/rỗng/i);
  });
  it("(f) CHẤP NHẬN dạng rỗng hợp lệ pg_dump plain: set_config('search_path', '', false)", () => {
    const sql =
      "SELECT pg_catalog.set_config('search_path', '', false);\n" +
      'CREATE TABLE app."Order" (id bigint);\n';
    expect(() => assertPlainSqlOnlySchema(sql, "app")).not.toThrow();
  });
  it("(f) KHÔNG false-positive: set_config trong THÂN function ($$…$$) — không chạy lúc restore", () => {
    const sql =
      "CREATE FUNCTION app.f() RETURNS void AS $$ BEGIN PERFORM set_config('search_path','auth',false); END $$ LANGUAGE plpgsql;\n";
    expect(() => assertPlainSqlOnlySchema(sql, "app")).not.toThrow();
  });
  it("(f) KHÔNG false-positive: set_config('search_path','auth') trong payload COPY (dữ liệu)", () => {
    const sql =
      'COPY app."Order" (note) FROM stdin;\n' +
      "set_config('search_path', 'auth', false) is only a note value\t1\n" +
      "\\.\n" +
      'CREATE TABLE app."Order" (id bigint);\n';
    expect(() => assertPlainSqlOnlySchema(sql, "app")).not.toThrow();
  });
  it("(f) KHÔNG false-positive: chuỗi nháy đơn chứa set_config (nháy nhân đôi)", () => {
    const sql =
      "INSERT INTO app.\"Order\" (note) VALUES ('tip: set_config(''search_path'',''auth'') hay ho');\n";
    expect(() => assertPlainSqlOnlySchema(sql, "app")).not.toThrow();
  });

  // --- Comment-bypass (review đối kháng M5-A): chèn comment SQL giữa token để né guard.
  // strip comment TRƯỚC khi soi → các biến thể sau phải bị CHẶN.
  it("(f) từ chối set_config né bằng comment khối SAU tên hàm", () => {
    expect(() =>
      assertPlainSqlOnlySchema("SELECT set_config/* x */('search_path', 'auth', false);\n", "app"),
    ).toThrow(/rỗng/i);
  });
  it("(f) từ chối set_config né bằng comment khối TRONG ngoặc", () => {
    expect(() =>
      assertPlainSqlOnlySchema("SELECT set_config(/* x */'search_path', 'auth', false);\n", "app"),
    ).toThrow(/rỗng/i);
  });
  it("(f) từ chối set_config né bằng comment dòng (--)", () => {
    expect(() =>
      assertPlainSqlOnlySchema("SELECT set_config( -- ghi chu\n 'search_path', 'auth', false);\n", "app"),
    ).toThrow(/rỗng/i);
  });
  it("(d) từ chối SET search_path né bằng comment khối", () => {
    expect(() =>
      assertPlainSqlOnlySchema("SET/* x */search_path = auth;\n", "app"),
    ).toThrow(/search_path/i);
  });
  it("(f) từ chối set_config né bằng comment khối LỒNG NHAU (PostgreSQL nesting)", () => {
    expect(() =>
      assertPlainSqlOnlySchema("SELECT set_config /* a /* b */ */ ('search_path', 'auth', false);\n", "app"),
    ).toThrow(/rỗng/i);
  });
  it("(d) từ chối SET search_path né bằng comment khối LỒNG NHAU", () => {
    expect(() =>
      assertPlainSqlOnlySchema("SET /* a /* b */ */ search_path = auth;\n", "app"),
    ).toThrow(/search_path/i);
  });
  it("scanner nhận biết nháy: '/*' trong dữ liệu KHÔNG nuốt câu set_config sau (không tạo bypass)", () => {
    const sql =
      "INSERT INTO app.\"Order\" (note) VALUES ('giam /* 50% */ off');\n" +
      "SELECT set_config('search_path', 'auth', false);\n";
    expect(() => assertPlainSqlOnlySchema(sql, "app")).toThrow(/rỗng/i);
  });
  it("KHÔNG false-positive: dữ liệu chứa '/*' KHÔNG cân bằng (không phải comment)", () => {
    const sql = "INSERT INTO app.\"Order\" (note) VALUES ('giam gia /* 50% off khong dong');\n";
    expect(() => assertPlainSqlOnlySchema(sql, "app")).not.toThrow();
  });
  it("(d) thân $$…$$ có nháy lẻ KHÔNG che được SET search_path top-level sau đó (không bypass)", () => {
    const sql =
      "CREATE FUNCTION app.f() RETURNS text AS $$ a ' b $$ LANGUAGE sql;\n" +
      "SET search_path = auth;\n";
    expect(() => assertPlainSqlOnlySchema(sql, "app")).toThrow(/search_path/i);
  });

  // --- Cặp `\restrict`/`\unrestrict` của pg_dump ≥ 15.14 (bản vá bảo mật 08/2025). ĐO THẬT trên
  // prod 31/07: container app có pg_dump 15.18 và `pg_dump -Fp -n app` của nó LUÔN phát hai dòng
  // này. Nếu guard (g) coi chúng là tấn công thì MỌI file .sql.gz do đời pg_dump hiện tại sinh ra
  // đều bị từ chối — từ-chối-oan đúng loại nguy hiểm nhất với đường phục hồi.
  it("CHẤP NHẬN dump plain có cặp \\restrict/\\unrestrict (pg_dump ≥ 15.14)", () => {
    expect(() => assertPlainSqlOnlySchema(fixture("sql-restrict-token.sql"), "app")).not.toThrow();
  });
  it("allowlist \\restrict HẸP: token có ký tự lạ vẫn bị từ chối", () => {
    expect(() => assertPlainSqlOnlySchema("\\restrict abc; \\! id\n", "app")).toThrow(
      /meta-command/i,
    );
  });
  it("allowlist KHÔNG nới cho meta-command khác cùng tiền tố (\\restrictfoo)", () => {
    expect(() => assertPlainSqlOnlySchema("\\restrictfoo tok\n", "app")).toThrow(/meta-command/i);
  });

  // --- (h) Chuỗi trải nhiều dòng ngoài khối COPY. Một dòng `COPY … FROM stdin;` GIẢ đặt trong
  // chuỗi (hoặc trong thân dollar-quote) mở chế độ bỏ-payload tới `\.`, xoá cả vùng đó khỏi bản
  // soi ⇒ guard (b)/(e)/(g) mù trong khi psql vẫn chạy các câu ở giữa.
  it("(h) từ chối chuỗi nháy đơn đa dòng giấu mốc COPY giả (che TRUNCATE auth.users)", () => {
    expect(() =>
      assertPlainSqlOnlySchema(fixture("sql-chuoi-nhay-da-dong.sql"), "app"),
    ).toThrow(/xuống dòng/i);
  });
  it("(h) từ chối định danh nháy kép trải nhiều dòng", () => {
    expect(() =>
      assertPlainSqlOnlySchema('CREATE TABLE app."a\nCOPY x FROM stdin;\nb" (id bigint);\n', "app"),
    ).toThrow(/xuống dòng/i);
  });
  it("mốc COPY giả trong thân $$…$$ KHÔNG che được câu ghi schema hệ thống sau đó", () => {
    expect(() =>
      assertPlainSqlOnlySchema(
        "SELECT $$\nCOPY fake FROM stdin;\n$$;\nTRUNCATE auth.users;\n\\.\nSELECT 1;\n",
        "app",
      ),
    ).toThrow(/auth/);
  });

  // --- Tag dollar-quote: PostgreSQL KHÔNG cho tag bắt đầu bằng chữ số (đo thật PG 15.8:
  // `SELECT $0$abc$0$;` → unterminated dollar-quoted string). Coi `$9$…$9$` là thân dollar-quote
  // sẽ xoá vùng đó khỏi bản soi trong khi psql VẪN thực thi `\! id` bên trong.
  it("từ chối $9$ \\! id $9$ — tag chữ số KHÔNG mở dollar-quote", () => {
    expect(() => assertPlainSqlOnlySchema(fixture("sql-dollar-tag-chu-so.sql"), "app")).toThrow(
      /meta-command/i,
    );
  });
  it("CHẤP NHẬN $x$ \\! id $x$ — tag hợp lệ nên psql coi là chuỗi, không thực thi", () => {
    expect(() => assertPlainSqlOnlySchema("SELECT $x$ \\! id $x$;\n", "app")).not.toThrow();
  });

  // --- Hai fixture dưới đây dùng CHUNG với twin shell để giữ hai bản guard cùng phán quyết.
  it("(d) từ chối SET search_path né bằng comment khối (fixture dùng chung với twin shell)", () => {
    expect(() =>
      assertPlainSqlOnlySchema(fixture("sql-set-search-path-ne-comment.sql"), "app"),
    ).toThrow(/search_path/i);
  });
  it("(f) KHÔNG false-positive: set_config trong thân function (fixture dùng chung)", () => {
    expect(() =>
      assertPlainSqlOnlySchema(fixture("sql-set-config-than-ham.sql"), "app"),
    ).not.toThrow();
  });

  // --- (i) `COPY … FROM/TO PROGRAM` — CHẠY LỆNH ở tầng SQL. Guard (g) chỉ bắt meta-command có dấu
  // `\`; dạng SQL thuần không có `\` nào nên trước bản vá 22/09/2026 nó lọt sạch, và TOC của bản
  // `.dump` tương đương cũng hợp lệ (chỉ schema app) ⇒ guard TOC cũng mù.
  it("(i) từ chối COPY … FROM PROGRAM", () => {
    expect(() => assertPlainSqlOnlySchema(fixture("sql-copy-from-program.sql"), "app")).toThrow(
      /FROM\/TO PROGRAM/,
    );
  });
  it("(i) từ chối COPY … TO PROGRAM (chiều rò dữ liệu ra)", () => {
    expect(() => assertPlainSqlOnlySchema(fixture("sql-copy-to-program.sql"), "app")).toThrow(
      /FROM\/TO PROGRAM/,
    );
  });
  it("(i) bắt được cả khi nằm trong DO $$…$$ (khối này CHẠY THẬT lúc restore)", () => {
    expect(() =>
      assertPlainSqlOnlySchema("DO $$ BEGIN COPY app.t FROM PROGRAM 'id'; END $$;\n", "app"),
    ).toThrow(/FROM\/TO PROGRAM/);
  });
  // 🔴 Lệch song sinh ĐO ĐƯỢC 22/09: `stripSqlComments` không theo dõi dollar-quote, nên `/*` trong
  // thân `$$…$$` nuốt mọi câu tới `*/` — bản soi giữ-dollar khi đó chỉ còn `SELECT $$   $$;` trong
  // khi psql vẫn chạy trọn. Bản bash bắt được (lexer theo dõi `dtag`); TS phải soi THÊM bản đã bỏ
  // dollar-quote mới hết mù.
  it("(i) không né được bằng `/*` giấu trong thân dollar-quote (lệch song sinh)", () => {
    expect(() =>
      assertPlainSqlOnlySchema(fixture("sql-dollar-quote-che-comment-program.sql"), "app"),
    ).toThrow(/FROM\/TO PROGRAM/);
  });
  it("(i) không né được bằng comment chèn giữa token (FROM/* x */PROGRAM)", () => {
    expect(() =>
      assertPlainSqlOnlySchema("COPY app.t FROM/* x */PROGRAM 'id';\n", "app"),
    ).toThrow(/FROM\/TO PROGRAM/);
  });
  // CHỐNG VÁ QUÁ TAY — đây mới là chiều nguy hiểm: từ chối oan nghĩa là chủ shop mất đường phục
  // hồi đúng lúc cần nhất (bài học `total_discount` âm). Chữ "program" ở tên cột / dữ liệu COPY /
  // literal là thứ một dump THẬT hoàn toàn có thể chứa.
  it("(i) CHẤP NHẬN dump có chữ 'program' ở tên cột, dữ liệu COPY và literal", () => {
    expect(() =>
      assertPlainSqlOnlySchema(fixture("sql-copy-stdin-chua-chu-program.sql"), "app"),
    ).not.toThrow();
  });

  // --- (j) câu lệnh ĐẶC QUYỀN. Dump schema-scoped không phát ra; ở đường bash chúng chạy bằng
  // `psql -U supabase_admin` (superuser THẬT) nên đều thành công.
  it("(j) từ chối ALTER ROLE (fixture dùng chung với twin shell)", () => {
    expect(() => assertPlainSqlOnlySchema(fixture("sql-cau-lenh-dac-quyen.sql"), "app")).toThrow(
      /đặc quyền/i,
    );
  });
  it("(j) từ chối SECURITY DEFINER — hàm nằm gọn trong schema đích nên (a)/(b)/(e) đều cho qua", () => {
    expect(() => assertPlainSqlOnlySchema(fixture("sql-security-definer.sql"), "app")).toThrow(
      /đặc quyền/i,
    );
  });
  it.each([
    ["CREATE EXTENSION", "CREATE EXTENSION pg_stat_statements;\n"],
    ["CREATE ROLE", "CREATE ROLE ke_tan_cong LOGIN SUPERUSER;\n"],
    ["DROP USER", "DROP USER hogikids;\n"],
    ["ALTER SYSTEM", "ALTER SYSTEM SET archive_command = 'sh -c \"id\"';\n"],
    ["CREATE LANGUAGE", "CREATE TRUSTED PROCEDURAL LANGUAGE plperlu;\n"],
  ])("(j) từ chối %s", (_ten, sql) => {
    expect(() => assertPlainSqlOnlySchema(sql, "app")).toThrow(/đặc quyền/i);
  });
  // CHỐNG VÁ QUÁ TAY: mệnh đề `LANGUAGE plpgsql` đứng cuối MỌI `CREATE FUNCTION` — bắt nhầm nó là
  // từ chối gần như mọi dump có hàm.
  it("(j) CHẤP NHẬN mệnh đề LANGUAGE plpgsql cuối CREATE FUNCTION", () => {
    expect(() =>
      assertPlainSqlOnlySchema(fixture("sql-set-config-than-ham.sql"), "app"),
    ).not.toThrow();
  });
});
