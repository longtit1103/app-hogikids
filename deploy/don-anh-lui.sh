#!/usr/bin/env bash
# Dọn ảnh Docker `hogikids-app:rollback-*` cũ có bảo vệ cứng (GH-262). Chạy TRÊN minipc, CHỈ SAU khi
# lượt deploy đã nghiệm thu (runbook §2b, bước cuối). Mặc định DRY-RUN: chỉ in bảng + VÂN TAY, không xoá gì.
#
# Dùng: bash deploy/don-anh-lui.sh [--giu N] [--vars FILE] [--xoa-tag TAG]... [--don-cache]
#                                   [--xoa-that --xac-nhan VÂN_TAY]
#   --giu N       giữ N ẢNH rollback-* mới nhất (đếm theo Image ID, không theo tag; mặc định 5; hoặc GIU_ROLLBACK)
#   --vars FILE   đường dẫn .deploy-vars (mặc định ./.deploy-vars — chạy từ thư mục app như runbook §2b; hoặc DEPLOY_VARS_FILE)
#   --xoa-tag TAG thêm một tag KHÁC rollback-* làm ứng viên xoá (vd deploy-ad7a38d-20260917-1545) — chỉ khi
#                 chủ shop đã duyệt đích danh; vẫn qua đủ cổng bảo vệ theo ID. Lặp được.
#   --don-cache   kèm dọn build cache theo tuổi 72h (tôn trọng dry-run)
#   --xoa-that    BẬT xoá thật; BẮT BUỘC kèm --xac-nhan <vân tay> do lượt dry-run đã duyệt in ra. Tính lại vân tay
#                 (danh sách tag xoá + ID + nội dung mọi .deploy-vars* + N + --don-cache + --xoa-tag); lệch ⇒ dừng,
#                 không xoá gì. Lượt --xoa-that KHÔNG in vân tay (chỉ dry-run mới in) nên không "đọc rồi dán" được.
#
# Bảo vệ (tính bằng IMAGE ID, không tin tên tag) — ảnh dính bất kỳ cái nào ⇒ GIỮ:
#   1. ảnh container đang chạy `hogikids-app` + tag `hogikids-app:latest`
#   2. OLD_IMAGE_ID + ROLLBACK_TAG trong MỌI file `.deploy-vars*` cùng thư mục (gồm `.deploy-vars-truoc-m1` = đường
#      lùi M1). File chính `.deploy-vars` thiếu/hỏng ⇒ thoát lỗi; file phụ thiếu khoá ⇒ cảnh báo. Muốn bỏ ghim M1:
#      chủ shop xoá file, hoặc chuyển ra ngoài thư mục / đổi sang tên KHÔNG bắt đầu bằng `.deploy-vars` khi đóng
#      cửa sổ lùi (đổi thành `.deploy-vars-xxx` vẫn bị ghim). KHÔNG `source` file; ID sai định dạng ⇒ dừng.
#      Mọi Image ID đọc từ docker (images/inspect) phải đủ 64 hex; ID container chạy phải thuộc repo hogikids-app.
#   3. N ẢNH rollback-<sha>-YYYYMMDD-HHMM mới nhất theo mốc trong tên tag (tag sai định dạng ⇒ GIỮ + cảnh báo);
#      mọi tag cùng ID với ảnh được giữ đều giữ
#   4. mọi ảnh mà BẤT KỲ container nào (kể cả đã dừng) tham chiếu
#   5. chỉ xét repo `hogikids-app`; repo khác không bao giờ được liệt kê
# Gỡ theo TÊN tag từng cái, không ép buộc; lỗi ⇒ dừng cả lượt. Tương thích bash 3.2 (macOS) + Linux
# (không mapfile, không mảng kết hợp, không date -d).
set -euo pipefail
export LC_ALL=C

REPO="hogikids-app"
CONTAINER="hogikids-app"
GIU="${GIU_ROLLBACK:-5}"
VARS_FILE="${DEPLOY_VARS_FILE:-./.deploy-vars}"
XOA_THAT=0
DON_CACHE=0
XAC_NHAN=""
TAG_THEM=""   # tag thêm, mỗi dòng một tag
RE_ROLLBACK='^rollback-[0-9a-f]{4,40}-[0-9]{8}-[0-9]{4}$'

