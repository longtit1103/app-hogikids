import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { moTaKhoanMatTrang } from "@/components/settings/delete-all-dialog";
import {
  coDuLieuGiaoDich,
  deleteAllData,
  demAdsMoCoi,
  demChiPhiKhongDungLai,
  demDonMoCoi,
  dungLaiTuKhoTho,
  type ChiPhiKhongDungLai,
} from "@/lib/actions/data-admin";
import { landRaw } from "@/lib/bronze/land-raw";
import { prisma } from "@/lib/prisma";
import { seedReference, seedShopIdSetting } from "./helpers/test-db";

import { xoaCacheCauHinhShop } from "@/lib/ket-noi/cau-hinh-shop";

/**
 * Integration test hợp đồng "Xóa dữ liệu giao dịch" + đường phục hồi, chạy trên
 * DB thật (`hogikids_test`). Chỉ mock `requireUser` (nó gọi `cookies()` — không
 * có request scope trong vitest) và `revalidatePath` (cần request scope).
 *
 * Trọng tâm:
 *  - `deleteAllData` xoá ĐÚNG sổ sách giao dịch (gồm 4 bảng "Tiền đã về"), GIỮ
 *    kho thô + sản phẩm/giá vốn + cấu hình (User/Channel/ExpenseCategory/Setting)
 *    + dòng `SyncLog` kind BACKUP (nguồn trạng thái sao lưu, không phải giao
 *    dịch); gõ sai tên shop → không xoá gì.
 *  - `dungLaiTuKhoTho` dựng lại đơn nhưng TUYỆT ĐỐI không kéo tồn kho lùi về ảnh
 *    kho thô, và khoá lượt thứ hai khi đang có lượt chạy.
 */
