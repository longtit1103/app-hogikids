#!/usr/bin/env bash
#
# `docker` GIẢ cho harness `deploy/restore.sh` — đặt ĐẦU PATH dưới tên `docker`.
#
# KHÔNG BAO GIỜ gọi docker/psql thật: mỗi lời gọi chỉ được GHI LẠI (tham số + nhãn sự kiện) và trả lời
# từ một máy trạng thái tí hon trong thư mục `$GIA_TRANG_THAI`:
#   acl    — `datacl` hiện tại của DB đích ("NULL" hoặc chuỗi `{…}`; "DA_REVOKE" sau câu REVOKE)
#   login  — rolcanlogin của role app (t/f)
#   phien  — còn bao nhiêu lần "đếm phiên" trả về > 0
# Nhận diện lời gọi theo NỘI DUNG câu SQL (tham số cuối của `psql -c`) hoặc theo lệnh con (`ps`,
# `pg_restore -l`, `pg_restore … -f -`, nạp qua stdin). Nhãn sự kiện ghi vào `su-kien` (mỗi dòng một
# nhãn) để test so THỨ TỰ; toàn văn tham số ghi vào `loi-goi` (ngăn bằng NUL) để test so CHUỖI SQL.
#
# Tiêm lỗi: `GIA_LOI_KHI` = danh sách nhãn cách nhau dấu cách — lời gọi mang nhãn đó trả mã 1 và KHÔNG
# đổi trạng thái (như Postgres rollback câu lỗi).
set -u

S="${GIA_TRANG_THAI:?GIA_TRANG_THAI chưa đặt — chỉ chạy qua harness}"
printf '%s\0' "$*" >> "$S/loi-goi"

ghi() { printf '%s\n' "$1" >> "$S/su-kien"; }
co_tiem_loi() { [[ " ${GIA_LOI_KHI:-} " == *" $1 "* ]]; }
# `GIA_MA_LOI` (mặc định 1): mã thoát của lời gọi bị tiêm lỗi — > 128 giả lập lệnh chết vì tín hiệu.
loi() { echo "ERROR:  loi gia lap o buoc $1" >&2; exit "${GIA_MA_LOI:-1}"; }
# Giả lập lệnh chạy lâu (để test gửi tín hiệu giữa chừng): `GIA_NGU_O` = nhãn, ngủ `GIA_NGU_GIAY` giây.
# Tạo `$S/dang-ngu` TRƯỚC khi ngủ — harness chờ tệp này rồi mới gửi tín hiệu (không đoán bằng đồng hồ).
ngu_neu_can() {
  if [[ "${GIA_NGU_O:-}" == "$1" ]]; then
    : > "$S/dang-ngu"
    sleep "${GIA_NGU_GIAY:-2}"
  fi
}

if [[ "${1:-}" == ps ]]; then
  ghi PS
  co_tiem_loi PS && loi PS
  printf '%s\n' supabase-db
  # `GIA_CONTAINER_DANG_CHAY`: tên container thêm, cách nhau dấu cách (vd hogikids-app).
  for ten in ${GIA_CONTAINER_DANG_CHAY:-}; do printf '%s\n' "$ten"; done
  # Container cùng tiền tố nhưng KHÁC tên — phép kiểm phải so nguyên dòng, không so chuỗi con.
  printf '%s\n' hogikids-app-cu-da-doi-ten-x
  exit 0
fi

if [[ "${1:-}" != exec ]]; then
  echo "docker-gia: lệnh con lạ '$*' — harness chưa hỗ trợ" >&2
  exit 97
fi