die() { echo "✗ $1" >&2; exit "${2:-1}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --xoa-that) XOA_THAT=1 ;;
    --don-cache) DON_CACHE=1 ;;
    --giu) shift; [ $# -gt 0 ] || die "--giu cần giá trị" 2; GIU="$1" ;;
    --vars) shift; [ $# -gt 0 ] || die "--vars cần giá trị" 2; VARS_FILE="$1" ;;
    --xac-nhan) shift; [ $# -gt 0 ] || die "--xac-nhan cần giá trị" 2; XAC_NHAN="$1" ;;
    --xoa-tag) shift; [ $# -gt 0 ] || die "--xoa-tag cần giá trị" 2; TAG_THEM="${TAG_THEM}$1"$'\n' ;;
    -h|--help) awk 'NR>1 && /^#/ {print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *) die "tham số lạ: $1" 2 ;;
  esac
  shift
done

case "$GIU" in ''|*[!0-9]*) die "N phải là số nguyên dương (nhận '$GIU')" 2 ;; esac
[ "$GIU" -ge 1 ] || die "N phải ≥ 1 (không bao giờ giữ 0 ảnh lùi)" 2
if [ "$XOA_THAT" -eq 1 ] && [ -z "$XAC_NHAN" ]; then
  die "--xoa-that bắt buộc kèm --xac-nhan <vân tay> (chạy dry-run trước, chủ shop duyệt bảng + vân tay)" 2
fi

# Công cụ băm: macOS có shasum, Linux có sha256sum. Thiếu cả hai ⇒ dừng sớm (không có vân tay thì không xoá).
if command -v sha256sum >/dev/null 2>&1; then HASH_CMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then HASH_CMD="shasum -a 256"
else die "không có sha256sum/shasum để tính vân tay — DỪNG (không xoá gì)"; fi
bam() { $HASH_CMD | cut -d' ' -f1; }

chuan_id() { echo "${1#sha256:}"; }   # so sánh ID bỏ tiền tố sha256:
dung_id() { grep -Eq '^[0-9a-f]{64}$' <<<"$1"; }
# Dòng đầu tiên "<khoá> <giá trị>" khớp khoá (không dùng grep|head: tránh SIGPIPE dưới pipefail)
tra_khoa() { awk -v k="$1" '$1==k && !d {print $2; d=1}' <<<"$2"; }

# Tập ID được bảo vệ: mỗi dòng "<id> <lý do>"; tập tag giữ theo tên: mỗi dòng một tag
BAO_VE=""
them_bao_ve() {
  bv_id="$(chuan_id "$1")"
  dung_id "$bv_id" || die "Image ID không hợp lệ (nhận '$1', cần 64 hex) — nguồn: $2 — DỪNG (không xoá gì)"
  BAO_VE="${BAO_VE}${bv_id} $2"$'\n'
}
TAG_GIU_TEN=""
FP_VARS=""    # nội dung chuẩn hoá các khoá mốc, đưa vào vân tay

# ── Bảo vệ 2: đọc đúng 2 khoá, KHÔNG source file. Chịu CRLF, khoảng trắng, nháy bao, tiền tố `export ` ──
doc_khoa() { # $1 = file, $2 = khoá
  tr -d '\r' < "$1" \
    | sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?$2[[:space:]]*=//p" \
    | tail -n 1 \
    | sed -E -e 's/^[[:space:]]+//' -e 's/[[:space:]]+$//' -e "s/^[\"']//" -e "s/[\"']\$//" -e 's/^[[:space:]]+//' -e 's/[[:space:]]+$//'
}

