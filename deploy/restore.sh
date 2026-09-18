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
CONTAINER=supabase-db
OWNER_ROLE=hogikids

# Role CHỈ-ĐỌC của n8n (đọc kho khoá `Setting`). Thay sạch schema + `pg_restore --no-privileges`
# xoá cả ACL, nên hậu kỳ phải cấp lại — nếu không, 10 workflow n8n chết ở node lấy khoá trong khi
# app vẫn đăng nhập bình thường (ingest/ads/webhook tắt câm, không có báo động).
N8N_RO_ROLE=n8n_config_ro

# Schema HỆ THỐNG Supabase self-host — đồng bộ với SUPABASE_SYSTEM_SCHEMAS trong
# src/lib/backup/assert-plain-sql-only-schema.ts (bản twin TS). Sửa một bên PHẢI sửa bên kia:
# hiện chỉ có parity theo phán quyết trên fixture, KHÔNG có test nào so hai DANH SÁCH.
SYSTEM_SCHEMAS="auth storage vault realtime graphql extensions supabase_functions _realtime pgbouncer net cron pgsodium supabase_migrations"

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
      n = split("TABLE DATA|SEQUENCE SET|SEQUENCE OWNED BY|MATERIALIZED VIEW DATA|MATERIALIZED VIEW|FK CONSTRAINT|CHECK CONSTRAINT|DEFAULT ACL|EVENT TRIGGER|ROW SECURITY|PUBLICATION TABLE|FOREIGN TABLE|OPERATOR CLASS|OPERATOR FAMILY|ACCESS METHOD|SHELL TYPE|USER MAPPING|DATABASE PROPERTIES|LARGE OBJECT|PROCEDURAL LANGUAGE|FOREIGN DATA WRAPPER|TEXT SEARCH CONFIGURATION|TEXT SEARCH DICTIONARY|TEXT SEARCH PARSER|TEXT SEARCH TEMPLATE|TABLE|SEQUENCE|VIEW|INDEX|CONSTRAINT|DEFAULT|ACL|TRIGGER|FUNCTION|PROCEDURE|AGGREGATE|TYPE|DOMAIN|SCHEMA|EXTENSION|COMMENT|POLICY|RULE|STATISTICS|ENCODING|STDSTRINGS|SEARCHPATH|DATABASE|COLLATION|CONVERSION|OPERATOR|CAST|TRANSFORM|SERVER|BLOB|BLOBS|PUBLICATION", a, "|")
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
      if ($0 ~ /^\\\.[ \t]*$/) { incopy = 0; ncopy = 0 }
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
  local schema=$1 sqlfile=$2 sys verb_re sys_re pat schema_ddl foreign norm normf

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
  norm=$(mktemp "${TMPDIR:-/tmp}/hogikids-norm.XXXXXX.sql")
  normf=$(mktemp "${TMPDIR:-/tmp}/hogikids-normf.XXXXXX.sql")
  trap 'rm -f "$norm" "$normf"' RETURN
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
  if [[ "$dump_tu_tao" == "1" ]]; then
    sql="DROP SCHEMA IF EXISTS \"$schema\" CASCADE;"
  else
    sql="DROP SCHEMA IF EXISTS \"$schema\" CASCADE; CREATE SCHEMA \"$schema\";"
  fi
  docker exec -i "$CONTAINER" psql -U supabase_admin -d "$db" -v ON_ERROR_STOP=1 -c "$sql"
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
  local db=$1 schema=$2
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
\$\$;
DO \$\$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$N8N_RO_ROLE') THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO $N8N_RO_ROLE', '$schema');
    -- Tu 2026-08-21: role doc VIEW SettingN8n thay bang Setting goc (view loai 2 khoa ha tang
    -- n8nApiKey/n8nDbRoPassword — xem src/lib/n8n/role-doc-kho-khoa.ts, phai khop hang N8N_SETTING_VIEW).
    IF to_regclass(format('%I.%I', '$schema', 'SettingN8n')) IS NULL THEN
      RAISE NOTICE 'Khong thay view %.\"SettingN8n\" — bo qua GRANT SELECT (ban dump qua cu?).', '$schema';
    ELSE
      EXECUTE format('GRANT SELECT ON %I.%I TO $N8N_RO_ROLE', '$schema', 'SettingN8n');
    END IF;
  ELSE
    RAISE NOTICE 'Chua co role $N8N_RO_ROLE — bo qua cap quyen doc. Workflow n8n se chet o node lay khoa cho toi khi tao role (xem runbook DR muc 11, buoc tao role $N8N_RO_ROLE).';
  END IF;
END
\$\$;"
}

main() {
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
  # DB/SCHEMA được nội suy thẳng vào SQL + tên container → chỉ cho phép identifier an toàn.
  if ! [[ "$DB" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "Lỗi: tên DB '$DB' không hợp lệ (chỉ chữ/số/_ , bắt đầu bằng chữ hoặc _)." >&2
    exit 1
  fi
  if ! [[ "$SCHEMA" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "Lỗi: tên schema '$SCHEMA' không hợp lệ (chỉ chữ/số/_ , bắt đầu bằng chữ hoặc _)." >&2
    exit 1
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
    # Dọn schema TRƯỚC khi nạp — `--clean` KHÔNG đủ: nó chỉ drop object CÓ trong TOC, nên bảng/cột
    # sinh ra SAU thời điểm sao lưu (migration mới) sống sót và trộn vào bản vừa phục hồi. Đo thật
    # 29/07: restore một dump 1 bảng vào schema đang có thêm bảng lạ ⇒ bảng lạ VẪN CÒN; thêm bước
    # dọn này thì đúng chỉ còn nội dung của bản dump. Dump custom KHÔNG tự tạo schema (cờ `-n` bỏ
    # qua entry SCHEMA) nên phải tạo lại ngay tại đây.
    echo ">> Dọn schema '$SCHEMA' của '$DB' (thay sạch, không để sót object sinh sau backup)..." >&2
    drop_schema_dich "$DB" "$SCHEMA" ""
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
    sql_tmp=$(mktemp "${TMPDIR:-/tmp}/hogikids-restore.XXXXXX.sql")
    trap 'rm -f "$sql_tmp"' EXIT
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
    echo ">> Dọn schema '$SCHEMA' của '$DB' (dump tự tạo schema: ${dump_tu_tao:-không})..." >&2
    drop_schema_dich "$DB" "$SCHEMA" "$dump_tu_tao"
    echo ">> Nạp SQL vào '$DB' (schema '$SCHEMA')..." >&2
    docker exec -i "$CONTAINER" psql -U supabase_admin -d "$DB" -v ON_ERROR_STOP=1 < "$sql_tmp"

    rm -f "$sql_tmp"
    trap - EXIT
  fi

  # --- 5) Hậu kỳ BẮT BUỘC ------------------------------------------------
  # Restore chạy `-U supabase_admin --no-owner --no-privileges` → object thuộc `supabase_admin` và
  # sạch ACL: role app mất quyền (app chết sau DR), role chỉ-đọc n8n mất quyền đọc kho khoá (9
  # workflow chết trong im lặng), enum/function ở lại owner cũ (migration sau này bị từ chối).
  # Trả owner + cấp lại quyền CHỈ trong schema đích (KHÔNG REASSIGN OWNED).
  reassign_owner_scoped "$DB" "$SCHEMA"

  echo "✓ Phục hồi schema '$SCHEMA' của '$DB' xong. Đăng nhập app bằng mật khẩu tại thời điểm bản backup." >&2
}

# Chỉ chạy main khi file được EXECUTE trực tiếp; cho phép `source` để unit-test guard.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
