import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { kiemMigrationNguyenKhoi, laHamChiDocDaBiet, PHAN_TEN, phanLoaiCau, tachCau, tenGoiHam } from "../helpers/kiem-migration-nguyen-khoi";
import { MIGRATION_DA_AP_PROD } from "./migration-da-ap-prod-sha256";

/**
 * Cổng migration MỚI phải nguyên khối dưới Prisma 7.4+ (luật + lý do: đầu file `tests/helpers/kiem-migration-nguyen-khoi.ts`).
 * 58 file đã áp prod giữ nguyên — khoá bằng SHA-256, không áp luật (nhiều file Prisma tự sinh không có BEGIN/COMMIT).
 */

const THU_MUC = path.resolve(process.cwd(), "prisma/migrations");
const dsMigration = readdirSync(THU_MUC)
  .filter((t) => statSync(path.join(THU_MUC, t)).isDirectory())
  .sort();
const docSql = (ten: string) => readFileSync(path.join(THU_MUC, ten, "migration.sql"), "utf8");

describe("58 migration đã áp prod — bất biến", () => {
  it("đủ 58 tên, mỗi file còn nguyên SHA-256 đã ghim", () => {
    const ten = Object.keys(MIGRATION_DA_AP_PROD);
    expect(ten).toHaveLength(58);
    for (const t of ten) {
      const file = path.join(THU_MUC, t, "migration.sql");
      expect(existsSync(file), `mất ${t}`).toBe(true);
      expect(createHash("sha256").update(readFileSync(file)).digest("hex"), `${t} bị sửa`).toBe(MIGRATION_DA_AP_PROD[t]);
    }
  });

  it("migration mới chỉ được xếp SAU migration đã áp cuối cùng (không chen vào lịch sử)", () => {
    const cuoi = Object.keys(MIGRATION_DA_AP_PROD).sort().at(-1) ?? "";
    for (const t of dsMigration.filter((x) => !(x in MIGRATION_DA_AP_PROD))) {
      expect(t > cuoi, `${t} xếp trước ${cuoi}`).toBe(true);
    }
  });
});

describe("migration mới (ngoài 58 file) qua luật nguyên khối", () => {
  const moi = dsMigration.filter((t) => !(t in MIGRATION_DA_AP_PROD));
  it.each(moi.length > 0 ? moi : ["(chưa có migration mới)"])("%s", (ten) => {
    if (!moi.includes(ten)) return;
    expect(kiemMigrationNguyenKhoi(docSql(ten))).toEqual([]);
  });
});

