#!/usr/bin/env bash
# Sinh lại 4 fixture dump cho cổng "dump đời trước phân quyền" (src/lib/backup/kiem-migration-trong-dump.ts):
#   truoc-m1.{dump,sql.gz}  — schema app áp mọi migration TRỪ M1 (20260930170000_tai_khoan_phu_phan_quyen)
#   sau-m1.{dump,sql.gz}    — cùng dữ liệu, áp tiếp M1 (M1 nhánh 1 user: nâng OWNER, copy epoch/shop)
#
# CHỈ dữ liệu TỔNG HỢP (1 user owner@fixture.test, 1 Setting sessionEpoch, 2 đơn id FX-…) trên DB
# dùng-một-lần — TUYỆT ĐỐI không dump từ DB thật. Sau khi sinh, script tự kiểm TOÀN VĂN 4 file
# (bung trọn ra SQL, không nối DB) rồi in SHA-256 để chép vào README + BINARY_MANIFEST.
#
# Postgres 15 là BẮT BUỘC (cả pg_dump lẫn server): container app/CI dùng postgresql-client-15 —
# dump do pg_dump mới hơn sinh ra thì pg_restore 15 không đọc được.
#
# Dùng (từ gốc repo):
#   FIXTURE_DB_URL=postgresql://USER:PASS@HOST:PORT/<ten>_fixture_test \
#   PG_BIN=/duong/dan/postgresql@15/bin  bash tests/fixtures/backup/sinh-fixture.sh [schema-khac]
#
# Đối số `schema-khac` CHỈ sinh 4 fixture "file không phải backup của app" cho cổng sớm của route
# phục hồi (KHÔNG đụng 4 fixture M1):
#   schema-khac.{dump,sql.gz}   — chỉ schema `khac` (có `_prisma_migrations` mang M1 hoàn tất)
#   nhieu-schema.{dump,sql.gz}  — schema `app` (chỉ `_prisma_migrations` mang M1 hoàn tất) + schema `khac`
set -euo pipefail

CHE_DO="${1:-m1}"
case "$CHE_DO" in m1|schema-khac) ;; *) echo "✗ Đối số không hợp lệ: $CHE_DO (m1 | schema-khac)" >&2; exit 1;; esac

cd "$(git rev-parse --show-toplevel)"

PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@15/bin}"
FIXTURE_DB_URL="${FIXTURE_DB_URL:-postgresql://hogikids:hogikids@localhost:55415/hogikids_fixture_test}"
OUT="tests/fixtures/backup"
M1="20260930170000_tai_khoan_phu_phan_quyen"

die() { echo "✗ $*" >&2; exit 1; }

# ── Cổng an toàn: script DROP schema app của DB đích ─────────────────────────────
case "$FIXTURE_DB_URL" in *\?*) die "FIXTURE_DB_URL không được kèm ?query (script tự thêm ?schema=app)";; esac
db_name="${FIXTURE_DB_URL##*/}"
[[ "$db_name" == *_fixture_test ]] || die "Từ chối: DB đích phải tận cùng _fixture_test (nhận: $db_name)"
[[ "$("$PG_BIN/pg_dump" --version)" =~ \)\ 15\. ]] || die "pg_dump ở $PG_BIN không phải bản 15"
[[ "$("$PG_BIN/pg_restore" --version)" =~ \)\ 15\. ]] || die "pg_restore ở $PG_BIN không phải bản 15"

psql15() { "$PG_BIN/psql" "$FIXTURE_DB_URL" -v ON_ERROR_STOP=1 -q -X "$@"; }
srv="$(psql15 -Atc 'SHOW server_version_num')"
[[ "$srv" == 15* ]] || die "Server Postgres đích không phải 15 (server_version_num=$srv)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# $1 = bo-m1 | du — chép migrations sang thư mục tạm rồi áp bằng một prisma.config.ts TẠM trỏ đúng
# thư mục đó. Prisma 7 đọc thư mục migrations từ file cấu hình (`prisma.config.ts` của repo trỏ CỨNG
# prisma/migrations) — chỉ đổi `--schema` là lặng lẽ áp bộ ĐẦY ĐỦ, fixture "trước M1" mang luôn M1.
# File tạm không import gì (nằm ngoài repo, không resolve được package).
ap_migrations() {
  local d="$TMP/$1"
  rm -rf "$d"; mkdir -p "$d"
  cp -R prisma/migrations "$d/migrations"
  if [ "$1" = "bo-m1" ]; then rm -rf "$d/migrations/$M1"; fi
  cp prisma/schema.prisma "$d/schema.prisma"
  cat >"$d/prisma.config.ts" <<EOF
export default {
  schema: "$d/schema.prisma",
  migrations: { path: "$d/migrations" },
  datasource: { url: process.env.DATABASE_URL ?? "" },
};
EOF
  DATABASE_URL="${FIXTURE_DB_URL}?schema=app" npx prisma migrate deploy --config "$d/prisma.config.ts" >"$TMP/migrate-$1.log" 2>&1 \
    || { cat "$TMP/migrate-$1.log" >&2; die "prisma migrate deploy ($1) thất bại"; }
}

