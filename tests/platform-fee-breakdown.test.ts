import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { calcPnl } from "@/lib/reports/pnl";
import { computeBackfilledPlatformFee, computePlatformFeeComponents } from "@/lib/reports/platform-fee-breakdown";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Chi tiết phí sàn đọc từ `Order.raw->'advanced_platform_fee'` (`hogikids_test`).
 *
 * Bất biến kiểm: chi tiết chỉ DIỄN GIẢI tổng của `calcPnl`, không bao giờ vượt
 * hay đổi nó — cùng tập "đơn hợp lệ" (loại RETURNED/CANCELLED), cùng biên kỳ.
 * Và các key KHÔNG phải phí (`marketplace_voucher`, tiền ship, `returned_fee`)
 * TUYỆT ĐỐI không được cộng vào: cộng nhầm là thổi phí sàn lên, ăn thẳng vào
 * lãi hiển thị cho chủ shop.
 */

const RANGE = { from: new Date(2026, 5, 1), to: new Date(2026, 5, 30) };
const IN_RANGE = new Date(2026, 5, 15);
const NGOAI_KY = new Date(2026, 4, 15);

// Đơn thật 583601650514297876 (TikTok, 19/04/2026) — Σ 5 khoản = 101.237 đúng
// từng đồng với `fee_marketplace`, đã đối chiếu chéo với TikTok Shop API.
const PHI_DON_THAT = {
  tax: 5250,
  payment_fee: 17500,
  service_fee: 17587,
  iva_vat_amount: 3500, // khoản CON của `tax` — cộng thêm là tính hai lần
  diff_shipping_fee: 0,
  marketplace_voucher: 20000, // sàn tài trợ, KHÔNG phải phí
  platform_commission: 37800,
  shipping_fee_amount: 0,
  affiliate_commission: 23100,
  isr_income_tax_amount: 1750, // khoản CON của `tax`
  customer_paid_shipping_fee: 0,
};
const TONG_PHI_DON_THAT = 101_237;

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function taoDon(
  pancakeId: string,
  opts: {
    status?: "COMPLETED" | "RETURNED" | "CANCELLED";
    orderedAt?: Date;
    platformFeeEst: number;
    phi?: Record<string, number> | null;
    channelId?: string;
  }
): Promise<void> {
  await prisma.order.create({
    data: {
      pancakeId,
      code: pancakeId,
      channelId: opts.channelId ?? "tiktok",
      status: opts.status ?? "COMPLETED",
      orderedAt: opts.orderedAt ?? IN_RANGE,
      syncedAt: IN_RANGE,
      itemsTotal: 350_000,
      discount: 0,
      platformFeeEst: opts.platformFeeEst,
      raw: opts.phi === null ? {} : { advanced_platform_fee: opts.phi ?? PHI_DON_THAT },
    },
  });
}

const tong = (xs: { amount: number }[]) => xs.reduce((s, x) => s + x.amount, 0);

