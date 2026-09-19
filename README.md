# app-hogikids

Ứng dụng nội bộ **theo dõi sức khoẻ kinh doanh** cho một shop bán lẻ online: đồng bộ dữ liệu vận hành từ **Pancake POS** (+ TikTok Shop, Meta/TikTok Ads), bổ sung giá vốn và chi phí, rồi tính lãi/lỗ (P&L) theo kênh.

> Đây là **bản chụp mã nguồn công khai** (public snapshot) của một app nội bộ — đã lược bỏ tài liệu vận hành, kế hoạch nội bộ và mọi thông tin hạ tầng/kinh doanh riêng. Fixtures dùng dữ liệu tổng hợp. Cấu hình thật ở `.env` (không commit) — xem `.env.example`.

## Tech stack

Next.js 16 (App Router, Turbopack) + TypeScript · Prisma + PostgreSQL 15 · Tailwind 4 + shadcn/ui · Recharts · zod · iron-session · Vitest + Playwright.

## Chạy dev

```bash
cp .env.example .env
npm install
npm run dev        # http://localhost:3000
npm test           # Vitest (cần TEST_DATABASE_URL trỏ DB test riêng)
npm run test:e2e   # Playwright
npm run build
```

> ⚠️ Test ghi/reset dữ liệu — luôn trỏ `TEST_DATABASE_URL` sang một database test riêng.

## Giấy phép

Chưa cấp phép mở — **all rights reserved**. Công khai để tham khảo; không có quyền tái sử dụng/phân phối lại nếu không có thoả thuận riêng.
