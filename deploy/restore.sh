#!/usr/bin/env bash
#
# restore.sh — phục hồi 1 SCHEMA của DB từ 1 bản dump, CHẠY TRÊN HOST minipc.
#
# Host KHÔNG có pg client → mọi thao tác Postgres đi qua `docker exec supabase-db`
# (client = server = v15, luôn khớp version). Đây là đường DR / file lớn (>~100MB)
# thay cho trang "Phục hồi từ file" trong app (giới hạn Cloudflare ~100MB — C7).
#
# ✱ SCHEMA-SCOPED — AN TOÀN TRÊN DB CHUNG ✱
#   App có thể dùng chung DB `postgres` của Supabase (các schema hệ thống auth/
#   storage/vault/realtime/graphql/extensions/...). Vì vậy restore CHỈ được đụng
#   ĐÚNG 1 schema đích, KHÔNG BAO GIỜ đè object hệ thống. Cụ thể:
#     • custom (.dump): kiểm TOC `pg_restore -l` — TỪ CHỐI nếu có object schema ≠
#       đích; nạp bằng `pg_restore -n <schema>` (backstop cứng: chỉ restore object
#       trong schema đích, bỏ qua phần còn lại của dump).
#     • plain (.sql.gz): TỪ CHỐI khi SQL có CREATE/DROP/ALTER SCHEMA ≠ đích, có
#       câu lệnh ghi/xoá nhắm schema hệ thống Supabase, có object schema-qualified
#       nhắm schema BẤT KỲ ≠ đích (đối xứng TOC guard — chặn dump `public` cũ), có
#       câu lệnh SET search_path HOẶC set_config('search_path', <khác rỗng>) (pg_dump
#       plain THẬT chỉ phát dạng chuỗi RỖNG — dấu hiệu file bị chỉnh sửa để né guard),
#       có chuỗi nháy trải nhiều dòng ngoài khối COPY (cách giấu mốc COPY giả để làm
#       guard mù), meta-command \connect, hoặc meta-command psql nào khác (\!, \copy,
#       \i, \o, \g… — psql THỰC THI chúng khi nạp file, không có cờ nào tắt được).
#       CHỈ allowlist đúng thứ pg_dump thật phát ra: dòng `\.` kết payload COPY và cặp
#       `\restrict`/`\unrestrict` của pg_dump ≥ 15.14. Dọn bằng
#       `DROP SCHEMA IF EXISTS <schema>` (KHÔNG hardcode `public`).
#   ✗ TUYỆT ĐỐI KHÔNG dùng `REASSIGN OWNED BY postgres` — trên DB chung nó trao
#     quyền sở hữu MỌI object hệ thống Supabase cho role app (không phải superuser)
#     → hỏng auth/storage/PostgREST. Hậu kỳ trả quyền CHỈ trong schema đích:
#     `ALTER SCHEMA <schema> OWNER TO hogikids` + đổi owner từng object (bảng/sequence/view/
#     ENUM/routine) + cấp lại 2 quyền đọc của role n8n (USAGE schema + SELECT bảng `Setting`).
#   ✱ Bước CUỐI thu hồi MỌI phiên đăng nhập (`deploy/thu-hoi-phien-sau-phuc-hoi.sql`) — không thì
#     cookie cấp trong đời bản dump sống lại. Dump đời trước phân quyền: in hướng dẫn migrate + chạy tay.
#
# ✱ LOẠI TRỪ PHIÊN ROLE APP suốt lúc thay schema (xem khối "LOẠI TRỪ PHIÊN ROLE APP" bên dưới) ✱
#   Khoá MUỘN (sau mọi guard file, sát trước DROP), mở SỚM (ngay sau hậu kỳ quyền, TRƯỚC bước thu hồi
#   phiên và lối thoát mã 3). Đích ≠ `postgres`: REVOKE CONNECT cấp DATABASE, trả lại ĐÚNG `datacl` đã
#   lưu. Đích = `postgres` (DB chung Supabase): app phải dừng sẵn + `ALTER ROLE hogikids NOLOGIN`.
#   Mọi lối thoát (lỗi, mã 3, Ctrl-C) đều mở lại; mở hỏng ⇒ in lệnh mở tay + giữ tệp đánh dấu
#   `~/docker/backups/.restore-dang-do` để lượt sau dừng ngay ở preflight.
#
# CHỈ nhận bản `pg_dump -Fc` STANDALONE 1-DB (custom .dump) hoặc plain `.sql.gz`.
# TỪ CHỐI `.tar.gz` backup-toàn-server (chặn TRƯỚC mọi thao tác DB — C1).
#
# Cách dùng (mặc định = DB chung sau consolidation: postgres/app):
#   bash deploy/restore.sh <dump>                 # db=postgres schema=app (mặc định)
#   bash deploy/restore.sh <dump> hogikids public # DB riêng cũ (grace, trước khi drop hogikids)
#   bash deploy/restore.sh <dump> [db] [schema]
#   (DB/SCHEMA cũng đọc được từ biến môi trường DB/SCHEMA nếu không truyền arg.)
#
# ✱ Mọi thao tác DB chạy bằng `supabase_admin` (superuser THẬT của Supabase self-host):
#   role `postgres` ở đây KHÔNG superuser + KHÔNG member `hogikids` → không DROP/CREATE
#   schema đích, không `ALTER OWNER TO hogikids` trên DB chung. Host DR chạy qua
#   docker exec (bối cảnh trusted) nên dùng superuser là đúng.
#
set -euo pipefail

DB_DEFAULT=postgres
SCHEMA_DEFAULT=app
# Container Postgres đích. Ghi đè bằng `CONTAINER_DB_DICH` CHỈ để diễn tập trên stack song song
# (`supabase-db-drill` — runbook DR): `main` chỉ nhận `supabase-db` hoặc `supabase-db-<hậu tố>`, và
# container app cần kiểm đã dừng đi theo ĐÚNG hậu tố đó (`hogikids-app-<hậu tố>`) — không có núm riêng
# nào để tắt phép kiểm app.
CONTAINER="${CONTAINER_DB_DICH:-supabase-db}"
OWNER_ROLE=hogikids

# Mã thoát RIÊNG cho ca "dữ liệu đã nạp nhưng quy trình CHƯA XONG": dump đời trước phân quyền (chưa có
# cột `User.sessionEpoch`) ⇒ còn phải `migrate deploy` + thu hồi phiên trước khi mở app. ≠ 0 để mọi
# khối `bash deploy/restore.sh … && docker compose up -d` tự dừng; khác 1 để §4.2 bắt đúng ca này
# (`|| [ $? -eq 3 ]`) mà không nuốt lỗi thật.
MA_THOAT_CHUA_XONG=3

# Hạn chờ (giây) của `LOCK TABLE … ACCESS EXCLUSIVE` trong cổng khoá việc nặng (xem
# `sql_cong_khoa_viec_nang`). Đây là lock CẤP POSTGRES — khác khoá logic ở giá trị cột `Setting.value`
# (TTL 5 phút do app tự quản). Nếu một phiên khác đang giữ BẤT KỲ lock nào trên bảng `Setting` (vd
# transaction dài đang UPDATE dòng khoá lúc gia hạn) thì không có `lock_timeout` ⇒ restore CHỜ VÔ HẠN
# — không rollback, không thông báo, người vận hành tưởng script treo. 30s đủ dài để không văng oan
# vì một UPDATE/gia hạn ngắn đang chạy song song, đủ ngắn để không giữ chân người chạy DR nhiều phút
# khi thật sự có phiên giữ khoá — hết hạn thì psql lỗi rõ ràng, rollback, schema còn nguyên (xem hint
# lỗi ở `drop_schema_dich`).
LOCK_TIMEOUT_CONG_KHOA_GIAY=30

# Role CHỈ-ĐỌC của n8n (đọc kho khoá `Setting`). Thay sạch schema + `pg_restore --no-privileges`
# xoá cả ACL, nên hậu kỳ phải cấp lại — nếu không, 10 workflow n8n chết ở node lấy khoá trong khi
# app vẫn đăng nhập bình thường (ingest/ads/webhook tắt câm, không có báo động).
N8N_RO_ROLE=n8n_config_ro

# VIEW mà role trên được SELECT — KHÔNG phải bảng `Setting` gốc (đổi 2026-08-21). Bản song sinh của
# `N8N_SETTING_VIEW` trong src/lib/n8n/role-doc-kho-khoa.ts.
N8N_SETTING_VIEW=SettingN8n

# Allowlist key n8n ĐƯỢC ĐỌC qua view trên — BẢN SONG SINH của `KEY_N8N_DUOC_DOC`
# (src/lib/n8n/role-doc-kho-khoa.ts). Test đọc chéo ép hai bên khớp tuyệt đối:
# tests/unit/backup/key-n8n-twin-shell-vs-ts.test.ts.
#
# VÌ SAO BẢN BASH PHẢI CÓ DANH SÁCH NÀY (đo 22/09/2026): ĐỊNH NGHĨA view nằm TRONG dump. Trước bản
# vá này, `restore.sh` chỉ `GRANT USAGE` + `GRANT SELECT` chứ KHÔNG dựng lại định nghĩa view
# (bản TS có, bản bash không) ⇒ phục hồi bằng đường DR
# một bản backup tạo TRƯỚC 21/09 sẽ đưa view về bản FAIL-OPEN cũ (`key NOT IN (…)`), phơi lại 43/45
# key cho role n8n — gồm cả kho token Meta/TikTok. Và im lặng tuyệt đối: ô cảnh báo ở /cai-dat chỉ
# đo QUYỀN, không bao giờ đọc ĐỊNH NGHĨA view. Đường DR là đúng đường dùng khi thảm hoạ thật.
KEY_N8N_DUOC_DOC="n8nAppUrl n8nIngestSecret n8nTokenVaultSecret pancakeApiKeyKho pancakeApiKeyShopee pancakeApiKeyTiktok pancakeShopIdKho pancakeShopIdShopee pancakeShopIdTiktok metaAdsAccountId metaAdsManualDays tiktokShopAppKey tiktokShopAppSecret tiktokShopCipher tiktokShopShopId tiktokShopManualDays tiktokShopAnalyticsManualDays tiktokShopAffiliateManualDays tiktokBusinessAppId tiktokBusinessAppSecret tiktokBusinessToken tiktokBusinessManualDays tiktokBusinessHoaDonTuNgay"

# Schema HỆ THỐNG Supabase self-host — đồng bộ với SUPABASE_SYSTEM_SCHEMAS trong
# src/lib/backup/assert-plain-sql-only-schema.ts (bản twin TS). Sửa một bên PHẢI sửa bên kia;
# tests/unit/backup/system-schemas-twin-shell-vs-ts.test.ts so hai DANH SÁCH, đỏ ngay khi lệch.
SYSTEM_SCHEMAS="auth storage vault realtime graphql extensions supabase_functions _realtime pgbouncer net cron pgsodium supabase_migrations"

# Script thu hồi mọi phiên chạy ở bước CUỐI (xem `thu_hoi_phien_sau_phuc_hoi`) — nằm CẠNH file này.
# Nạp chính file đó thay vì chép câu SQL vào đây: một nguồn duy nhất cho cả đường tự động lẫn đường
# chạy tay của runbook. `main()` kiểm file tồn tại TRƯỚC mọi thao tác DB.
THU_HOI_PHIEN_SQL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/thu-hoi-phien-sau-phuc-hoi.sql"

# ---------------------------------------------------------------------------
# GUARD 1 — TOC custom dump (đường .dump). Hàm THUẦN: đọc output `pg_restore -l`
# trên STDIN, arg1 = schema đích. Exit 0 nếu SẠCH, 1 nếu có object schema ≠ đích.
# Tách hàm để `source` file này rồi unit-test bằng fixture (xem cuối file: chỉ
# chạy main() khi EXECUTE trực tiếp).
#
# ⚠ BẪY parse `pg_restore -l`: cột DESC là ĐA TỪ (`TABLE DATA`, `SEQUENCE SET`,
# `SEQUENCE OWNED BY`, `MATERIALIZED VIEW DATA`…). Awk ngây thơ `$4=DESC $5=schema`
# đọc nhầm "DATA"/"SET"/"OWNED" thành schema → TỪ CHỐI MỌI dump hợp lệ (đúng lỗi
# vừa sửa ở guard TS). Ở đây khớp TIỀN TỐ DESC dài-nhất-trước (p3→p2→p1) nên token
# KẾ TIẾP mới là namespace. `-n <schema>` của pg_restore vẫn là backstop cứng, nên
# guard này là phòng-thủ-lớp: over-reject dump hợp lệ nguy hiểm hơn (tập thói quen
# tắt guard) ⇒ DESC lạ → BỎ QUA, chỉ TỪ CHỐI khi namespace/tên-schema RÕ RÀNG ≠ đích.
# ---------------------------------------------------------------------------
assert_toc_only_schema() {
  local schema=$1
  awk -v s="$schema" '
    # Trả về CHỈ SỐ trường của namespace theo độ dài DESC (p3=7, p2=6, p1=5); 0 nếu
    # DESC không nhận diện được (→ bỏ qua dòng đó).
    function nsfor(   p3, p2) {
      p3 = $4 " " $5 " " $6; if (p3 in D) return 7
      p2 = $4 " " $5;        if (p2 in D) return 6
      if ($4 in D) return 5
      return 0
    }
    BEGIN {
      # DESC pg_dump/pg_restore — khớp tiền tố DÀI NHẤT trước. Không cần vét cạn:
      # DESC lạ (không khớp) sẽ bỏ qua chứ không từ chối.
      # `TABLE ATTACH`/`INDEX ATTACH` (bảng partition): thiếu thì khớp `TABLE`/`INDEX` 1 từ và đọc chữ
      # ATTACH thành namespace ⇒ từ chối OAN dump hợp lệ (DR lượt 3, 25/09). Bản TS song sinh cũng có.
      n = split("TABLE DATA|TABLE ATTACH|INDEX ATTACH|SEQUENCE SET|SEQUENCE OWNED BY|MATERIALIZED VIEW DATA|MATERIALIZED VIEW|FK CONSTRAINT|CHECK CONSTRAINT|DEFAULT ACL|EVENT TRIGGER|ROW SECURITY|PUBLICATION TABLE|FOREIGN TABLE|OPERATOR CLASS|OPERATOR FAMILY|ACCESS METHOD|SHELL TYPE|USER MAPPING|DATABASE PROPERTIES|LARGE OBJECT|PROCEDURAL LANGUAGE|FOREIGN DATA WRAPPER|TEXT SEARCH CONFIGURATION|TEXT SEARCH DICTIONARY|TEXT SEARCH PARSER|TEXT SEARCH TEMPLATE|TABLE|SEQUENCE|VIEW|INDEX|CONSTRAINT|DEFAULT|ACL|TRIGGER|FUNCTION|PROCEDURE|AGGREGATE|TYPE|DOMAIN|SCHEMA|EXTENSION|COMMENT|POLICY|RULE|STATISTICS|ENCODING|STDSTRINGS|SEARCHPATH|DATABASE|COLLATION|CONVERSION|OPERATOR|CAST|TRANSFORM|SERVER|BLOB|BLOBS|PUBLICATION", a, "|")
      for (i = 1; i <= n; i++) D[a[i]] = 1
    }
    # Dòng object TOC: "<id>; <tableoid> <oid> <DESC…> <namespace> <tag…> <owner>".
    # Dòng comment/header bắt đầu bằng ";" (không có số) nên $1 không khớp → bỏ qua.
    $1 ~ /^[0-9]+;$/ {
      ni = nsfor()
      if (ni == 0) next
      if ($4 == "SCHEMA") {
        # "SCHEMA - <tên> <owner>": object SCHEMA không thuộc namespace nào ($5="-"),
        # tên schema đang tạo nằm ở cột tag ($6).
        created = ($5 == "-") ? $6 : $5
        if (created != "" && created != s && !(created in seen)) {
          seen[created] = 1; bad = 1; badlist = badlist sep created; sep = ", "
        }
        next
      }
      ns = $(ni)
      if (ns == "" || ns == "-" || ns == "pg_catalog") next
      if (ns != s && !(ns in seen)) {
        seen[ns] = 1; bad = 1; badlist = badlist sep ns; sep = ", "
      }
    }
    END { if (bad) print "  Schema ngoài đích: " badlist; exit bad ? 1 : 0 }
  '
}