describe("computePlatformFeeComponents", () => {
  it("tách đúng 5 khoản phí của đơn thật, Σ = tổng phí sàn", async () => {
    await taoDon("PF-1", { platformFeeEst: TONG_PHI_DON_THAT });

    const components = await computePlatformFeeComponents(RANGE);
    const byKey = new Map(components.map((c) => [c.key, c.amount]));

    expect(byKey.get("platform_commission")).toBe(37_800);
    expect(byKey.get("affiliate_commission")).toBe(23_100);
    expect(byKey.get("payment_fee")).toBe(17_500);
    expect(byKey.get("service_fee")).toBe(17_587);
    expect(byKey.get("tax")).toBe(5_250);
    expect(tong(components)).toBe(TONG_PHI_DON_THAT);
  });

  it("KHÔNG cộng voucher sàn tài trợ, tiền ship, hay khoản con của thuế", async () => {
    await taoDon("PF-2", { platformFeeEst: TONG_PHI_DON_THAT });

    const keys = (await computePlatformFeeComponents(RANGE)).map((c) => c.key);
    for (const k of [
      "marketplace_voucher",
      "shipping_fee_amount",
      "customer_paid_shipping_fee",
      "diff_shipping_fee",
      "iva_vat_amount",
      "isr_income_tax_amount",
    ]) {
      expect(keys).not.toContain(k);
    }
  });

  it("Σ chi tiết KHÔNG BAO GIỜ vượt tổng phí sàn của calcPnl", async () => {
    await taoDon("PF-OK", { platformFeeEst: TONG_PHI_DON_THAT });
    await taoDon("PF-TRONG", { platformFeeEst: 19_500, phi: null }); // Pancake không trả chi tiết
    await taoDon("PF-UOC-TINH", { platformFeeEst: 8_000, phi: null, channelId: "facebook" }); // phí ước tính %

    const [pnl, components] = await Promise.all([calcPnl(RANGE), computePlatformFeeComponents(RANGE)]);
    expect(tong(components)).toBe(TONG_PHI_DON_THAT);
    expect(pnl.platformFee).toBe(TONG_PHI_DON_THAT + 19_500 + 8_000);
    expect(tong(components)).toBeLessThanOrEqual(pnl.platformFee);
  });

  it("loại đơn hoàn/hủy và đơn ngoài kỳ — khớp tập đơn của calcPnl", async () => {
    await taoDon("PF-HOAN", { platformFeeEst: TONG_PHI_DON_THAT, status: "RETURNED" });
    await taoDon("PF-HUY", { platformFeeEst: TONG_PHI_DON_THAT, status: "CANCELLED" });
    await taoDon("PF-CU", { platformFeeEst: TONG_PHI_DON_THAT, orderedAt: NGOAI_KY });

    const [pnl, components] = await Promise.all([calcPnl(RANGE), computePlatformFeeComponents(RANGE)]);
    expect(components).toHaveLength(0);
    expect(pnl.platformFee).toBe(0);
  });

  it("lọc theo kênh giống calcPnl(channelId)", async () => {
    await taoDon("PF-TT", { platformFeeEst: TONG_PHI_DON_THAT, channelId: "tiktok" });
    await taoDon("PF-SP", {
      platformFeeEst: 30_000,
      channelId: "shopee",
      phi: { platform_commission: 10_000, seller_transaction_fee: 12_000, service_fee: 5_000, tax: 3_000 },
    });

    const [toanShop, chiTiktok, chiShopee] = await Promise.all([
      computePlatformFeeComponents(RANGE),
      computePlatformFeeComponents(RANGE, { channelId: "tiktok" }),
      computePlatformFeeComponents(RANGE, { channelId: "shopee" }),
    ]);

    expect(tong(toanShop)).toBe(TONG_PHI_DON_THAT + 30_000);
    expect(tong(chiTiktok)).toBe(TONG_PHI_DON_THAT);
    expect(tong(chiShopee)).toBe(30_000);
    // Khoản riêng của Shopee có nhãn riêng, không rơi vào "chưa có chi tiết".
    expect(chiShopee.map((c) => c.key)).toContain("seller_transaction_fee");
  });

  it("bỏ qua khoản = 0 và giá trị không phải số (object đối soát của TikTok)", async () => {
    await prisma.order.create({
      data: {
        pancakeId: "PF-LA",
        code: "PF-LA",
        channelId: "tiktok",
        status: "COMPLETED",
        orderedAt: IN_RANGE,
        syncedAt: IN_RANGE,
        itemsTotal: 100_000,
        discount: 0,
        platformFeeEst: 10_000,
        raw: {
          advanced_platform_fee: {
            platform_commission: 10_000,
            service_fee: 0,
            tax: null,
            settlement: { id: "abc", amount: 123 },
          },
        },
      },
    });

    const components = await computePlatformFeeComponents(RANGE);
    expect(components).toHaveLength(1);
    expect(components[0]).toMatchObject({ key: "platform_commission", amount: 10_000 });
  });

  it("đơn có advanced_platform_fee KHÔNG phải object → không được làm sập truy vấn", async () => {
    // `jsonb_each` văng "cannot call jsonb_each on a non-object"; schema khai field này là nullish
    // nên shape này HỢP LỆ. Không guard thì cả trang Lãi/Lỗ trả 500 — mất luôn bảng P&L lẫn nút xuất
    // Excel, chứ không riêng phần chi tiết phí.
    for (const [ten, phi] of [
      ["null", null],
      ["so", 123],
      ["chuoi", "abc"],
      ["mang", [1, 2]],
    ] as const) {
      await prisma.order.create({
        data: {
          pancakeId: `PF-SHAPE-${ten}`,
          code: `PF-SHAPE-${ten}`,
          channelId: "tiktok",
          status: "COMPLETED",
          orderedAt: IN_RANGE,
          syncedAt: IN_RANGE,
          itemsTotal: 100_000,
          discount: 0,
          platformFeeEst: 10_000,
          raw: { advanced_platform_fee: phi },
        },
      });
    }
    await taoDon("PF-BINH-THUONG", { platformFeeEst: TONG_PHI_DON_THAT });

    // Không throw, và vẫn đọc đúng đơn bình thường nằm cùng kỳ.
    const components = await computePlatformFeeComponents(RANGE);
    expect(tong(components)).toBe(TONG_PHI_DON_THAT);
  });

  it("sắp giảm dần theo số tiền (khoản nặng nhất lên đầu)", async () => {
    await taoDon("PF-SORT", { platformFeeEst: TONG_PHI_DON_THAT });

    const amounts = (await computePlatformFeeComponents(RANGE)).map((c) => c.amount);
    expect(amounts).toEqual([...amounts].sort((a, b) => b - a));
  });
});