vi.mock("@/lib/session", () => ({
  requireUser: vi.fn(async () => "test-user-id"),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const USER_ID = "test-user-id";
const SHOP_NAME = "HogiKids Test";
/** Giá vốn nhập tay — APP-OWNED, phải sống sót qua lượt xoá. */
const COST_PRICE = 42_000;
const ORDER_PANCAKE_ID = "o-del-1";
/** Tồn do WEBHOOK ghi (kèm mốc `stockUpdatedAt`) — lượt dựng lại không được kéo lùi. */
const STOCK_WEBHOOK = 7;
const MOC_TON_WEBHOOK = new Date("2026-07-27T18:00:00+07:00");
/** Lúc lượt sao lưu gần nhất xong — nằm ở `SyncLog` kind BACKUP, phải sống sót qua lượt xoá. */
const MOC_SAO_LUU = new Date("2026-07-09T10:00:00+07:00");

/**
 * Seed 1 hàng cho mỗi bảng giao dịch + kho thô + sản phẩm + User + Settings
 * (dùng lại kênh/danh mục seedReference). Dòng kho thô khớp `pancakeId` của đơn
 * để dataset gốc KHÔNG có đơn mồ côi.
 */
async function seedFullDataset(): Promise<void> {
  await prisma.user.create({
    data: {
      id: USER_ID,
      email: "owner@hogikids.test",
      passwordHash: "scrypt$fake$hash",
      shopName: SHOP_NAME,
    },
  });

  await prisma.setting.createMany({
    data: [
      { key: "defaultLowStockThreshold", value: "5" },
      { key: "lastStockResyncAt", value: new Date("2026-07-27T18:00:00+07:00").toISOString() },
    ],
  });

  const product = await prisma.product.create({
    data: { pancakeId: "p-del-1", name: "Váy hè", syncedAt: new Date() },
  });
  const variant = await prisma.variant.create({
    data: {
      pancakeId: "v-del-1",
      productId: product.id,
      sku: "SKU-DEL-1",
      label: "3-4T / Đỏ",
      costPrice: COST_PRICE,
      stock: STOCK_WEBHOOK,
      stockUpdatedAt: MOC_TON_WEBHOOK,
      syncedAt: new Date(),
    },
  });
  const order = await prisma.order.create({
    data: {
      pancakeId: ORDER_PANCAKE_ID,
      code: "ORD-DEL-1",
      channelId: "shopee",
      status: "COMPLETED",
      orderedAt: new Date("2026-07-05T00:00:00+07:00"),
      itemsTotal: 150000,
      syncedAt: new Date(),
    },
  });
  await prisma.orderItem.create({
    data: {
      orderId: order.id,
      variantId: variant.id,
      sku: "SKU-DEL-1",
      productName: "Váy hè",
      quantity: 1,
      unitPrice: 150000,
    },
  });
  await prisma.expense.create({
    data: {
      date: new Date("2026-07-05T00:00:00+07:00"),
      categoryId: "other",
      description: "Chi phí test",
      amount: 50000,
    },
  });
  await prisma.recurringExpense.create({
    data: { categoryId: "fixed", amount: 2000000, dayOfMonth: 1, description: "Mặt bằng" },
  });
  // Khoản tiền khác ghi tay — sổ sách giao dịch, không có bản gốc ngoài app.
  await prisma.cashMovement.create({
    data: { date: new Date("2026-07-05T00:00:00+07:00"), kind: "CAPITAL_IN", amount: 7_000_000, description: "Góp vốn test" },
  });
  // Hồ sơ khoản vay + dòng giải ngân của nó: FK `onDelete: Restrict` nên lượt xoá PHẢI dọn
  // `CashMovement` trước `Loan`; sai thứ tự là cả transaction xoá vỡ, không phải hỏng lặng.
  const loan = await prisma.loan.create({
    data: {
      name: "Vay test",
      lender: "VPBank",
      startDate: new Date("2026-07-01T00:00:00+07:00"),
      annualRateBp: 1050,
      termMonths: 12,
      firstDueDate: new Date("2026-08-01T00:00:00+07:00"),
    },
  });
  await prisma.cashMovement.create({
    data: {
      date: new Date("2026-07-01T00:00:00+07:00"),
      kind: "LOAN_IN",
      amount: 50_000_000,
      loanId: loan.id,
      description: "Giải ngân test",
    },
  });
  // Sổ tiết kiệm sinh lãi ĐÃ TẤT TOÁN: đủ cả ba bảng con-cha (`ThuNhap` → `CashMovement` →
  // `SoTietKiem`) để lượt xoá phải đi đúng thứ tự, nếu không FK `Restrict` chặn ngay.
  const soTietKiem = await prisma.soTietKiem.create({
    data: {
      name: "Sổ 6 tháng test",
      bank: "Vietcombank",
      principal: 30_000_000,
      startDate: new Date("2026-07-01T00:00:00+07:00"),
      termMonths: 6,
      maturityDate: new Date("2027-01-01T00:00:00+07:00"),
      annualRateBp: 520,
      closedAt: new Date("2027-01-01T00:00:00+07:00"),
    },
  });
  await prisma.cashMovement.create({
    data: {
      date: new Date("2026-07-01T00:00:00+07:00"),
      kind: "SAVINGS_OUT",
      amount: 30_000_000,
      savingsId: soTietKiem.id,
      description: "Gửi tiết kiệm test",
    },
  });
  await prisma.thuNhap.create({
    data: {
      date: new Date("2027-01-01T00:00:00+07:00"),
      kind: "LAI_TIET_KIEM",
      amount: 780_000,
      savingsId: soTietKiem.id,
      refId: `TIETKIEM:${soTietKiem.id}`,
      description: "Lãi sổ test",
    },
  });
  await prisma.syncLog.create({ data: { kind: "PANCAKE", status: "OK" } });
  // Dòng BACKUP = nguồn trạng thái sao lưu của màn Cài đặt (`lib/backup/trang-thai-sao-luu.ts`),
  // KHÔNG phải log giao dịch — phải sống sót qua lượt xoá.
  await prisma.syncLog.create({
    data: {
      kind: "BACKUP",
      status: "OK",
      // `startedAt` neo vào quá khứ (mặc định là now()) để dòng này không tranh chỗ "log mới nhất"
      // với lượt dựng lại mà suite dưới soi.
      startedAt: MOC_SAO_LUU,
      finishedAt: MOC_SAO_LUU,
      stats: { file: "hogikids-20260709-0400.dump", sizeBytes: 22_958_125 },
    },
  });

  // Kho thô (Bronze) — bản gốc của chính đơn trên; là đường dựng lại Silver duy nhất.
  await prisma.rawPancakeOrder.create({
    data: {
      shopId: "1942992175",
      externalId: ORDER_PANCAKE_ID,
      payloadHash: "hash-del-1",
      payload: { id: ORDER_PANCAKE_ID, total_price: 150000 },
    },
  });

  // 4 bảng Silver "Tiền đã về" — mỗi bảng 1 dòng.
  await prisma.tiktokSettlement.create({
    data: {
      statementId: "st-del-1",
      shopId: "100975192",
      statementTime: new Date("2026-07-05T00:00:00+07:00"),
      paymentStatus: "SETTLED",
      settlementAmount: 300000,
      revenueAmount: 0,
      feeAmount: 0,
      adjustmentAmount: 0,
      netSalesAmount: 0,
      shippingCostAmount: 0,
    },
  });
  await prisma.tiktokAdsSettlement.create({
    data: {
      transactionId: "ads-del-1",
      shopId: "100975192",
      orderCreateTime: new Date("2026-07-05T00:00:00+07:00"),
      settlementAmount: -100000,
    },
  });
  await prisma.tiktokPayment.create({
    data: {
      paymentId: "pay-del-1",
      shopId: "100975192",
      status: "PAID",
      paidTime: new Date("2026-07-05T00:00:00+07:00"),
      settlementValue: 200000,
      amountValue: 200000,
    },
  });
  await prisma.shopeeSettlement.create({
    data: {
      externalId: "sp-del-1",
      shopId: "1942992175",
      txnTime: new Date("2026-07-05T00:00:00+07:00"),
      type: "REVENUE",
      orderCode: "ORD-DEL-1",
      amount: 120000,
      status: "ok",
      runningBalance: 0,
    },
  });
}

async function clearAll(): Promise<void> {
  // Con trước cha; thêm syncLog + setting + user (không nằm trong truncateBusinessTables).
  // Dọn cả kho thô + settlement vì test tự seed chúng (deleteAllData cố ý KHÔNG xoá kho thô).
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.variant.deleteMany();
  await prisma.product.deleteMany();
  await prisma.expense.deleteMany();
  await prisma.recurringExpense.deleteMany();
  await prisma.thuNhap.deleteMany(); // TRƯỚC SoTietKiem (FK Restrict)
  await prisma.cashMovement.deleteMany();
  await prisma.soTietKiem.deleteMany(); // SAU ThuNhap + CashMovement (FK Restrict)
  await prisma.loan.deleteMany(); // SAU CashMovement (FK Restrict)
  await prisma.syncLog.deleteMany();
  await prisma.rawPancakeOrder.deleteMany();
  await prisma.rawPancakeProduct.deleteMany();
  // Kho thô của các nguồn KHÁC mà chính suite này không seed: `dungLaiTuKhoTho` quét TOÀN BỘ bảng
  // raw, nên một dòng sót lại từ suite khác (dùng chung DB test) sẽ làm bộ đếm "dựng lại" khác 0 và
  // test đỏ tuỳ thứ tự chạy file. Dọn ở đây để suite này tất định, không phụ thuộc hàng xóm.
  await prisma.rawShopeeWalletTxn.deleteMany();
  await prisma.rawTiktokShopStatement.deleteMany();
  await prisma.rawTiktokShopTransaction.deleteMany();
  await prisma.rawTiktokShopPayment.deleteMany();
  await prisma.rawMetaAdsReport.deleteMany();
  await prisma.rawTiktokBusinessReport.deleteMany();
  await prisma.rawTiktokBusinessInvoice.deleteMany();
  await prisma.tiktokSettlement.deleteMany();
  await prisma.tiktokAdsSettlement.deleteMany();
  await prisma.tiktokPayment.deleteMany();
  await prisma.shopeeSettlement.deleteMany();
  await prisma.setting.deleteMany();
  await prisma.user.deleteMany();
  // Vừa xoá TRỌN Setting ⇒ mất luôn shop id mà đường transform/rebuild đọc từ cấu hình
  // (cau-hinh-shop.ts) — seed lại + xoá cache, nếu không dungLaiTuKhoTho ném "Chưa cấu hình".
  await seedShopIdSetting();
  xoaCacheCauHinhShop();
}

beforeAll(async () => {
  await seedReference(); // 4 kênh + 8 danh mục hệ thống
}, 60_000);

beforeEach(async () => {
  await clearAll();
  await seedFullDataset();
});

afterAll(async () => {
  await clearAll();
  await prisma.$disconnect();
});

describe("deleteAllData", () => {
  it("gõ SAI tên shop → ok:false, KHÔNG xoá gì", async () => {
    const settingTruoc = await prisma.setting.count();
    const res = await deleteAllData("Tên Sai");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("Tên shop không khớp");

    // Toàn bộ dữ liệu còn nguyên.
    expect(await prisma.order.count()).toBe(1);
    expect(await prisma.orderItem.count()).toBe(1);
    expect(await prisma.product.count()).toBe(1);
    expect(await prisma.variant.count()).toBe(1);
    expect(await prisma.expense.count()).toBe(1);
    expect(await prisma.recurringExpense.count()).toBe(1);
    expect(await prisma.cashMovement.count()).toBe(3); // 1 góp vốn + 1 giải ngân vay + 1 gửi tiết kiệm
    expect(await prisma.loan.count()).toBe(1);
    expect(await prisma.soTietKiem.count()).toBe(1);
    expect(await prisma.thuNhap.count()).toBe(1);
    expect(await prisma.syncLog.count()).toBe(2); // 1 PANCAKE + 1 BACKUP
    expect(await prisma.tiktokSettlement.count()).toBe(1);
    expect(await prisma.tiktokAdsSettlement.count()).toBe(1);
    expect(await prisma.tiktokPayment.count()).toBe(1);
    expect(await prisma.shopeeSettlement.count()).toBe(1);
    expect(await prisma.rawPancakeOrder.count()).toBe(1);
    // So trước/sau thay vì số cứng: seed toàn cục (tests/setup.ts + clearAll) còn thêm các key
    // shop id cấu hình — ý định của assert là "Setting không bị đụng", không phải đếm đúng N.
    expect(await prisma.setting.count()).toBe(settingTruoc);
  });

  it("gõ ĐÚNG tên shop → ok:true, xoá giao dịch, GIỮ cấu hình", async () => {
    const settingTruoc = await prisma.setting.count();
    const res = await deleteAllData(SHOP_NAME);
    expect(res.ok).toBe(true);

    // Giao dịch về 0.
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.orderItem.count()).toBe(0);
    expect(await prisma.expense.count()).toBe(0);
    expect(await prisma.recurringExpense.count()).toBe(0);
    expect(await prisma.cashMovement.count()).toBe(0);
    // Hồ sơ khoản vay cũng là sổ sách nhập tay — bỏ sót thì màn Dòng tiền còn dư nợ của một khoản
    // không còn dòng tiền nào đỡ.
    expect(await prisma.loan.count()).toBe(0);
    // Sổ tiết kiệm + lãi đã ghi. `ThuNhap` là ca hỏng LẶNG nguy nhất: sót nó thì dòng "Thu nhập tài
    // chính" của P&L vẫn cộng lãi của một sổ không còn tồn tại, mà không phép đếm nào khác đỏ.
    expect(await prisma.soTietKiem.count()).toBe(0);
    expect(await prisma.thuNhap.count()).toBe(0);
    expect(await prisma.syncLog.count({ where: { kind: { not: "BACKUP" } } })).toBe(0);

    // 4 bảng "Tiền đã về" cũng về 0 — cùng là sổ sách giao dịch.
    expect(await prisma.tiktokSettlement.count()).toBe(0);
    expect(await prisma.tiktokAdsSettlement.count()).toBe(0);
    expect(await prisma.tiktokPayment.count()).toBe(0);
    expect(await prisma.shopeeSettlement.count()).toBe(0);

    // Cấu hình giữ nguyên.
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.channel.count()).toBe(4);
    expect(await prisma.expenseCategory.count()).toBeGreaterThanOrEqual(7);

    // Setting còn NGUYÊN — cấu hình, không phải giao dịch. So trước/sau thay vì số cứng (seed
    // toàn cục còn thêm key shop id cấu hình).
    expect(await prisma.setting.count()).toBe(settingTruoc);

    // Dòng SyncLog kind BACKUP còn NGUYÊN: quy trình đúng là "Sao lưu ngay rồi mới xóa", xóa dấu
    // vết lượt sao lưu đi thì màn Cài đặt lại kêu "Chưa sao lưu lần nào" ngay sau lượt xóa —
    // đúng cảnh báo giả mà nguồn SyncLog này sinh ra để diệt.
    const backup = await prisma.syncLog.findFirst({ where: { kind: "BACKUP" } });
    expect(backup?.status).toBe("OK");
    expect(backup?.finishedAt).toEqual(MOC_SAO_LUU);
  });

  it("GIỮ kho thô — bản gốc Pancake là đường dựng lại Silver duy nhất", async () => {
    const res = await deleteAllData(SHOP_NAME);
    expect(res.ok).toBe(true);

    const raw = await prisma.rawPancakeOrder.findFirst();
    expect(raw?.externalId).toBe(ORDER_PANCAKE_ID);
    expect(await prisma.rawPancakeOrder.count()).toBe(1);
  });

  it("GIỮ sản phẩm/biến thể và giá vốn nhập tay (APP-OWNED)", async () => {
    const res = await deleteAllData(SHOP_NAME);
    expect(res.ok).toBe(true);

    expect(await prisma.product.count()).toBe(1);
    const variant = await prisma.variant.findUnique({ where: { pancakeId: "v-del-1" } });
    expect(variant?.costPrice).toBe(COST_PRICE);
  });
});

describe("demDonMoCoi", () => {
  it("dataset có đủ bản gốc → 0 đơn mồ côi", async () => {
    expect(await demDonMoCoi()).toEqual({ soDon: 0, tongTien: 0 });
  });

  it("đơn không có bản gốc → đếm vào, số đơn và số tiền cùng một tập", async () => {
    await prisma.order.createMany({
      data: [
        {
          pancakeId: "o-mo-coi-1",
          code: "ORD-MC-1",
          channelId: "shopee",
          status: "COMPLETED",
          orderedAt: new Date("2026-07-05T00:00:00+07:00"),
          itemsTotal: 250_000,
          syncedAt: new Date(),
        },
        {
          pancakeId: "o-mo-coi-2",
          code: "ORD-MC-2",
          channelId: "shopee",
          status: "CANCELLED",
          orderedAt: new Date("2026-07-05T00:00:00+07:00"),
          itemsTotal: 900_000,
          syncedAt: new Date(),
        },
      ],
    });

    // Đơn hủy KHÔNG bị loại khỏi tiền: loại nó mà vẫn đếm vào số đơn sẽ in ra "2 đơn (250.000 đ)"
    // trong khi giá trị hàng của 2 đơn là 1.150.000 đ.
    expect(await demDonMoCoi()).toEqual({ soDon: 2, tongTien: 1_150_000 });
  });
});

describe("demChiPhiKhongDungLai", () => {
  it("đếm số dòng + tổng tiền chi phí và số mẫu định kỳ", async () => {
    expect(await demChiPhiKhongDungLai()).toEqual({
      soChiPhi: 1,
      tongChiPhi: 50_000,
      soDinhKy: 1,
      // 3 dòng: góp vốn 7tr + giải ngân vay 50tr + gửi tiết kiệm 30tr.
      soKhoanTienKhac: 3,
      tongKhoanTienKhac: 87_000_000,
      soKhoanVay: 1,
      soSoTietKiem: 1,
      tongThuNhap: 780_000,
    });
  });

  it("KHÔNG đếm chi tiêu quảng cáo — kho thô giữ bản gốc báo cáo nên dựng lại được", async () => {
    await prisma.expense.create({
      data: {
        date: new Date("2026-07-05T00:00:00+07:00"),
        categoryId: "ads",
        adsSource: "META",
        channelId: "facebook",
        description: "Ao vay be gai",
        amount: 132_000,
        source: "ADS_API",
        refId: "META:2026-07-05:23851",
      },
    });

    expect(await demChiPhiKhongDungLai()).toEqual({
      soChiPhi: 1,
      tongChiPhi: 50_000,
      soDinhKy: 1,
      // 3 dòng: góp vốn 7tr + giải ngân vay 50tr + gửi tiết kiệm 30tr.
      soKhoanTienKhac: 3,
      tongKhoanTienKhac: 87_000_000,
      soKhoanVay: 1,
      soSoTietKiem: 1,
      tongThuNhap: 780_000,
    });

    await prisma.expense.deleteMany({ where: { source: "ADS_API" } });
  });

  it("không có chi phí nào → 0 hết (không trả null)", async () => {
    await prisma.expense.deleteMany();
    await prisma.recurringExpense.deleteMany();
    await prisma.thuNhap.deleteMany(); // TRƯỚC SoTietKiem (FK Restrict)
    await prisma.cashMovement.deleteMany();
    await prisma.soTietKiem.deleteMany();
    await prisma.loan.deleteMany();

    expect(await demChiPhiKhongDungLai()).toEqual({
      soChiPhi: 0,
      tongChiPhi: 0,
      soDinhKy: 0,
      soKhoanTienKhac: 0,
      tongKhoanTienKhac: 0,
      soKhoanVay: 0,
      soSoTietKiem: 0,
      tongThuNhap: 0,
    });
  });

  it("CHỈ còn khoản tiền khác (đã xoá hết chi phí) → vẫn đếm để dialog cảnh báo", async () => {
    await prisma.expense.deleteMany();
    await prisma.recurringExpense.deleteMany();
    expect(await demChiPhiKhongDungLai()).toMatchObject({
      soChiPhi: 0,
      // 3 dòng: góp vốn 7tr + giải ngân vay 50tr + gửi tiết kiệm 30tr.
      soKhoanTienKhac: 3,
      tongKhoanTienKhac: 87_000_000,
      soKhoanVay: 1,
      soSoTietKiem: 1,
      tongThuNhap: 780_000,
    });
  });
});

/**
 * Dialog xoá khẳng định "chi tiêu quảng cáo dựng lại được" — lời khẳng định đó phải có SỐ ĐỠ, vì
 * bước land bản gốc trong cả 2 workflow n8n là best-effort (land hỏng thì bỏ qua, đi tiếp) trong
 * khi bước ghi `Expense` là bắt buộc. Đêm nào land hỏng riêng là đẻ ra đúng loại dòng đếm ở đây.
 */
describe("demAdsMoCoi", () => {
  const ngayVn = (ngay: string) => new Date(`${ngay}T00:00:00+07:00`);

  async function themChiTieuAds(refId: string, amount: number): Promise<void> {
    await prisma.expense.create({
      data: {
        date: ngayVn("2026-05-20"),
        categoryId: "ads",
        adsSource: refId.startsWith("META") ? "META" : "TIKTOK_ADS",
        channelId: refId.startsWith("META") ? "facebook" : "tiktok",
        description: "Chiến dịch",
        amount,
        source: "ADS_API",
        refId,
      },
    });
  }

  beforeEach(async () => {
    await prisma.expense.deleteMany({ where: { source: "ADS_API" } });
    await prisma.rawMetaAdsReport.deleteMany();
    await prisma.rawTiktokBusinessReport.deleteMany();
  });

  it("chưa có chi tiêu quảng cáo nào → 0 (không trả null)", async () => {
    expect(await demAdsMoCoi()).toEqual({ soDong: 0, tongTien: 0 });
  });

  it("cả 3 dạng khoá đều có bản gốc trong kho thô → 0 mồ côi", async () => {
    await landRaw(
      "meta/report",
      "act_415299582336742",
      `{"data":[{"spend":"120000","campaign_id":"23851","campaign_name":"M","account_currency":"VND",` +
        `"date_start":"2026-05-20","date_stop":"2026-05-20"}],"paging":{}}`
    );
    await landRaw(
      "tiktokbusiness/report",
      "7129548444015902722",
      `{"code":0,"data":{"list":[` +
        `{"dimensions":{"campaign_id":"C1","stat_time_day":"2026-05-20 00:00:00"},"metrics":{"cost":"81617"}},` +
        `{"dimensions":{"campaign_id":"C1","stat_time_day":"2026-05-20 00:00:00"},"metrics":{"spend":"50000"}}` +
        `],"page_info":{"total_page":1}}}`
    );

    await themChiTieuAds("META:2026-05-20:23851", 132_000);
    await themChiTieuAds("TIKTOK_ADS:2026-05-20:C1", 89_779);
    await themChiTieuAds("TIKTOK_ADS:auction:2026-05-20:C1", 55_000);

    expect(await demAdsMoCoi()).toEqual({ soDong: 0, tongTien: 0 });
  });

  it("dòng chi phí không còn bản gốc báo cáo → đếm vào cả số dòng lẫn số tiền", async () => {
    await themChiTieuAds("META:2026-05-20:23851", 132_000);
    await themChiTieuAds("TIKTOK_ADS:auction:2026-05-20:C1", 55_000);

    expect(await demAdsMoCoi()).toEqual({ soDong: 2, tongTien: 187_000 });
  });
});

/** Dọn sạch mọi bảng mà nút xóa đụng tới, giữ nguyên sản phẩm/biến thể + kho thô. */
async function xoaHetGiaoDich(): Promise<void> {
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.expense.deleteMany();
  await prisma.recurringExpense.deleteMany();
  await prisma.thuNhap.deleteMany(); // TRƯỚC SoTietKiem (FK Restrict)
  await prisma.cashMovement.deleteMany();
  await prisma.soTietKiem.deleteMany(); // SAU ThuNhap + CashMovement (FK Restrict)
  await prisma.loan.deleteMany(); // SAU CashMovement (FK Restrict)
  await prisma.tiktokSettlement.deleteMany();
  await prisma.tiktokAdsSettlement.deleteMany();
  await prisma.tiktokPayment.deleteMany();
  await prisma.shopeeSettlement.deleteMany();
}

describe("coDuLieuGiaoDich", () => {
  it("còn đủ dữ liệu → true", async () => {
    expect(await coDuLieuGiaoDich()).toBe(true);
  });

  it("CHỈ còn số liệu Tiền đã về → vẫn true", async () => {
    await xoaHetGiaoDich();
    await prisma.shopeeSettlement.create({
      data: {
        externalId: "sp-con-lai",
        shopId: "1942992175",
        txnTime: new Date("2026-07-06T00:00:00+07:00"),
        type: "REVENUE",
        orderCode: "ORD-DEL-1",
        amount: 90_000,
        status: "ok",
        runningBalance: 0,
      },
    });

    expect(await coDuLieuGiaoDich()).toBe(true);
  });

  it("CHỈ còn khoản tiền khác ghi tay → vẫn true (là giao dịch, nút xóa phải chạm)", async () => {
    await xoaHetGiaoDich();
    await prisma.cashMovement.create({
      data: { date: new Date("2026-07-06T00:00:00+07:00"), kind: "CAPITAL_OUT", amount: 500_000, description: "còn lại" },
    });

    expect(await coDuLieuGiaoDich()).toBe(true);
  });

  it("sạch giao dịch, chỉ còn sản phẩm/giá vốn → false", async () => {
    await xoaHetGiaoDich();

    // Product/Variant vẫn còn nhưng KHÔNG được tính là "có dữ liệu để xóa" — nút xóa không chạm.
    expect(await prisma.variant.count()).toBe(1);
    expect(await coDuLieuGiaoDich()).toBe(false);
  });
});

const rawBody = (items: string) => `{"success":true,"data":[${items}]}`;

/** Đơn Shopee hợp lệ trong kho thô — bản gốc để lượt dựng lại đọc lại. */
const RAW_ORDER = `{
  "id":"o-raw-1","status":3,"inserted_at":"2026-07-06T10:00:00.000000",
  "order_sources_name":"Shopee","marketplace_id":"-3",
  "total_price":200000,"total_discount":0,"fee_marketplace":15000,
  "items":[{"quantity":2,"discount_each_product":0,"variation_id":"V-SHOPEE-KHAC",
    "variation_info":{"display_id":"SKU-DEL-1","name":"Váy hè","retail_price":100000}}]}`;

/**
 * Sản phẩm shop kho trong kho thô: ảnh của lượt kéo đêm nói tồn = 10, KHÁC số 7 mà webhook đã ghi.
 * Có dòng này thì phép khẳng định "tồn kho không bị kéo lùi" mới có răng — thiếu nó, test pass chỉ
 * vì chẳng có gì để transform.
 */
const RAW_PRODUCT = `{"id":"p-del-1","name":"Váy hè","variations":[
  {"id":"v-del-1","display_id":"SKU-DEL-1","retail_price":100000,
   "remain_quantity":10,"average_imported_price":40000}]}`;

describe("dungLaiTuKhoTho", () => {
  it("dựng lại đơn từ kho thô, KHÔNG kéo tồn kho lùi về ảnh kho thô", async () => {
    // Xóa sạch giao dịch (như vừa bấm nút xóa) + bỏ dòng raw seed sẵn (payload rút gọn, sai shape).
    await xoaHetGiaoDich();
    await prisma.rawPancakeOrder.deleteMany();
    await landRaw("orders", "1942992175", rawBody(RAW_ORDER));
    await landRaw("products", "714995134", rawBody(RAW_PRODUCT));

    const res = await dungLaiTuKhoTho();
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.data.ordersUpserted).toBe(1);
    expect(await prisma.order.count({ where: { pancakeId: "o-raw-1" } })).toBe(1);
    // 4 bộ đếm Tiền đã về có mặt trong kết quả (kho thô chưa có sao kê/ví nào ⇒ 0).
    expect(res.data.settlementsUpserted).toBe(0);
    expect(res.data.adsUpserted).toBe(0);
    expect(res.data.paymentsUpserted).toBe(0);
    expect(res.data.shopeeUpserted).toBe(0);

    const variant = await prisma.variant.findUnique({ where: { pancakeId: "v-del-1" } });
    expect(variant?.stock).toBe(STOCK_WEBHOOK); // KHÔNG về 10 (remain_quantity của ảnh kho thô)
    expect(variant?.stockUpdatedAt).toEqual(MOC_TON_WEBHOOK); // mốc webhook KHÔNG bị xóa
    expect(variant?.costPrice).toBe(COST_PRICE); // giá vốn nhập tay giữ nguyên

    // Lượt chạy được ghi vào nhật ký đồng bộ → cảnh báo không mất theo toast.
    const log = await prisma.syncLog.findFirst({ orderBy: { startedAt: "desc" } });
    expect(log?.kind).toBe("PANCAKE");
    expect(log?.status).toBe("OK");
  });

  it("đang có lượt đồng bộ chạy → ok:false, KHÔNG chạy lượt thứ hai", async () => {
    await prisma.syncLog.deleteMany();
    await prisma.syncLog.create({ data: { kind: "PANCAKE", status: "RUNNING" } });

    const res = await dungLaiTuKhoTho();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("Đang có lượt đồng bộ");

    // Không đẻ thêm log ⇒ lượt thứ hai bị chặn trước khi chạy.
    expect(await prisma.syncLog.count()).toBe(1);
  });

  it("log RUNNING treo quá lâu KHÔNG khoá nút vĩnh viễn", async () => {
    await prisma.syncLog.deleteMany();
    await prisma.syncLog.create({
      data: {
        kind: "PANCAKE",
        status: "RUNNING",
        startedAt: new Date(Date.now() - 20 * 60_000), // quá mốc dọn log treo 15'
      },
    });

    const res = await dungLaiTuKhoTho();
    expect(res.ok).toBe(true);
  });
});