# ---------------------------------------------------------------------------
# GUARD 2 — SQL plain (đường .sql.gz). arg1 = schema đích, arg2 = đường dẫn file
# SQL đã gunzip. Đường plain KHÔNG có `-n <schema>` backstop nên guard phải MẠNH.
# Grep chạy trên FILE (không phải pipe) → tránh bẫy pipefail/SIGPIPE khi grep -q
# đóng pipe sớm. Exit 1 (in lý do ra stderr) khi vi phạm.
#
# GIỚI HẠN ĐÃ BIẾT: check (b) chỉ bắt câu lệnh có qualifier `<schema_hệ_thống>.` rõ
# ràng. Nếu dump chèn `SET search_path = auth;` rồi ghi UNQUALIFIED (không `auth.`),
# check (b) sẽ bỏ lọt. Vá bằng check (d): TỪ CHỐI thẳng mọi `SET search_path` — vì
# `pg_dump` plain THẬT KHÔNG BAO GIỜ phát ra câu này (dùng
# `pg_catalog.set_config('search_path', '', false)`), nên sự xuất hiện của nó là
# bất thường, đáng ngờ đủ để fail-closed.
#
# Check (f) vá NỐT dạng HÀM của cùng lỗ hổng đó: `set_config('search_path','auth',false)`
# không phải CÂU LỆNH `SET` nên (d) không thấy, chuỗi 'auth' nằm trong nháy nên (b) không
# thấy, `SELECT` không phải verb ghi nên (e) không thấy — chỉ dạng chuỗi RỖNG được qua.
#
# Check (e) làm guard ĐỐI XỨNG với TOC guard: bắt object schema-qualified nhắm schema
# BẤT KỲ ≠ đích (gồm cả `public` — thứ (b) bỏ qua vì không phải hệ thống). awk soi theo
# DÒNG và fail-closed. Kẽ hở "nhiều câu trên MỘT dòng" / "verb và qualifier tách dòng" đã
# được normalize_sql_statements dựng lại thành mỗi-câu-một-dòng; chuỗi ĐA DÒNG ngoài khối
# COPY thì bị TỪ CHỐI thẳng thay vì soi lệch (xem normalize_sql_statements).
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Chuẩn hoá SQL plain → MỖI CÂU MỘT DÒNG cho guard (b)/(e)/(f)/(g).
#   arg1 = file SQL; arg2 = 1 (mặc định) che chuỗi nháy đơn, 0 = GIỮ NGUYÊN literal;
#   arg3 = 1 để BỎ thân dollar-quote (mặc định 0 = giữ).
#   In ra STDOUT. Trả về 2 khi phát hiện chuỗi nháy trải nhiều dòng (xem dưới).
#
#   • Bỏ `\r` cuối dòng TRƯỚC mọi bước khác: awk KHÔNG coi `\r` là hết dòng, nên với file CRLF hai
#     mốc `…FROM STDIN;$` và `^\.$` đều không khớp ⇒ payload COPY KHÔNG bị bỏ, dòng data (`\N`,
#     `auth.` trong prose) lọt vào guard và bị từ chối OAN. Chỉ bỏ 1 ký tự cuối dòng, không nới guard.
#   • Bỏ payload của khối `COPY … FROM stdin;` (data tab-phân-tách chứa `.`/`;`/từ giống verb).
#   • Bỏ hai dòng `\restrict <token>` / `\unrestrict <token>` mà pg_dump ≥15.14 luôn phát (bản vá
#     bảo mật 08/2025). Chúng là dòng LÀM TĂNG an toàn, không phải tấn công — xem guard (g).
#   • Che chuỗi nháy đơn `'…'` → `''` khi arg2=1 (dữ liệu không bị soi nhầm là câu lệnh).
#   • Gộp các dòng vật lý rồi TÁCH LẠI theo `;` → mỗi câu SQL nằm trên đúng một dòng, verb
#     luôn ở đầu câu. Vá kẽ hở guard neo-đầu-dòng cũ (nhiều câu/dòng + verb-qualifier tách dòng).
#
# ⚠ PHẢI LEX THEO TRẠNG THÁI, KHÔNG cắt comment / dò mốc COPY bằng regex thuần:
#   • `sub(/--.*$/, "")` ngây thơ cắt luôn phần thân dollar-quote: dòng `SELECT $$--$$; TRUNCATE
#     auth.users;` bị cắt từ `--` ⇒ câu TRUNCATE BIẾN MẤT khỏi bản soi, trong khi psql coi `$$--$$`
#     là chuỗi nên VẪN THỰC THI. Vì vậy chỉ cắt `--` khi đang ở TRẠNG THÁI GỐC.
#   • Mốc `COPY … FROM stdin;` GIẢ đặt bên trong chuỗi/thân dollar-quote đa dòng sẽ mở chế độ
#     bỏ-payload tới `\.`, xoá cả vùng đó khỏi bản soi ⇒ guard (b)/(e)/(g) mù. Chỉ vào chế độ COPY
#     khi đang ở TRẠNG THÁI GỐC.
#   • Chuỗi nháy đơn/kép trải nhiều dòng ⇒ TỪ CHỐI (exit 2) — đó chính là cách giấu mốc COPY giả,
#     fail-closed như đã làm với SET search_path. GIỚI HẠN ĐÃ BIẾT: pg_dump CÓ phát chuỗi đa dòng
#     nếu DB có literal chứa xuống dòng ngoài COPY (thực tế chỉ ở `COMMENT ON … IS '…\n…'`); repo
#     này không sinh dạng đó (đã đối chiếu dump plain THẬT của prod 31/07). Gặp từ-chối-oan thì
#     nạp bản `.dump` custom (có `pg_restore -n` chốt cứng), KHÔNG nới guard.
#   • Khối COPY KHÔNG có dòng `\.` kết ⇒ trả lại nguyên văn payload (fail-closed), không để lệnh
#     giấu sau một khối COPY dở dang lọt khỏi bản soi.
#   ⚠️ LỐI THOÁT ĐỔI TỪ 22/09/2026: câu "gặp từ-chối-oan thì nạp bản `.dump` custom" KHÔNG CÒN ĐÚNG
#     — nhánh custom nay cũng chạy chính hàm này. Lối thoát bây giờ là `BO_QUA_KIEM_NOI_DUNG_DUMP=1`
#     cho nhánh custom (in cảnh báo, giữ guard TOC + `pg_restore -n`); xem khối gọi trong `main`.
# ---------------------------------------------------------------------------
normalize_sql_statements() {
  awk -v mask="${2:-1}" -v nodollar="${3:-0}" '
    BEGIN { sq = sprintf("%c", 39); dq = sprintf("%c", 34); dtag = ""; blockdepth = 0 }

    # Lex MOT dong: cap nhat trang thai vat-qua-dong (than dollar-quote, comment khoi long nhau),
    # BO comment, GIU nguyen chuoi. Dat multiline=1 khi chuoi nhay chua dong luc het dong.
    function lexline(line,   i, n, c, c2, out, seg, closed, dl) {
      out = ""; i = 1; n = length(line)
      while (i <= n) {
        if (blockdepth > 0) {                      # dang trong comment khoi (long nhau duoc)
          c2 = substr(line, i, 2)
          if (c2 == "/*") { blockdepth++; i += 2 }
          else if (c2 == "*/") { blockdepth--; i += 2; out = out " " }
          else i++
          continue
        }
        if (dtag != "") {                          # dang trong than dollar-quote
          dl = length(dtag)
          if (substr(line, i, dl) == dtag) { if (!nodollar) out = out dtag; dtag = ""; i += dl }
          else { if (!nodollar) out = out substr(line, i, 1); i++ }
          continue
        }
        c = substr(line, i, 1); c2 = substr(line, i, 2)
        if (c2 == "--") return out                 # comment dong -> bo phan con lai
        if (c2 == "/*") { blockdepth = 1; i += 2; continue }
        if (c == sq || c == dq) {                  # chuoi / dinh danh nhay
          seg = c; i++; closed = 0
          while (i <= n) {
            if (substr(line, i, 1) == c) {
              if (substr(line, i + 1, 1) == c) { seg = seg c c; i += 2; continue }
              seg = seg c; i++; closed = 1; break
            }
            seg = seg substr(line, i, 1); i++
          }
          if (!closed) { multiline = 1; return out seg }
          out = out seg
          continue
        }
        # Tag dollar-quote HOP LE: rong hoac dinh danh KHONG bat dau bang chu so (do that PG 15.8:
        # "SELECT $0$abc$0$" -> unterminated dollar-quoted string). Noi long se xoa nham vung that.
        if (c == "$" && match(substr(line, i), /^\$([A-Za-z_][A-Za-z_0-9]*)?\$/)) {
          dtag = substr(line, i, RLENGTH); if (!nodollar) out = out dtag; i += RLENGTH
          continue
        }
        out = out c; i++
      }
      return out
    }

    { sub(/\r$/, "", $0) }                        # bo CR: moc STDIN;$ / \.$ khong khop \r (file CRLF)

    incopy {                                       # trong khoi COPY: gom payload cho toi moc "\."
      if ($0 ~ /^\\\.[ \t]*$/) { incopy = 0; ncopy = 0; delete copybuf }
      else copybuf[++ncopy] = $0
      next
    }
    {
      line = $0
      if (line ~ /^\\(un)?restrict [A-Za-z0-9_]+$/) next   # dong hop le cua pg_dump >= 15.14
      if (dtag == "" && blockdepth == 0 && toupper(line) ~ /^COPY[ \t].*[ \t]FROM[ \t]+STDIN;[ \t]*$/) {
        buf = buf " " line                         # GIU dong lenh COPY cho guard (e) soi schema
        incopy = 1; ncopy = 0
        next
      }
      line = lexline(line)
      if (multiline) exit 2
      if (mask) gsub(sq "[^" sq "]*" sq, sq sq, line)
      buf = buf " " line
    }
    END {
      if (multiline) exit 2
      for (i = 1; i <= ncopy; i++) buf = buf " " copybuf[i]   # COPY thieu "\." -> fail-closed
      n = split(buf, st, ";")
      for (i = 1; i <= n; i++) { s = st[i]; sub(/^[ \t]+/, "", s); if (s != "") print s }
    }
  ' "$1"
}

