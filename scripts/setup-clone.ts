/**
 * `npm run setup` — MỘT lệnh dựng phần Supabase/DB cho bản clone (và vô hại khi chạy lại):
 *   kiểm .env → chốt chặn DB thật → `prisma migrate deploy` → seed CHỈ-TẠO-MỚI → ghi shop ID
 *   (qua đúng lưới chặn-đổi của app) → tạo role đọc kho khoá cho n8n → ghi bộ `n8nDb*` → in bước kế.
 *
 * KHÔNG có nhánh reset/drop nào. Mọi bước là upsert / migrate deploy / tạo-nếu-chưa-có.
 * Phần n8n (đẩy 10 workflow) KHÔNG nằm ở đây — làm trên UI: /cai-dat → "Cài / cập nhật workflows".
 *
 * Cờ: --shop-kho= --shop-shopee= --shop-tiktok= [--tiktok-shop-id= --meta-account-id=]
 *     --admin-url=<DSN superuser, CHỈ truyền qua cờ — đừng ghi vào .env: compose nạp .env vào
 *       container app mọi lần chạy, DSN admin nằm thường trực trong env runtime là bẫy>
 *     [--n8n-db-host=] [--rotate-ro-password] [--toi-biet-day-la-db-that] [--khong-tuong-tac]
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Nạp .env như app (Node ≥20.6 có sẵn) — biến shell đã set vẫn thắng.
const envPath = path.resolve(process.cwd(), ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

import { chanDbThat, kiemEnv, laDbAnToan, parseThamSo, tenDbTu } from "./setup-clone/kiem-env-va-chan-db";

const buoc = (s: string) => console.log(`\n▶ ${s}`);
const dat = (s: string) => console.log(`  ✅ ${s}`);
const truot = (s: string) => console.error(`  ✕ ${s}`);

async function main(): Promise<void> {
  const thamSo = parseThamSo(process.argv.slice(2));

  buoc("1/7 Kiểm biến môi trường (.env)");
  const thieu = kiemEnv();
  if (thieu.length > 0) {
    truot(`Thiếu: ${thieu.join(", ")} — xem chú thích trong .env.example.`);
    process.exitCode = 1;
    return;
  }
  dat("Đủ DATABASE_URL, SESSION_SECRET, INGEST_SECRET, APP_INTERNAL_URL.");

  const databaseUrl = process.env.DATABASE_URL as string;
  const { db: tenDb } = tenDbTu(databaseUrl);

  buoc("2/7 Chốt chặn DB thật");
  if (!(await chanDbThat(databaseUrl, thamSo))) {
    process.exitCode = 1;
    return;
  }
  // Trên DB KHÔNG-test, hai thao tác dưới đây đổi hành vi hệ đang chạy — đòi xác nhận tường minh
  // kể cả ở mode tương tác (gõ lại tên DB mới chỉ chứng minh "biết mình ở đâu").
  if (!laDbAnToan(tenDb) && !thamSo.toiBietDbThat && (thamSo.rotateRoPassword || thamSo.shopKho || thamSo.shopShopee || thamSo.shopTiktok)) {
    truot("--rotate-ro-password / --shop-* trên DB không-test cần kèm cờ --toi-biet-day-la-db-that.");
    process.exitCode = 1;
    return;
  }
  dat("Được phép ghi.");

  buoc("3/7 prisma migrate deploy");
  try {
    execFileSync("npx", ["prisma", "migrate", "deploy"], { stdio: "inherit", env: process.env });
    dat("Schema đã ở bản mới nhất.");
  } catch {
    truot("Migrate thất bại — đọc lỗi Prisma phía trên (thường: DSN sai, hoặc role thiếu quyền tạo schema `app`).");
    process.exitCode = 1;
    return;
  }

  buoc("4/7 Seed dữ liệu khởi tạo (chỉ-tạo-mới — không đè giá trị đã sửa tay)");
  try {
    execFileSync("npx", ["tsx", "prisma/seed.ts"], {
      stdio: "inherit",
      env: { ...process.env, SEED_CHI_TAO_MOI: "1" },
    });
    dat("Seed xong. Nếu vừa tạo tài khoản: XOÁ INIT_EMAIL/INIT_PASSWORD khỏi .env ngay.");
  } catch {
    truot("Seed thất bại — lượt ĐẦU cần INIT_EMAIL + INIT_PASSWORD trong .env (xoá sau khi xong).");
    process.exitCode = 1;
    return;
  }

  // Các module dưới import "@/lib/*" (đọc DB qua prisma singleton) — nạp SAU khi migrate đã chạy.
  const { ghiN8nDb, ghiShopIdBanDau } = await import("./setup-clone/ghi-setting-ban-dau");
  const { sqlTaoRoleChayTay, taoRoleN8nRo } = await import("./setup-clone/tao-role-n8n-ro");
  const { prisma } = await import("@/lib/prisma");

  try {
    buoc("5/7 Ghi shop ID vào kho cấu hình");
    const kq = await ghiShopIdBanDau(thamSo);
    if (kq.loi) {
      truot(kq.loi);
      process.exitCode = 1;
      return;
    }
    if (kq.daGhi.length > 0) dat(`Đã ghi: ${kq.daGhi.join(", ")}.`);
    else dat("Không truyền cờ --shop-* — giữ nguyên (điền/sửa được ở /cai-dat).");

    buoc("6/7 Role đọc kho khoá cho n8n");
    const role = await taoRoleN8nRo({ adminUrl: thamSo.adminUrl, tenDb, schema: "app", rotate: thamSo.rotateRoPassword });
    if (role.ket === "skip") {
      console.warn(`  ⚠ Bỏ qua: ${role.lyDo}\n${sqlTaoRoleChayTay(tenDb, "app")}`);
    } else {
      dat(
        role.ket === "tao-moi"
          ? "Đã tạo role + cấp quyền đọc view kho khoá."
          : role.ket === "rotate"
            ? "Đã ĐỔI mật khẩu role. ⚠ PHẢI bấm lại \"Cài / cập nhật workflows\" ở /cai-dat — nếu không 10 workflow n8n chết câm ở node lấy khoá."
            : "Role đã có — giữ nguyên mật khẩu (đổi thì thêm --rotate-ro-password)."
      );
    }

    buoc("7/7 Ghi địa chỉ DB cho credential n8n");
    const keys = await ghiN8nDb(databaseUrl, thamSo, role.ket === "skip" ? null : role.matKhauMoi);
    dat(`Đã ghi: ${keys.join(", ")}.`);

    console.log(`
── Xong. Bước kế tiếp ─────────────────────────────────────────────
1. Chạy app (npm run dev / docker compose up) → đăng nhập.
2. /cai-dat › "Khóa kết nối": điền API key các nguồn (+ shop ID nếu chưa truyền cờ).
3. /cai-dat › "Kết nối n8n": điền n8n URL + API key → Kiểm tra → "Cài / cập nhật workflows".
4. Dán 3 URL webhook (hiện ở khối Pancake) vào cài đặt webhook của Pancake POS.
5. Backfill lịch sử: chạy tay workflow "history-import" trong n8n (sửa mốc ngày trong CONFIG).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: unknown) => {
  console.error("Setup thất bại:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
