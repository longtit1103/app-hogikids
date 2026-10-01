/**
 * Seed dữ liệu khởi tạo: 1 user chủ shop (OWNER) + hồ sơ shop, các kênh bán, danh mục chi phí hệ
 * thống, và các Setting mặc định. Idempotent (upsert) — chạy lại không tạo trùng dòng.
 *
 * Logic tài khoản chủ shop nằm ở `prisma/seed-lib.ts` (test gọi thẳng được); file này chỉ đọc env.
 */
import { PrismaClient } from "@prisma/client";

import { damBaoShopProfile, seedChuShop } from "./seed-lib";

const prisma = new PrismaClient();

/**
 * Mode CHỈ-TẠO-MỚI (env `SEED_CHI_TAO_MOI=1` — `scripts/setup-clone.ts` luôn bật): upsert với
 * `update: {}` — dòng đã tồn tại thì GIỮ NGUYÊN từng field. Vì sao phải có: bản mặc định ghi đè
 * `platformFeePct/paymentFeePct` (đi thẳng vào công thức phí ước tính của P&L) và
 * `defaultLowStockThreshold` — đều là giá trị người dùng sửa được ở /cai-dat; chạy seed trên DB
 * ĐANG CÓ DỮ LIỆU là lặng lẽ reset cấu hình của họ (review 21/08). Đường seed go-live thuần
 * (DB trắng) giữ hành vi cũ.
 */
const CHI_TAO_MOI = process.env.SEED_CHI_TAO_MOI === "1";

const CHANNELS = [
  { id: "shopee", name: "Shopee", color: "#cc785c", platformFeePct: 10, paymentFeePct: 2.5, sortOrder: 1 },
  { id: "tiktok", name: "TikTok Shop", color: "#141413", platformFeePct: 6, paymentFeePct: 2, sortOrder: 2 },
  { id: "facebook", name: "Facebook/Instagram", color: "#5db8a6", platformFeePct: 0, paymentFeePct: 0, sortOrder: 3 },
  { id: "website", name: "Website/Khác", color: "#e8a55a", platformFeePct: 0, paymentFeePct: 0, sortOrder: 4 },
  // Đơn lên từ màn "Bán hàng" Pancake (khách trả tại shop). Máy đang chạy nhận kênh này qua migration.
  { id: "direct", name: "Bán trực tiếp", color: "#6a8fd8", platformFeePct: 0, paymentFeePct: 0, sortOrder: 5 },
] as const;

const EXPENSE_CATEGORIES = [
  { id: "purchase", name: "Nhập hàng" },
  { id: "ads", name: "Quảng cáo" },
  { id: "shipping", name: "Vận chuyển" },
  { id: "packaging", name: "Đóng gói" },
  { id: "return_bom", name: "Hoàn/Bom hàng" },
  { id: "fixed", name: "Mặt bằng-cố định" },
  { id: "interest", name: "Lãi vay" },
  { id: "other", name: "Khác" },
] as const;

const SETTINGS = [
  { key: "defaultLowStockThreshold", value: "5" },
  { key: "slowSellerMaxOrders", value: "2" },
] as const;

async function seedUser(): Promise<void> {
  // Mode chỉ-tạo-mới: đã có tài khoản thì bỏ qua tạo user — lượt setup chạy LẠI không được đòi
  // INIT_EMAIL/INIT_PASSWORD (hai biến này phải xoá khỏi .env ngay sau lượt đầu). Hồ sơ shop vẫn
  // đảm bảo có (chỉ tạo khi thiếu, không ghi đè).
  if (CHI_TAO_MOI && (await prisma.user.count()) > 0) {
    await damBaoShopProfile(prisma);
    console.log("Đã có tài khoản — bỏ qua seed user (mode chỉ-tạo-mới).");
    return;
  }
  const { INIT_EMAIL, INIT_PASSWORD } = process.env;
  if (!INIT_EMAIL || !INIT_PASSWORD) {
    throw new Error(
      "INIT_EMAIL và INIT_PASSWORD phải được set trong .env trước khi chạy seed."
    );
  }

  // Tài khoản chủ shop = OWNER, email chuẩn hoá, không ghi đè hash nếu đã có; trần độ dài mật khẩu
  // kiểm TRƯỚC khi ghi (tài khoản không đăng nhập nổi là tệ hơn seed thất bại) — xem seed-lib.
  await seedChuShop(prisma, { email: INIT_EMAIL, password: INIT_PASSWORD });
}

async function seedChannels(): Promise<void> {
  for (const channel of CHANNELS) {
    await prisma.channel.upsert({
      where: { id: channel.id },
      update: CHI_TAO_MOI
        ? {}
        : {
            name: channel.name,
            color: channel.color,
            platformFeePct: channel.platformFeePct,
            paymentFeePct: channel.paymentFeePct,
            sortOrder: channel.sortOrder,
          },
      create: channel,
    });
  }
}

async function seedExpenseCategories(): Promise<void> {
  for (const category of EXPENSE_CATEGORIES) {
    await prisma.expenseCategory.upsert({
      where: { id: category.id },
      update: CHI_TAO_MOI ? {} : { name: category.name, isSystem: true },
      create: { id: category.id, name: category.name, isSystem: true },
    });
  }
}

async function seedSettings(): Promise<void> {
  for (const setting of SETTINGS) {
    await prisma.setting.upsert({
      where: { key: setting.key },
      update: CHI_TAO_MOI ? {} : { value: setting.value },
      create: setting,
    });
  }
}

async function main(): Promise<void> {
  // Channel/ExpenseCategory/Setting không phụ thuộc biến môi trường —
  // seed trước để luôn ở trạng thái nhất quán dù seedUser() có ném lỗi.
  await seedChannels();
  await seedExpenseCategories();
  await seedSettings();
  await seedUser();
  console.log(
    `Seed hoàn tất: 1 User OWNER + ShopProfile, ${CHANNELS.length} Channel, ` +
      `${EXPENSE_CATEGORIES.length} ExpenseCategory, ${SETTINGS.length} Setting.`
  );
}

main()
  .catch((error: unknown) => {
    console.error("Seed thất bại:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