# $1 = tên fixture — đúng hai định dạng backup: custom (như backup prod) và plain nén gzip.
# gzip -n: không ghi tên/mốc giờ file vào header.
dump() {
  "$PG_BIN/pg_dump" -Fc -n app -f "$OUT/$1.dump" "$FIXTURE_DB_URL"
  "$PG_BIN/pg_dump" -n app "$FIXTURE_DB_URL" | gzip -n -9 >"$OUT/$1.sql.gz"
}

if [ "$CHE_DO" = m1 ]; then
echo "▸ Dựng lại schema app trên $db_name…"
psql15 -c "SET client_min_messages = warning" -c "DROP SCHEMA IF EXISTS app CASCADE" -c "CREATE SCHEMA app"

echo "▸ Áp migrations trừ M1 + dữ liệu tổng hợp…"
ap_migrations bo-m1
psql15 <<'SQL'
INSERT INTO app."User" ("id", "email", "passwordHash", "shopName", "createdAt")
VALUES ('FX-user-owner', 'owner@fixture.test', 'FX-khong-phai-hash', 'Shop Fixture', '2026-09-01 08:00:00');
INSERT INTO app."Setting" ("key", "value") VALUES ('sessionEpoch', '1727000000000');
INSERT INTO app."Order" ("id", "pancakeId", "code", "channelId", "status", "orderedAt", "itemsTotal", "syncedAt")
VALUES
  ('FX-order-1', 'FX-don-1', 'FX-DON-1', 'direct', 'COMPLETED', '2026-09-01 10:00:00', 100000, '2026-09-01 10:05:00'),
  ('FX-order-2', 'FX-don-2', 'FX-DON-2', 'direct', 'CANCELLED', '2026-09-02 11:00:00', 50000, '2026-09-02 11:05:00');
SQL
dump truoc-m1