assert_sql_only_schema() {
  local schema=$1 sqlfile=$2 sys verb_re sys_re pat schema_ddl foreign norm normf dac_quyen

  # (a) CREATE/DROP/ALTER SCHEMA nhắm tên ≠ $schema → nghi dump full-DB / đè schema
  # hệ thống. Bắt các dòng schema-DDL trước (thường rất ít), rồi loại các dòng nhắm
  # ĐÚNG $schema; còn sót dòng nào → từ chối. (Grep KHÔNG neo dòng nên bắt cả câu sau `;`.)
  schema_ddl=$(grep -iE '(^|[^[:alnum:]_])(CREATE|DROP|ALTER)[[:space:]]+SCHEMA([^[:alnum:]_]|$)' "$sqlfile" || true)
  if [[ -n "$schema_ddl" ]]; then
    foreign=$(printf '%s\n' "$schema_ddl" | grep -ivE "(CREATE|DROP|ALTER)[[:space:]]+SCHEMA[[:space:]]+(IF[[:space:]]+(NOT[[:space:]]+)?EXISTS[[:space:]]+)?\"?${schema}\"?([^[:alnum:]_]|$)" || true)
    if [[ -n "$foreign" ]]; then
      echo "Lỗi: SQL chứa CREATE/DROP/ALTER SCHEMA khác '$schema' — TỪ CHỐI (nghi dump full-DB)." >&2
      return 1
    fi
  fi

  # CHUẨN HOÁ trước guard (b)/(e)/(f)/(g): tách MỖI câu SQL ra MỘT dòng (bỏ payload COPY, bỏ
  # comment). Nhờ đó verb luôn nằm đầu câu bất kể dump gốc nhồi nhiều câu trên một dòng
  # (`SELECT 1; DROP other.x;`) hay tách verb/qualifier xuống dòng (`TRUNCATE\n auth.users`)
  # — cả hai đều là kẽ hở của guard neo-đầu-dòng cũ. Đồng bộ ngữ nghĩa với twin TS (neo đầu CÂU).
  #
  # HAI bản: `$norm` CHE chuỗi nháy đơn (dữ liệu không bị soi nhầm là câu lệnh) cho (b)/(e)/(g);
  # `$normf` GIỮ NGUYÊN literal cho (f) — che nháy sẽ biến cả `set_config('search_path','auth',…)`
  # lẫn dạng hợp lệ `set_config('search_path','',…)` thành cùng một chuỗi, mất sạch tín hiệu.
  # Khuôn mktemp phải KẾT THÚC bằng các chữ X, KHÔNG có đuôi `.sql` phía sau. Đo 22/09/2026 trên
  # macOS (BSD mktemp): khuôn `tên.XXXXXX.sql` trả về TÊN LITERAL `tên.XXXXXX.sql`, và lần gọi thứ
  # hai chết `mkstemp failed: File exists` ⇒ hai lượt chạy song song (vitest chạy nhiều file test
  # cùng lúc, mỗi file `source` script này) giẫm lên nhau, và một file sót lại làm hỏng mọi lượt
  # sau. GNU mktemp (minipc/CI) chịu được khuôn đó nên lỗi này CHỈ hiện ở máy dev — đúng loại lệch
  # môi trường mà bản song sinh bash phải tránh.
  norm=$(mktemp "${TMPDIR:-/tmp}/hogikids-norm-XXXXXX")
  normf=$(mktemp "${TMPDIR:-/tmp}/hogikids-normf-XXXXXX")
  # Trap TỰ GỠ và đọc biến có giá trị mặc định. Bash giữ trap RETURN sau khi hàm này trả về, nên nó
  # còn bắn thêm một lần nữa lúc `main` return — khi đó `norm`/`normf` đã ra khỏi tầm và `set -u`
  # biến nó thành `unbound variable`, làm script kết thúc bằng lỗi NGAY SAU dòng "✓ Phục hồi xong".
  # Đo thật trong DR diễn tập 23/09: lỗi này chỉ lộ khi có hàm KHÁC trả về sau đó, nên trước 22/09
  # nó nằm im (nhánh custom chưa gọi hàm này) và không test nào chạm tới.
  trap 'rm -f "${norm:-}" "${normf:-}"; trap - RETURN' RETURN
  # exit 2 = chuỗi nháy trải nhiều dòng ngoài khối COPY (xem normalize_sql_statements).
  if ! normalize_sql_statements "$sqlfile" 1 > "$norm"; then
    echo "Lỗi: SQL có chuỗi nháy TRẢI QUA XUỐNG DÒNG ngoài khối COPY — pg_dump plain THẬT không phát ra dạng này — TỪ CHỐI (chuỗi đa dòng che được mốc COPY giả, làm guard mù cả một vùng file)." >&2
    return 1
  fi
  # `$normf` còn BỎ thân dollar-quote (đối xứng `stripDollarQuoted` của twin TS): set_config nằm
  # trong thân function chỉ chạy khi GỌI hàm, KHÔNG chạy lúc restore ⇒ không phải vector, chặn nó
  # là từ-chối-oan. (Bản `$norm` cho (b)/(e)/(g) thì GIỮ thân dollar-quote — cố ý chặt hơn.)
  normalize_sql_statements "$sqlfile" 0 1 > "$normf"

  # (b) Câu lệnh GHI/XOÁ nhắm schema HỆ THỐNG Supabase (vd `TRUNCATE storage.objects`,
  # `DELETE FROM vault.secrets`). Soi bản CHUẨN HOÁ (payload COPY đã bỏ, chuỗi nháy đã che)
  # nên `auth.` trong dữ liệu không gây false-positive; câu tách dòng vẫn bắt được.
  verb_re='DROP|CREATE|ALTER|TRUNCATE|DELETE[[:space:]]+FROM|INSERT[[:space:]]+INTO|UPDATE|COPY|GRANT|REVOKE|COMMENT[[:space:]]+ON|LOCK|REINDEX|REFRESH|CLUSTER'
  for sys in $SYSTEM_SCHEMAS; do
    [[ "$sys" == "$schema" ]] && continue
    pat="(^|[^[:alnum:]_])(${verb_re})[^;'\"]*[^[:alnum:]_]${sys}\\."
    if grep -iEq "$pat" "$norm"; then
      echo "Lỗi: SQL thao tác trên schema hệ thống Supabase '$sys' — TỪ CHỐI." >&2
      return 1
    fi
  done

  # (c) Meta-command \connect / \c — chuyển sang DB khác. Các meta-command còn lại do (g) chặn.
  if grep -iEq '^[[:space:]]*\\c(onnect)?([[:space:]]|$)' "$sqlfile"; then
    echo "Lỗi: SQL chứa meta-command \\connect — TỪ CHỐI (có thể chuyển sang DB khác)." >&2
    return 1
  fi

  # (d) `SET search_path` — vá lỗ hổng của check (b): (b) chỉ bắt câu lệnh có qualifier
  # `<schema>.` rõ ràng, nên dump chèn `SET search_path = auth;` rồi ghi UNQUALIFIED sẽ
  # lọt qua (b). `pg_dump` plain THẬT KHÔNG BAO GIỜ phát ra `SET search_path` (dùng
  # `pg_catalog.set_config('search_path', '', false)`) → bất kỳ `SET search_path` nào
  # cũng là BẤT THƯỜNG, TỪ CHỐI thẳng (fail-closed).
  # Soi bản CHUẨN HOÁ (mỗi câu một dòng, comment đã bỏ) chứ KHÔNG soi file thô: soi thô thì
  # `SET/* x */search_path = auth;` né được guard (chèn comment giữa token), đúng cùng loại
  # bypass mà check (f) phải chặn — vá (f) mà bỏ ngỏ (d) thì kẻ tấn công chỉ việc đổi dạng.
  # Soi $norm cũng hết từ-chối-oan khi dòng DỮ LIỆU trong payload COPY mở đầu bằng chữ
  # "SET search_path" (payload đã được bỏ).
  pat='(^|;)[[:space:]]*SET[[:space:]]+((SESSION|LOCAL)[[:space:]]+)?search_path([^[:alnum:]_]|$)'
  if grep -iEq "$pat" "$norm"; then
    echo "Lỗi: SQL chứa câu lệnh SET search_path — TỪ CHỐI (pg_dump plain THẬT dùng set_config, không bao giờ phát ra SET search_path; nghi file bị chỉnh sửa để né guard)." >&2
    return 1
  fi

  # (e) ĐỐI XỨNG với assert_toc_only_schema: TỪ CHỐI câu ghi object schema-qualified nhắm
  # schema ≠ $schema (KHÔNG chỉ schema hệ thống ở (b)). Chặn dump plain tiền-migration của
  # DB `public` cũ (vd `CREATE TABLE public."Order" …`) mà (a)+(b) đều bỏ lọt (không có
  # CREATE SCHEMA, public không phải hệ thống — H3). awk soi theo DÒNG (pg_dump phát 1 câu/
  # dòng): bỏ payload COPY, cắt dòng ở nháy ĐẦU TIÊN (qualifier object luôn đứng trước mọi
  # chuỗi/định danh nháy), rồi lấy qualifier `schema.` đầu tiên. Fail-closed: dòng nghi ngờ
  # bị chặn — an toàn hơn cho đường plain vốn không có `-n` backstop.
  local foreign_ns
  foreign_ns=$(awk -v s="$schema" '
    BEGIN {
      sq = sprintf("%c", 39)   # nhay don
      dq = sprintf("%c", 34)   # nhay kep
      vre = "^[ \t]*(CREATE|ALTER|DROP|TRUNCATE|INSERT|UPDATE|DELETE|COPY|GRANT|REVOKE|COMMENT|LOCK)[ \t]"
      allow["pg_catalog"] = 1
      allow["information_schema"] = 1
    }
    # Bo payload cua khoi COPY ... FROM stdin (du lieu tab-phan-tach, ket thuc bang dong "\.").
    incopy && $0 ~ /^\\\.[ \t]*$/ { incopy = 0; next }
    incopy { next }
    {
      line = $0
      up = toupper(line)
      if (up ~ vre) {
        # Cat dong o nhay DAU TIEN: qualifier object luon dung truoc moi chuoi/dinh danh nhay.
        p1 = index(line, sq); p2 = index(line, dq)
        cut = 0
        if (p1 > 0) cut = p1
        if (p2 > 0 && (cut == 0 || p2 < cut)) cut = p2
        head = (cut > 0) ? substr(line, 1, cut - 1) : line
        if (match(head, /[A-Za-z_][A-Za-z0-9_]*\./)) {
          ns = substr(head, RSTART, RLENGTH - 1)
          if (ns != s && !(ns in allow)) { print ns; exit 1 }
        }
      }
      # Vao che do bo-payload SAU khi da kiem tra chinh dong lenh COPY.
      if (up ~ /^[ \t]*COPY[ \t].*[ \t]FROM[ \t]+STDIN;[ \t]*$/) incopy = 1
    }
  ' "$norm") || {
    echo "Lỗi: SQL thao tác object schema '$foreign_ns' ≠ '$schema' — TỪ CHỐI (nghi dump full-DB / schema ngoài đích)." >&2
    return 1
  }

  # (f) `set_config('search_path', <khác rỗng>, …)` — DẠNG HÀM của (d), đối xứng twin TS. Guard (d)
  # chỉ bắt CÂU LỆNH `SET search_path`; file .sql.gz chỉnh tay dùng
  # `SELECT set_config('search_path','auth',false);` rồi ghi UNQUALIFIED sẽ né được cả (b) (chuỗi
  # 'auth' nằm trong nháy nên không phải qualifier) lẫn (e) (SELECT không phải verb ghi) — rồi chạy
  # bằng `psql -U supabase_admin` trên DB CHUNG. `pg_dump` plain THẬT chỉ phát ra dạng chuỗi RỖNG
  # `set_config('search_path', '', false)` (ép mọi object phải qualified) ⇒ CHỈ chấp nhận dạng đó.
  # Soi `$normf` (literal còn nguyên, comment đã bỏ) và lấy tới đối số thứ 2; occurrence nào không
  # phải `''` → từ chối. `|| true`: grep trả 1 khi không khớp, pipefail sẽ giết script oan.
  local set_config_bad
  set_config_bad=$(grep -oiE "set_config[[:space:]]*\([[:space:]]*'search_path'[[:space:]]*,[^,)]*" "$normf" \
    | grep -vE ",[[:space:]]*''[[:space:]]*$" || true)
  if [[ -n "$set_config_bad" ]]; then
    echo "Lỗi: SQL chứa set_config('search_path', …) với giá trị KHÁC chuỗi rỗng — pg_dump plain THẬT chỉ dùng set_config('search_path', '', false) — TỪ CHỐI (nghi file bị chỉnh sửa để né guard schema hệ thống)." >&2
    return 1
  fi

  # (g) Meta-command psql CÒN LẠI — đối xứng guard (g) của twin TS. `psql < file` THỰC THI mọi lệnh
  # `\…`: `\!` chạy shell TRONG container DB, `\copy … TO PROGRAM 'cmd'` cũng vậy, `\i` nạp thêm
  # file, `\o|sh` / `\g|sh` đổ output vào shell. Check (c) chỉ bắt \connect/\c.
  # Soi bản CHUẨN HOÁ ($norm), TUYỆT ĐỐI KHÔNG soi file thô: trong payload COPY, `\N` (NULL) và
  # `\\` là DỮ LIỆU ⇒ soi thô sẽ từ chối oan MỌI dump thật. normalize_sql_statements đã bỏ cả
  # payload COPY LẪN dòng `\.` (nó `next` ở mốc kết), đã bỏ hai dòng `\restrict`/`\unrestrict` của
  # pg_dump ≥15.14, đã che chuỗi nháy đơn và bỏ comment — nên trong $norm KHÔNG còn `\` hợp lệ nào:
  # còn `\` = TỪ CHỐI.
  # BẤT ĐỐI XỨNG ĐÃ CHẤP NHẬN: $norm GIỮ thân dollar-quote (`$$…$$`), twin TS thì bỏ. Dump có `\`
  # trong thân function (ngoài nháy đơn, ngoài comment) sẽ bị đường CLI từ chối oan trong khi app
  # vẫn nhận. Giữ thân dollar-quote làm check (b) MẠNH hơn (bắt được `DO $$ … DELETE FROM auth.users
  # … $$`), và đường plain là đường DUY NHẤT không có `-n <schema>` backstop nên đổi rủi ro
  # "oan, THẤY ĐƯỢC" lấy "lọt, IM LẶNG" là sai hướng. Lật quyết định khi repo có thân function chứa
  # `\` ngoài nháy đơn; lối thoát trước mắt là nạp bản `.dump` custom (đường vận hành thật).
  local meta
  # `|| true`: grep trả 1 khi không khớp, và `| head -1` có thể làm grep nhận SIGPIPE (141) —
  # `set -o pipefail` sẽ giết script oan.
  meta=$(grep -n '\\' "$norm" | head -1 || true)
  if [[ -n "$meta" ]]; then
    echo "Lỗi: SQL chứa meta-command psql ($meta) — psql thực thi lệnh \\… khi nạp file và KHÔNG tắt được; pg_dump plain THẬT chỉ phát ra dòng \\. kết thúc COPY — TỪ CHỐI." >&2
    return 1
  fi

  # (i) `COPY … FROM PROGRAM 'cmd'` / `COPY … TO PROGRAM 'cmd'` — đối xứng guard (i) của twin TS.
  # Đường CHẠY LỆNH ở TẦNG SQL: check (g) chỉ bắt META-COMMAND (`\copy … TO PROGRAM`, có dấu `\`),
  # còn dạng SQL thuần không có `\` nào nên lọt sạch. Ở đường này nó NẶNG HƠN bản app: câu lệnh
  # chạy bằng `-U supabase_admin` (superuser THẬT), mà `COPY … PROGRAM` đòi đúng quyền đó.
  # Neo vào FROM|TO (không cấm mọi chữ "PROGRAM"): cú pháp PostgreSQL chỉ đặt từ khoá này ngay sau
  # FROM/TO của câu COPY ⇒ không bỏ lọt, mà dump hợp lệ của DB có cột tên `program` không bị oan.
  # POSIX class, KHÔNG dùng `\b`: `\b` là mở rộng GNU, BSD grep (macOS — nơi restore-sh-guard.test.ts
  # chạy) hành xử khác ⇒ đúng lớp lệch song sinh mà file này phải tránh.
  if grep -iEq '(^|[^[:alnum:]_])(FROM|TO)[[:space:]]+PROGRAM([^[:alnum:]_]|$)' "$norm"; then
    echo "Lỗi: SQL chứa COPY … FROM/TO PROGRAM — đây là đường CHẠY LỆNH trên máy chủ; pg_dump plain THẬT chỉ dùng COPY … FROM stdin — TỪ CHỐI (nghi file bị chỉnh sửa)." >&2
    return 1
  fi

  # (j) Câu lệnh ĐẶC QUYỀN — đối xứng guard (j) của twin TS. Dump schema-scoped (`pg_dump -n`)
  # không sinh ra chúng; chúng chỉ có trong dump full-DB hoặc file chế tác. Lớp BỔ SUNG cho
  # (a)/(b)/(e), không phải lớp duy nhất.
  # `CREATE … LANGUAGE` neo `CREATE` liền trước để KHÔNG bắt nhầm mệnh đề `LANGUAGE plpgsql` cuối
  # mọi `CREATE FUNCTION`.
  dac_quyen='(^|[^[:alnum:]_])(CREATE[[:space:]]+EXTENSION|(CREATE|ALTER|DROP)[[:space:]]+(ROLE|USER)|ALTER[[:space:]]+SYSTEM|CREATE[[:space:]]+(OR[[:space:]]+REPLACE[[:space:]]+)?(TRUSTED[[:space:]]+)?(PROCEDURAL[[:space:]]+)?LANGUAGE|SECURITY[[:space:]]+DEFINER)([^[:alnum:]_]|$)'
  if grep -iEq "$dac_quyen" "$norm"; then
    echo "Lỗi: SQL chứa câu lệnh đặc quyền (CREATE EXTENSION / CREATE|ALTER|DROP ROLE / ALTER SYSTEM / CREATE LANGUAGE / SECURITY DEFINER) — dump schema-scoped KHÔNG BAO GIỜ phát ra câu này — TỪ CHỐI (nghi dump full-DB hoặc file chế tác)." >&2
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Dọn schema đích để phục hồi ĐÚNG NGHĨA "thay sạch". arg1 = db, arg2 = schema,
# arg3 = "1" nếu bản dump TỰ phát `CREATE SCHEMA <đích>` (đường plain), "" nếu không.
#
# ✱ ĐÂY LÀ LÝ DO TỒN TẠI CỦA restore.sh ✱
#   Trang "Phục hồi từ file" trong app KHÔNG làm được bước này: role app (`hogikids`)
#   đo được `has_database_privilege(…,'CREATE') = false` — nó SỞ HỮU schema nên DROP
#   trót lọt nhưng TẠO LẠI thì bị từ chối, tức sẽ xoá sạch schema rồi chết giữa chừng.
#   Script này chạy `supabase_admin` (superuser thật) nên làm được. Nói cách khác:
#   phục hồi trong app = thay THEO OBJECT (object sinh sau lúc sao lưu còn sót lại);
#   phục hồi bằng script này = thay SẠCH.
#
# ✱ KHÔNG tự CREATE khi dump đã có câu tạo ✱ (đo thật 29/07 trên DB test)
#   `pg_dump -Fp -n <schema>` LUÔN phát `CREATE SCHEMA <schema>;`. Nếu ta tạo trước rồi
#   nạp, `psql -v ON_ERROR_STOP=1` chết ở "schema đã tồn tại" NGAY SAU KHI vừa drop ⇒
#   schema TRỐNG RỖNG. Đã tái hiện: bản cũ để lại 0 bảng, bản này phục hồi đủ bảng+dữ liệu.
#   Đường custom thì ngược lại: `pg_restore -n` BỎ QUA entry SCHEMA của dump (đo: không
#   phát DROP/CREATE SCHEMA nào) nên PHẢI tự tạo, nếu không sẽ nạp vào hư không.
# ---------------------------------------------------------------------------
drop_schema_dich() {
  local db=$1 schema=$2 dump_tu_tao=$3 sql
  # Cổng khoá việc nặng đứng ĐẦU cùng một chuỗi `psql -c` = CÙNG MỘT transaction với DROP (xem
  # `sql_cong_khoa_viec_nang`): khoá đang giữ ⇒ RAISE ⇒ rollback, schema còn nguyên.
  # `SET TRANSACTION` đứng ĐẦU: cổng phải đọc bản khoá MỚI NHẤT — nếu cluster đặt mặc định
  # REPEATABLE READ thì snapshot đóng băng ở câu đầu và cổng nhìn khoá cũ, DROP đè lên việc đang chạy
  # (review 25/09 đo được trên PG thật). Vẫn cùng một transaction ngầm của `psql -c`.
  # `SET LOCAL lock_timeout` đứng NGAY SAU (chỉ có hiệu lực trong transaction hiện tại, phải sau câu
  # SET TRANSACTION vì câu đó BẮT BUỘC là câu đầu) — chặn treo vô hạn ở `LOCK TABLE` phía dưới khi có
  # phiên khác đang giữ lock Postgres trên `Setting` (xem giải thích ở hằng số `LOCK_TIMEOUT_CONG_KHOA_GIAY`).
  sql="SET TRANSACTION ISOLATION LEVEL READ COMMITTED; SET LOCAL lock_timeout = '${LOCK_TIMEOUT_CONG_KHOA_GIAY}s'; $(sql_cong_khoa_viec_nang "$schema")"
  if [[ "$dump_tu_tao" == "1" ]]; then
    sql="$sql DROP SCHEMA IF EXISTS \"$schema\" CASCADE;"
  else
    sql="$sql DROP SCHEMA IF EXISTS \"$schema\" CASCADE; CREATE SCHEMA \"$schema\";"
  fi
  docker exec -i "$CONTAINER" psql -U supabase_admin -d "$db" -v ON_ERROR_STOP=1 -c "$sql" || {
    echo "Lỗi: KHÔNG dọn được schema '$schema' của '$db' — schema CÒN NGUYÊN (cổng khoá + DROP chạy trong MỘT transaction)." >&2
    echo "    Dòng ERROR có KHOA_VIEC_NANG_DANG_GIU ⇒ một việc nặng (dựng lại từ kho thô / ghi giá vốn /" >&2
    echo "    xoá dữ liệu / sao lưu trong app) ĐANG ghi vào schema này. Chờ nó xong rồi chạy lại — việc đã" >&2
    echo "    chết thì khoá tự hết hạn sau tối đa 5 phút. Khoá hỏng định dạng (lỗi bigint) mà chắc chắn không" >&2
    echo "    còn việc nào chạy: DELETE FROM \"$schema\".\"Setting\" WHERE key = '$KHOA_VIEC_NANG_KEY';" >&2
    echo "    Vừa nạp một bản sao lưu TẠO TỪ APP (/api/backup) chưa tới 5 phút? Bản đó mang theo chính dòng khoá" >&2
    echo "    của lượt sao lưu ⇒ bị chặn oan — chờ hết hạn rồi chạy lại." >&2
    echo "    ERROR là 'deadlock detected' ⇒ KHÔNG phải khoá việc nặng: một việc khác vừa chạm bảng Setting cùng" >&2
    echo "    lúc; lượt này đã huỷ an toàn, chạy lại." >&2
    echo "    ERROR là 'canceling statement due to lock timeout' ⇒ KHÔNG phải khoá việc nặng của app (cổng còn" >&2
    echo "    chưa kịp đọc tới) — một phiên KHÁC đang giữ lock Postgres trên bảng Setting (transaction dài, phiên" >&2
    echo "    treo…) quá ${LOCK_TIMEOUT_CONG_KHOA_GIAY}s. Dừng app (docker compose stop app), đóng phiên psql/prisma" >&2
    echo "    đang mở tới DB này rồi chạy lại." >&2
    return 1
  }
}

# ---------------------------------------------------------------------------
# Cổng "khoá việc nặng" — cùng khoá với app (`src/lib/backup/khoa-viec-nang.ts`): dòng
# `Setting.key = khoaViecNang`, giá trị `<token>|<hạn epoch ms>|<tên việc>`, hạn 5 phút, chủ khoá
# gia hạn ở mỗi mốc tiến độ thật. Script dựng lại / ghi giá vốn chạy ở tiến trình RIÊNG
# (`docker compose run --rm app …`) nên `docker compose stop app` KHÔNG dừng được chúng — cổng này
# là thứ duy nhất chặn DROP đè lên một việc đang ghi. arg1 = schema đích. In ra một khối SQL.
#
# VÌ SAO chỉ ĐỌC dưới LOCK, không giành/nhả như app: khoá nằm TRONG chính bảng sắp bị DROP. Giành
# rồi nhả là vô nghĩa (DROP xoá luôn dòng khoá; bảng về lại từ dump), còn trap nhả khoá là thêm đúng
# lớp lỗi `trap` đã cắn đường DR 23/09. Thay vào đó: LOCK ACCESS EXCLUSIVE ⇒ không ai giành/gia hạn
# được giữa lúc kiểm và lúc DROP (họ chờ, rồi vấp bảng đã mất — chết TRƯỚC khi ghi). Không có khe.
# Bảng chưa tồn tại (DB nháp mới tạo, cluster DR trắng) ⇒ không có gì để bảo vệ ⇒ bỏ qua; nhờ vậy
# diễn tập vào DB nháp KHÔNG bao giờ đọc/ghi khoá của DB thật (khoá theo DB đích, không dùng chung).
# Giới hạn (giống app): việc nặng khởi động SAU khi DROP commit, giữa lúc đang nạp, không bị chặn.
# ⚠️ Chuỗi nháy KÉP: KHÔNG backtick, `$$` phải viết `\$\$` (bài học 23/09).
# ---------------------------------------------------------------------------
KHOA_VIEC_NANG_KEY=khoaViecNang   # BẢN SONG SINH của KHOA_KEY trong khoa-viec-nang.ts — test ép khớp
sql_cong_khoa_viec_nang() {
  local schema=$1
  printf '%s\n' "DO \$\$
DECLARE v text;
BEGIN
  IF to_regclass('\"$schema\".\"Setting\"') IS NULL THEN RETURN; END IF;
  LOCK TABLE \"$schema\".\"Setting\" IN ACCESS EXCLUSIVE MODE;
  SELECT \"value\" INTO v FROM \"$schema\".\"Setting\" WHERE \"key\" = '$KHOA_VIEC_NANG_KEY';
  IF v IS NOT NULL AND split_part(v, '|', 2)::bigint >= (extract(epoch from now()) * 1000)::bigint THEN
    RAISE EXCEPTION 'KHOA_VIEC_NANG_DANG_GIU: viec \"%\" con han ~% giay', split_part(v, '|', 3),
      (split_part(v, '|', 2)::bigint - (extract(epoch from now()) * 1000)::bigint) / 1000;
  END IF;
END
\$\$;"
}

# ---------------------------------------------------------------------------
# Hậu kỳ: trả quyền sở hữu CHỈ trong schema đích về role app, rồi cấp lại quyền ĐỌC của role n8n.
# Thay cho REASSIGN OWNED BY postgres (nguy hiểm trên DB chung). arg1 = db, arg2 = schema.
#
# Vì sao phải có ENUM + ROUTINE, không chỉ bảng/sequence: restore chạy `-U supabase_admin --no-owner`
# nên MỌI object mới thuộc `supabase_admin`. `prisma migrate deploy` lại chạy bằng role app ⇒ migration
# dạng `ALTER TYPE … ADD VALUE` hoặc `CREATE OR REPLACE FUNCTION` (repo đã có cả hai) sẽ bị từ chối
# "must be owner of" ở prod, đúng lúc vừa phục hồi xong. Trigger KHÔNG cần bước này (EXECUTE mặc định
# cấp cho PUBLIC) — chỉ đường DDL bị chặn.
#
# Vì sao phải cấp lại GRANT: `DROP SCHEMA … CASCADE` xoá ACL của schema, `pg_restore --no-privileges`
# bỏ mọi GRANT trong dump ⇒ role chỉ-đọc của n8n mất USAGE + SELECT. Cấp lại ĐÚNG 2 quyền cũ, không
# rộng hơn. `GRANT CONNECT` cấp database KHÔNG mất nên không cấp lại ở đây.
# ---------------------------------------------------------------------------
reassign_owner_scoped() {
  local db=$1 schema=$2 k key_in=""
  # Danh sách key → literal SQL `'a', 'b', …` cho mệnh đề IN của định nghĩa view.
  for k in $KEY_N8N_DUOC_DOC; do key_in="${key_in:+$key_in, }'$k'"; done
  echo ">> Trả quyền sở hữu schema '$schema' về role '$OWNER_ROLE' + cấp lại quyền đọc cho '$N8N_RO_ROLE'..." >&2
  docker exec "$CONTAINER" psql -U supabase_admin -d "$db" -v ON_ERROR_STOP=1 -c "
ALTER SCHEMA \"$schema\" OWNER TO $OWNER_ROLE;
DO \$\$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relkind, c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = '$schema' AND c.relkind IN ('r','p','S','v','m')
  LOOP
    IF r.relkind = 'S' THEN
      EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO $OWNER_ROLE', '$schema', r.relname);
    ELSIF r.relkind = 'v' THEN
      EXECUTE format('ALTER VIEW %I.%I OWNER TO $OWNER_ROLE', '$schema', r.relname);
    ELSIF r.relkind = 'm' THEN
      EXECUTE format('ALTER MATERIALIZED VIEW %I.%I OWNER TO $OWNER_ROLE', '$schema', r.relname);
    ELSE
      EXECUTE format('ALTER TABLE %I.%I OWNER TO $OWNER_ROLE', '$schema', r.relname);
    END IF;
  END LOOP;

  -- Repo chỉ tạo ENUM (Prisma) nên lọc typtype='e'; type composite của bảng đã theo owner bảng.
  FOR r IN
    SELECT t.typname
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = '$schema' AND t.typtype = 'e'
  LOOP
    EXECUTE format('ALTER TYPE %I.%I OWNER TO $OWNER_ROLE', '$schema', r.typname);
  END LOOP;

  -- ALTER ROUTINE bao cả function/procedure/aggregate (PG >= 11; container supabase-db là v15).
  -- pg_get_function_identity_arguments cho ĐÚNG chữ ký, không thì hàm trùng tên bị bỏ sót/nhầm.
  FOR r IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = '$schema'
  LOOP
    EXECUTE format('ALTER ROUTINE %I.%I(%s) OWNER TO $OWNER_ROLE', '$schema', r.proname, r.args);
  END LOOP;
END
\$\$;"

  # KHỐI 2 — cấp lại đường đọc của n8n, chạy bằng MỘT lệnh psql RIÊNG.
  #
  # VÌ SAO TÁCH (đo 22/09/2026): `psql -c "a; b"` gửi cả chuỗi như MỘT query ⇒ MỘT transaction ngầm.
  # Khối 1 ở trên chỉ trả quyền sở hữu (không thể lỗi trong thực tế); khối 2 nay chứa DDL THẬT
  # (`CREATE OR REPLACE VIEW`) có thể lỗi thật — view cũ khác số/tên cột thì Postgres ném
  # `cannot change name of view column`, còn nếu `SettingN8n` lại là BẢNG thì `… is not a view`.
  # Để chung một lệnh nghĩa là một lỗi hình dạng view sẽ ROLLBACK luôn cả phần trả quyền sở hữu ⇒
  # app chết sau DR và `prisma migrate deploy` bị từ chối hàng loạt, trong khi dữ liệu đã nạp xong.
  docker exec "$CONTAINER" psql -U supabase_admin -d "$db" -v ON_ERROR_STOP=1 -c "
DO \$\$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$N8N_RO_ROLE') THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO $N8N_RO_ROLE', '$schema');
    -- Tu 2026-08-21: role doc VIEW SettingN8n thay bang Setting goc (view loai 2 khoa ha tang
    -- n8nApiKey/n8nDbRoPassword — xem src/lib/n8n/role-doc-kho-khoa.ts, phai khop hang N8N_SETTING_VIEW).
    --
    -- DUNG LAI DINH NGHIA VIEW (them 22/09/2026), khong chi cap quyen: dinh nghia view nam TRONG
    -- dump, nen nap mot ban backup tao truoc 21/09 la view quay ve ban FAIL-OPEN cu (key NOT IN
    -- (...), phoi 43/45 key gom ca kho token Meta/TikTok) — va khong gi phat hien duoc. Cau duoi
    -- ep view ve dung allowlist hien hanh sau MOI luot phuc hoi. Doi xung voi ham
    -- sqlKhoiPhucDuongDocN8n() trong src/lib/backup/run-restore.ts.
    -- KHONG dung dau backtick trong khoi SQL nay: ca chuoi nam trong dau nhay KEP cua bash nen
    -- backtick la command-substitution — no NUOT noi dung comment (do that 22/09) va la duong
    -- chay lenh neu ai do dan vao day mot doan co bien.
    IF to_regclass(format('%I.%I', '$schema', 'Setting')) IS NOT NULL THEN
      EXECUTE \$q\$CREATE OR REPLACE VIEW \"$schema\".\"$N8N_SETTING_VIEW\" AS
        SELECT key, value FROM \"$schema\".\"Setting\" WHERE key IN ($key_in)\$q\$;
      EXECUTE 'ALTER VIEW \"$schema\".\"$N8N_SETTING_VIEW\" SET (security_barrier = true)';
      -- TRA OWNER cho view. Vong lap doi owner o KHOI 1 duyet pg_class TAI THOI DIEM DO, ma view
      -- nay duoc dung SAU do ⇒ neu ban dump khong chua view (dung ca ban backup cu ma khoi nay
      -- sinh ra de xu ly), no o lai owner supabase_admin. Do that DR dien tap 23/09: buoc (g) cua
      -- runbook DR (prisma migrate deploy, chay bang role app) khi do chet voi
      -- loi ERROR: must be owner of view SettingN8n — dung loai loi ma vong lap owner sinh ra de chan.
      -- (Trong khoi nay TUYET DOI khong go dau backtick lan dau nhay kep tran: ca chuoi nam trong
      --  dau nhay KEP cua bash, backtick = chay lenh, nhay kep = DONG chuoi som. Do ca hai 23/09.)
      EXECUTE format('ALTER VIEW %I.%I OWNER TO $OWNER_ROLE', '$schema', '$N8N_SETTING_VIEW');
    END IF;
    IF to_regclass(format('%I.%I', '$schema', '$N8N_SETTING_VIEW')) IS NULL THEN
      RAISE NOTICE 'Khong thay view %.\"$N8N_SETTING_VIEW\" — bo qua GRANT SELECT (ban dump qua cu?).', '$schema';
    ELSE
      EXECUTE format('GRANT SELECT ON %I.%I TO $N8N_RO_ROLE', '$schema', '$N8N_SETTING_VIEW');
    END IF;
  ELSE
    RAISE NOTICE 'Chua co role $N8N_RO_ROLE — bo qua cap quyen doc. Workflow n8n se chet o node lay khoa cho toi khi tao role (xem runbook DR muc 11, buoc tao role $N8N_RO_ROLE).';
  END IF;
END
\$\$;"
}