describe("tách câu + phân loại", () => {
  it("dấu ; trong chuỗi, định danh nháy, chú thích, $tag$ không cắt câu", () => {
    const sql = [
      "-- chú thích; có chấm phẩy",
      "/* khối; chú thích */",
      `INSERT INTO "a;b" VALUES ('x;y', 'it''s; ok');`,
      "DO $kiem$ BEGIN IF 1 = 2 THEN RAISE EXCEPTION 'loi; that'; END IF; END $kiem$;",
      "CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql;",
    ].join("\n");
    expect(tachCau(sql)).toHaveLength(3);
  });

  it("phân loại từ khoá", () => {
    expect(phanLoaiCau("BEGIN").loai).toBe("begin");
    expect(phanLoaiCau("COMMIT").loai).toBe("commit");
    expect(phanLoaiCau("SET LOCAL lock_timeout = '15s'").loai).toBe("set-local");
    expect(phanLoaiCau("SELECT count(*) FROM app.\"User\"").loai).toBe("chi-doc");
    expect(phanLoaiCau("SELECT setval('s', 10)").loai).toBe("ghi");
    expect(phanLoaiCau('CREATE INDEX CONCURRENTLY "i" ON "t"("c")').loai).toBe("concurrently");
    expect(phanLoaiCau(`ALTER TYPE "K" ADD VALUE IF NOT EXISTS 'X'`)).toMatchObject({ loai: "them-gia-tri-enum", nhanEnumMoi: "X" });
    expect(phanLoaiCau("DO $$ BEGIN IF (SELECT count(*) FROM t) > 1 THEN RAISE EXCEPTION 'update nhieu'; END IF; END $$").loai).toBe("chi-doc");
    expect(phanLoaiCau("DO $$\nBEGIN\n  -- ghi chú: update sau\n  RAISE NOTICE 'x';\nEND $$").loai).toBe("chi-doc");
    expect(phanLoaiCau("DO $$ BEGIN UPDATE t SET a = 1; END $$").loai).toBe("ghi");
    expect(phanLoaiCau('ALTER TABLE "t" ADD COLUMN "c" int').loai).toBe("ghi");
    expect(phanLoaiCau("SELECT app.ham_la()").loai).toBe("ghi");
    expect(phanLoaiCau("SELECT current_database(), count(*) FROM t WHERE x IN (1, 2)").loai).toBe("chi-doc");
    expect(phanLoaiCau("SELECT 'setval(' || 'x'").loai).toBe("chi-doc"); // tên hàm nằm trong chuỗi không tính
    expect(phanLoaiCau("COMMIT PREPARED 'x'").loai).toBe("dieu-khien-tx-ngoai-quy-uoc");
    expect(phanLoaiCau("begin").loai).toBe("begin");
    // Tên có schema: chỉ `pg_catalog.` là built-in; `app.count` là hàm của app dù trùng tên `count`.
    expect(phanLoaiCau('SELECT app.count(*) FROM "t"').loai).toBe("ghi");
    expect(phanLoaiCau('SELECT "app"."count"(1)').loai).toBe("ghi");
    expect(phanLoaiCau("SELECT public.coalesce(1, 2)").loai).toBe("ghi");
    expect(phanLoaiCau('SELECT "Count"(1)').loai).toBe("ghi"); // tên nháy giữ hoa thường ⇒ không phải `count`
    expect(phanLoaiCau('SELECT pg_catalog.count(*) FROM "t"').loai).toBe("chi-doc");
    expect(phanLoaiCau('SELECT "pg_catalog"."count"(*) FROM "t"').loai).toBe("chi-doc");
  });

  it("`--` trong chuỗi / định danh / $tag$ / E'…' KHÔNG phải chú thích — phần sau nó vẫn được xét", () => {
    expect(phanLoaiCau("SELECT '--' || app.f()").loai).toBe("ghi");
    expect(phanLoaiCau("SELECT 'a -- b', app.f() FROM t").loai).toBe("ghi");
    expect(phanLoaiCau('SELECT "cot--x", app.f() FROM t').loai).toBe("ghi");
    expect(phanLoaiCau("SELECT $q$ -- $q$ || app.f()").loai).toBe("ghi");
    expect(phanLoaiCau("SELECT E'it\\'s -- ' || app.f()").loai).toBe("ghi");
    expect(phanLoaiCau("SELECT '/*', app.f(), '*/'").loai).toBe("ghi");
    expect(phanLoaiCau("DO $$ DECLARE n int; BEGIN SELECT length('--') + app.f() INTO n; END $$").loai).toBe("ghi");
    expect(phanLoaiCau("SELECT '--'\n || app.f()").loai).toBe("ghi");
  });

  it("chú thích thật (dòng, khối, khối lồng) được bỏ đúng — không chặn oan, không mở chuỗi giả", () => {
    expect(phanLoaiCau("SELECT 1 -- app.f()\n").loai).toBe("chi-doc");
    expect(phanLoaiCau("SELECT 1 /* app.f() */").loai).toBe("chi-doc");
    expect(phanLoaiCau("SELECT 1 /* a /* b */ app.f() */").loai).toBe("chi-doc");
    expect(phanLoaiCau("SELECT 1 /* a /* b */ c */, app.f()").loai).toBe("ghi");
    expect(phanLoaiCau("SELECT 1 -- it's\n, app.f()").loai).toBe("ghi"); // `'` trong chú thích không mở chuỗi
    expect(phanLoaiCau("SELECT 1 -- it's\n").loai).toBe("chi-doc");
  });

  it("tách câu: `;` trong E'…', chú thích khối lồng, $tag$ không cắt câu; `;` sau chú thích dòng có nháy vẫn cắt", () => {
    expect(tachCau("SELECT E'a\\';b';\nSELECT 2;")).toEqual(["SELECT E'a\\';b'", "SELECT 2"]);
    expect(tachCau("/* a /* ; */ ; */ SELECT 1;")).toEqual(["SELECT 1"]);
    expect(tachCau("SELECT 1; -- it's\nSELECT 2;")).toEqual(["SELECT 1", "SELECT 2"]);
    expect(tachCau("SELECT 'x--';SELECT 2")).toEqual(["SELECT 'x--'", "SELECT 2"]);
  });

  it("lời gọi hàm trong đối số RAISE được soát như mọi chỗ khác", () => {
    expect(phanLoaiCau("DO $$ BEGIN RAISE NOTICE '%', setval('s', 1); END $$").loai).toBe("ghi");
    expect(phanLoaiCau("DO $$ BEGIN RAISE NOTICE '%', app.xoa_het(); END $$").loai).toBe("ghi");
    expect(phanLoaiCau("DO $$ BEGIN RAISE EXCEPTION USING MESSAGE = nextval('s')::text; END $$").loai).toBe("ghi");
    // RAISE chỉ dùng hàm chỉ đọc đã biết / mệnh đề USING thì vẫn là khối kiểm chỉ đọc.
    expect(phanLoaiCau("DO $$ BEGIN RAISE NOTICE 'n=%', coalesce(length('a'), 0); END $$").loai).toBe("chi-doc");
    expect(phanLoaiCau("DO $$ BEGIN RAISE EXCEPTION 'x' USING HINT = 'chạy lại', ERRCODE = 'P0001'; END $$").loai).toBe("chi-doc");
  });

  it("định danh / thẻ dollar có chữ không-ASCII đọc như Postgres (byte ≥ 0x80 là chữ)", () => {
    // `$ă$…$ă$` là MỘT chuỗi (PG15 trả ";\nBEGIN;\n") ⇒ BEGIN bên trong không phải câu lệnh.
    expect(tachCau("SELECT $ă$;\nBEGIN;\n$ă$;\nSELECT 2;")).toEqual(["SELECT $ă$;\nBEGIN;\n$ă$", "SELECT 2"]);
    // `ă$x$` là định danh (PG15 nhận `AS ă$x$`), `$x$` sau nó KHÔNG mở chuỗi; `1$x$` thì có (sau hằng số là token mới).
    expect(tachCau("SELECT 1 AS ă$x$; UPDATE t SET c = 1; SELECT 1 AS b$x$;")).toHaveLength(3);
    expect(tachCau("SELECT 1 AS x1$x$; SELECT 2;")).toHaveLength(2);
    expect(tachCau("SELECT 1$x$; SELECT 2; $x$;")).toHaveLength(1);
    expect(tachCau("SELECT $1; SELECT a$b; SELECT 3;")).toHaveLength(3); // `$1` tham số, `a$b` định danh
    expect(phanLoaiCau("DO $kiểm$ BEGIN IF (SELECT count(*) FROM t) > 1 THEN RAISE EXCEPTION 'x'; END IF; END $kiểm$").loai).toBe("chi-doc");
    expect(phanLoaiCau("SELECT hàm_lạ(1)").loai).toBe("ghi");
    expect(phanLoaiCau("SELECT ĕ'a' || app.f()").loai).toBe("ghi"); // `ĕ'` không phải E-string: không nuốt phần sau
  });

  it("SET không LOCAL ở vị trí câu lệnh (mức ngoài lẫn trong DO) là set-phien; SET LOCAL / UPDATE … SET thì không", () => {
    expect(phanLoaiCau("SET search_path TO public").loai).toBe("set-phien");
    expect(phanLoaiCau("SET SESSION lock_timeout = 0").loai).toBe("set-phien");
    expect(phanLoaiCau("set lock_timeout = 0").loai).toBe("set-phien");
    expect(phanLoaiCau("SET CONSTRAINTS ALL DEFERRED").loai).toBe("ghi");
    expect(phanLoaiCau("DO $$ BEGIN SET search_path TO public; END $$").loai).toBe("set-phien");
    expect(phanLoaiCau("DO $$ BEGIN IF true THEN SET session_replication_role = replica; END IF; END $$").loai).toBe("set-phien");
    expect(phanLoaiCau("DO $$ BEGIN RAISE NOTICE 'x'; SET lock_timeout = '3s'; END $$").loai).toBe("set-phien");
    expect(phanLoaiCau("DO $$ BEGIN <<nhan>> SET lock_timeout = '3s'; END $$").loai).toBe("set-phien");
    expect(phanLoaiCau("DO $$ BEGIN SET LOCAL lock_timeout = '3s'; END $$").loai).toBe("ghi");
    expect(phanLoaiCau("DO $$ BEGIN UPDATE t SET a = 1; END $$").loai).toBe("ghi");
    expect(phanLoaiCau("DO $$ BEGIN RAISE NOTICE 'SET x = 1'; END $$").loai).toBe("chi-doc"); // SET trong chuỗi
  });

  it("lời gọi set_config thật (mọi dạng tên, cả trong DO) là set-config; chữ set_config trong chuỗi / chú thích thì không", () => {
    for (const cau of [
      "SELECT set_config('lock_timeout', '0', false)",
      "SELECT set_config('lock_timeout', '0', true)",
      "SELECT set_config ('search_path', 'public', false)",
      "SELECT pg_catalog.set_config('search_path', 'public', false)",
      'SELECT "pg_catalog"."set_config"(\'search_path\', \'public\', false)',
      "SELECT PG_CATALOG.SET_CONFIG('search_path', 'public', false)",
      "SELECT x FROM t WHERE set_config('a.b', '1', false) IS NOT NULL",
      "DO $$ BEGIN PERFORM set_config('search_path', 'public', false); END $$",
      "DO $$ DECLARE v text; BEGIN v := pg_catalog.set_config('lock_timeout', '0', false); END $$",
      "DO $kiểm$ BEGIN IF true THEN PERFORM set_config('a.b', '1', false); END IF; END $kiểm$",
    ]) {
      expect(phanLoaiCau(cau).loai, cau).toBe("set-config");
    }
    // Không phải lời gọi: chữ nằm trong chuỗi / chuỗi dollar / chú thích, hoặc tên khác.
    expect(phanLoaiCau("SELECT 'set_config(' || 'x'").loai).toBe("chi-doc");
    expect(phanLoaiCau("SELECT $q$ set_config('a','b',false) $q$").loai).toBe("chi-doc");
    expect(phanLoaiCau("DO $$ BEGIN RAISE NOTICE 'đừng gọi set_config(a, b, false)'; END $$").loai).toBe("chi-doc");
    expect(phanLoaiCau("DO $$ BEGIN -- set_config('a','b',false)\n RAISE NOTICE 'x'; END $$").loai).toBe("chi-doc");
    expect(phanLoaiCau("DO $$ BEGIN /* set_config('a','b',false) */ RAISE NOTICE 'x'; END $$").loai).toBe("chi-doc");
    expect(phanLoaiCau('SELECT "set_config_cu"(1)').loai).toBe("ghi"); // hàm lạ ⇒ ghi, không phải set-config
    expect(phanLoaiCau("SELECT app.set_config(1)").loai).toBe("ghi"); // hàm của app, không phải built-in
    expect(phanLoaiCau("SELECT current_setting('lock_timeout')").loai).toBe("chi-doc");
  });

  it("ADD VALUE: tên enum có schema / nháy kép / dấu cách, giá trị '…' hoặc $tag$", () => {
    expect(phanLoaiCau(`ALTER TYPE "Loai K" ADD VALUE 'X'`)).toMatchObject({ loai: "them-gia-tri-enum", nhanEnumMoi: "X" });
    expect(phanLoaiCau(`ALTER TYPE app."Loai ""K""" ADD VALUE IF NOT EXISTS 'it''s'`)).toMatchObject({ loai: "them-gia-tri-enum", nhanEnumMoi: "it's" });
    expect(phanLoaiCau(`ALTER TYPE "K" ADD VALUE $v$X Y$v$`)).toMatchObject({ loai: "them-gia-tri-enum", nhanEnumMoi: "X Y" });
  });

  it("tên gọi hàm giữ schema, chỉ bỏ pg_catalog", () => {
    expect(tenGoiHam('SELECT app.count(*), "app" . "Ham"(1), pg_catalog.max(x), sum(y), "lower"(z)')).toEqual([
      "app.count",
      "app.Ham",
      "max",
      "sum",
      "lower",
    ]);
    // Nháy kép thoát `""`, chữ không-ASCII, hạ chữ thường CHỈ ký tự ASCII (như PG với UTF-8).
    expect(tenGoiHam('SELECT "x""count"(1), "a""b"."c"(2), hàm_lạ(3), CoUNT(4), ĐẾM(5)')).toEqual(['x"count', 'a"b.c', "hàm_lạ", "count", "ĐẾm"]); // PG: `ĐẾM` → `ĐẾm`
    expect(phanLoaiCau('SELECT "x""count"(1)').loai).toBe("ghi");
  });
});