# $1 = file mốc, $2 = 1 nếu là file chính (.deploy-vars: mọi thiếu sót ⇒ dừng), 0 nếu file phụ (thiếu khoá ⇒ cảnh báo)
nap_vars() {
  v_file="$1"; v_chinh="$2"; v_ten="$(basename "$v_file")"
  v_goi=""
  [ "$v_chinh" -eq 1 ] || v_goi=" (nếu là file rác, chuyển ra khỏi mẫu tên .deploy-vars*)"
  [ -r "$v_file" ] || die "không đọc được $v_file — không biết mốc đường lùi, DỪNG (không xoá gì)"
  v_old_raw="$(doc_khoa "$v_file" OLD_IMAGE_ID)"
  v_tag="$(doc_khoa "$v_file" ROLLBACK_TAG)"
  if [ -z "$v_old_raw" ]; then
    [ "$v_chinh" -eq 0 ] || die "thiếu OLD_IMAGE_ID trong $v_file — DỪNG (không xoá gì)"
    echo "⚠ $v_ten thiếu OLD_IMAGE_ID — bảo vệ phần còn lại" >&2
  fi
  if [ -z "$v_tag" ]; then
    [ "$v_chinh" -eq 0 ] || die "thiếu ROLLBACK_TAG trong $v_file — DỪNG (không xoá gì)"
    echo "⚠ $v_ten thiếu ROLLBACK_TAG — bảo vệ phần còn lại" >&2
  fi
  v_old=""
  if [ -n "$v_old_raw" ]; then
    v_old="$(chuan_id "$v_old_raw")"
    dung_id "$v_old" || die "OLD_IMAGE_ID trong $v_ten không phải ID đầy đủ 64 hex (nhận '$v_old_raw') — DỪNG$v_goi"
    them_bao_ve "$v_old" "OLD_IMAGE_ID ($v_ten)"
  fi
  v_rb=""
  if [ -n "$v_tag" ]; then
    TAG_GIU_TEN="${TAG_GIU_TEN}${v_tag}"$'\n'
    v_rb="$(docker image inspect -f '{{.Id}}' "$v_tag" 2>/dev/null)" || v_rb=""
    if [ -z "$v_rb" ]; then
      [ "$v_chinh" -eq 0 ] || die "ROLLBACK_TAG=$v_tag trong $v_ten không phân giải được ảnh — đường lùi đã mất/hỏng, DỪNG (không xoá gì)"
      echo "⚠ $v_ten: ROLLBACK_TAG=$v_tag không còn ảnh — chỉ bảo vệ OLD_IMAGE_ID" >&2
    else
      v_rb="$(chuan_id "$v_rb")"
      dung_id "$v_rb" || die "Image ID của $v_tag không hợp lệ ('$v_rb') — DỪNG$v_goi"
      if [ -n "$v_old" ] && [ "$v_rb" != "$v_old" ]; then
        die "$v_ten: ROLLBACK_TAG=$v_tag trỏ ảnh khác OLD_IMAGE_ID — file mốc không nhất quán, DỪNG (không xoá gì)$v_goi"
      fi
      them_bao_ve "$v_rb" "ROLLBACK_TAG ($v_ten)"
    fi
  fi
  FP_VARS="${FP_VARS}${v_ten}|OLD=${v_old}|TAG=${v_tag}|RB=${v_rb}"$'\n'
}

# ── Bảo vệ 1: ảnh container đang chạy ──
CHAY_ID="$(docker container inspect -f '{{.Image}}' "$CONTAINER")" || die "không đọc được container $CONTAINER — DỪNG"
[ -n "$CHAY_ID" ] || die "container $CONTAINER không có Image ID — DỪNG"
them_bao_ve "$CHAY_ID" "ảnh container đang chạy"
CHAY_NID="$(chuan_id "$CHAY_ID")"

[ -r "$VARS_FILE" ] || die "thiếu/không đọc được $VARS_FILE — không có mốc đường lùi, DỪNG (không xoá gì)"
nap_vars "$VARS_FILE" 1
# Mọi file mốc phụ cùng thư mục (vd .deploy-vars-truoc-m1 = đường lùi M1)
for f in "$(dirname "$VARS_FILE")"/.deploy-vars*; do
  [ -f "$f" ] || continue
  if [ "$f" -ef "$VARS_FILE" ]; then continue; fi
  nap_vars "$f" 0
done