# ---- psql -c "<sql>" -------------------------------------------------------
if [[ " $* " == *" psql "* && " $* " == *" -c "* ]]; then
  sql="${*: -1}"
  case "$sql" in
    *KHOA_VIEC_NANG_DANG_GIU*"DROP SCHEMA"*) nhan=DROP ;;
    *KHOA_VIEC_NANG_DANG_GIU*) nhan=XEM_KHOA_VIEC_NANG ;;
    *"COALESCE(datacl::text"*) nhan=DOC_ACL ;;
    *"REVOKE CONNECT ON DATABASE"*) nhan=REVOKE ;;
    *has_database_privilege*) nhan=KIEM_QUYEN ;;
    *"UPDATE pg_catalog.pg_database SET datacl"*) nhan=TRA_ACL ;;
    *rolcanlogin*) nhan=DOC_LOGIN ;;
    *"ALTER ROLE"*NOLOGIN*) nhan=NOLOGIN ;;
    *"ALTER ROLE"*LOGIN*) nhan=LOGIN ;;
    *pg_terminate_backend*) nhan=CAT_PHIEN ;;
    *"count(*) FROM pg_catalog.pg_stat_activity"*) nhan=DEM_PHIEN ;;
    *information_schema.columns*) nhan=KIEM_COT ;;
    *"ALTER SCHEMA"*"OWNER TO"*) nhan=TRA_OWNER ;;
    *"GRANT USAGE ON SCHEMA"*) nhan=CAP_QUYEN_N8N ;;
    *) nhan=KHAC ;;
  esac
  ghi "$nhan"
  ngu_neu_can "$nhan"
  co_tiem_loi "$nhan" && loi "$nhan"
  case "$nhan" in
    DOC_ACL) cat "$S/acl"; echo ;;
    REVOKE) printf '%s' DA_REVOKE > "$S/acl" ;;
    KIEM_QUYEN)
      if [[ "$(cat "$S/acl")" == DA_REVOKE && "${GIA_CON_QUYEN_SAU_REVOKE:-0}" != 1 ]]; then echo f; else echo t; fi ;;
    TRA_ACL)
      if [[ "$sql" == *"SET datacl = NULL "* ]]; then
        printf '%s' NULL > "$S/acl"
      else
        v="${sql#*SET datacl = \'}"
        v="${v%%\'::aclitem[]*}"
        printf '%s' "$v" > "$S/acl"
      fi ;;
    DOC_LOGIN) cat "$S/login"; echo ;;
    NOLOGIN) printf '%s' f > "$S/login" ;;
    LOGIN) printf '%s' t > "$S/login" ;;
    DEM_PHIEN)
      con=$(cat "$S/phien")
      if [[ "$con" -gt 0 ]]; then printf '%s' $((con - 1)) > "$S/phien"; echo 1; else echo 0; fi ;;
    KIEM_COT) echo "${GIA_COT_SESSION_EPOCH:-1}" ;;
  esac
  exit 0
fi

# ---- pg_restore (đọc archive qua stdin) ------------------------------------
if [[ " $* " == *" pg_restore "* ]]; then
  cat > /dev/null
  if [[ " $* " == *" -l "* ]]; then
    ghi DOC_TOC
    co_tiem_loi DOC_TOC && loi DOC_TOC
    exit 0   # TOC rỗng ⇒ guard TOC qua
  fi
  if [[ " $* " == *" -f - "* ]]; then
    ghi BUNG_DUMP
    co_tiem_loi BUNG_DUMP && loi BUNG_DUMP
    printf '%s\n' 'CREATE TABLE app."X" (id integer);'
    exit 0
  fi
  ghi NAP_PG_RESTORE
  ngu_neu_can NAP_PG_RESTORE
  co_tiem_loi NAP_PG_RESTORE && loi NAP_PG_RESTORE
  exit 0
fi

# ---- psql đọc stdin: nạp SQL plain hoặc file thu hồi phiên ----------------
if [[ " $* " == *" psql "* ]]; then
  dong_dau=""
  IFS= read -r dong_dau || true
  cat > /dev/null
  if [[ "$dong_dau" == "-- thu-hoi-phien-sau-phuc-hoi.sql"* ]]; then nhan=THU_HOI; else nhan=NAP_PSQL; fi
  ghi "$nhan"
  ngu_neu_can "$nhan"
  co_tiem_loi "$nhan" && loi "$nhan"
  exit 0
fi

echo "docker-gia: lời gọi exec lạ '$*' — harness chưa hỗ trợ" >&2
exit 98