describe("migration của repo không tự tạo hàm trùng tên hàm built-in trong danh sách trắng", () => {
  // Hàm `app.count(kiểu cụ thể)` khớp kiểu đối số tốt hơn có thể được PG chọn thay `pg_catalog.count` cho lời gọi không
  // schema ⇒ danh sách trắng theo TÊN chỉ an toàn khi không migration nào tạo hàm trùng tên đó.
  const mau = new RegExp(String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE|AGGREGATE)\s+(${PHAN_TEN}(?:\s*\.\s*${PHAN_TEN})?)\s*\(`, "gi");
  it.each(dsMigration)("%s", (ten) => {
    const trung = [...docSql(ten).matchAll(mau)]
      .map((m) => (tenGoiHam(`${m[1]}(`)[0] ?? "").split(".").at(-1) ?? "")
      .filter((t) => laHamChiDocDaBiet(t));
    expect(trung).toEqual([]);
  });

  it("lưới không mù: bắt được hàm tạo trùng tên", () => {
    const sql = 'CREATE OR REPLACE FUNCTION app."count"(x text) RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;\nCREATE FUNCTION "a""b".coalesce(int) RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;';
    const trung = [...sql.matchAll(mau)].map((m) => (tenGoiHam(`${m[1]}(`)[0] ?? "").split(".").at(-1) ?? "").filter((t) => laHamChiDocDaBiet(t));
    expect(trung).toEqual(["count", "coalesce"]);
  });
});

describe("luật — ca đạt", () => {
  it.each([
    ["một câu DDL không bọc", 'ALTER TABLE "t" ADD COLUMN "c" int;'],
    ["một câu ADD VALUE", `ALTER TYPE "K" ADD VALUE IF NOT EXISTS 'X';`],
    ["CONCURRENTLY đứng một mình", 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "i" ON "t"("c");'],
    ["nhiều câu bọc BEGIN/COMMIT, SET LOCAL sau BEGIN", "BEGIN;\nSET LOCAL lock_timeout = '15s';\nALTER TABLE \"t\" ADD COLUMN \"c\" int;\nUPDATE \"t\" SET \"c\" = 1;\nCOMMIT;"],
    ["khối kiểm chỉ đọc đứng trước BEGIN", "DO $$ BEGIN IF (SELECT count(*) FROM t) > 1 THEN RAISE EXCEPTION 'nhieu'; END IF; END $$;\nBEGIN;\nALTER TABLE \"t\" ADD COLUMN \"c\" int;\nCOMMIT;"],
    ["nhiều câu chỉ đọc không cần bọc", "SELECT 1;\nSELECT 2;"],
    ["nhiều ADD VALUE bọc chung, không dùng giá trị", `BEGIN;\nALTER TYPE "K" ADD VALUE 'A';\nALTER TYPE "K" ADD VALUE 'B';\nCOMMIT;`],
    ["khối kiểm thẻ dollar có dấu đứng trước BEGIN", "DO $kiểm$ BEGIN IF (SELECT count(*) FROM t) > 1 THEN RAISE EXCEPTION 'nhieu'; END IF; END $kiểm$;\nBEGIN;\nALTER TABLE \"t\" ADD COLUMN \"c\" int;\nCOMMIT;"],
    ["SET LOCAL + SET CONSTRAINTS trong khối", "BEGIN;\nSET LOCAL lock_timeout = '15s';\nSET CONSTRAINTS ALL DEFERRED;\nUPDATE \"t\" SET \"c\" = 1;\nCOMMIT;"],
    ["chữ set_config chỉ trong chuỗi / chú thích", "-- set_config('a','b',false)\nDO $$ BEGIN RAISE NOTICE 'không dùng set_config(a, b, false)'; END $$;\nBEGIN;\n/* set_config(x) */\nSET LOCAL lock_timeout = '15s';\nUPDATE \"t\" SET \"c\" = 'set_config(1)';\nCOMMIT;"],
  ])("%s", (_ten, sql) => {
    expect(kiemMigrationNguyenKhoi(sql)).toEqual([]);
  });
});

describe("luật — ca trượt (mỗi ca đúng lý do)", () => {
  it.each([
    ["nhiều câu ghi không bọc", 'ALTER TABLE "t" ADD COLUMN "c" int;\nUPDATE "t" SET "c" = 1;', /phải bọc BEGIN/],
    ["thiếu COMMIT", 'BEGIN;\nALTER TABLE "t" ADD COLUMN "c" int;\nUPDATE "t" SET "c" = 1;', /thiếu COMMIT/],
    ["thiếu BEGIN", 'ALTER TABLE "t" ADD COLUMN "c" int;\nUPDATE "t" SET "c" = 1;\nCOMMIT;', /thiếu BEGIN/],
    ["câu ghi trước BEGIN", 'UPDATE "t" SET "c" = 0;\nBEGIN;\nALTER TABLE "t" ADD COLUMN "c" int;\nCOMMIT;', /chưa xác định là chỉ đọc nằm ngoài BEGIN/],
    ["câu ghi sau COMMIT", 'BEGIN;\nALTER TABLE "t" ADD COLUMN "c" int;\nCOMMIT;\nUPDATE "t" SET "c" = 1;', /ngoài BEGIN;…COMMIT;|câu cuối/],
    ["khối DO có ghi đứng trước BEGIN", 'DO $$ BEGIN UPDATE t SET a = 1; END $$;\nBEGIN;\nALTER TABLE "t" ADD COLUMN "c" int;\nCOMMIT;', /chưa xác định là chỉ đọc nằm ngoài BEGIN/],
    ["setval ngoài khối", "SELECT setval('s', 10);\nBEGIN;\nALTER TABLE \"t\" ADD COLUMN \"c\" int;\nCOMMIT;", /chưa xác định là chỉ đọc nằm ngoài BEGIN/],
    ["SET LOCAL trước BEGIN", "SET LOCAL lock_timeout = '15s';\nBEGIN;\nALTER TABLE \"t\" ADD COLUMN \"c\" int;\nUPDATE \"t\" SET \"c\" = 1;\nCOMMIT;", /SET LOCAL ngoài/],
    ["SET LOCAL trong file một câu, không BEGIN", "SET LOCAL lock_timeout = '15s';\nALTER TABLE \"t\" ADD COLUMN \"c\" int;", /SET LOCAL ngoài/],
    ["hai cặp BEGIN/COMMIT", 'BEGIN;\nALTER TABLE "t" ADD COLUMN "c" int;\nCOMMIT;\nBEGIN;\nUPDATE "t" SET "c" = 1;\nCOMMIT;', /MỘT cặp/],
    ["có ROLLBACK", 'BEGIN;\nALTER TABLE "t" ADD COLUMN "c" int;\nROLLBACK;', /ROLLBACK/],
    ["thêm giá trị enum rồi dùng ngay", `BEGIN;\nALTER TYPE "K" ADD VALUE 'X';\nUPDATE "t" SET "k" = 'X';\nCOMMIT;`, /giá trị enum mới 'X'/],
    ["ADD VALUE rồi CHECK nhắc giá trị", `BEGIN;\nALTER TYPE "K" ADD VALUE 'X';\nALTER TABLE "t" ADD CONSTRAINT "c" CHECK ("k" <> 'X');\nCOMMIT;`, /giá trị enum mới 'X'/],
    ["CONCURRENTLY cùng câu khác", 'CREATE INDEX CONCURRENTLY "i" ON "t"("c");\nALTER TABLE "t" ADD COLUMN "d" int;', /CONCURRENTLY phải là câu DUY NHẤT/],
    ["CONCURRENTLY trong BEGIN/COMMIT", 'BEGIN;\nCREATE INDEX CONCURRENTLY "i" ON "t"("c");\nCOMMIT;', /CONCURRENTLY phải là câu DUY NHẤT/],
    // Hàm chưa xác định không được coi là chỉ đọc (danh sách trắng, không phải danh sách đen).
    ["SELECT gọi hàm của app trước BEGIN", 'SELECT app.don_du_lieu_cu();\nBEGIN;\nALTER TABLE "t" ADD COLUMN "c" int;\nCOMMIT;', /chưa xác định là chỉ đọc nằm ngoài BEGIN/],
    ["SELECT app.count() trùng tên hàm hệ thống trước BEGIN", 'SELECT app.count(*) FROM "t";\nBEGIN;\nALTER TABLE "t" ADD COLUMN "c" int;\nCOMMIT;', /chưa xác định là chỉ đọc nằm ngoài BEGIN/],
    ["khối DO gọi app.count() trước BEGIN", 'DO $$ BEGIN IF app.count(1) > 0 THEN RAISE EXCEPTION \'x\'; END IF; END $$;\nBEGIN;\nALTER TABLE "t" ADD COLUMN "c" int;\nCOMMIT;', /chưa xác định là chỉ đọc nằm ngoài BEGIN/],
    ["`--` trong chuỗi che hàm của app trước BEGIN", "SELECT '--' || app.don_cu();\nBEGIN;\nALTER TABLE \"t\" ADD COLUMN \"c\" int;\nCOMMIT;", /chưa xác định là chỉ đọc nằm ngoài BEGIN/],
    ["SELECT gọi hàm lạ không schema trước BEGIN", 'SELECT lam_gi_do(1);\nBEGIN;\nALTER TABLE "t" ADD COLUMN "c" int;\nCOMMIT;', /chưa xác định là chỉ đọc nằm ngoài BEGIN/],
    ["pg_advisory_lock trước BEGIN", 'SELECT pg_advisory_lock(1);\nBEGIN;\nALTER TABLE "t" ADD COLUMN "c" int;\nCOMMIT;', /chưa xác định là chỉ đọc nằm ngoài BEGIN/],
    ["khối DO gọi hàm lạ trước BEGIN", 'DO $$ DECLARE n int; BEGIN SELECT lam_gi(1) INTO n; END $$;\nBEGIN;\nALTER TABLE "t" ADD COLUMN "c" int;\nCOMMIT;', /chưa xác định là chỉ đọc nằm ngoài BEGIN/],
    ["SELECT … FOR UPDATE trước BEGIN", 'SELECT * FROM "t" FOR UPDATE;\nBEGIN;\nALTER TABLE "t" ADD COLUMN "c" int;\nCOMMIT;', /chưa xác định là chỉ đọc nằm ngoài BEGIN/],
    ["SELECT … FOR KEY SHARE trước BEGIN (khoá dòng, không có chữ UPDATE)", 'SELECT * FROM "t" FOR KEY SHARE;\nBEGIN;\nALTER TABLE "t" ADD COLUMN "c" int;\nCOMMIT;', /chưa xác định là chỉ đọc nằm ngoài BEGIN/],
    ["SELECT INTO bảng mới trước BEGIN", 'SELECT * INTO "t_sao" FROM "t";\nBEGIN;\nALTER TABLE "t" ADD COLUMN "c" int;\nCOMMIT;', /chưa xác định là chỉ đọc nằm ngoài BEGIN/],
    ["CTE xoá dữ liệu trước BEGIN", 'WITH x AS (DELETE FROM "t" RETURNING *) SELECT count(*) FROM x;\nBEGIN;\nALTER TABLE "t" ADD COLUMN "c" int;\nCOMMIT;', /chưa xác định là chỉ đọc nằm ngoài BEGIN/],
    ["nhiều câu chỉ gồm SELECT hàm lạ, không bọc", "SELECT lam_gi_do(1);\nSELECT lam_gi_khac(2);", /phải bọc BEGIN/],
    // Chỉ BEGIN; / COMMIT; trơn là đúng quy ước.
    ["COMMIT PREPARED thay COMMIT", "BEGIN;\nALTER TABLE \"t\" ADD COLUMN \"c\" int;\nUPDATE \"t\" SET \"c\" = 1;\nCOMMIT PREPARED 'gd1';", /ngoài quy ước.*COMMIT PREPARED/],
    ["PREPARE TRANSACTION", "BEGIN;\nALTER TABLE \"t\" ADD COLUMN \"c\" int;\nPREPARE TRANSACTION 'gd1';\nCOMMIT;", /ngoài quy ước.*PREPARE TRANSACTION/],
    ["START TRANSACTION thay BEGIN", 'START TRANSACTION;\nALTER TABLE "t" ADD COLUMN "c" int;\nUPDATE "t" SET "c" = 1;\nCOMMIT;', /ngoài quy ước.*START TRANSACTION/],
    ["BEGIN có tham số", 'BEGIN ISOLATION LEVEL SERIALIZABLE;\nALTER TABLE "t" ADD COLUMN "c" int;\nUPDATE "t" SET "c" = 1;\nCOMMIT;', /ngoài quy ước.*BEGIN ISOLATION/],
    ["END thay COMMIT", 'BEGIN;\nALTER TABLE "t" ADD COLUMN "c" int;\nUPDATE "t" SET "c" = 1;\nEND;', /ngoài quy ước.*END/],
    ["COMMIT AND CHAIN", 'BEGIN;\nALTER TABLE "t" ADD COLUMN "c" int;\nUPDATE "t" SET "c" = 1;\nCOMMIT AND CHAIN;', /ngoài quy ước.*COMMIT AND CHAIN/],
    ["SAVEPOINT trong khối", 'BEGIN;\nSAVEPOINT s1;\nALTER TABLE "t" ADD COLUMN "c" int;\nCOMMIT;', /ngoài quy ước.*SAVEPOINT/],
    // Hàm trong đối số RAISE.
    ["RAISE gọi setval trước BEGIN", "DO $$ BEGIN RAISE NOTICE '%', setval('s', 1); END $$;\nBEGIN;\nALTER TABLE \"t\" ADD COLUMN \"c\" int;\nCOMMIT;", /chưa xác định là chỉ đọc nằm ngoài BEGIN/],
    ["RAISE … USING gọi nextval trước BEGIN", "DO $$ BEGIN RAISE EXCEPTION USING MESSAGE = nextval('s')::text; END $$;\nBEGIN;\nALTER TABLE \"t\" ADD COLUMN \"c\" int;\nCOMMIT;", /chưa xác định là chỉ đọc nằm ngoài BEGIN/],
    // Chữ không-ASCII trong thẻ dollar / định danh.
    ["$ă$ nuốt BEGIN: thật ra không có khối", "SELECT $ă$;\nBEGIN;\n$ă$;\nUPDATE \"t\" SET \"c\" = 1;\nUPDATE \"t\" SET \"d\" = 2;\nCOMMIT;", /thiếu BEGIN/],
    ["định danh ă$x$ không mở chuỗi giả che câu ghi", "SELECT 1 AS ă$x$;\nUPDATE \"t\" SET \"c\" = 9;\nSELECT 1 AS b$x$;\nBEGIN;\nALTER TABLE \"t\" ADD COLUMN \"c\" int;\nCOMMIT;", /chưa xác định là chỉ đọc nằm ngoài BEGIN.*UPDATE/],
    ['tên nháy có "" trùng đuôi hàm hệ thống trước BEGIN', 'SELECT "x""count"(1);\nBEGIN;\nALTER TABLE "t" ADD COLUMN "c" int;\nCOMMIT;', /chưa xác định là chỉ đọc nằm ngoài BEGIN/],
    // SET không LOCAL ở mọi vị trí.
    ["SET phiên trong khối", "BEGIN;\nSET lock_timeout = 0;\nALTER TABLE \"t\" ADD COLUMN \"c\" int;\nCOMMIT;", /SET không LOCAL/],
    ["SET phiên trước BEGIN", "SET search_path TO public;\nBEGIN;\nALTER TABLE \"t\" ADD COLUMN \"c\" int;\nCOMMIT;", /SET không LOCAL/],
    ["SET phiên một câu duy nhất", "SET search_path TO public;", /SET không LOCAL/],
    ["DO có SET phiên trước BEGIN", "DO $$ BEGIN SET search_path TO public; END $$;\nBEGIN;\nALTER TABLE \"t\" ADD COLUMN \"c\" int;\nCOMMIT;", /SET không LOCAL/],
    ["DO có SET phiên trong khối", "BEGIN;\nDO $$ BEGIN SET session_replication_role = replica; END $$;\nALTER TABLE \"t\" ADD COLUMN \"c\" int;\nCOMMIT;", /SET không LOCAL/],
    // Enum: tên có dấu cách, giá trị dùng qua chuỗi dollar.
    ["enum tên có dấu cách: thêm rồi dùng ngay", `BEGIN;\nALTER TYPE "Loai K" ADD VALUE 'X';\nUPDATE "t" SET "k" = 'X';\nCOMMIT;`, /giá trị enum mới 'X'/],
    ["enum: dùng giá trị qua $$X$$", `BEGIN;\nALTER TYPE "K" ADD VALUE 'X';\nUPDATE "t" SET "k" = $$X$$;\nCOMMIT;`, /giá trị enum mới 'X'/],
    ["enum: dùng giá trị qua $$X$$ lồng trong DO", `BEGIN;\nALTER TYPE "K" ADD VALUE 'X';\nDO $d$ BEGIN UPDATE t SET k = $$X$$; END $d$;\nCOMMIT;`, /giá trị enum mới 'X'/],
    ["enum: thêm bằng $v$…$v$ rồi dùng '…'", `BEGIN;\nALTER TYPE app."Loai K" ADD VALUE $v$X$v$;\nUPDATE "t" SET "k" = 'X';\nCOMMIT;`, /giá trị enum mới 'X'/],
    // set_config ở mọi vị trí, mọi dạng tên.
    ["set_config(…, false) trong khối", "BEGIN;\nSELECT set_config('lock_timeout', '0', false);\nALTER TABLE \"t\" ADD COLUMN \"c\" int;\nCOMMIT;", /set_config.*SET LOCAL/],
    ["set_config(…, true) trong khối", "BEGIN;\nSELECT set_config('lock_timeout', '15s', true);\nALTER TABLE \"t\" ADD COLUMN \"c\" int;\nCOMMIT;", /set_config.*SET LOCAL/],
    ["pg_catalog.set_config trước BEGIN", "SELECT pg_catalog.set_config('search_path', 'public', false);\nBEGIN;\nALTER TABLE \"t\" ADD COLUMN \"c\" int;\nCOMMIT;", /set_config.*SET LOCAL/],
    ["DO PERFORM set_config trong khối", "BEGIN;\nDO $$ BEGIN PERFORM set_config('search_path', 'public', false); END $$;\nALTER TABLE \"t\" ADD COLUMN \"c\" int;\nCOMMIT;", /set_config.*SET LOCAL/],
    ["set_config một câu duy nhất", "SELECT set_config('search_path', 'public', false);", /set_config.*SET LOCAL/],
  ])("%s", (_ten, sql, lyDo) => {
    const loi = kiemMigrationNguyenKhoi(sql);
    expect(loi.length, `không bắt được: ${sql}`).toBeGreaterThan(0);
    expect(loi.join(" | ")).toMatch(lyDo);
  });

  it("áp luật lên file cũ đã đo là để DB dở khi lỗi giữa chừng thì cổng bắt được (cổng không mù)", () => {
    expect(kiemMigrationNguyenKhoi(docSql("20261008094601_them_bang_no_phai_tra_va_rang_buoc")).join(" | ")).toMatch(/phải bọc BEGIN/);
    expect(kiemMigrationNguyenKhoi(docSql("20261015020100_lai_nhap_goc_thau_chi_va_rang_buoc")).join(" | ")).toMatch(/phải bọc BEGIN/);
    expect(kiemMigrationNguyenKhoi(docSql("20261008094600_them_loai_dong_tien_no_phai_tra")).join(" | ")).toMatch(/phải bọc BEGIN/);
  });

  it("hai migration viết tay đã bọc đúng (M1, landSeq) đạt luật — luật không chặn oan mẫu tốt", () => {
    expect(kiemMigrationNguyenKhoi(docSql("20260930170000_tai_khoan_phu_phan_quyen"))).toEqual([]);
    expect(kiemMigrationNguyenKhoi(docSql("20261106150000_raw_pancake_order_land_seq"))).toEqual([]);
  });
});