# ── Bảo vệ 4: mọi container (kể cả dừng) ──
CIDS="$(docker ps -a --format '{{.ID}}')" || die "docker ps -a lỗi — DỪNG"
for cid in $CIDS; do
  cimg="$(docker container inspect -f '{{.Image}}' "$cid")" || die "không đọc được ảnh container $cid — DỪNG"
  [ -n "$cimg" ] || die "container $cid không có Image ID — DỪNG"
  them_bao_ve "$cimg" "container $cid tham chiếu"
done

# ── Liệt kê ảnh repo hogikids-app (bảo vệ 5: lọc cứng theo repo, cả ở đối số docker lẫn khi đọc) ──
LIST="$(docker images --no-trunc --format '{{.Repository}} {{.Tag}} {{.ID}}' "$REPO")" || die "docker images lỗi — DỪNG"
TAGS_ID=""   # dòng "<tag> <id>"
while read -r repo tag id; do
  [ "$repo" = "$REPO" ] || continue
  id="$(chuan_id "$id")"
  dung_id "$id" || die "Image ID của $REPO:$tag từ docker images không đủ 64 hex ('$id') — DỪNG (thiếu --no-trunc?)"
  if [ -z "$tag" ] || [ "$tag" = "<none>" ]; then continue; fi
  TAGS_ID="${TAGS_ID}${tag} ${id}"$'\n'
done <<EOF_LIST
$LIST
EOF_LIST
[ -n "$TAGS_ID" ] || die "không thấy ảnh $REPO nào — DỪNG"
# Cổng: ảnh container đang chạy phải là một ảnh của repo (không thì ID/tên đang lệch nhau — dừng)
awk -v k="$CHAY_NID" '$2==k {f=1} END {exit !f}' <<<"$TAGS_ID" \
  || die "ảnh container $CONTAINER ($CHAY_NID) không thuộc danh sách ảnh repo $REPO — DỪNG (không xoá gì)"
LATEST_ID="$(tra_khoa latest "$TAGS_ID")"
if [ -n "$LATEST_ID" ]; then them_bao_ve "$LATEST_ID" "tag latest"; else echo "⚠ không thấy tag $REPO:latest" >&2; fi

# ── Bảo vệ 3: N ẢNH rollback-* mới nhất (khoá = YYYYMMDDHHMM trong tên tag; đếm theo ID phân biệt) ──
KHOA_TAG=""   # dòng "<YYYYMMDDHHMM> <tag> <id>"
while read -r tag id; do
  [ -n "$tag" ] || continue
  if grep -Eq "$RE_ROLLBACK" <<<"$tag"; then
    ts="$(sed -E 's/.*-([0-9]{8})-([0-9]{4})$/\1\2/' <<<"$tag")"
    KHOA_TAG="${KHOA_TAG}${ts} ${tag} $(chuan_id "$id")"$'\n'
  fi
done <<EOF_T
$TAGS_ID
EOF_T
if [ -n "$KHOA_TAG" ]; then
  DA_CHON=""; SO_CHON=0
  while read -r ts tag nid; do
    [ -n "$tag" ] || continue
    if grep -Fxq -e "$nid" <<<"$DA_CHON"; then continue; fi
    [ "$SO_CHON" -lt "$GIU" ] || break
    DA_CHON="${DA_CHON}${nid}"$'\n'; SO_CHON=$((SO_CHON + 1))
    them_bao_ve "$nid" "thuộc $GIU ảnh rollback-* mới nhất (mốc $tag)"
  done <<EOF_S
$(sort -r <<<"$KHOA_TAG")
EOF_S
fi