# ---------------------------------------------------------------------------
# HẬU KỲ 2 — THU HỒI MỌI PHIÊN (spec phân quyền §7.4 bước 4). Chạy SAU `reassign_owner_scoped`.
#
# Vì sao BẮT BUỘC với MỌI dump, không riêng dump đời trước phân quyền: cookie phiên là cookie KÝ, không
# có bản ghi phía máy chủ — hợp lệ khi `mocPhien` trong cookie = `User.sessionEpoch`. Dump mang epoch
# của ĐỜI CHỤP ⇒ nạp xong mà không đổi epoch là mọi cookie cấp trong đời đó (kể cả cookie đã bị thu hồi
# SAU lúc chụp — đổi mật khẩu, khoá tài khoản) SỐNG LẠI. Đường phục hồi trong app đã tự làm việc này
# (`thuHoiMoiPhienCoHan`); đường host thì trước đây không.
#
# Dump đời TRƯỚC migration phân quyền: `User` chưa có cột `sessionEpoch` ⇒ file SQL sẽ lỗi. Không tự
# `migrate deploy` ở đây (cần ảnh app đang lên, và app phải còn dừng) ⇒ in hướng dẫn rồi trả
# `MA_THOAT_CHUA_XONG` (3): `set -e` dừng main TRƯỚC dòng ✓, script thoát 3 — KHÔNG thoát 0, vì mọi
# khối `restore.sh && up -d` sẽ mở app trên schema chưa migrate và cookie đời dump chưa bị thu hồi.
# Runbook §4.2 bắt đúng mã này rồi chạy tiếp migrate + chính file thu hồi.
#
# Schema ≠ app: file cố định `SET search_path = app;` và app chỉ đọc schema `app` ⇒ bỏ qua, cảnh báo.
# ---------------------------------------------------------------------------
thu_hoi_phien_sau_phuc_hoi() {
  local db=$1 schema=$2 co_cot
  if [[ "$schema" != "app" ]]; then
    echo "!!! Schema '$schema' ≠ app: KHÔNG thu hồi phiên ($THU_HOI_PHIEN_SQL cố định search_path = app; app chỉ đọc schema app)." >&2
    return 0
  fi
  echo ">> Thu hồi mọi phiên đăng nhập (đổi User.sessionEpoch từng người)..." >&2
  co_cot=$(docker exec "$CONTAINER" psql -U supabase_admin -d "$db" -X -tA -v ON_ERROR_STOP=1 -c \
    "SELECT count(*) FROM information_schema.columns WHERE table_schema = '$schema' AND table_name = 'User' AND column_name = 'sessionEpoch'") || {
    echo "✗ LỖI: không kiểm được cột User.sessionEpoch — CHƯA thu hồi phiên. Dữ liệu ĐÃ nạp xong." >&2
    echo "    GIỮ APP DỪNG, xử lý lỗi kết nối rồi chạy tay:" >&2
    echo "      docker exec -i $CONTAINER psql -U supabase_admin -d $db -X -v ON_ERROR_STOP=1 < deploy/thu-hoi-phien-sau-phuc-hoi.sql" >&2
    return 1
  }
  case "$co_cot" in
    1) ;;
    0)
      echo "✗ CHƯA XONG — dump đời TRƯỚC phân quyền (User chưa có cột sessionEpoch): dữ liệu ĐÃ nạp, CHƯA thu hồi phiên." >&2
      echo "    GIỮ APP DỪNG (KHÔNG 'up -d'), làm tiếp theo runbook §4.2 'Phục hồi dump đời trước phân quyền':" >&2
      echo "      docker compose run --rm app npx --no-install prisma migrate deploy" >&2
      echo "      docker exec -i $CONTAINER psql -U supabase_admin -d $db -X -v ON_ERROR_STOP=1 < deploy/thu-hoi-phien-sau-phuc-hoi.sql" >&2
      echo "    rồi mới 'docker compose up -d'. (Thoát mã $MA_THOAT_CHUA_XONG.)" >&2
      return "$MA_THOAT_CHUA_XONG"
      ;;
    *)
      echo "✗ LỖI: kiểm cột User.sessionEpoch trả kết quả lạ ('$co_cot') — CHƯA thu hồi phiên. GIỮ APP DỪNG, kiểm tay." >&2
      return 1
      ;;
  esac
  docker exec -i "$CONTAINER" psql -U supabase_admin -d "$db" -X -v ON_ERROR_STOP=1 < "$THU_HOI_PHIEN_SQL" || {
    echo "✗ LỖI: thu hồi phiên THẤT BẠI — cookie cấp trong đời bản dump có thể SỐNG LẠI. Dữ liệu ĐÃ nạp xong." >&2
    echo "    GIỮ APP DỪNG, đọc lỗi psql phía trên, sửa rồi chạy tay:" >&2
    echo "      docker exec -i $CONTAINER psql -U supabase_admin -d $db -X -v ON_ERROR_STOP=1 < deploy/thu-hoi-phien-sau-phuc-hoi.sql" >&2
    return 1
  }
  echo "✓ Đã thu hồi mọi phiên — mọi người phải đăng nhập lại." >&2
}

