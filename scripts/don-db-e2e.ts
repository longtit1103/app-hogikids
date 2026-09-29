/**
 * Dọn DB e2e (`hogikids_e2e_test`) MỘT LẦN cho máy dev — xoá dữ liệu nghiệp vụ tích luỹ qua nhiều
 * lượt Playwright (issue #247: đo 28/09 — `Expense` 453 dòng Σ 491.727.537 ₫, phần lớn là mẫu
 * `RecurringExpense` "E2E định kỳ …" không được dọn nên mỗi lượt render lại sinh thêm; `Loan`/
 * `CashMovement` cũng lẫn dòng thử nghiệm cũ). Chạy tay khi dev thấy DB e2e local "bẩn"; e2e tự chạy
 * lại vẫn sạch nhờ các spec đã tự dọn đúng bản ghi mình tạo — script này KHÔNG cần chạy định kỳ.
 *
 * FAIL-CLOSED:
 *  - Nguồn URL DUY NHẤT để KẾT NỐI là `TEST_DATABASE_URL_E2E` — KHÔNG đọc `DATABASE_URL` (dev nối
 *    chung DB PROD qua Tailscale, xem CLAUDE.md). Thiếu biến ⇒ thoát khác 0.
 *  - Kiểm TĨNH trước khi kết nối (`kiemUrlDbE2e`, hàm thuần — Vitest gọi trực tiếp, không cần DB):
 *    tên database phải đúng `hogikids_e2e_test`, tham số `schema` phải đúng `app`, và URL (chuẩn hoá
 *    bỏ password + thứ tự tham số) không được trùng host+port+database với `DATABASE_URL` hiện tại.
 *    Lỗi parse URL ⇒ từ chối. Bất kỳ điều kiện nào sai ⇒ in lý do, thoát khác 0, KHÔNG kết nối.
 *  - Kiểm ĐỘNG sau khi kết nối: `current_database()`/`current_schema()` phải khớp — sai ⇒ thoát khác
 *    0, KHÔNG xoá gì (phòng ca URL đã qua kiểm tĩnh nhưng Postgres redirect/alias khác đi).
 *
 * Mặc định CHẠY THỬ: chỉ in số dòng SẼ xoá theo từng bảng, không đụng DB. Chỉ cờ `--yes` mới xoá
 * thật, gộp trong MỘT transaction (lỗi giữa chừng ⇒ rollback toàn bộ, không xoá dở).
 *
 * Bảng xoá = ĐÚNG bộ "bảng nghiệp vụ" của `tests/helpers/test-db.ts` → `truncateBusinessTables()`
 * (cùng thứ tự an toàn khoá ngoại) — KHÔNG đụng `Channel`/`ExpenseCategory` (tham chiếu), KHÔNG đụng
 * `User`/`Setting`, KHÔNG đụng `_prisma_migrations`, KHÔNG `DROP` bảng nào. `tests/e2e/global-setup.ts`
 * tự reset `User` (1 tài khoản test, `seedTestUser()`) và upsert `Setting` (4 shop id, `seedShopIds()`)
 * ở MỌI lượt chạy Playwright — hai bảng đó không cần script này lo. `Channel`/`ExpenseCategory` là dữ
 * liệu tham chiếu seed một lần khi dựng DB `hogikids_e2e_test`, không nằm trong vòng đời dọn-tái tạo.
 *
 * Chạy: `npx tsx scripts/don-db-e2e.ts` (chạy thử) → soát số liệu → `npx tsx scripts/don-db-e2e.ts --yes`.
 */

import { Prisma, PrismaClient } from "@prisma/client";

const TEN_DB_E2E = "hogikids_e2e_test";
const SCHEMA_BAT_BUOC = "app";

export type KetQuaKiemUrl = { ok: true } | { ok: false; lyDo: string };

/** Chuẩn hoá host+port+database (bỏ password + thứ tự tham số) — hai URL cùng chuỗi này là cùng một
 *  điểm nối, bất kể user/password/thứ tự query string khác nhau thế nào. */
