#!/usr/bin/env bash
# So TẬP migration đã áp THÀNH CÔNG trên DB (tên + checksum) với MANIFEST migration của ĐÚNG ảnh app cũ đã ghim image ID
# — bằng chứng cho runbook triển khai ③a-6 "KHI MIGRATION THẤT BẠI" (chủ shop xét phương án lùi ảnh).
#
# KHỚP (thoát 0) CHỈ mô tả TẬP BẢN GHI đã đo: các dòng `_prisma_migrations` đã áp thành công (`finished_at` có, chưa
# `rolled_back_at`) có ĐÚNG tên + checksum trong manifest ảnh cũ VÀ ngược lại, và KHÔNG có dòng dở dang nào khác landSeq.
# KHỚP KHÔNG thay XÁC NHẬN schema (cột / sequence thật) và KIỂM PHIÊN phía server của runbook, và KHÔNG phải quyền tự lùi
# ảnh: script chỉ THU THẬP BẰNG CHỨNG; lùi ảnh / restore / `migrate resolve` là quyết định của chủ shop, duyệt từng lượt.
# Mọi ca khác ⇒ CHƯA ĐỦ CĂN CỨ (thoát 2): thiếu / hỏng `.deploy-vars`, ID ảnh không đầy đủ, ảnh không còn hoặc khác ID,
# lấy manifest lỗi / rỗng / sai dạng / có dòng trống, truy vấn DB lỗi / rỗng / sai dạng / có dòng trống, tên trùng, dòng
# dở dang (`finished_at` và `rolled_back_at` đều NULL) của migration khác landSeq, sort / so lỗi, hoặc hai tập lệch.
# "Kết quả rỗng" KHÁC "lệnh thất bại": mọi lệnh con kiểm mã thoát riêng; danh sách rỗng KHÔNG BAO GIỜ được coi là khớp.
# Không dùng mốc giờ (giờ `migrate deploy` lần đầu hay lần chạy lại) để kết luận — chỉ so tên + checksum.
#
# Checksum = sha256 hex của BYTE file `migration.sql` — đúng giá trị Prisma ghi vào `_prisma_migrations.checksum` (đo
# local 09/11/2026: 57/57 migration không sửa file sau khi áp đều khớp; migration sửa file sau khi áp thì lệch — đúng ý).
# Manifest đọc TRONG ảnh cũ: `docker run --rm --network none --pull never --entrypoint node <ID>` — không mạng, không
# DB, không kéo ảnh; thư mục `/app/prisma/migrations` (Dockerfile: WORKDIR /app, bước runner chép cả /app từ bước build).
#
# Dùng (trên host deploy, trong thư mục app; `.deploy-vars` có `OLD_IMAGE_ID` = ảnh đã ghim ở PREFLIGHT P3):
#   bash deploy/so-migration-da-ap-voi-anh-cu.sh .deploy-vars; echo "ma=$?"
# Thay lệnh `docker` / psql (`DOCKER_CMD`, `PSQL_CMD`) CHỈ trong chế độ thử TƯỜNG MINH `HK_SO_MIGRATION_CHE_DO_THU=1`.
# Đường production: thấy một trong hai biến (kể cả biến sót lại trong shell) ⇒ TỪ CHỐI (thoát 64) — không âm thầm trỏ
# sang docker / DB khác; KHÔNG in giá trị biến (có thể chứa thông tin kết nối).
set -u -o pipefail
set -f # tách từ của DOCKER_CMD / PSQL_CMD và danh sách dòng không được mở rộng ký tự đại diện

LANDSEQ="20261106150000_raw_pancake_order_land_seq"
NHAN_THU="" # chế độ thử: gắn vào CHÍNH dòng KẾT LUẬN — không chỉ dòng đầu, để kết quả thử không bị đọc nhầm là production
if [[ "${HK_SO_MIGRATION_CHE_DO_THU:-}" == 1 ]]; then
  NHAN_THU=" [CHẾ ĐỘ THỬ — KHÔNG phải kết quả production]"
  echo "CHẾ ĐỘ THỬ: lệnh docker / psql có thể đã bị thay (không dùng trên production)."
  DOCKER_CMD="${DOCKER_CMD:-docker}"
  PSQL_CMD="${PSQL_CMD:-docker exec supabase-db psql -U supabase_admin -d postgres}"
else
  if [[ -n "${DOCKER_CMD+x}" || -n "${PSQL_CMD+x}" ]]; then
    echo "TỪ CHỐI: biến DOCKER_CMD / PSQL_CMD đang được đặt (giá trị không in) — đường production chỉ dùng lệnh mặc định; unset rồi chạy lại." >&2
    exit 64
  fi
  DOCKER_CMD="docker"
  PSQL_CMD="docker exec supabase-db psql -U supabase_admin -d postgres"