# ===========================================================================
# LOẠI TRỪ PHIÊN ROLE APP TRONG LÚC THAY SCHEMA
#
# Vì sao: từ lúc DROP tới lúc nạp xong, một phiên `hogikids` còn sống (app chưa dừng hẳn, script
# `docker compose run --rm app …`, máy dev nối qua Tailscale) ghi vào schema nửa vời hoặc vào bảng vừa
# dựng lại — dữ liệu lai, không ai thấy. `docker compose stop app` KHÔNG dừng được tiến trình CLI.
#
# HAI CHẾ ĐỘ — chọn theo DB đích, KHÔNG BAO GIỜ trộn:
#   • Đích ≠ `postgres` (DB nháp diễn tập DR, DB riêng): `REVOKE CONNECT ON DATABASE "<db>" FROM PUBLIC,
#     hogikids` — chặn ĐÚNG DB đó, DB khác trong cluster (gồm prod) nối bình thường. KHÔNG `ALTER ROLE`:
#     role là đối tượng TOÀN CLUSTER — DB nháp, 3 DB test và prod cùng cluster `supabase-db`, cùng role
#     `hogikids` ⇒ NOLOGIN trong lúc diễn tập là đánh sập prod.
#   • Đích = `postgres` (DB chung Supabase): CẤM REVOKE PUBLIC — đo prod 28/10: PostgREST
#     (`authenticator`) và storage nối DB này NHỜ quyền PUBLIC (`=Tc/postgres`), REVOKE là cắt Supabase;
#     REVOKE riêng `hogikids` thì vô tác dụng (vẫn còn PUBLIC). ⇒ app phải dừng sẵn (preflight kiểm
#     `docker ps`) + `ALTER ROLE hogikids NOLOGIN` (chấp nhận: chặn luôn `hogikids` ở các DB test).
#   Hai chế độ cùng cắt phiên `pg_terminate_backend(pid, 5000)` lọc `datname = <đích> AND usename =
#   'hogikids'` rồi CHỜ có hạn tới 0 phiên — terminate chỉ gửi tín hiệu, kiểm ngay sau đó có thể còn
#   thấy phiên đang chết.
#
# Trả lại (chế độ REVOKE) bằng `UPDATE pg_catalog.pg_database SET datacl = <bản lưu nguyên văn>` rồi đọc
# lại so chuỗi. KHÔNG dùng GRANT: superuser GRANT ghi grantor = owner (lệch chuỗi khi grantor gốc khác
# owner), và `datacl` NULL (mặc định PUBLIC CONNECT — DB nháp do supabase_admin tạo) không quay về NULL
# được bằng GRANT. Catalog là dữ liệu: superuser UPDATE được (`allow_system_table_mods` chỉ chặn DDL).
# ⚠️ Lối UPDATE này CHỈ dành cho DB nháp `datacl` NULL (đúng trạng thái đo 28/10 của DB diễn tập DR):
# UPDATE catalog KHÔNG chạm `pg_shdepend`. Với ACL có mục role tường minh (`hogikids=c/…`), REVOKE đã xoá
# dòng phụ thuộc của role, UPDATE ghi lại mục đó mà KHÔNG dựng lại phụ thuộc ⇒ về sau `DROP ROLE` lọt
# kiểm phụ thuộc, để `aclitem` treo theo OID. Cần restore vào DB có grant tường minh ⇒ trả bằng
# `GRANT … GRANTED BY <grantor gốc>` thay vì UPDATE (chưa làm — chưa có đích nào như vậy).
#
# Bài học trap 23/09: lỗi là trap bị ĐÈ, không phải dùng trap. Ở đây chỉ có MỘT trap EXIT
# (`don_dep_khi_thoat` — mở lại + dọn MỌI file tạm) và MỘT trap ERR (`khi_loi` → `mo_lai_dang_nhap`), cài
# trong `main` (source file để test thì không cài gì). Không chỗ nào khác được `trap … EXIT`.
#
# VÙNG PHÁ HUỶ (`BUOC_PHA_HUY` ≠ "") — từ lệnh DROP tới hết hậu kỳ trả quyền (`reassign_owner_scoped`).
# MỌI lối thoát trong vùng này mà schema có thể đã DỞ ⇒ FAIL-CLOSED: KHÔNG mở lại đăng nhập, GIỮ tệp
# đánh dấu (ghi lý do + bước dở), in cách kiểm schema + lệnh mở tay. Lượt sau dừng ở preflight cho tới
# khi người vận hành kiểm + mở tay — app/n8n không bao giờ được nối lại một schema nửa vời mà không ai
# biết (bật app tay ngoài khối `restore.sh && docker compose up -d` là ghi vào schema dở, mất ở lượt
# restore lại). Gồm:
#  - bị NGẮT (INT/TERM, hoặc lệnh chết vì tín hiệu — mã > 128) lúc DROP / nạp / trả quyền: `docker exec`
#    KHÔNG chuyển tín hiệu vào container ⇒ `pg_restore`/`psql`/`ALTER … OWNER` trong `supabase-db` có thể
#    VẪN chạy; mở lại lúc đó là mở cửa cho app/CLI ghi xen (dữ liệu lai);
#  - lỗi THƯỜNG (mã 1…128) SAU khi DROP đã commit: nạp dở (`--exit-on-error`/`ON_ERROR_STOP` không có
#    `--single-transaction` ⇒ phần đã nạp ở lại), hậu kỳ trả quyền dở (role app thiếu quyền một phần);
#  - `exit` tường minh trong vùng (trap EXIT cũng xét vùng, không chỉ trap ERR).
# NGOẠI LỆ duy nhất: lệnh DROP tự LỖI THƯỜNG ⇒ mở lại như cũ — cổng khoá việc nặng + DROP + CREATE chạy
# trong MỘT `psql -c` (một transaction ngầm, xem `drop_schema_dich`) ⇒ lỗi = rollback, schema còn nguyên.
# Bị ngắt GIỮA lệnh DROP thì vẫn giữ khoá (không biết transaction đã commit chưa). Lỗi/ngắt TRƯỚC DROP ⇒
# mở lại như mọi lối thoát khác.
# ===========================================================================