function diemNoi(u: URL): string {
  return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
}

/**
 * Kiểm TĨNH — hàm THUẦN, không kết nối DB, export để Vitest gọi trực tiếp.
 *
 * `urlE2e` = ứng viên (đọc từ `TEST_DATABASE_URL_E2E`); `urlProd` = `DATABASE_URL` hiện tại của tiến
 * trình (có thể `undefined`/rác — parse lỗi thì BỎ QUA phép so trùng, không phải việc hàm này chặn
 * biến ĐÓ, chỉ chặn khi hai URL THỰC SỰ trỏ cùng một điểm nối).
 */
export function kiemUrlDbE2e(urlE2e: string | undefined, urlProd: string | undefined): KetQuaKiemUrl {
  if (!urlE2e) return { ok: false, lyDo: "Thiếu TEST_DATABASE_URL_E2E." };

  let e2e: URL;
  try {
    e2e = new URL(urlE2e);
  } catch {
    return { ok: false, lyDo: `TEST_DATABASE_URL_E2E không phải URL hợp lệ: "${urlE2e}".` };
  }

  // Cho phép trắng CHÍNH XÁC đúng một tên database — không dùng luật lỏng kiểu "đuôi _test" của
  // `resolveE2eDatabaseUrl()` (đủ cho Playwright vì còn cổng "khác DATABASE_URL" đứng cạnh), vì script
  // này CHỦ ĐỘNG xoá dữ liệu nên siết tối đa: chỉ đúng MỘT database được phép mất dữ liệu.
  const db = e2e.pathname.replace(/^\//, "");
  if (db !== TEN_DB_E2E) {
    return { ok: false, lyDo: `Database phải đúng "${TEN_DB_E2E}", nhận "${db || "(rỗng)"}".` };
  }

  const schema = e2e.searchParams.get("schema");
  if (schema !== SCHEMA_BAT_BUOC) {
    return { ok: false, lyDo: `Tham số schema phải đúng "${SCHEMA_BAT_BUOC}", nhận "${schema ?? "(không có)"}".` };
  }

  if (urlProd) {
    try {
      const prod = new URL(urlProd);
      if (diemNoi(prod) === diemNoi(e2e)) {
        return {
          ok: false,
          lyDo: `URL trùng host+port+database với DATABASE_URL hiện tại (${diemNoi(e2e)}) — từ chối để tránh xoá nhầm DB thật.`,
        };
      }
    } catch {
      // DATABASE_URL rác không phải việc guard này chặn — bỏ qua, chỉ chặn khi THỰC SỰ trùng.
    }
  }

  return { ok: true };
}

type Db = PrismaClient | Prisma.TransactionClient;

/** Đúng bộ + đúng thứ tự an toàn khoá ngoại của `tests/helpers/test-db.ts` → `truncateBusinessTables()`. */
const BANG_NGHIEP_VU: { ten: string; dem: (db: Db) => Promise<number>; xoa: (db: Db) => Promise<unknown> }[] = [
  { ten: "OrderItem", dem: (db) => db.orderItem.count(), xoa: (db) => db.orderItem.deleteMany() },
  { ten: "Order", dem: (db) => db.order.count(), xoa: (db) => db.order.deleteMany() },
  { ten: "Expense", dem: (db) => db.expense.count(), xoa: (db) => db.expense.deleteMany() },
  { ten: "RecurringExpense", dem: (db) => db.recurringExpense.count(), xoa: (db) => db.recurringExpense.deleteMany() },
  { ten: "ThuNhap", dem: (db) => db.thuNhap.count(), xoa: (db) => db.thuNhap.deleteMany() },
  { ten: "CashMovement", dem: (db) => db.cashMovement.count(), xoa: (db) => db.cashMovement.deleteMany() },
  { ten: "SoTietKiem", dem: (db) => db.soTietKiem.count(), xoa: (db) => db.soTietKiem.deleteMany() },
  { ten: "Loan", dem: (db) => db.loan.count(), xoa: (db) => db.loan.deleteMany() },
  { ten: "BanGhiDaXoa", dem: (db) => db.banGhiDaXoa.count(), xoa: (db) => db.banGhiDaXoa.deleteMany() },
  { ten: "SoDuChotThang", dem: (db) => db.soDuChotThang.count(), xoa: (db) => db.soDuChotThang.deleteMany() },
  { ten: "Variant", dem: (db) => db.variant.count(), xoa: (db) => db.variant.deleteMany() },
  { ten: "Product", dem: (db) => db.product.count(), xoa: (db) => db.product.deleteMany() },
  { ten: "TiktokSettlement", dem: (db) => db.tiktokSettlement.count(), xoa: (db) => db.tiktokSettlement.deleteMany() },
  {
    ten: "TiktokAdsSettlement",
    dem: (db) => db.tiktokAdsSettlement.count(),
    xoa: (db) => db.tiktokAdsSettlement.deleteMany(),
  },
  { ten: "TiktokPayment", dem: (db) => db.tiktokPayment.count(), xoa: (db) => db.tiktokPayment.deleteMany() },
  { ten: "ShopeeSettlement", dem: (db) => db.shopeeSettlement.count(), xoa: (db) => db.shopeeSettlement.deleteMany() },
];

async function main(): Promise<void> {
  const yes = process.argv.includes("--yes");
  const urlE2e = process.env.TEST_DATABASE_URL_E2E;

  const kiemTinh = kiemUrlDbE2e(urlE2e, process.env.DATABASE_URL);
  if (!kiemTinh.ok) {
    console.error(`[don-db-e2e] TỪ CHỐI (kiểm tĩnh, chưa kết nối): ${kiemTinh.lyDo}`);
    process.exitCode = 1;
    return;
  }

  const db = new PrismaClient({ datasources: { db: { url: urlE2e } } });
  try {
    const [hang] = await db.$queryRaw<{ db: string; schema: string }[]>(
      Prisma.sql`SELECT current_database() AS db, current_schema() AS schema`,
    );
    if (hang.db !== TEN_DB_E2E || hang.schema !== SCHEMA_BAT_BUOC) {
      console.error(
        `[don-db-e2e] TỪ CHỐI (kiểm động, đã kết nối nhưng KHÔNG xoá gì): kết nối thực tế là ` +
          `database="${hang.db}" schema="${hang.schema}", không khớp "${TEN_DB_E2E}"/"${SCHEMA_BAT_BUOC}".`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`[don-db-e2e] Đã xác minh kết nối: database="${hang.db}" schema="${hang.schema}".`);

    const soDong = await Promise.all(BANG_NGHIEP_VU.map(async (b) => ({ ten: b.ten, so: await b.dem(db) })));
    const tong = soDong.reduce((s, b) => s + b.so, 0);

    console.log(`[don-db-e2e] Số dòng ${yes ? "SẼ XOÁ (--yes)" : "sẽ xoá — CHẠY THỬ, thêm --yes để xoá thật"}:`);
    for (const { ten, so } of soDong) console.log(`  ${ten}: ${so}`);
    console.log(`  TỔNG: ${tong}`);

    if (!yes) {
      console.log("[don-db-e2e] Chạy thử xong — KHÔNG xoá gì.");
      return;
    }

    await db.$transaction(async (tx) => {
      for (const b of BANG_NGHIEP_VU) await b.xoa(tx);
    });
    console.log(`[don-db-e2e] Đã xoá ${tong} dòng trong ${BANG_NGHIEP_VU.length} bảng (1 transaction).`);
  } finally {
    await db.$disconnect();
  }
}

// Chỉ tự chạy khi gọi trực tiếp (`npx tsx scripts/don-db-e2e.ts`) — Vitest `import` file này để lấy
// `kiemUrlDbE2e` (hàm thuần) KHÔNG được kéo theo side-effect kết nối/xoá DB.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: unknown) => {
    console.error("[don-db-e2e] Lỗi:", e);
    process.exitCode = 1;
  });
}