/**
 * Phí của đơn ĐƯỢC BÙ là số app tự ước (Pancake mất đơn gốc), nên vĩnh viễn
 * không chia được thành khoản — tách riêng để bảng nói đúng nguyên nhân thay vì
 * đổ hết cho "Pancake trả thiếu". Phải cùng tập đơn + cùng biên kỳ với `calcPnl`,
 * lệch là dòng con lệch dòng cha.
 */
describe("computeBackfilledPlatformFee", () => {
  async function taoDonBu(pancakeId: string, phi: number, opts?: { status?: "COMPLETED" | "CANCELLED"; orderedAt?: Date }) {
    await prisma.order.create({
      data: {
        pancakeId,
        code: pancakeId,
        channelId: "shopee",
        status: opts?.status ?? "COMPLETED",
        orderedAt: opts?.orderedAt ?? IN_RANGE,
        syncedAt: IN_RANGE,
        itemsTotal: 350_000,
        discount: 0,
        platformFeeEst: phi,
        backfilledFromMirror: true,
        raw: {},
      },
    });
  }

  it("cộng phí đơn bù, bỏ qua đơn thường", async () => {
    await taoDonBu("BU-1", 50_000);
    await taoDonBu("BU-2", 30_000);
    await taoDon("THUONG", { platformFeeEst: TONG_PHI_DON_THAT });

    expect(await computeBackfilledPlatformFee(RANGE)).toBe(80_000);
  });

  it("bỏ đơn hoàn/hủy và đơn ngoài kỳ — đúng tập đơn của calcPnl", async () => {
    await taoDonBu("BU-HUY", 90_000, { status: "CANCELLED" });
    await taoDonBu("BU-NGOAI-KY", 70_000, { orderedAt: NGOAI_KY });
    await taoDonBu("BU-HOP-LE", 25_000);

    expect(await computeBackfilledPlatformFee(RANGE)).toBe(25_000);
  });

  it("không có đơn bù nào → 0 (không phải null)", async () => {
    await taoDon("CHI-DON-THUONG", { platformFeeEst: TONG_PHI_DON_THAT });

    expect(await computeBackfilledPlatformFee(RANGE)).toBe(0);
  });

  it("lọc theo kênh khi có channelId", async () => {
    await taoDonBu("BU-SHOPEE", 40_000);

    expect(await computeBackfilledPlatformFee(RANGE, { channelId: "shopee" })).toBe(40_000);
    expect(await computeBackfilledPlatformFee(RANGE, { channelId: "tiktok" })).toBe(0);
  });
});