# DB chung của Supabase self-host — đích này dùng chế độ NOLOGIN (xem trên).
DB_SUPABASE_CHUNG=postgres

# Số lần kiểm "còn phiên role app" (mỗi lần cắt lại + đếm) và số giây nghỉ giữa hai lần. Ghi đè qua
# biến môi trường chỉ để harness test chạy nhanh; `main` từ chối giá trị không phải số nguyên.
HAN_CHO_HET_PHIEN_LAN="${RESTORE_HAN_CHO_HET_PHIEN_LAN:-30}"
NGU_GIUA_LAN_KIEM_PHIEN="${RESTORE_NGU_GIUA_LAN_KIEM:-1}"

# Trạng thái khoá — biến TOÀN CỤC: trap đọc được ở mọi lối thoát, kể cả `exit` gọi sâu trong hàm.
#   LOAI_TRU_CHE_DO: "" = chưa khoá / đã mở · "revoke" = đã REVOKE CONNECT cấp DB · "nologin".
LOAI_TRU_CHE_DO=""
LOAI_TRU_DB=""
LOAI_TRU_ACL=""      # datacl nguyên văn trước REVOKE; "NULL" = cột NULL (mặc định PUBLIC CONNECT)
TEP_DANG_DO=""       # đặt trong main (mặc định ~/docker/backups/.restore-dang-do)
APP_CONTAINER=""     # đặt trong main theo hậu tố của $CONTAINER
TEP_TAM_CAN_DON=""   # mỗi dòng một đường dẫn file tạm — don_dep_khi_thoat dọn hết
BUOC_PHA_HUY=""      # "" = ngoài vùng phá huỷ · drop · nap · tra_quyen — xem "VÙNG PHÁ HUỶ"

# Một câu SQL qua psql, in kết quả dạng trơn (`-tA`). arg1 = db, arg2 = SQL.
psql_mot_cau() {
  docker exec "$CONTAINER" psql -U supabase_admin -d "$1" -X -tA -v ON_ERROR_STOP=1 -c "$2"
}

dang_ky_tep_tam() { TEP_TAM_CAN_DON="${TEP_TAM_CAN_DON}$1"$'\n'; }

don_tep_tam() {
  local f
  while IFS= read -r f; do
    if [[ -n "$f" ]]; then rm -f -- "$f"; fi
  done <<EOF
$TEP_TAM_CAN_DON
EOF
  TEP_TAM_CAN_DON=""
}

# Câu SQL mở lại cho chế độ arg1 — DÙNG CHUNG cho lượt mở tự động, lệnh mở tay in ra, và tệp đánh dấu.
sql_mo_lai_dang_nhap() {
  if [[ "$1" == nologin ]]; then
    printf '%s' "ALTER ROLE $OWNER_ROLE LOGIN;"
  elif [[ "$LOAI_TRU_ACL" == NULL ]]; then
    printf '%s' "UPDATE pg_catalog.pg_database SET datacl = NULL WHERE datname = '$LOAI_TRU_DB';"
  else
    printf '%s' "UPDATE pg_catalog.pg_database SET datacl = '$LOAI_TRU_ACL'::aclitem[] WHERE datname = '$LOAI_TRU_DB';"
  fi
}

# Lệnh mở tay (heredoc nháy đơn — dán nguyên văn được dù ACL có dấu nháy kép). arg1 = chế độ.
in_lenh_mo_tay() {
  echo "    docker exec -i $CONTAINER psql -U supabase_admin -d $LOAI_TRU_DB -X -v ON_ERROR_STOP=1 <<'SQL'"
  echo "$(sql_mo_lai_dang_nhap "$1")"
  echo "SQL"
  echo "    rồi xoá tệp đánh dấu: rm -f $TEP_DANG_DO"
}

# Tệp đánh dấu — ghi TRƯỚC câu khoá: chết giữa chừng (mất điện, kill -9) thì lượt sau vẫn biết role/DB
# đang khoá CÓ CHỦ ĐÍCH và mở thế nào. `set -C` ⇒ không đè tệp của một lượt khác chưa xử lý xong.
ghi_tep_dang_do() {
  mkdir -p "$(dirname "$TEP_DANG_DO")"
  (
    set -C
    {
      echo "# restore.sh ĐANG DỞ — đăng nhập role $OWNER_ROLE đang bị khoá CÓ CHỦ ĐÍCH."
      echo "thoi_diem=$(date '+%Y-%m-%d %H:%M:%S %z')"
      echo "container=$CONTAINER"
      echo "db=$LOAI_TRU_DB"
      echo "che_do=$1"
      echo "acl_da_luu=$LOAI_TRU_ACL"
      echo "# Mở tay — CHỈ khi chắc không còn lượt restore.sh nào đang chạy:"
      in_lenh_mo_tay "$1"
    } > "$TEP_DANG_DO"
  )
}

# Preflight: còn tệp đánh dấu ⇒ một lượt trước dừng giữa chừng mà KHÔNG mở lại được. Không đoán, không
# tự mở (có thể lượt đó vẫn đang chạy ở terminal khác) — in nội dung + cách xử lý rồi dừng.
kiem_tep_dang_do() {
  [[ -e "$TEP_DANG_DO" ]] || return 0
  echo "Lỗi: còn tệp đánh dấu '$TEP_DANG_DO' — một lượt restore.sh trước dừng giữa chừng và CÓ THỂ" >&2
  echo "    còn khoá đăng nhập role '$OWNER_ROLE'. DB KHÔNG bị đụng ở lượt này. Nội dung tệp:" >&2
  sed 's/^/      /' "$TEP_DANG_DO" >&2 || true
  echo "    Kiểm không còn lượt nào đang chạy (ps aux | grep restore.sh), chạy lệnh mở tay ở trên, xoá tệp" >&2
  echo "    rồi chạy lại. Đích là DB nháp thì kiểm datacl; đích postgres thì kiểm rolcanlogin của '$OWNER_ROLE'." >&2
  return 1
}

# Preflight cho đích = DB chung: container app (cùng hậu tố với $CONTAINER) phải đã dừng. So khớp
# NGUYÊN DÒNG bằng bash, không pipe vào `grep -q` (pipefail + SIGPIPE ⇒ kết luận "đã dừng" oan).
kiem_app_da_dung() {
  local ds
  ds=$(docker ps --format '{{.Names}}') || {
    echo "Lỗi: không chạy được 'docker ps' để kiểm container '$APP_CONTAINER' đã dừng — DB KHÔNG bị đụng." >&2
    return 1
  }
  if [[ $'\n'"$ds"$'\n' == *$'\n'"$APP_CONTAINER"$'\n'* ]]; then
    echo "Lỗi: container '$APP_CONTAINER' ĐANG CHẠY — đích '$DB_SUPABASE_CHUNG' khoá đăng nhập role '$OWNER_ROLE' (NOLOGIN)" >&2
    echo "    suốt lúc thay schema. Dừng app trước: docker compose stop app — rồi chạy lại. DB KHÔNG bị đụng." >&2
    return 1
  fi
}

# Cắt mọi phiên role app trên DB đích rồi chờ tới 0 phiên (có hạn). arg1 = db.
cho_het_phien_role_app() {
  local db=$1 i con=""
  local loc="datname = '$db' AND usename = '$OWNER_ROLE'"
  for (( i = 1; i <= HAN_CHO_HET_PHIEN_LAN; i++ )); do
    psql_mot_cau "$db" "SELECT pg_terminate_backend(pid, 5000) FROM pg_catalog.pg_stat_activity WHERE $loc" > /dev/null
    con=$(psql_mot_cau "$db" "SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE $loc")
    if [[ "$con" == 0 ]]; then
      echo "✓ Không còn phiên '$OWNER_ROLE' nào trên '$db'." >&2
      return 0
    fi
    echo "   còn $con phiên '$OWNER_ROLE' trên '$db' — chờ (lần $i/$HAN_CHO_HET_PHIEN_LAN)..." >&2
    sleep "$NGU_GIUA_LAN_KIEM_PHIEN"
  done
  echo "Lỗi: sau $HAN_CHO_HET_PHIEN_LAN lần vẫn còn '$con' phiên '$OWNER_ROLE' trên '$db' — dừng TRƯỚC khi dọn schema." >&2
  return 1
}

# KHOÁ — gọi SAU mọi guard file, sát trước `drop_schema_dich`. arg1 = db, arg2 = schema.
khoa_dang_nhap_role_app() {
  local db=$1 schema=$2 acl login quyen
  # Xem trước khoá việc nặng (chỉ đọc, cùng khối SQL với cổng trong `drop_schema_dich` — cổng đó vẫn là
  # chốt thật, cùng transaction với DROP). Không xem trước thì bước cắt phiên dưới đây GIẾT chính việc
  # nặng đang chạy (dựng lại từ kho thô bằng `docker compose run`), rồi cổng vẫn từ chối vì dòng khoá
  # còn hạn ⇒ Silver dở dang VÀ không phục hồi.
  psql_mot_cau "$db" "SET TRANSACTION ISOLATION LEVEL READ COMMITTED; SET LOCAL lock_timeout = '${LOCK_TIMEOUT_CONG_KHOA_GIAY}s'; $(sql_cong_khoa_viec_nang "$schema")" > /dev/null || {
    echo "Lỗi: xem trước khoá việc nặng thất bại (đọc dòng ERROR phía trên) — CHƯA khoá đăng nhập, schema CÒN NGUYÊN." >&2
    echo "    KHOA_VIEC_NANG_DANG_GIU ⇒ một việc nặng đang ghi schema này: chờ nó xong rồi chạy lại." >&2
    return 1
  }

  LOAI_TRU_DB=$db
  if [[ "$db" == "$DB_SUPABASE_CHUNG" ]]; then
    login=$(psql_mot_cau "$db" "SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE rolname = '$OWNER_ROLE'")
    if [[ "$login" != t ]]; then
      echo "Lỗi: role '$OWNER_ROLE' hiện có rolcanlogin='$login' (kỳ vọng t) mà KHÔNG có tệp đánh dấu — không biết" >&2
      echo "    trạng thái gốc để trả lại. Kiểm tay rồi chạy lại. CHƯA khoá gì, schema CÒN NGUYÊN." >&2
      return 1
    fi
    LOAI_TRU_ACL=""
    ghi_tep_dang_do nologin
    LOAI_TRU_CHE_DO=nologin
    echo ">> Khoá đăng nhập role '$OWNER_ROLE' (NOLOGIN) — đích là DB chung Supabase, KHÔNG đụng quyền PUBLIC..." >&2
    psql_mot_cau "$db" "ALTER ROLE $OWNER_ROLE NOLOGIN;" > /dev/null
  else
    acl=$(psql_mot_cau "$db" "SELECT COALESCE(datacl::text, 'NULL') FROM pg_catalog.pg_database WHERE datname = '$db'")
    # Chỉ nhận đúng hai hình dạng: NULL hoặc mảng aclitem `{…}` một dòng, không nháy đơn (nội suy vào
    # literal SQL lúc trả lại). Lạ ⇒ dừng TRƯỚC khi đụng gì — trả sai ACL là DB mất quyền nối.
    if [[ "$acl" != NULL && ( "$acl" != "{"*"}" || "$acl" == *"'"* || "$acl" == *$'\n'* ) ]]; then
      echo "Lỗi: không đọc được datacl của DB '$db' (nhận: '$acl') — DB có tồn tại? CHƯA khoá gì, schema CÒN NGUYÊN." >&2
      return 1
    fi
    LOAI_TRU_ACL=$acl
    ghi_tep_dang_do revoke
    LOAI_TRU_CHE_DO=revoke
    echo ">> Chặn role '$OWNER_ROLE' nối DB '$db' (REVOKE CONNECT cấp DATABASE; datacl đã lưu: $acl)..." >&2
    psql_mot_cau "$db" "REVOKE CONNECT ON DATABASE \"$db\" FROM PUBLIC, $OWNER_ROLE;" > /dev/null
    # REVOKE của superuser chạy "như owner" ⇒ grant do role KHÁC cấp, hay quyền thừa hưởng qua role cha,
    # còn nguyên. Hỏi thẳng quyền hiệu lực thay vì tin câu REVOKE.
    quyen=$(psql_mot_cau "$db" "SELECT has_database_privilege('$OWNER_ROLE', '$db', 'CONNECT')")
    if [[ "$quyen" != f ]]; then
      echo "Lỗi: sau REVOKE role '$OWNER_ROLE' VẪN nối được '$db' (has_database_privilege='$quyen') — grant từ role" >&2
      echo "    khác hoặc qua role cha. Gỡ tay rồi chạy lại. Đang trả ACL về bản lưu, schema CÒN NGUYÊN." >&2
      return 1
    fi
  fi
  cho_het_phien_role_app "$db"
}

# MỞ LẠI — idempotent, chạy TỐI ĐA một lần mỗi lượt khoá. Gọi tường minh ở luồng chính (ngay sau hậu kỳ
# quyền) + qua trap ERR (lỗi ở bất kỳ đâu trong vùng khoá) + trap EXIT (`exit N`, Ctrl-C). Trong subshell
# (`$(…)` thừa hưởng trap ERR do `set -E`) thì bỏ qua — trạng thái ở đó là bản sao, mở ở đó là mở hai lần.
# Hỏng ⇒ in lệnh mở tay, GIỮ tệp đánh dấu, trả 1. Không dựa `set -e` bên trong (thường chạy ở ngữ cảnh
# điều kiện / trap): mọi bước tự kiểm bằng `if`.
mo_lai_dang_nhap() {
  [[ "${BASH_SUBSHELL:-0}" -eq 0 ]] || return 0
  [[ -n "$LOAI_TRU_CHE_DO" ]] || return 0
  local che_do=$LOAI_TRU_CHE_DO acl_sau="" ok=0
  LOAI_TRU_CHE_DO=""
  echo ">> Mở lại đăng nhập role '$OWNER_ROLE' (chế độ $che_do, DB '$LOAI_TRU_DB')..." >&2
  if psql_mot_cau "$LOAI_TRU_DB" "$(sql_mo_lai_dang_nhap "$che_do")" > /dev/null; then
    if [[ "$che_do" == nologin ]]; then
      ok=1
    elif acl_sau=$(psql_mot_cau "$LOAI_TRU_DB" "SELECT COALESCE(datacl::text, 'NULL') FROM pg_catalog.pg_database WHERE datname = '$LOAI_TRU_DB'") \
      && [[ "$acl_sau" == "$LOAI_TRU_ACL" ]]; then
      ok=1
    else
      echo "✗ datacl sau khi trả ('$acl_sau') KHÁC bản lưu ('$LOAI_TRU_ACL')." >&2
    fi
  fi
  if [[ "$ok" -eq 1 ]]; then
    rm -f -- "$TEP_DANG_DO" || echo "!!! Không xoá được tệp đánh dấu '$TEP_DANG_DO' — xoá tay trước lượt sau." >&2
    echo "✓ Đã mở lại đăng nhập role '$OWNER_ROLE' trên '$LOAI_TRU_DB'." >&2
    return 0
  fi
  echo "✗ KHÔNG mở lại được đăng nhập role '$OWNER_ROLE' — app/CLI sẽ không nối được '$LOAI_TRU_DB'. Mở tay:" >&2
  in_lenh_mo_tay "$che_do" >&2
  return 1
}

