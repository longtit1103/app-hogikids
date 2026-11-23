#!/usr/bin/env bash
# Tái hiện MỘT file migration trên DB NHÁP để thấy câu lỗi gốc (runbook triển khai ③a-6, bước (4)).
#
# Vì sao cần: `supabase-db` chạy `-c log_min_messages=fatal` ⇒ lỗi mức ERROR không vào log container; khi Prisma chỉ in
# "current transaction is aborted", cách thấy lỗi gốc là chạy lại ĐÚNG file migration bằng psql trên một DB NHÁP phục hồi
# từ dump mới nhất — psql in câu lỗi ở client.
#
# RÀO (cố ý chặt — chạy nhầm lên DB thật mà file KHÔNG lỗi thì migration COMMIT ngoài Prisma):
#  1. Tên DB phải khớp mẫu nháp `^nhap_[a-z0-9_]{1,50}$` (chỉ chữ thường, số, gạch dưới — không ký tự nào thoát được chuỗi
#     SQL). `postgres`, `template*`, `hogikids*`, mọi tên khác ⇒ TỪ CHỐI trước khi gọi psql.
#  2. Trong CHÍNH phiên psql chạy file, câu đầu kiểm `current_database()` = tên đã duyệt; khác ⇒ RAISE, `ON_ERROR_STOP`
#     dừng trước khi chạm file migration.
#  3. File truyền qua stdin (`-f -`) ⇒ chạy được với `docker exec -i` (đường dẫn host không có trong container).
#  4. CẤM metacommand psql: nội dung file có BẤT KỲ dấu `\` nào ⇒ TỪ CHỐI trước khi gọi psql. psql coi `\` ngoài chuỗi
#     là metacommand Ở BẤT KỲ ĐÂU trên dòng (kể cả sau một câu SQL: `SELECT 1; \connect postgres`) — `\c`/`\connect` đổi
#     sang DB thật vượt qua chốt (2), `\i`/`\ir`/`\include` nạp file khác, `\!` chạy lệnh shell, `\o` ghi file, `\set`
#     tắt ON_ERROR_STOP. Chặn theo NỘI DUNG, không theo tên/đường dẫn file. Cố ý chặt: migration có `\` trong chuỗi SQL
#     (2 migration cũ của repo) bị từ chối — script này chỉ dùng cho migration landSeq (0 dấu `\`).
#     Nội dung đọc MỘT lần vào biến rồi kiểm + chạy CHÍNH bản đó ⇒ file đổi giữa lúc kiểm và lúc chạy cũng không lọt.
#     Kiểm theo byte (`LC_ALL=C`) — byte UTF-8 hỏng cạnh `\` không làm lọt, thông báo vẫn in.
#
# KHÔNG PHẢI SANDBOX SQL: psql chạy bằng `supabase_admin` (superuser) ⇒ SQL THUẦN vẫn ra được ngoài DB nháp (`COPY …
# TO PROGRAM`, `dblink`, …). Rào chỉ chặn nhầm ĐÍCH kết nối + metacommand; script CHỈ dùng cho migration đã review trong
# repo, KHÔNG đưa file SQL lạ / chưa đọc vào.
#
# Dùng (trên minipc, sau khi đã phục hồi dump vào DB nháp — runbook DR "Diễn tập phục hồi"):
#   bash deploy/tai-hien-migration-tren-db-nhap.sh nhap_landseq_0711 \
#     prisma/migrations/20261106150000_raw_pancake_order_land_seq/migration.sql
# Biến `PSQL_CMD` (mặc định `docker exec -i supabase-db psql -U supabase_admin`) để test chạy với psql local.
set -euo pipefail

TEN="${1:-}"
FILE="${2:-prisma/migrations/20261106150000_raw_pancake_order_land_seq/migration.sql}"

if [[ ! "$TEN" =~ ^nhap_[a-z0-9_]{1,50}$ ]]; then
  echo "TỪ CHỐI: tên DB '$TEN' không khớp mẫu nháp ^nhap_[a-z0-9_]{1,50}\$ — chỉ chạy trên DB NHÁP phục hồi từ dump, KHÔNG BAO GIỜ trên postgres." >&2
  exit 64
fi
if [[ ! -f "$FILE" ]]; then
  echo "TỪ CHỐI: không thấy file migration '$FILE'." >&2
  exit 66