fi
MAU_ID='^sha256:[0-9a-f]{64}$'
MAU_DONG='^[0-9]{14}_[a-z0-9_]+ [0-9a-f]{64}$'

chua_du() {
  echo "KẾT LUẬN${NHAN_THU}: CHƯA ĐỦ CĂN CỨ — $1 — KHÔNG kết luận được schema tương thích ảnh cũ; giữ app + nguồn ghi DỪNG, báo chủ shop."
  exit 2
}

if [[ $# -ne 1 || -z "${1:-}" ]]; then
  echo "Dùng: bash deploy/so-migration-da-ap-voi-anh-cu.sh <đường dẫn .deploy-vars>" >&2
  exit 64
fi
VARS="$1"

# ── Ảnh cũ đã ghim ────────────────────────────────────────────────────────────────────────────────────────────────
[[ -f "$VARS" && -r "$VARS" ]] || chua_du "không đọc được file '$VARS'"
DONG_ID="$(grep -E '^OLD_IMAGE_ID=' -- "$VARS")"
MA=$?
[[ $MA -eq 0 ]] || chua_du "'$VARS' không có dòng OLD_IMAGE_ID (grep thoát $MA)"
[[ "$DONG_ID" != *$'\n'* ]] || chua_du "'$VARS' có NHIỀU dòng OLD_IMAGE_ID"
ID="${DONG_ID#OLD_IMAGE_ID=}"
[[ "$ID" =~ $MAU_ID ]] || chua_du "OLD_IMAGE_ID '$ID' không phải ID đầy đủ sha256:<64 hex>"
echo "ảnh cũ đã ghim: $ID"

ID_THAT="$($DOCKER_CMD image inspect -f '{{.Id}}' "$ID")"
MA=$?
[[ $MA -eq 0 ]] || chua_du "không tra được ảnh $ID trên máy (docker image inspect thoát $MA)"
[[ "$ID_THAT" == "$ID" ]] || chua_du "ảnh tra được có ID '$ID_THAT' ≠ ID đã ghim"

# ── Danh sách "tên checksum": kiểm dạng từng dòng + không trùng tên ──────────────────────────────────────────────────
kiem_danh_sach() { # $1 = nhãn, $2 = nội dung
  local nhan="$1" noi_dung="$2" dong trung
  [[ -n "$noi_dung" ]] || chua_du "$nhan RỖNG (lệnh thoát 0 nhưng không có dòng nào)"
  # Dòng trống ở BẤT KỲ đâu (đầu / giữa; cuối đã bị `$(…)` cắt) ⇒ đầu ra lạ — vòng tách dòng dưới sẽ nuốt nó.
  [[ $'\n'"$noi_dung" != *$'\n\n'* && $'\n'"$noi_dung" != *$'\n'$'\r'* ]] || chua_du "$nhan có dòng TRỐNG / đầu ra lạ"
  local IFS=$'\n'
  for dong in $noi_dung; do
    [[ "$dong" =~ $MAU_DONG ]] || chua_du "$nhan có dòng sai dạng 'tên checksum': '$dong'"
  done
  trung="$(printf '%s\n' "$noi_dung" | cut -d' ' -f1 | LC_ALL=C sort | uniq -d)" || chua_du "không kiểm được tên trùng trong $nhan"
  [[ -z "$trung" ]] || chua_du "$nhan có tên migration TRÙNG: $trung"
}

# ── Manifest của ảnh cũ ─────────────────────────────────────────────────────────────────────────────────────────────
# Mỗi thư mục con = một migration; thiếu `migration.sql` ⇒ node ném lỗi ⇒ thoát khác 0 ⇒ CHƯA ĐỦ CĂN CỨ.
JS='const fs=require("fs"),c=require("crypto"),d=process.argv[1];
for (const n of fs.readdirSync(d).sort()) {
  if (!fs.statSync(d + "/" + n).isDirectory()) continue;
  const h = c.createHash("sha256").update(fs.readFileSync(d + "/" + n + "/migration.sql")).digest("hex");
  process.stdout.write(n + " " + h + "\n");
}'
MANIFEST="$($DOCKER_CMD run --rm --network none --pull never --entrypoint node "$ID" -e "$JS" /app/prisma/migrations)"
MA=$?
[[ $MA -eq 0 ]] || chua_du "lấy manifest migration từ ảnh cũ LỖI (docker run thoát $MA)"
kiem_danh_sach "manifest ảnh cũ" "$MANIFEST"

# ── Bản ghi _prisma_migrations: MỘT câu, MỘT snapshot ─────────────────────────────────────────────────────────────────
# Đã áp thành công (A), dở dang (D) và đã đánh dấu cuộn lại (R) đọc CÙNG một lần — hai câu riêng thì một migration đổi
# trạng thái giữa hai câu (dở dang → xong) có thể lọt cả hai. Dòng DỞ DANG: landSeq lỗi là ca dự kiến của runbook (chỉ in);
# migration KHÁC dở dang ⇒ trạng thái schema không đo được từ metadata ⇒ CHƯA ĐỦ CĂN CỨ.
SQL="BEGIN TRANSACTION READ ONLY; SET LOCAL statement_timeout = '10s'; \
SELECT CASE WHEN finished_at IS NOT NULL AND rolled_back_at IS NULL THEN 'A|' || migration_name || ' ' || checksum \
WHEN finished_at IS NULL AND rolled_back_at IS NULL THEN 'D|' || migration_name \
ELSE 'R|' || migration_name END FROM app._prisma_migrations ORDER BY 1; ROLLBACK"
BAN_GHI="$($PSQL_CMD -X -q -tA -v ON_ERROR_STOP=1 -c "$SQL")"
MA=$?
[[ $MA -eq 0 ]] || chua_du "truy vấn _prisma_migrations LỖI (psql thoát $MA)"
[[ -n "$BAN_GHI" ]] || chua_du "truy vấn _prisma_migrations RỖNG (lệnh thoát 0 nhưng không có dòng nào)"
[[ $'\n'"$BAN_GHI" != *$'\n\n'* ]] || chua_du "đầu ra truy vấn _prisma_migrations có dòng TRỐNG / đầu ra lạ"
DA_AP=""
DO_KHAC=""
IFS_CU="$IFS"
IFS=$'\n'
for dong in $BAN_GHI; do
  case "$dong" in
    A\|*) DA_AP+="${dong#A|}"$'\n' ;;
    D\|*)
      if [[ "${dong#D|}" == "$LANDSEQ" ]]; then echo "dòng dở dang (dự kiến khi migration landSeq lỗi): ${dong#D|}"
      else DO_KHAC+="${dong#D|} "; fi ;;
    R\|*) ;;
    *) IFS="$IFS_CU"; chua_du "đầu ra truy vấn _prisma_migrations có dòng lạ: '$dong'" ;;
  esac
