/**
 * Seed dữ liệu khởi tạo: 1 user chủ shop, 4 kênh bán, 8 danh mục chi phí hệ
 * thống, và các Setting mặc định. Idempotent (upsert) — chạy lại không tạo
 * trùng dòng.
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";

// Trần độ dài mật khẩu lấy TỪ nguồn duy nhất của app (`src/lib/password.ts`) — seed KHÔNG được
// tự khai một số riêng: seed rộng hơn màn đăng nhập nghĩa là lượt go-live/phục hồi thảm hoạ có
// thể tạo tài khoản thành công rồi KHÔNG BAO GIỜ đăng nhập được (xem `seedUser`).
import { MAX_PASSWORD_LENGTH } from "../src/lib/password";

const scrypt = promisify(scryptCallback);
const prisma = new PrismaClient();

const SCRYPT_KEY_LENGTH = 64;

/**
 * Mode CHỈ-TẠO-MỚI (env `SEED_CHI_TAO_MOI=1` — `scripts/setup-clone.ts` luôn bật): upsert với
 * `update: {}` — dòng đã tồn tại thì GIỮ NGUYÊN từng field. Vì sao phải có: bản mặc định ghi đè
 * `platformFeePct/paymentFeePct` (đi thẳng vào công thức phí ước tính của P&L) và
 * `defaultLowStockThreshold` — đều là giá trị người dùng sửa được ở /cai-dat; chạy seed trên DB
 * ĐANG CÓ DỮ LIỆU là lặng lẽ reset cấu hình của họ (review 21/08). Đường seed go-live thuần
 * (DB trắng) giữ hành vi cũ.
 */
const CHI_TAO_MOI = process.env.SEED_CHI_TAO_MOI === "1";

/**
 * Băm mật khẩu bằng crypto.scrypt (Node built-in, không cần thêm dependency).
 * Định dạng lưu trữ: "<salt-hex>:<derivedKey-hex>" — verifyPassword() (auth,
 * task 4) tách theo dấu ":", scrypt lại mật khẩu nhập vào với salt đã lưu rồi
 * so sánh derivedKey bằng timingSafeEqual.
 */
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = (await scrypt(password, salt, SCRYPT_KEY_LENGTH)) as Buffer;
  return `${salt}:${derivedKey.toString("hex")}`;
}

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
  // Mode chỉ-tạo-mới: đã có tài khoản thì bỏ qua hẳn — lượt setup chạy LẠI không được đòi
  // INIT_EMAIL/INIT_PASSWORD (hai biến này phải xoá khỏi .env ngay sau lượt đầu).
  if (CHI_TAO_MOI && (await prisma.user.count()) > 0) {
    console.log("Đã có tài khoản — bỏ qua seed user (mode chỉ-tạo-mới).");
    return;
  }
  const { INIT_EMAIL, INIT_PASSWORD } = process.env;
  if (!INIT_EMAIL || !INIT_PASSWORD) {
    throw new Error(
      "INIT_EMAIL và INIT_PASSWORD phải được set trong .env trước khi chạy seed."
    );
  }

  // DỪNG NGAY thay vì tạo được tài khoản không đăng nhập nổi. Màn đăng nhập từ chối mật khẩu dài
  // quá `MAX_PASSWORD_LENGTH` và chỉ trả đúng một thông báo chung ("Email hoặc mật khẩu không
  // đúng" — cố ý không nói lý do, chống dò tài khoản), nên nếu seed cho qua thì người vận hành sẽ
  // thấy seed BÁO THÀNH CÔNG rồi đăng nhập hoài không được mà không có manh mối nào; đường thoát
  // duy nhất lúc đó là sửa tay trong DB. Nguy nhất ở lượt go-live/phục hồi thảm hoạ, đúng lúc
  // không ai muốn phải mò.
  if (INIT_PASSWORD.length > MAX_PASSWORD_LENGTH) {
    throw new Error(
      `INIT_PASSWORD dài ${INIT_PASSWORD.length} ký tự, vượt trần ${MAX_PASSWORD_LENGTH} của màn ` +
        `đăng nhập — tài khoản seed ra sẽ KHÔNG đăng nhập được. Rút ngắn mật khẩu rồi chạy lại seed.`
    );
  }

  const passwordHash = await hashPassword(INIT_PASSWORD);
  await prisma.user.upsert({
    where: { email: INIT_EMAIL },
    // Không ghi đè passwordHash nếu user đã tồn tại — tránh đổi mật khẩu
    // ngoài ý muốn mỗi lần re-seed (đổi mật khẩu là việc của màn Cài đặt).
    update: {},
    create: { email: INIT_EMAIL, passwordHash },
  });
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
  console.log("Seed hoàn tất: 1 User, 4 Channel, 7 ExpenseCategory, 2 Setting.");
}

main()
  .catch((error: unknown) => {
    console.error("Seed thất bại:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
