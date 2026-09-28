# Clone-and-go — dựng bản của bạn từ repo public

Hướng dẫn dựng app từ số 0: clone repo → nối **Supabase (Postgres)** + **n8n** CỦA BẠN → chạy.
App là bộ theo dõi lãi/lỗ trên dữ liệu **Pancake POS**; không có Pancake thì app chạy nhưng không
có gì để xem.

## 0. Cần có trước

| Thứ | Ghi chú |
|---|---|
| Node.js ≥ 24 + npm | build/chạy app |
| Postgres 15 (Supabase self-host hoặc Supabase cloud) | app dùng database `postgres`, schema `app`, nối **DIRECT 5432** (không qua pooler 6543) |
| n8n self-host (ảnh docker chính chủ) | máy kéo dữ liệu — dùng mẫu `deploy/docker-compose.n8n-mau.yml` |
| Shop trên **Pancake POS** theo topology **3 shop**: 1 shop KHO (tồn + giá vốn) + shop Shopee + shop TikTok | **Giả định cứng v1** — topology khác (thiếu shop kho, gộp shop…) CHƯA hỗ trợ |
| (tuỳ chọn) TikTok Shop API · Meta Ads · TikTok Business | phí sàn/đối soát + chi tiêu quảng cáo |

## 1. `.env`

```bash
cp .env.example .env
```

Điền theo chú thích trong file. Bắt buộc: `DATABASE_URL`, `SESSION_SECRET`, `INGEST_SECRET`,
`APP_INTERNAL_URL` (URL nội bộ mà n8n gọi tới app — chạy docker cùng network thì
`http://hogikids-app:3000`). Lượt đầu thêm `INIT_EMAIL`/`INIT_PASSWORD` (tài khoản đăng nhập) —
**xoá 2 dòng này khỏi `.env` ngay sau khi setup xong**.

Supabase cloud: lấy DSN **direct 5432** (không phải pooler 6543), giữ `?schema=app`.

## 2. Dựng database — một lệnh

```bash
npm install
npm run setup -- \
  --shop-kho=<id shop kho> --shop-shopee=<id shop shopee> --shop-tiktok=<id shop tiktok> \
  --admin-url='postgresql://postgres:<mat-khau>@<host>:5432/postgres'
```

- Shop id xem trong Pancake (Cài đặt shop) — chỉ chữ số. Bỏ cờ `--shop-*` thì điền sau ở `/cai-dat`.
- `--admin-url` = DSN có quyền tạo role (Supabase cloud: user `postgres`). **Chỉ truyền qua cờ,
  đừng ghi vào `.env`** — compose nạp `.env` vào container app mọi lần chạy. Không có admin DSN
  thì script in sẵn khối SQL để nhờ người có quyền chạy tay.
- Script idempotent: chạy lại vô hại, không đè giá trị bạn đã sửa trong app.

## 3. Dựng n8n

```bash
mkdir -p webhook-samples && sudo chown 1000:1000 webhook-samples
docker compose -f deploy/docker-compose.n8n-mau.yml up -d
```

Mở n8n UI → tạo tài khoản → **Settings → n8n API → Create API key**. Cần thêm một đường CÔNG KHAI
(reverse proxy / tunnel) trỏ vào n8n để Pancake bắn webhook tới.

## 4. Nối tất cả trong app

Chạy app (`npm run dev` hoặc docker) → đăng nhập → **/cai-dat › Kết nối & Đồng bộ**:

1. Khối **"Khóa kết nối nguồn dữ liệu"**: điền API key Pancake của TỪNG shop (+ shop ID nếu chưa
   truyền cờ ở bước 2; + TikTok Shop/Meta/TikTok Ads nếu dùng). Bấm **Kiểm tra kết nối** từng nguồn.
2. Khối **"Kết nối n8n"**: điền `n8n URL` (app gọi tới — cùng docker network thì
   `http://hogikids-n8n:5678`), `n8n URL công khai` (Pancake gọi tới) và `n8n API key` → **Lưu** →
   **Kiểm tra n8n** → **Cài / cập nhật workflows**. Nút này tự đẩy 10 workflow vào n8n, tạo
   credential, bật lịch chạy, rồi tự kiểm chứng end-to-end (kích một lượt đồng bộ thử).
3. Khối Pancake hiện **3 URL webhook** — dán vào cài đặt webhook của từng shop trong Pancake POS
   (đơn hàng + tồn kho realtime).

## 5. Kéo lịch sử (một lần)

Trong n8n, mở workflow **`hogikids-history-import`** → sửa mốc ngày bắt đầu trong khối `CONFIG`
của node Code (mặc định là mốc của shop gốc) → **Execute workflow** (chạy tay, không bật lịch).

## 6. Sau đó

- Nhập **giá vốn** cho biến thể ở màn Sản phẩm (COGS = giá vốn hiện hành — thiếu giá vốn thì lãi ảo).
- Lịch tự động: nightly 01:00/01:15/02:00/03:00 giờ VN + webhook realtime; nút **Đồng bộ ngay**
  ở /cai-dat khi cần.

## Sự cố thường gặp

| Triệu chứng | Nguyên nhân thường gặp |
|---|---|
| Workflow n8n đỏ ngay bước đầu, lỗi `THIẾU KHOÁ trong bảng Setting` | chưa điền đủ khóa/shop id ở /cai-dat (workflow tự nói thiếu key nào) |
| Bấm "Cài workflows" xong nhưng probe ⚠ "app chưa nhận được trang nào" | `APP_INTERNAL_URL` sai (n8n không gọi được app) — xem execution của `hogikids-sync-now` trong n8n |
| Webhook Pancake không thấy sự kiện | thiếu đường công khai vào n8n, dán sai URL vào Pancake, hoặc thiếu volume `webhook-samples` (xem execution lỗi ghi file) |
| `/api/ingest/raw` trả lỗi "Chưa cấu hình shop ID" | chưa chạy `npm run setup` / chưa điền shop ID |
| Đăng nhập không được sau setup | `INIT_PASSWORD` dài quá trần màn đăng nhập — seed đã chặn và báo; đặt mật khẩu ngắn hơn rồi chạy lại setup |
| Đổi mật khẩu role n8n (`--rotate-ro-password`) xong n8n chết ở node lấy khoá | PHẢI bấm lại "Cài / cập nhật workflows" để app tạo credential mới cho n8n |
