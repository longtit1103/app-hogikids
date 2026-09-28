#!/usr/bin/env bash
#
# Preview UI cục bộ AN TOÀN — chạy app trên máy dev nhưng trỏ vào DB TEST
# (hogikids_test), HOÀN TOÀN tách khỏi data sản phẩm thật. Dùng để XEM bản nháp
# trước khi deploy prod: bấm/sửa (giá vốn, ngưỡng…) thoải mái, KHÔNG ảnh hưởng
# app thật app.example.com.
#
# Dùng:
#   npm run preview
# rồi mở http://localhost:3000 và đăng nhập bằng INIT_EMAIL / INIT_PASSWORD (trong .env)
# — cùng tài khoản đăng nhập app thật, nhưng đây là bản LOCAL trên DB test.
#
# ⚠️ Vì sao cần script này: `npm run dev` mặc định trỏ DATABASE_URL trong .env =
# DB PROD (nối qua Tailscale). Script này ÉP DATABASE_URL sang TEST_DATABASE_URL
# để không đụng data thật, và TỪ CHỐI chạy nếu URL không kết thúc bằng "_test".

set -euo pipefail
cd "$(dirname "$0")/.."

# Lấy TEST_DATABASE_URL từ .env (không in giá trị đầy đủ ra ngoài để tránh lộ credential).
TEST_URL=$(grep -E '^TEST_DATABASE_URL=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\"'" | tr -d ' ')
if [ -z "${TEST_URL:-}" ]; then
  echo "❌ Không tìm thấy TEST_DATABASE_URL trong .env" >&2
  exit 1
fi

# GUARD chống đụng prod: DB phải là *_test (cùng nguyên tắc tests/e2e/global-setup.ts).
DB_NAME=$(printf '%s' "$TEST_URL" | sed -E 's|.*/([^/?]+)(\?.*)?$|\1|')
case "$DB_NAME" in
  *_test) : ;;
  *)
    echo "❌ TEST_DATABASE_URL trỏ DB \"$DB_NAME\" — không phải *_test. Từ chối để tránh đụng data thật." >&2
    exit 1
    ;;
esac

export DATABASE_URL="$TEST_URL"
echo "🔒 Preview LOCAL trỏ DB test an toàn: $DB_NAME (không đụng prod)"
echo "   Đảm bảo schema + tài khoản đăng nhập + data mẫu…"
npx prisma migrate deploy >/dev/null
npx prisma db seed >/dev/null 2>&1 || true            # tạo login INIT_EMAIL nếu chưa có (idempotent)
npx tsx scripts/seed-preview-products.ts >/dev/null 2>&1 || true  # 5 SP mẫu để xem UI ngay (idempotent, không đè giá vốn)

echo "▶️  Sắp mở http://localhost:3000 — đăng nhập bằng INIT_EMAIL/INIT_PASSWORD trong .env."
echo "   (Bấm Ctrl+C để dừng preview.)"
npm run dev