fi
NOI_DUNG="$(cat -- "$FILE")"
if [[ -z "$NOI_DUNG" ]]; then
  echo "TỪ CHỐI: file migration '$FILE' rỗng." >&2
  exit 65
fi
# Kiểm THEO BYTE (`LC_ALL=C`, `grep -a`): dưới locale UTF-8, dòng có byte UTF-8 hỏng làm `grep` không khớp — phép kiểm
# phải bắt `\` bất kể byte quanh nó.
# KHÔNG dùng `grep -q` qua pipe (grep thoát sớm ⇒ printf SIGPIPE dưới `pipefail` ⇒ rào LỌT file lớn), KHÔNG dùng
# here-string (bash cần file tạm; không ghi được file tạm thì lệnh trả 1 = trùng "không khớp" ⇒ rào LỌT — đo 07/11).
# `grep -c` đọc HẾT đầu vào; lấy mã thoát CẢ printf lẫn grep qua PIPESTATUS ngay trong subshell. CHỈ cho qua khi đúng
# "0|0|1" (grep đọc tới hết, đếm 0 dòng có `\`, printf ghi trọn). Đếm ≥ 1 ⇒ TỪ CHỐI 65. MỌI kết quả khác (lỗi đọc/ghi,
# grep lỗi, đầu ra lạ) ⇒ KHÔNG KIỂM ĐƯỢC ⇒ TỪ CHỐI 74 — không bao giờ coi là sạch. `set +e` CHỈ trong subshell này: ở
# chế độ POSIX (`bash --posix`, `POSIXLY_CORRECT`) `$(…)` kế thừa `set -e` ⇒ grep thoát 1 (file sạch) giết subshell
# trước `echo` ⇒ chặn oan; điều kiện mã printf / mã grep / số đếm ở dưới giữ nguyên.
KIEM="$(set +e; export LC_ALL=C; printf '%s\n' "$NOI_DUNG" | grep -c -a -F '\'; echo "|${PIPESTATUS[0]}|${PIPESTATUS[1]}")" || true
KIEM="${KIEM//$'\n'/}"
if [[ ! "$KIEM" =~ ^([0-9]+)\|([0-9]+)\|([0-9]+)$ ]]; then
  echo "TỪ CHỐI: KHÔNG KIỂM ĐƯỢC nội dung file '$FILE' (kết quả phép kiểm '${KIEM}') — không coi là sạch, không gọi psql." >&2
  exit 74
fi
SO_DONG="${BASH_REMATCH[1]}"; MA_PRINTF="${BASH_REMATCH[2]}"; MA_GREP="${BASH_REMATCH[3]}"
if [[ "$MA_PRINTF" = 0 && "$MA_GREP" = 0 && "$SO_DONG" != 0 ]]; then
  DONG="$(export LC_ALL=C; printf '%s\n' "$NOI_DUNG" | grep -n -a -F '\' | cut -d: -f1 | tr '\n' ' ' || true)"
  echo "TỪ CHỐI: file '$FILE' có dấu '\\' (metacommand psql: \\connect, \\c, \\i, \\ir, \\!, \\o, \\set…) ở dòng: ${DONG:-?} — không gọi psql." >&2
  exit 65
fi
if [[ "$SO_DONG" != 0 || "$MA_PRINTF" != 0 || "$MA_GREP" != 1 ]]; then
  echo "TỪ CHỐI: KHÔNG KIỂM ĐƯỢC nội dung file '$FILE' (đếm=${SO_DONG}, mã printf=${MA_PRINTF}, mã grep=${MA_GREP}) — không coi là sạch, không gọi psql." >&2
  exit 74
fi

read -r -a PSQL <<< "${PSQL_CMD:-docker exec -i supabase-db psql -U supabase_admin}"

echo ">> Tái hiện '$FILE' trên DB nháp '$TEN' (ON_ERROR_STOP, kiểm current_database() trước)..." >&2
printf '%s\n' "$NOI_DUNG" | "${PSQL[@]}" -X -v ON_ERROR_STOP=1 -d "$TEN" \
  -c "DO \$\$ BEGIN IF current_database() <> '$TEN' THEN RAISE EXCEPTION 'SAI ĐÍCH: đang nối % chứ không phải $TEN', current_database(); END IF; END \$\$" \
  -c 'SET search_path = app' \
  -f -