echo "▸ Áp M1…"
ap_migrations du
[ "$(psql15 -Atc "SELECT role FROM app.\"User\"")" = "OWNER" ] || die "M1 không nâng user fixture thành OWNER"
dump sau-m1
DS_FILE=(truoc-m1.dump sau-m1.dump truoc-m1.sql.gz sau-m1.sql.gz)
else
# File KHÔNG phải backup của app: dữ liệu tối thiểu, chỉ đủ để mỗi file đi đúng nhánh của cổng.
# `_prisma_migrations` mang M1 HOÀN TẤT ở cả hai schema ⇒ cổng M1 một mình KHÔNG chặn được
# `nhieu-schema` (có app._prisma_migrations đời mới) và nói sai nguyên nhân cho `schema-khac` —
# chỉ guard schema chạy TRƯỚC cổng M1 mới trả đúng câu.
echo "▸ Dựng schema app (chỉ _prisma_migrations) + schema khac trên $db_name…"
psql15 <<SQL
SET client_min_messages = warning;
DROP SCHEMA IF EXISTS app CASCADE;
DROP SCHEMA IF EXISTS khac CASCADE;
CREATE SCHEMA app;
CREATE SCHEMA khac;
CREATE TABLE app."_prisma_migrations" (
  "id" VARCHAR(36) PRIMARY KEY NOT NULL, "checksum" VARCHAR(64) NOT NULL, "finished_at" TIMESTAMPTZ,
  "migration_name" VARCHAR(255) NOT NULL, "logs" TEXT, "rolled_back_at" TIMESTAMPTZ,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(), "applied_steps_count" INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE khac."_prisma_migrations" (LIKE app."_prisma_migrations" INCLUDING ALL);
INSERT INTO app."_prisma_migrations" VALUES
  ('FX-mig-app', repeat('f', 64), '2026-09-30 17:00:01+00', '$M1', NULL, NULL, '2026-09-30 17:00:00+00', 1);
INSERT INTO khac."_prisma_migrations" VALUES
  ('FX-mig-khac', repeat('f', 64), '2026-09-30 17:00:01+00', '$M1', NULL, NULL, '2026-09-30 17:00:00+00', 1);
CREATE TABLE khac."GhiChu" ("id" INTEGER PRIMARY KEY, "noiDung" TEXT NOT NULL);
INSERT INTO khac."GhiChu" VALUES (1, 'FX-khong-phai-backup-cua-app');
SQL
"$PG_BIN/pg_dump" -Fc -n khac -f "$OUT/schema-khac.dump" "$FIXTURE_DB_URL"
"$PG_BIN/pg_dump" -n khac "$FIXTURE_DB_URL" | gzip -n -9 >"$OUT/schema-khac.sql.gz"
"$PG_BIN/pg_dump" -Fc -n app -n khac -f "$OUT/nhieu-schema.dump" "$FIXTURE_DB_URL"
"$PG_BIN/pg_dump" -n app -n khac "$FIXTURE_DB_URL" | gzip -n -9 >"$OUT/nhieu-schema.sql.gz"
# Trả DB fixture về như chế độ m1 để lại: không để schema lạ sót (chế độ m1 chỉ dọn schema app).
psql15 -c "SET client_min_messages = warning" -c "DROP SCHEMA khac CASCADE"
DS_FILE=(schema-khac.dump nhieu-schema.dump schema-khac.sql.gz nhieu-schema.sql.gz)
fi

# ── Kiểm TOÀN VĂN (bung trọn ra SQL, không nối DB) ────────────────────────────────
# grep: exit 1 (không khớp) là KẾT QUẢ hợp lệ, exit ≥2 là lỗi ⇒ dừng.
dem() {  # $1 regex · $2 file ⇒ in số dòng khớp
  local n
  n="$(grep -cE -- "$1" "$2")" || [ $? -eq 1 ] || die "grep lỗi trên $2"
  echo "$n"
}
echo "▸ Kiểm toàn văn ${#DS_FILE[@]} fixture…"
for f in "${DS_FILE[@]}"; do
  sql="$TMP/$f.sql"
  case "$f" in
    *.dump) "$PG_BIN/pg_restore" -f - "$OUT/$f" >"$sql" ;;
    *.sql.gz) gunzip -c "$OUT/$f" >"$sql" ;;
  esac
  emails="$(grep -oE -- '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+' "$sql" | sort -u)" || [ $? -eq 1 ] || die "grep lỗi"
  la="$(printf '%s\n' "$emails" | grep -vxF 'owner@fixture.test' | grep -v '^$')" || [ $? -eq 1 ] || die "grep lỗi"
  [ -z "$la" ] || die "$f: có chuỗi dạng email lạ: $la"
  # Checksum SHA-256 (64 hex) của `_prisma_migrations` là hàm của file migration public, và CÓ chuỗi
  # con 10 chữ số mở đầu bằng 0 khớp mẫu SĐT — gột riêng các token 64-hex trước khi đếm (đo 30/09: đúng 1
  # dòng dương tính giả, nằm ở checksum migration 20260714170000_rename_raw_tiktok_shop).
  sed -E 's/[0-9a-f]{64}/<sha256>/g' "$sql" >"$sql.khong-checksum"
  sdt="$(dem '(^|[^0-9])0[0-9]{9}([^0-9]|$)' "$sql.khong-checksum")"
  [ "$sdt" = "0" ] || die "$f: $sdt dòng có chuỗi dạng SĐT VN"
  shop="$(dem '714995134|1942992175|100975192' "$sql")"
  [ "$shop" = "0" ] || die "$f: có shop id thật"
  don_la="$(awk -F'\t' '/^COPY app\."Order" /{t=1;next} /^\\\.$/{t=0} t && $2 !~ /^FX-/' "$sql")"
  [ -z "$don_la" ] || die "$f: pancakeId không phải id giả FX-: $don_la"
  restrict="$(dem '^\\(un)?restrict ' "$sql")"
  echo "  ✓ $f: email chỉ owner@fixture.test · 0 SĐT · 0 shop id thật · pancakeId toàn FX- · dòng \\restrict/\\unrestrict: $restrict · $(wc -l <"$sql" | tr -d ' ') dòng"
done

echo "▸ SHA-256 (chép vào README.md + BINARY_MANIFEST của scripts/publish-public-snapshot.sh):"
for f in "${DS_FILE[@]}"; do
  shasum -a 256 "$OUT/$f"
done
