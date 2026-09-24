import { prisma } from "@/lib/prisma";

/**
 * Helper DB test dùng chung cho các suite integration (`hogikids_test`).
 *
 * KHÔNG `prisma db push` ở đây: schema test đã được đẩy sẵn (các suite
 * integration hiện hành — vd tests/ingest, tests/queries — đều dựa vào điều
 * này và chạy pass). Push lại mỗi lần vừa thừa vừa chậm.
 *
 * Cung cấp:
 *  - seedReference(): upsert 5 kênh + 8 danh mục chi phí hệ thống (dữ liệu
 *    tham chiếu, tồn tại suốt vòng đời suite; gọi 1 lần trong beforeAll).
 *  - truncateBusinessTables(): xoá các bảng nghiệp vụ theo thứ tự an toàn FK
 *    (gọi trong beforeEach để mỗi test khởi đầu sạch); GIỮ lại Channel +
 *    ExpenseCategory để không phải seed lại tham chiếu giữa các test.
 *
 * Phase 5/6 tái dùng nguyên helper này — đừng đổi chữ ký export.
 */

// Khớp prisma/seed.ts để test chạy trên đúng dữ liệu tham chiếu như prod.
const CHANNELS = [
  { id: "shopee", name: "Shopee", color: "#cc785c", platformFeePct: 10, paymentFeePct: 2.5, sortOrder: 1 },
  { id: "tiktok", name: "TikTok Shop", color: "#141413", platformFeePct: 6, paymentFeePct: 2, sortOrder: 2 },
  { id: "facebook", name: "Facebook/Instagram", color: "#5db8a6", platformFeePct: 0, paymentFeePct: 0, sortOrder: 3 },
  { id: "website", name: "Website/Khác", color: "#e8a55a", platformFeePct: 0, paymentFeePct: 0, sortOrder: 4 },
  { id: "direct", name: "Bán trực tiếp", color: "#6a8fd8", platformFeePct: 0, paymentFeePct: 0, sortOrder: 5 },
];

const EXPENSE_CATEGORIES = [
  { id: "purchase", name: "Nhập hàng" },
  { id: "ads", name: "Quảng cáo" },
  { id: "shipping", name: "Vận chuyển" },
  { id: "packaging", name: "Đóng gói" },
  { id: "return_bom", name: "Hoàn/Bom hàng" },
  { id: "fixed", name: "Mặt bằng-cố định" },
  { id: "interest", name: "Lãi vay" },
  { id: "other", name: "Khác" },
];

/**
 * Seed lại 4 shop id + warehouse fixture vào `Setting` — cho suite nào tự `setting.deleteMany()`
 * (vd delete-all-data). Bình thường không cần gọi: `tests/setup.ts` đã seed trước mỗi file; nhưng
 * suite xoá trọn bảng thì mọi đường transform/rebuild sau đó throw "Chưa cấu hình shop ID".
 * Nhớ kèm `xoaCacheCauHinhShop()` phía caller nếu suite đã lỡ mồi cache bằng giá trị khác.
 */
export async function seedShopIdSetting(): Promise<void> {
  const { Prisma } = await import("@prisma/client");
  const { SEED_SHOP_ID } = await import("./shop-ids-fixture");
  await prisma.$executeRaw`
    INSERT INTO "Setting" (key, value)
    VALUES ${Prisma.join(SEED_SHOP_ID.map(([k, v]) => Prisma.sql`(${k}, ${v})`))}
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;
}

/** Upsert dữ liệu tham chiếu (kênh + danh mục hệ thống). Idempotent. */
export async function seedReference(): Promise<void> {
  for (const c of CHANNELS) {
    await prisma.channel.upsert({ where: { id: c.id }, create: c, update: {} });
  }
  for (const cat of EXPENSE_CATEGORIES) {
    await prisma.expenseCategory.upsert({
      where: { id: cat.id },
      create: { id: cat.id, name: cat.name, isSystem: true },
      update: { isSystem: true },
    });
  }
}

/**
 * Xoá dữ liệu nghiệp vụ theo thứ tự an toàn khoá ngoại (con → cha):
 * OrderItem → Order → Expense → RecurringExpense → ThuNhap → CashMovement → SoTietKiem → Loan →
 * Variant → Product. Không đụng Channel/ExpenseCategory (dữ liệu tham chiếu).
 *
 * `ThuNhap` và `CashMovement` đều trỏ `SoTietKiem` bằng FK Restrict, còn `SoTietKiem` trỏ `Loan`
 * bằng SetNull — nên thứ tự đúng là hai bảng con trước, rồi sổ, rồi khoản vay. Sai thứ tự thì chính
 * hàm dọn ném lỗi FK và MỌI suite integration đỏ hàng loạt.
 */
export async function truncateBusinessTables(): Promise<void> {
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.expense.deleteMany();
  await prisma.recurringExpense.deleteMany();
  // Thu nhập ngoài bán hàng (lãi tiết kiệm) — trỏ SoTietKiem bằng FK Restrict ⇒ xoá TRƯỚC sổ.
  await prisma.thuNhap.deleteMany();
  // Khoản tiền khác ghi tay (CashMovement) — FK tới Loan và SoTietKiem, cả hai nullable + Restrict.
  await prisma.cashMovement.deleteMany();
  await prisma.soTietKiem.deleteMany(); // sổ tiết kiệm — xoá SAU ThuNhap + CashMovement (FK Restrict)
  await prisma.loan.deleteMany(); // hồ sơ khoản vay — xoá SAU CashMovement (FK Restrict)
  // Thùng rác khôi phục — không FK nào cả hai chiều, xoá độc lập. Bỏ sót thì ảnh chụp của suite
  // trước sống sang suite sau và mọi phép đếm dòng thùng rác đều lệch.
  await prisma.banGhiDaXoa.deleteMany();
  // Bản chốt số dư cuối tháng — không FK, xoá độc lập. Sót là bản chốt của suite trước sống sang suite
  // sau và phép "lưu lại cùng tháng ⇒ vẫn 1 dòng" xanh giả.
  await prisma.soDuChotThang.deleteMany();
  await prisma.variant.deleteMany();
  await prisma.product.deleteMany();
  // Silver "tiền đã về" TikTok (Phase 2) + ví Shopee (Phase 3) — không FK, xoá độc lập.
  await prisma.tiktokSettlement.deleteMany();
  await prisma.tiktokAdsSettlement.deleteMany();
  await prisma.tiktokPayment.deleteMany();
  await prisma.shopeeSettlement.deleteMany();
}