done
IFS="$IFS_CU"
DA_AP="${DA_AP%$'\n'}"
kiem_danh_sach "danh sách migration đã áp trên DB" "$DA_AP"
[[ -z "$DO_KHAC" ]] || chua_du "có dòng _prisma_migrations DỞ DANG của migration khác landSeq: $DO_KHAC"

# ── So hai tập ─────────────────────────────────────────────────────────────────────────────────────────────────────
# QUYẾT ĐỊNH bằng so NGUYÊN chuỗi đã sort (mỗi lần sort kiểm mã thoát riêng) + số dòng bằng nhau; `comm` CHỈ để in dòng
# lệch — lỗi của nó không bao giờ dẫn tới KHỚP.
S_DB="$(printf '%s\n' "$DA_AP" | LC_ALL=C sort)" || chua_du "sort danh sách DB LỖI"
S_ANH="$(printf '%s\n' "$MANIFEST" | LC_ALL=C sort)" || chua_du "sort manifest LỖI"
SO_DB="$(printf '%s\n' "$S_DB" | wc -l | tr -d ' ')" || chua_du "đếm dòng DB LỖI"
SO_ANH="$(printf '%s\n' "$S_ANH" | wc -l | tr -d ' ')" || chua_du "đếm dòng manifest LỖI"
echo "đã áp thành công trên DB: $SO_DB migration · manifest ảnh cũ: $SO_ANH migration"

if [[ -z "$S_DB" || "$S_DB" != "$S_ANH" || "$SO_DB" != "$SO_ANH" ]]; then
  IFS=$'\n' # mỗi dòng "tên checksum" in thành MỘT dòng lệch
  CHI_DB="$(LC_ALL=C comm -23 <(printf '%s\n' "$S_DB") <(printf '%s\n' "$S_ANH"))" || CHI_DB="(không in được)"
  CHI_ANH="$(LC_ALL=C comm -13 <(printf '%s\n' "$S_DB") <(printf '%s\n' "$S_ANH"))" || CHI_ANH="(không in được)"
  [[ -z "$CHI_DB" ]] || printf 'ĐÃ ÁP trên DB mà ảnh cũ KHÔNG có (hoặc khác checksum): %s\n' $CHI_DB
  [[ -z "$CHI_ANH" ]] || printf 'ảnh cũ có mà DB CHƯA áp (hoặc khác checksum): %s\n' $CHI_ANH
  chua_du "tập migration đã áp KHÔNG khớp manifest ảnh cũ"
fi
echo "KẾT LUẬN${NHAN_THU}: KHỚP — tập bản ghi _prisma_migrations đã áp thành công ($SO_DB dòng, tên + checksum) = manifest ảnh cũ $ID, không dòng dở dang nào khác landSeq. CHỈ mô tả tập bản ghi đã đo: KHÔNG thay XÁC NHẬN schema + KIỂM PHIÊN, KHÔNG phải quyền tự lùi ảnh."
exit 0