/**
 * Câu định lượng trên dialog xoá — hàm THUẦN, không chạm DB. Khoá CHUỖI CHÍNH XÁC vì đây là câu chủ
 * shop đọc ngay trước khi xoá vĩnh viễn: vế 0 lọt vào câu ("0 khoản chi phí nhập tay (0 ₫)") làm câu
 * đọc như lỗi số liệu, và sai số đếm/số tiền thì chủ shop hiểu sai độ lớn khoản sắp mất.
 */
describe("moTaKhoanMatTrang", () => {
  const chiPhi = (ghiDe: Partial<ChiPhiKhongDungLai> = {}): ChiPhiKhongDungLai => ({
    soChiPhi: 0,
    tongChiPhi: 0,
    soDinhKy: 0,
    soKhoanTienKhac: 0,
    tongKhoanTienKhac: 0,
    soKhoanVay: 0,
    soSoTietKiem: 0,
    tongThuNhap: 0,
    ...ghiDe,
  });

  it("chưa nhập gì → câu 'chưa có'", () => {
    expect(moTaKhoanMatTrang(chiPhi())).toBe("Hiện chưa có khoản chi phí hay khoản tiền khác nhập tay nào.");
  });

  it("chỉ chi phí nhập tay → một vế", () => {
    expect(moTaKhoanMatTrang(chiPhi({ soChiPhi: 2, tongChiPhi: 50_000 }))).toBe(
      "Đang có 2 khoản chi phí nhập tay (50.000 ₫).",
    );
  });

  it("chỉ khoản tiền khác → KHÔNG in vế chi phí 0", () => {
    expect(moTaKhoanMatTrang(chiPhi({ soKhoanTienKhac: 1, tongKhoanTienKhac: 7_000_000 }))).toBe(
      "Đang có 1 khoản tiền khác ghi tay (7.000.000 ₫).",
    );
  });

  it("cả ba vế → nối ', ' và ' và ' trước vế cuối", () => {
    expect(
      moTaKhoanMatTrang(
        chiPhi({ soChiPhi: 2, tongChiPhi: 50_000, soDinhKy: 1, soKhoanTienKhac: 1, tongKhoanTienKhac: 7_000_000 }),
      ),
    ).toBe("Đang có 2 khoản chi phí nhập tay (50.000 ₫), 1 chi phí định kỳ và 1 khoản tiền khác ghi tay (7.000.000 ₫).");
  });

  it("chỉ khoản vay → một vế riêng (hồ sơ vay mất là mất dư nợ, không dựng lại được)", () => {
    expect(moTaKhoanMatTrang(chiPhi({ soKhoanVay: 2 }))).toBe("Đang có 2 khoản vay (hồ sơ + dư nợ).");
  });

  it("đủ bốn vế → khoản vay là vế cuối", () => {
    expect(
      moTaKhoanMatTrang(
        chiPhi({
          soChiPhi: 2,
          tongChiPhi: 50_000,
          soDinhKy: 1,
          soKhoanTienKhac: 1,
          tongKhoanTienKhac: 7_000_000,
          soKhoanVay: 1,
        }),
      ),
    ).toBe(
      "Đang có 2 khoản chi phí nhập tay (50.000 ₫), 1 chi phí định kỳ, 1 khoản tiền khác ghi tay (7.000.000 ₫) và 1 khoản vay (hồ sơ + dư nợ).",
    );
  });
});
