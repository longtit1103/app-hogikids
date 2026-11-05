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
# Lời gọi LỒNG (lệnh bên trong vỏ dấu chốt, xem dưới) không ghi lại lần nữa — `loi-goi` giữ đúng lời gọi
# restore.sh gửi đi.
[[ "${GIA_BEN_TRONG:-}" == 1 ]] || printf '%s\0' "$*" >> "$S/loi-goi"

ghi() { printf '%s\n' "$1" >> "$S/su-kien"; }

# ---- vỏ dấu chốt: exec [-i] <container> sh -c '<vỏ>' sh <lệnh…> ----------------------------------------
# restore.sh bọc lệnh dài bằng `sh -c` để shell TRONG container in dấu chốt hoàn tất. Stub chạy ĐÚNG chuỗi
# vỏ restore.sh gửi bằng `sh` thật, với lệnh bên trong là chính stub này (`$0 exec [-i] <container> <lệnh…>`)
# — nên test bắt được cả lỗi viết sai chuỗi vỏ (quên `1>&2`, sai tên biến…), không chỉ lỗi bash phía host.
# Tiêm lỗi theo NHÃN của lệnh bên trong (nhãn cuối cùng ghi vào `su-kien`):
#   `GIA_THIEU_DAU_CHOT_O` — docker exec thoát 0 mà KHÔNG có dấu chốt (đúng ca đo 04/11: docker CLI bị
#                            SIGINT thoát 0 trong khi lệnh trong container chưa xong).
#   `GIA_DAU_CHOT_RC_O` + `GIA_DAU_CHOT_RC` — dấu chốt mang mã ≠ 0 trong khi docker exec thoát 0 (dấu chốt
#                            phải thắng mã thoát docker).
#   `GIA_NHIEU_STDOUT_O` — stdout của docker exec có thêm một dòng nhiễu TRƯỚC dấu chốt thật (giả lập CLI/
#                            container in lẫn ra stdout) ⇒ restore.sh phải KHÔNG tin (so nguyên chuỗi, neo ^…$).
# Lệnh bên trong (psql/pg_restore giả) tự in command tag + một dòng GIỐNG dấu chốt ra stdout của nó, như
# psql thật in `SET`/`COPY n` — vỏ phải chuyển stdout lệnh sang stderr (`1>&2`), quên là mất dấu chốt.
if [[ "${1:-}" == exec && "${GIA_BEN_TRONG:-}" != 1 ]]; then
  a=("$@")
  i=1
  [[ "${a[1]:-}" == -i ]] && i=2
  if [[ "${a[i+1]:-}" == sh && "${a[i+2]:-}" == -c ]]; then
    vo="${a[i+3]}"
    ra=$(GIA_BEN_TRONG=1 sh -c "$vo" sh "$0" "${a[@]:0:i+1}" "${a[@]:i+5}")
    rc=$?
    nhan_trong=$(tail -n 1 "$S/su-kien")
    if [[ -n "${GIA_THIEU_DAU_CHOT_O:-}" && "$GIA_THIEU_DAU_CHOT_O" == "$nhan_trong" ]]; then exit 0; fi
    if [[ -n "${GIA_DAU_CHOT_RC_O:-}" && "$GIA_DAU_CHOT_RC_O" == "$nhan_trong" ]]; then
      printf '%s\n' "${ra%=*}=${GIA_DAU_CHOT_RC:-1}"
      exit 0
    fi
    if [[ -n "${GIA_NHIEU_STDOUT_O:-}" && "$GIA_NHIEU_STDOUT_O" == "$nhan_trong" ]]; then
      printf 'x%s\n%s\n' "$ra" "$ra"
      exit "$rc"
    fi
    printf '%s\n' "$ra"
    exit "$rc"
  fi
fi
# Nhiễu stdout của lệnh trong container (command tag + dòng giống dấu chốt) — xem chú thích vỏ dấu chốt.
in_nhieu_stdout_lenh() { printf '%s\n' 'SET' 'COPY 3' '__HOGIKIDS_RESTORE_RC=0'; }
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
  # Đọc lại rolcanlogin SAU câu mở (`ALTER ROLE … LOGIN`) mang nhãn riêng — tiêm lỗi được vào đúng lượt đọc
  # lại mà không đụng lượt đọc lúc khoá.
  # Đọc lại rolcanlogin NGAY SAU câu khoá (`ALTER ROLE … NOLOGIN`, chưa có câu mở) mang nhãn riêng thứ hai —
  # restore.sh phải xác nhận khoá đã có hiệu lực (ra f) trước khi cắt phiên / DROP.
  if [[ "$nhan" == DOC_LOGIN ]] && grep -qx LOGIN "$S/su-kien"; then
    nhan=DOC_LOGIN_SAU_MO
  elif [[ "$nhan" == DOC_LOGIN ]] && grep -qx NOLOGIN "$S/su-kien"; then
    nhan=DOC_LOGIN_SAU_KHOA
  fi
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
    # `GIA_RA_DOC_LOGIN_SAU_KHOA` / `GIA_RA_DOC_LOGIN_SAU_MO` (ĐẶT, kể cả rỗng): lượt đọc lại thoát 0 nhưng in
    # đúng chuỗi này thay trạng thái thật — giả lập `psql_mot_cau` (không dấu chốt) bị ngắt/ra rác mà docker
    # vẫn thoát 0. restore.sh phải so NGUYÊN `f`/`t`, không suy từ "không phải t"/"không phải f".
    DOC_LOGIN_SAU_KHOA)
      if [[ -n "${GIA_RA_DOC_LOGIN_SAU_KHOA+x}" ]]; then printf '%s\n' "$GIA_RA_DOC_LOGIN_SAU_KHOA"; else cat "$S/login"; echo; fi ;;
    DOC_LOGIN_SAU_MO)
      if [[ -n "${GIA_RA_DOC_LOGIN_SAU_MO+x}" ]]; then printf '%s\n' "$GIA_RA_DOC_LOGIN_SAU_MO"; else cat "$S/login"; echo; fi ;;
    DOC_LOGIN) cat "$S/login"; echo ;;
    # `GIA_NOLOGIN_KHONG_HIEU_LUC=1`: câu khoá thoát 0 mà rolcanlogin KHÔNG đổi (vẫn t) — restore.sh phải đọc
    # lại `DOC_LOGIN_SAU_KHOA` và dừng trước DROP, không tin mã thoát.
    NOLOGIN) [[ "${GIA_NOLOGIN_KHONG_HIEU_LUC:-0}" == 1 ]] || printf '%s' f > "$S/login" ;;
    # `GIA_LOGIN_KHONG_HIEU_LUC=1`: câu mở thoát 0 mà rolcanlogin KHÔNG đổi (giả lập câu lệnh "thành công"
    # nhưng không có hiệu lực — restore.sh phải đọc lại, không tin mã thoát).
    LOGIN) [[ "${GIA_LOGIN_KHONG_HIEU_LUC:-0}" == 1 ]] || printf '%s' t > "$S/login" ;;
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
  in_nhieu_stdout_lenh
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
  in_nhieu_stdout_lenh
  exit 0
fi

echo "docker-gia: lời gọi exec lạ '$*' — harness chưa hỗ trợ" >&2
exit 98