# Thoát trong VÙNG PHÁ HUỶ (arg1 = mã thoát, arg2 = kiểu: ngat | loi | exit) ⇒ GIỮ khoá + tệp đánh dấu
# (ghi lý do + bước dở), in cách kiểm schema + lệnh mở tay. Ngoài vùng thì không làm gì (lối thoát gọi
# mở lại như thường). Idempotent (xoá `LOAI_TRU_CHE_DO` ⇒ `mo_lai_dang_nhap` không mở). Trong subshell
# bỏ qua — trạng thái ở đó là bản sao.
giu_khoa_neu_dang_pha_huy() {
  [[ "${BASH_SUBSHELL:-0}" -eq 0 ]] || return 0
  [[ -n "$BUOC_PHA_HUY" && -n "$LOAI_TRU_CHE_DO" ]] || return 0
  local che_do=$LOAI_TRU_CHE_DO ma=$1 kieu=$2 buoc=$BUOC_PHA_HUY
  LOAI_TRU_CHE_DO=""   # don_dep_khi_thoat sẽ KHÔNG mở lại
  {
    if [[ "$kieu" == ngat ]]; then
      echo "bi_ngat_giua_nap=$(date '+%Y-%m-%d %H:%M:%S %z') ma=$ma buoc_do=$buoc"
      echo "# Bị ngắt SAU khi đã DROP — kiểm hết tiến trình nạp/trả quyền trong container trước khi mở tay."
    else
      echo "loi_sau_drop=$(date '+%Y-%m-%d %H:%M:%S %z') ma=$ma kieu=$kieu buoc_do=$buoc"
      echo "# Lỗi SAU khi đã DROP — schema '${SCHEMA:-?}' đang DỞ (bước '$buoc' chưa xong)."
    fi
  } >> "$TEP_DANG_DO" 2>/dev/null || true
  {
    if [[ "$kieu" == ngat ]]; then
      echo "!!! Bị ngắt (mã $ma) ở bước '$buoc' SAU khi đã DROP schema '${SCHEMA:-?}' của '$LOAI_TRU_DB' — 'docker exec'"
      echo "    không chuyển tín hiệu vào container nên pg_restore/psql/ALTER … OWNER CÓ THỂ VẪN ĐANG CHẠY."
    else
      echo "!!! Lỗi (mã $ma) ở bước '$buoc' SAU khi đã DROP schema '${SCHEMA:-?}' của '$LOAI_TRU_DB' — schema đang DỞ"
      echo "    (nạp thiếu bảng/dữ liệu, hoặc role app chưa được trả đủ quyền). Đọc dòng lỗi phía trên."
    fi
    echo "    KHÔNG mở lại đăng nhập role '$OWNER_ROLE', GIỮ tệp đánh dấu '$TEP_DANG_DO'. Schema đang DỞ — đừng bật app."
    echo "    1) Kiểm còn tiến trình nạp/trả quyền không:"
    echo "         docker exec $CONTAINER ps aux | grep -E 'pg_restore|psql' | grep -v grep"
    echo "         docker exec $CONTAINER psql -U supabase_admin -d $LOAI_TRU_DB -X -c \"SELECT pid, state, query_start, left(query, 60) FROM pg_stat_activity WHERE usename = 'supabase_admin' AND datname = '$LOAI_TRU_DB' AND pid <> pg_backend_pid();\""
    echo "       và xem schema đang dở tới đâu (số bảng; đối chiếu với bản dump):"
    echo "         docker exec $CONTAINER psql -U supabase_admin -d $LOAI_TRU_DB -X -c \"SELECT count(*) AS so_bang FROM pg_tables WHERE schemaname = '${SCHEMA:-?}';\""
    echo "    2) Chờ chúng xong (hoặc pg_cancel_backend), sửa nguyên nhân lỗi (đầy đĩa, dump hỏng…), rồi mở tay:"
    in_lenh_mo_tay "$che_do"
    echo "    3) Chạy lại restore.sh từ đầu để có schema trọn vẹn (lượt mới DROP + nạp lại sạch). Đừng bật app trước đó."
  } >&2
}

bi_ngat() {
  giu_khoa_neu_dang_pha_huy "$1" ngat
  exit "$1"
}

# Trap ERR. Trong VÙNG PHÁ HUỶ ⇒ giữ khoá (lệnh chết vì TÍN HIỆU — mã > 128, Ctrl-C tới cả nhóm tiến
# trình, docker CLI chết trước khi bash kịp chạy trap INT — tính là bị ngắt). Ngoại lệ: chính lệnh DROP
# lỗi THƯỜNG ⇒ transaction đã rollback, schema còn nguyên ⇒ mở lại như mọi lỗi trước DROP.
khi_loi() {
  if [[ -n "$BUOC_PHA_HUY" ]]; then
    if [[ "$1" -gt 128 ]]; then
      giu_khoa_neu_dang_pha_huy "$1" ngat
      return 0
    fi
    if [[ "$BUOC_PHA_HUY" != drop ]]; then
      giu_khoa_neu_dang_pha_huy "$1" loi
      return 0
    fi
  fi
  mo_lai_dang_nhap || true
}

# Trap EXIT DUY NHẤT: mở lại (nếu còn khoá) + dọn mọi file tạm. Giữ mã thoát gốc; mở hỏng mà mã gốc là
# 0 thì thoát 1 — không bao giờ báo thành công với role còn khoá. Còn trong VÙNG PHÁ HUỶ (vd `exit`
# tường minh, trap ERR không chạy) ⇒ giữ khoá thay vì mở.
don_dep_khi_thoat() {
  local ma=$?
  if [[ -n "$BUOC_PHA_HUY" ]]; then
    giu_khoa_neu_dang_pha_huy "$ma" exit
    if [[ "$ma" -eq 0 ]]; then ma=1; fi
  fi
  if ! mo_lai_dang_nhap; then
    if [[ "$ma" -eq 0 ]]; then ma=1; fi
  fi
  don_tep_tam
  exit "$ma"
}