# ── Phân loại từng tag ──
XOA_LIST=""   # mỗi dòng "<tag> <id>" sẽ xoá
BANG=""
SO_XOA=0
while read -r tag id; do
  [ -n "$tag" ] || continue
  nid="$(chuan_id "$id")"
  short="$(cut -c1-12 <<<"$nid")"
  hanh="GIU"; lydo=""
  bv="$(awk -v k="$nid" 'index($0, k " ") == 1 && !d {sub(/^[^ ]* /, ""); print; d=1}' <<<"$BAO_VE")"
  if [ "$tag" = "latest" ]; then
    lydo="tag latest"
  elif grep -Fxq -e "$REPO:$tag" <<<"$TAG_GIU_TEN" || grep -Fxq -e "$tag" <<<"$TAG_GIU_TEN"; then
    lydo="ROLLBACK_TAG (.deploy-vars*)"
  elif [ -n "$bv" ]; then
    lydo="bảo vệ theo ID: $bv"
  elif grep -Eq "$RE_ROLLBACK" <<<"$tag"; then
    hanh="XOA"; lydo="rollback-* ngoài $GIU ảnh mới nhất"
  elif grep -Fxq -e "$tag" <<<"$TAG_THEM"; then
    hanh="XOA"; lydo="tag chủ shop duyệt đích danh (--xoa-tag)"
  else
    case "$tag" in
      rollback-*) lydo="tag rollback-* SAI định dạng — giữ (fail-safe)"
                  echo "⚠ tag $REPO:$tag sai định dạng rollback-<sha>-YYYYMMDD-HHMM — giữ" >&2 ;;
      *) lydo="không phải rollback-* và chưa duyệt đích danh" ;;
    esac
  fi
  if [ "$hanh" = "XOA" ]; then XOA_LIST="${XOA_LIST}${tag} ${nid}"$'\n'; SO_XOA=$((SO_XOA + 1)); fi
  BANG="${BANG}$(printf '%-46s %-12s %-5s %s' "$REPO:$tag" "$short" "$hanh" "$lydo")"$'\n'
done <<EOF_P
$TAGS_ID
EOF_P

# --xoa-tag trỏ tag không tồn tại ⇒ cảnh báo (so chuỗi chính xác, không regex)
while read -r t; do
  [ -n "$t" ] || continue
  if [ -z "$(tra_khoa "$t" "$TAGS_ID")" ]; then echo "⚠ --xoa-tag $t: không có ảnh $REPO:$t" >&2; fi
done <<EOF_X
$TAG_THEM
EOF_X

# Vân tay = băm (danh sách tag xoá + ID, nội dung chuẩn hoá các khoá mốc, N, --don-cache, --xoa-tag). Đổi gì ⇒ đổi.
FP="$(printf 'XOA\n%sVARS\n%sOPT\ncache=%s giu=%s\nTAGS\n%s' "$(sort <<<"$XOA_LIST")"$'\n' "$FP_VARS" "$DON_CACHE" "$GIU" "$(sort <<<"$TAG_THEM")" | bam | cut -c1-16)"
[ -n "$FP" ] || die "không tính được vân tay — DỪNG (không xoá gì)"

printf '%-46s %-12s %-5s %s\n' "TAG" "IMAGE ID" "" "LÝ DO"
printf '%s' "$BANG"
echo "→ $SO_XOA tag sẽ xoá (giữ $GIU ảnh rollback-* mới nhất)."

if [ "$XOA_THAT" -ne 1 ]; then
  echo "VÂN TAY: $FP"
  echo "DRY-RUN — chưa xoá gì. Sau khi chủ shop duyệt bảng trên: --xoa-that --xac-nhan $FP (giữ NGUYÊN các cờ khác)."
  if [ "$DON_CACHE" -eq 1 ]; then echo "DRY-RUN — sẽ dọn build cache cũ hơn 72h."; fi
  exit 0
fi
[ "$XAC_NHAN" = "$FP" ] || die "vân tay không khớp bảng đã duyệt — chạy lại dry-run (không xoá gì)"

# ── Xoá thật: từng tag theo TÊN, lỗi ⇒ dừng ──
while read -r tag nid; do
  [ -n "$tag" ] || continue
  echo "docker rmi $REPO:$tag"
  docker rmi "$REPO:$tag" || die "docker rmi $REPO:$tag lỗi — DỪNG, không ép"
done <<EOF_R
$XOA_LIST
EOF_R
if [ "$DON_CACHE" -eq 1 ]; then
  echo "docker builder prune --builder default --filter until=72h"
  printf 'y\n' | docker builder prune --builder default --filter until=72h
fi
echo "✓ xong. Kiểm: docker image inspect \"<ROLLBACK_TAG>\" (mọi .deploy-vars*) và docker system df"
