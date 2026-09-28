# Base có sẵn pg client 15 (build + runner cùng kế thừa)
# Node 24: Node 20 EOL 30/04/2026 + CI (.github/workflows/ci.yml) đã chạy node-version 24 —
# ghim theo để runtime khớp CI, tránh lệch hành vi giữa test và image chạy thật.
FROM node:24-bookworm-slim AS base
WORKDIR /app
# TZ=Asia/Ho_Chi_Minh: mọi new Date()/date-fns trong container theo giờ VN (biên kỳ P&L, mốc ngày ads/order) — KHÔNG để UTC mặc định (B1)
ENV TZ=Asia/Ho_Chi_Minh
# tzdata = dữ liệu múi giờ cho TZ; postgresql-client-15 = khớp supabase-db v15 (Debian mặc định không có đúng v15 → thêm PGDG repo)
# CỐ Ý KHÔNG ghim bản phụ (15.x): kho PGDG chỉ giữ bản mới nhất, ghim thì lệnh dựng ảnh sẽ gãy đúng
# lúc đang phục hồi thảm hoạ — thời điểm bắt buộc phải dựng lại ảnh. Đổi lại, mỗi lần dựng có thể ra
# một đời pg_dump khác và đời mới có thể phát ra cú pháp mà chốt chặn file phục hồi chưa biết (đã
# xảy ra: bản vá 08/2025 thêm \restrict/\unrestrict vào mọi dump plain, chốt chặn coi là file bị sửa
# tay ⇒ từ chối đúng file của chính mình). Chốt lại bằng lệnh kiểm sau khi dựng ảnh:
#   docker compose run --rm app npx tsx scripts/kiem-chot-chan-nhan-dump-cua-chinh-minh.ts
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates gnupg gzip tzdata \
 && ln -fs /usr/share/zoneinfo/Asia/Ho_Chi_Minh /etc/localtime && dpkg-reconfigure -f noninteractive tzdata \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update && apt-get install -y --no-install-recommends postgresql-client-15 \
 && rm -rf /var/lib/apt/lists/*

FROM base AS build
COPY package*.json ./
# Tarball vendor phải có mặt TRƯỚC npm ci: package.json trỏ xlsx vào
# file:./third-party/xlsx-0.20.3.tgz (C3, cắt phụ thuộc CDN lúc build), mà `COPY . .`
# thì mãi dưới mới chạy ⇒ npm ci ăn ENOENT. CI không bắt được vì nó chạy npm ci trên
# repo đã checkout đủ, còn docker build thì CI không chạy — lỗi chỉ lộ đúng lúc deploy
# (ca thật 19/08, deploy PR #113 chết ở đây trong khi prod vẫn đứng ở PR #106).
# Chép RIÊNG thư mục này, không gộp vào `COPY . .`: giữ nguyên tầng cache của npm ci.
COPY third-party ./third-party
RUN npm ci
# .dockerignore loại .env*/node_modules/.next/.git/tests/plans/docs → KHÔNG nướng secrets,
# KHÔNG đè node_modules host (Mac arm64) lên npm ci (A4)
COPY . .
# next build (npm run build = next build)
RUN npx prisma generate && npm run build

FROM base AS runner
ENV NODE_ENV=production
# node_modules + .next + prisma + next binary từ build stage.
# --chown=node: runtime PHẢI ghi được vào /app/.next (fetch-cache — app gọi revalidatePath 24 chỗ, đo 17/08;
# nhánh cache tối ưu ảnh KHÔNG còn vì next.config bật images.unoptimized) — để nguyên
# owner root thì `next start` chạy dưới user node sẽ EACCES đúng lúc có request đầu tiên chạm cache.
COPY --from=build --chown=node:node /app ./
# Chạy bằng user KHÔNG đặc quyền: một lỗ RCE trong app không cho luôn quyền root của container.
# `node` trong image chính chủ là uid/gid 1000 — TRÙNG uid chủ sở hữu hai thư mục volume trên host
# minipc (./backups, ./uploads đều 1000:1000, đã đo trước khi đổi) nên mọi đường ghi
# (pre-restore dump, logo shop) giữ nguyên. Đổi host khác thì kiểm lại uid trước khi deploy.
USER node
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000"]