main() {
  # Trap cài ở ĐÂY, không ở mức file: test `source` restore.sh để gọi từng hàm thì không dính trap.
  set -E
  trap 'khi_loi $?' ERR
  trap 'don_dep_khi_thoat' EXIT
  trap 'bi_ngat 130' INT
  trap 'bi_ngat 143' TERM

  # --- 0) Tham số --------------------------------------------------------
  if [[ $# -lt 1 || $# -gt 3 ]]; then
    echo "Cách dùng: bash deploy/restore.sh <dump> [db] [schema]" >&2
    echo "  vd DB chung (mặc định postgres/app): bash deploy/restore.sh hogikids-20260716.dump" >&2
    echo "  vd DB riêng cũ (grace, pre-cutover): bash deploy/restore.sh hogikids-20260716.dump hogikids public" >&2
    exit 1
  fi
  local F=$1
  local DB="${2:-${DB:-$DB_DEFAULT}}"
  local SCHEMA="${3:-${SCHEMA:-$SCHEMA_DEFAULT}}"

  if [[ ! -f "$F" ]]; then
    echo "Lỗi: không thấy file '$F'." >&2
    exit 1
  fi
  # Kiểm TRƯỚC khi đụng DB: thiếu file này thì bước cuối hỏng SAU KHI schema đã bị thay.
  if [[ ! -r "$THU_HOI_PHIEN_SQL" ]]; then
    echo "Lỗi: thiếu '$THU_HOI_PHIEN_SQL' (bước thu hồi phiên sau phục hồi) — chạy restore.sh từ repo đầy đủ. DB KHÔNG bị đụng." >&2
    exit 1
  fi
  # DB/SCHEMA được nội suy thẳng vào SQL + tên container → chỉ cho phép identifier an toàn.
  if ! [[ "$DB" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "Lỗi: tên DB '$DB' không hợp lệ (chỉ chữ/số/_ , bắt đầu bằng chữ hoặc _)." >&2
    exit 1
  fi
  if ! [[ "$SCHEMA" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "Lỗi: tên schema '$SCHEMA' không hợp lệ (chỉ chữ/số/_ , bắt đầu bằng chữ hoặc _)." >&2
    exit 1
  fi
  # Regex qua biến: bash 3.2 (macOS — máy chạy test) parse ngoặc tròn trần trong `=~` không ổn định.
  local re_container='^supabase-db(-[a-z0-9]+)?$' re_so='^[0-9]+$'
  if ! [[ "$CONTAINER" =~ $re_container ]]; then
    echo "Lỗi: container DB '$CONTAINER' không hợp lệ (chỉ supabase-db hoặc supabase-db-<hậu tố>)." >&2
    exit 1
  fi
  if ! [[ "$HAN_CHO_HET_PHIEN_LAN" =~ $re_so && "$HAN_CHO_HET_PHIEN_LAN" -ge 1 && "$NGU_GIUA_LAN_KIEM_PHIEN" =~ $re_so ]]; then
    echo "Lỗi: RESTORE_HAN_CHO_HET_PHIEN_LAN / RESTORE_NGU_GIUA_LAN_KIEM phải là số nguyên (lần ≥ 1)." >&2
    exit 1
  fi
  APP_CONTAINER="hogikids-app${CONTAINER#supabase-db}"
  TEP_DANG_DO="${RESTORE_TEP_DANG_DO:-${HOME:?thiếu HOME}/docker/backups/.restore-dang-do}"

  # --- 0b) Preflight loại trừ (TRƯỚC mọi thao tác DB) ------------------------
  kiem_tep_dang_do || exit 1
  if [[ "$DB" == "$DB_SUPABASE_CHUNG" ]]; then
    kiem_app_da_dung || exit 1
  fi

  # --- 1) Cảnh báo + xác nhận (TRƯỚC mọi thao tác DB) --------------------
  echo "!!! CẢNH BÁO: thao tác này THAY SẠCH schema '$SCHEMA' của DB '$DB' (container '$CONTAINER')." >&2
  echo "    Chỉ schema '$SCHEMA' bị ghi đè bằng nội dung của: $F" >&2
  echo "    (Các schema khác — gồm schema hệ thống Supabase — KHÔNG bị đụng.)" >&2
  printf "Gõ 'y' để tiếp tục [y/N]: " >&2
  read -r confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "Đã huỷ. DB KHÔNG bị đụng." >&2
    exit 1
  fi

  # --- 2) Nhận diện định dạng qua magic byte (CHƯA đụng DB) --------------
  # PGDMP = 50 47 44 4d 50 (custom -Fc);  gzip = 1f 8b (plain .sql.gz).
  local magic5 fmt
  magic5=$(head -c 5 "$F" | od -v -An -tx1 | tr -d ' \n')
  if [[ "$magic5" == 5047444d50* ]]; then
    fmt=custom
  elif [[ "${magic5:0:4}" == "1f8b" ]]; then
    fmt=gzip
  else
    echo "Lỗi: file không hợp lệ (chỉ nhận .dump custom PGDMP hoặc .sql.gz)." >&2
    exit 1
  fi

  # --- 3) custom (.dump `pg_dump -Fc`) ----------------------------------
  # Kiểm TOC (chỉ schema đích) → nạp với `-n <schema>` (backstop cứng). pg_restore
  # --clean --if-exists tự drop + tạo lại object; --exit-on-error fail-loud khi hỏng.
  if [[ "$fmt" == "custom" ]]; then
    echo ">> Kiểm TOC dump (chỉ cho phép schema '$SCHEMA')..." >&2
    local toc
    toc=$(docker exec -i "$CONTAINER" pg_restore -l < "$F") || {
      echo "Lỗi: không đọc được TOC (pg_restore -l) từ '$F' — file có thể hỏng. TỪ CHỐI." >&2
      exit 1
    }
    printf '%s\n' "$toc" | assert_toc_only_schema "$SCHEMA" || {
      echo "Lỗi: dump chứa object NGOÀI schema '$SCHEMA' — TỪ CHỐI (nghi dump full-DB / hệ thống Supabase)." >&2
      exit 1
    }

    # --- SOI NỘI DUNG, KHÔNG CHỈ TOC (thêm 22/09/2026) -------------------
    # TOC chỉ nói dump ĐỤNG NHỮNG OBJECT NÀO, không nói câu lệnh bên trong LÀ GÌ. Một .dump chế
    # tác có TOC hoàn toàn hợp lệ (entry TABLE DATA, namespace đúng) nhưng bên trong chứa
    # `COPY … FROM PROGRAM '<lenh OS>'` thì lọt sạch qua assert_toc_only_schema.
    #
    # ĐƯỜNG NÀY LÀ ĐƯỜNG KHAI THÁC THẬT, không phải đường app: lệnh nạp dưới đây chạy
    # `-U supabase_admin` = SUPERUSER THẬT, mà `COPY … FROM PROGRAM` đòi đúng quyền đó. Đo
    # 22/09/2026 trên prod: role app (`hogikids`) KHÔNG superuser và KHÔNG thuộc
    # `pg_execute_server_program` ⇒ qua app câu đó bị chính Postgres từ chối; qua đây thì không.
    #
    # `pg_restore` KHÔNG có `-d` thì KHÔNG mở kết nối DB — nó chỉ dịch archive thành SQL phẳng ra
    # `-f -`. Bộ cờ phải TRÙNG bộ cờ chọn-lọc của lệnh nạp bên dưới (nhất là `-n "$SCHEMA"`):
    # bung mà thiếu `-n` thì văn bản soi có entry ngoài schema mà lệnh nạp vốn sẽ bỏ qua ⇒ guard
    # (a)/(e) TỪ CHỐI OAN chính bản dump HỢP LỆ — lỗi nguy hiểm nhất của đường DR.
    # Ghi ra FILE rồi mới soi (không pipe): `assert_sql_only_schema` nhận ĐƯỜNG DẪN và chạy awk
    # trên FILE, không nhận stdin.
    # SỐ ĐO THẬT trên minipc 23/09/2026, dump prod `hogikids-20260923-0400.dump`:
    #   dump `-Fc`        56,6 MiB (59.338.339 B)
    #   bung ra SQL phẳng 621,4 MiB (651.537.972 B) · 327.155 dòng · 45 khối COPY · 1,45 s
    #   assert_sql_only_schema  3,5-3,6 s · RSS đỉnh 111 MiB (0,18× kích thước file)
    #   trọn lượt restore.sh vào DB nháp: 24 s, mã thoát 0
    # RSS thấp vì `normalize_sql_statements` BỎ payload COPY — mà payload chiếm gần trọn 621 MiB:
    # bản chuẩn hoá `$norm` chỉ còn 57 KB / 488 dòng, nên 13 lượt grep chạy trên file tí hon.
    # ⚠️ ĐỪNG nói "awk đọc theo dòng nên bộ nhớ không phụ thuộc kích thước": chi phí phụ thuộc HÌNH
    # DẠNG file, không phải kích thước. Với SQL dạng TOÀN CÂU LỆNH (dump `--inserts`, không có khối
    # COPY) `buf` gom cả file rồi mới `split` ⇒ đo được 7,3× RSS và thời gian BẬC HAI (2MB → 14,6s,
    # 4MB → 77,1s). Dump của hệ thống này luôn COPY-nặng nên rơi vào cột 0,18×.
    #
    # 🔴 LỐI THOÁT CÓ CHỦ ĐÍCH — `BO_QUA_KIEM_NOI_DUNG_DUMP=1`.
    # Bước soi này chạy TRỌN bộ guard của đường plain, gồm cả (h) "chuỗi nháy trải nhiều dòng". Đo
    # 22/09/2026: một dump HỢP LỆ có `COMMENT ON … IS 'nhiều\ndòng'` — thứ Supabase Studio ghi mỗi
    # khi ai đó điền ô "Description" — bị (h) TỪ CHỐI. Trước bản vá, đường `.dump` nhận nó (chỉ soi
    # TOC) và chính vì vậy nó ĐANG được ghi khắp code là "lối thoát khi guard plain từ chối oan".
    # Siết mà không chừa cửa nghĩa là chủ shop mất ĐƯỜNG PHỤC HỒI CUỐI CÙNG, đúng lúc thảm hoạ.
    # ⇒ Mặc định vẫn CHẶT; cửa mở phải GÕ TAY và in rõ đang mất lớp nào.
    # Rủi ro còn lại CÓ TRẦN: guard TOC vẫn chạy, và lệnh nạp vẫn `pg_restore -n "$SCHEMA"` — chốt
    # cứng chỉ nạp object trong schema đích. Thứ mất đi là chặn NỘI DUNG (PROGRAM / đặc quyền /
    # meta-command), tức đúng phần chỉ có ý nghĩa với file KHÔNG do hệ thống này tạo ra.
    if [[ "${BO_QUA_KIEM_NOI_DUNG_DUMP:-}" == "1" ]]; then
      echo "!!! BỎ QUA kiểm nội dung dump (BO_QUA_KIEM_NOI_DUNG_DUMP=1)." >&2
      echo "    CÒN: guard TOC + nạp bằng 'pg_restore -n $SCHEMA' (chỉ đụng schema đích)." >&2
      echo "    MẤT: chặn COPY … FROM/TO PROGRAM, câu lệnh đặc quyền, meta-command psql." >&2
      echo "    CHỈ dùng cho bản backup do CHÍNH hệ thống này tạo ra và bạn tin nguồn gốc." >&2
    else
      echo ">> Bung dump ra SQL phẳng để soi NỘI DUNG (không chỉ TOC)..." >&2
      local sql_bung
      sql_bung=$(mktemp "${TMPDIR:-/tmp}/hogikids-bung-XXXXXX")
      dang_ky_tep_tam "$sql_bung"   # don_dep_khi_thoat dọn ở mọi lối thoát — KHÔNG đặt bẫy thoát riêng
      docker exec -i "$CONTAINER" pg_restore --clean --if-exists --exit-on-error \
        --no-owner --no-privileges -n "$SCHEMA" -f - < "$F" > "$sql_bung" || {
        echo "Lỗi: không bung được '$F' ra SQL phẳng (pg_restore -f -) — file có thể hỏng. TỪ CHỐI." >&2
        exit 1
      }
      echo ">> Kiểm nội dung SQL bung từ dump (chỉ cho phép schema '$SCHEMA')..." >&2
      assert_sql_only_schema "$SCHEMA" "$sql_bung" || {
        echo "" >&2
        echo "    Nếu đây là bản backup do CHÍNH hệ thống này tạo ra và bạn tin nó, chạy lại:" >&2
        echo "      BO_QUA_KIEM_NOI_DUNG_DUMP=1 bash deploy/restore.sh $F $DB $SCHEMA" >&2
        echo "    (guard TOC + 'pg_restore -n $SCHEMA' vẫn chạy — xem runbook DR.)" >&2
        exit 1
      }
      rm -f "$sql_bung"
    fi
    # Dọn schema TRƯỚC khi nạp — `--clean` KHÔNG đủ: nó chỉ drop object CÓ trong TOC, nên bảng/cột
    # sinh ra SAU thời điểm sao lưu (migration mới) sống sót và trộn vào bản vừa phục hồi. Đo thật
    # 29/07: restore một dump 1 bảng vào schema đang có thêm bảng lạ ⇒ bảng lạ VẪN CÒN; thêm bước
    # dọn này thì đúng chỉ còn nội dung của bản dump. Dump custom KHÔNG tự tạo schema (cờ `-n` bỏ
    # qua entry SCHEMA) nên phải tạo lại ngay tại đây.
    # Khoá MUỘN: mọi guard file đã qua, bước kế tiếp là phá huỷ.
    khoa_dang_nhap_role_app "$DB" "$SCHEMA"
    echo ">> Dọn schema '$SCHEMA' của '$DB' (thay sạch, không để sót object sinh sau backup)..." >&2
    BUOC_PHA_HUY=drop
    drop_schema_dich "$DB" "$SCHEMA" ""
    BUOC_PHA_HUY=nap
    echo ">> Phục hồi custom dump vào '$DB' (schema '$SCHEMA')..." >&2
    docker exec -i "$CONTAINER" pg_restore --clean --if-exists --exit-on-error \
      --no-owner --no-privileges -n "$SCHEMA" -U supabase_admin -d "$DB" < "$F"
  else
    # --- 4) gzip (.sql.gz) — CHỐT AN TOÀN C1 ----------------------------
    # PHẢI chặn `.tar.gz` toàn-server (magic gzip GIỐNG .sql.gz) TRƯỚC khi DROP
    # SCHEMA. Nếu không, đường plain sẽ xoá schema RỒI mới fail nạp → hỏng schema
    # đúng lúc cần phục hồi. Kiểm ustar@257 + nội dung-giống-SQL, cả hai chạy
    # TRƯỚC bất kỳ thao tác DB nào.
    # od -v: KHÔNG gộp dòng zero trùng (BSD/GNU od mặc định thay bằng '*' → lệch offset).
    # `|| true`: file lớn → head đóng pipe sớm → gunzip nhận SIGPIPE (141); pipefail+set -e
    # sẽ kill script oan. Chỉ cần 512 byte đầu (đã bắt xong trước khi SIGPIPE) → nuốt 141.
    local head_hex unz_head trimmed upper looks_sql
    head_hex=$(gunzip -c "$F" 2>/dev/null | head -c 512 | od -v -An -tx1 | tr -d ' \n') || true

    # TAR: "ustar" (75 73 74 61 72) tại offset 257 → offset 514 trong chuỗi hex.
    if [[ "${head_hex:514:10}" == "7573746172" ]]; then
      echo "Lỗi: đây là .tar.gz backup-TOÀN-SERVER, KHÔNG dùng để phục hồi 1 DB." >&2
      echo "      Dùng bản 'hogikids-*.dump' 1-DB (xem deploy/huong-dan-trien-khai-minipc.md)." >&2
      exit 1
    fi

    # Nội dung phải "trông giống SQL": bỏ null + khoảng trắng đầu rồi so tiền tố.
    unz_head=$(gunzip -c "$F" 2>/dev/null | head -c 512 | tr -d '\000') || true
    trimmed=${unz_head#"${unz_head%%[![:space:]]*}"}
    upper=$(printf '%s' "$trimmed" | tr '[:lower:]' '[:upper:]')
    looks_sql=0
    case "$upper" in
      --* | "SET "* | "CREATE "* | BEGIN* | "ALTER "* | COMMENT* | "\\CONNECT"* | "SELECT "*)
        looks_sql=1 ;;
    esac
    if [[ "$looks_sql" -ne 1 ]]; then
      echo "Lỗi: nội dung file không phải SQL hợp lệ — file có thể hỏng hoặc sai định dạng." >&2
      exit 1
    fi

    # Giải nén TOÀN BỘ ra file tạm (grep trên FILE an toàn với pipefail; nạp bằng
    # chính file này, không gunzip lại). Trap dọn file tạm ở mọi lối thoát.
    local sql_tmp
    sql_tmp=$(mktemp "${TMPDIR:-/tmp}/hogikids-restore-XXXXXX")
    dang_ky_tep_tam "$sql_tmp"   # don_dep_khi_thoat dọn ở mọi lối thoát — KHÔNG đặt bẫy thoát riêng
    gunzip -c "$F" > "$sql_tmp"

    # Guard schema-scoped cho plain SQL (đường plain KHÔNG có `-n` backstop).
    echo ">> Kiểm SQL plain (chỉ cho phép schema '$SCHEMA', cấm đụng schema hệ thống)..." >&2
    assert_sql_only_schema "$SCHEMA" "$sql_tmp" || exit 1

    # Qua tất cả guard → GIỜ mới được đụng DB. Dọn schema đích (dump plain không --clean).
    # CHỈ tạo lại schema khi chính dump KHÔNG tự tạo: `pg_dump -Fp -n` luôn phát
    # `CREATE SCHEMA <đích>;`, tạo trước là psql chết ở "đã tồn tại" ngay sau khi vừa drop
    # ⇒ mất sạch (đã tái hiện trên DB test 29/07). Xem `drop_schema_dich`.
    local dump_tu_tao=""
    if grep -iEq "(^|;)[[:space:]]*CREATE[[:space:]]+SCHEMA[[:space:]]+(IF[[:space:]]+NOT[[:space:]]+EXISTS[[:space:]]+)?\"?${SCHEMA}\"?([^[:alnum:]_]|$)" "$sql_tmp"; then
      dump_tu_tao=1
    fi
    # Khoá MUỘN: mọi guard file đã qua, bước kế tiếp là phá huỷ.
    khoa_dang_nhap_role_app "$DB" "$SCHEMA"
    echo ">> Dọn schema '$SCHEMA' của '$DB' (dump tự tạo schema: ${dump_tu_tao:-không})..." >&2
    BUOC_PHA_HUY=drop
    drop_schema_dich "$DB" "$SCHEMA" "$dump_tu_tao"
    BUOC_PHA_HUY=nap
    echo ">> Nạp SQL vào '$DB' (schema '$SCHEMA')..." >&2
    docker exec -i "$CONTAINER" psql -U supabase_admin -d "$DB" -v ON_ERROR_STOP=1 < "$sql_tmp"

    rm -f "$sql_tmp"
  fi

  # --- 5) Hậu kỳ BẮT BUỘC ------------------------------------------------
  # Restore chạy `-U supabase_admin --no-owner --no-privileges` → object thuộc `supabase_admin` và
  # sạch ACL: role app mất quyền (app chết sau DR), role chỉ-đọc n8n mất quyền đọc kho khoá (9
  # workflow chết trong im lặng), enum/function ở lại owner cũ (migration sau này bị từ chối).
  # Trả owner + cấp lại quyền CHỈ trong schema đích (KHÔNG REASSIGN OWNED). Vẫn trong VÙNG PHÁ HUỶ: lỗi /
  # ngắt giữa chừng là role app thiếu quyền một phần ⇒ giữ khoá; xong trọn mới ra khỏi vùng.
  BUOC_PHA_HUY=tra_quyen
  reassign_owner_scoped "$DB" "$SCHEMA"
  BUOC_PHA_HUY=""

  # --- 5b) Mở SỚM đăng nhập role app -------------------------------------
  # TRƯỚC bước thu hồi phiên: nó có thể thoát mã 3 và hướng dẫn `prisma migrate deploy` — lệnh đó chạy
  # bằng role app, role còn khoá là hướng dẫn chết ngay bước đầu. Bước thu hồi chạy bằng supabase_admin
  # nên không cần khoá; app (đích postgres) vẫn đang dừng tới khi người vận hành `up -d`.
  if ! mo_lai_dang_nhap; then
    echo "    Dữ liệu ĐÃ nạp + trả quyền xong; CHƯA thu hồi phiên. GIỮ APP DỪNG. Sau khi mở tay, chạy tiếp:" >&2
    echo "      docker exec -i $CONTAINER psql -U supabase_admin -d $DB -X -v ON_ERROR_STOP=1 < deploy/thu-hoi-phien-sau-phuc-hoi.sql" >&2
    exit 1
  fi

  # --- 6) Thu hồi mọi phiên (BƯỚC CUỐI) ----------------------------------
  # Lỗi ⇒ `set -e` dừng script, exit ≠ 0 — dữ liệu đã nạp nhưng cookie đời dump chưa bị chặn. Dump đời
  # trước phân quyền ⇒ thoát `MA_THOAT_CHUA_XONG`. Gọi TRẦN (không `||`, không `if`): đặt trong ngữ cảnh
  # điều kiện là `set -e` tắt bên trong hàm và mã lỗi bị nuốt — dòng ✓ in ra dù chưa thu hồi.
  thu_hoi_phien_sau_phuc_hoi "$DB" "$SCHEMA"

  echo "✓ Phục hồi schema '$SCHEMA' của '$DB' xong. Đăng nhập app bằng mật khẩu tại thời điểm bản backup." >&2
}

# Chỉ chạy main khi file được EXECUTE trực tiếp; cho phép `source` để unit-test guard.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
