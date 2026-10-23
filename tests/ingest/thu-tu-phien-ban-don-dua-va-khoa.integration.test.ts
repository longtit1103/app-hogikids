import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Prisma } from "@/generated/prisma/client";
import { demDaHachToan } from "@/lib/bronze/doi-soat-hach-toan";
import { dongDauKetCuc, KET_CUC } from "@/lib/bronze/ket-cuc-silver";
import { transformFromRaw } from "@/lib/bronze/transform-from-raw";
import { prisma } from "@/lib/prisma";

import { SHOP_KHO, SHOP_TIKTOK } from "../helpers/shop-ids-fixture";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Đóng bản dưới (`dongDauCacBanDuoi`) chạy ở MỌI lượt đóng dấu — hai hệ quả đồng thời phải canh:
 *  1. ĐUA: lô trang API chụp `latestPayloads` MỘT lần đầu lô rồi chạy vài giây. Giữa chừng một bản MỚI
 *     HƠN của cùng đơn land và được dựng xong (webhook) ⇒ bản lô đang cầm đã bị đóng `SUPERSEDED`. Lô
 *     tới đơn đó thì CAS dấu trượt — phải xử như "bản cũ" (cuộn lượt ghi, đếm `ordersSkippedStale`),
 *     KHÔNG chết cả lô, KHÔNG `skipped` (bật backlog giả).
 *  2. KHOÁ: đóng bản dưới là việc dọn dẹp — dòng đang bị phiên khác khoá thì BỎ QUA (`SKIP LOCKED`),
 *     không chờ; lượt sau đóng nốt.
 */
const T1 = "2026-07-01T05:00:00.000000";
const T2 = "2026-07-01T06:30:00.123456";

const DON = (id: string, fee: number, status: number, updatedAt: string, mirror = false) => ({
  id,
  system_id: id,
  status,
  status_name: "x",
  inserted_at: "2026-07-01T03:00:00.000000",
  updated_at: updatedAt,
  status_history: [],
  order_sources_name: mirror ? "Affiliate" : "Tiktok",
  marketplace_id: "-9",
  total_price: 200000,
  total_discount: 0,
  shipping_fee: 0,
  fee_marketplace: fee,
  advanced_platform_fee: { payment_fee: 0 },
  customer: { name: "Chị Hoa" },
  items: [
    {
      quantity: 2,
      discount_each_product: 0,
      variation_info: { display_id: "SKU-TT-1", name: "Áo thun", retail_price: 100000 },
    },
  ],
});
/** Payload có `id` + mốc nhưng thiếu field bắt buộc ⇒ zod hỏng ⇒ nhánh `FAILED_SHAPE`. */
const HONG_SHAPE = (id: string, updatedAt: string) => ({ id, updated_at: updatedAt });

let soHash = 0;
async function chen(shopId: string, externalId: string, payload: object, fetchedAt: Date): Promise<string> {
  const r = await prisma.rawPancakeOrder.create({
    data: {
      shopId,
      externalId,
      payloadHash: `h-dua-${++soHash}`,
      payload: payload as Prisma.InputJsonValue,
      fetchedAt,
    },
    select: { id: true },
  });
  return r.id;
}
const ketCuc = async (id: string) =>
  (await prisma.rawPancakeOrder.findUniqueOrThrow({ where: { id }, select: { silverOutcome: true } }))
    .silverOutcome;

/**
 * Lô theo từng đơn `externalIds` cầm ảnh chụp đầu lô (bản L của `idDua` đứng đầu). Ngay sau khi câu nạp
 * `latestPayloads` trả về — TRƯỚC khi lô tới đơn đó — bản R mới hơn land và một lượt khác (webhook) dựng
 * R xong, đóng L `SUPERSEDED`. Câu nạp là `$queryRawUnsafe` ĐẦU TIÊN của lượt transform đơn.
 */
async function chayLoBiChen(shopId: string, externalIds: string[], idDua: string, payloadR: object) {
  let R = "";
  const goc = prisma.$queryRawUnsafe.bind(prisma);
  vi.spyOn(prisma, "$queryRawUnsafe").mockImplementationOnce((async (...a: Parameters<typeof goc>) => {
    const anhChup = await goc(...a);
    R = await chen(shopId, idDua, payloadR, new Date());
    await transformFromRaw("orders", [], { externalIds: [idDua], shopId });
    return anhChup;
  }) as typeof prisma.$queryRawUnsafe);
  const warnings: string[] = [];
  const stats = await transformFromRaw("orders", warnings, { externalIds, shopId });
  return { R, stats, warnings };
}

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.rawPancakeOrder.deleteMany();
  vi.restoreAllMocks();
});

describe("lô cầm ảnh chụp cũ, bản mới hơn được dựng chen giữa", () => {
  it("nhánh mirror: lô KHÔNG chết, đơn sau trong lô vẫn được đóng dấu, bản cũ đếm là bản cũ", async () => {
    const idDua = `AF${SHOP_TIKTOK}O9001`;
    const idSau = `AF${SHOP_TIKTOK}O9002`;
    const L = await chen(SHOP_KHO, idDua, DON(idDua, 0, 3, T1, true), new Date(Date.now() - 60_000));
    const M = await chen(SHOP_KHO, idSau, DON(idSau, 0, 3, T1, true), new Date(Date.now() - 60_000));

    const { R, stats } = await chayLoBiChen(SHOP_KHO, [idDua, idSau], idDua, DON(idDua, 0, 4, T2, true));

    expect(await ketCuc(L)).toBe(KET_CUC.SUPERSEDED);
    expect(await ketCuc(R)).toBe(KET_CUC.EXCLUDED_MIRROR);
    expect(await ketCuc(M)).toBe(KET_CUC.EXCLUDED_MIRROR);
    expect(stats.ordersSkippedStale).toBe(1);
    expect(stats.ordersSkippedMirror).toBe(1);
    expect(stats.skipped).toBe(0);
    // Cổng "đã land vs đã hạch toán": 2 đơn của lô đều có số phận ⇒ không bật backlog.
    expect(demDaHachToan(stats)).toBe(2);
  });

  it("nhánh FAILED_SHAPE: bản lô cầm hỏng shape, bản mới map được ⇒ Silver giữ bản mới, không skipped", async () => {
    const id = "585229755054269101";
    const L = await chen(SHOP_TIKTOK, id, HONG_SHAPE(id, T1), new Date(Date.now() - 60_000));

    const { R, stats, warnings } = await chayLoBiChen(SHOP_TIKTOK, [id], id, DON(id, 5839, 4, T2));

    expect(await ketCuc(L)).toBe(KET_CUC.SUPERSEDED);
    expect(await ketCuc(R)).toBe(KET_CUC.APPLIED);
    expect(stats.skipped).toBe(0);
    expect(stats.ordersSkippedStale).toBe(1);
    expect(warnings.some((w) => w.includes("lỗi shape"))).toBe(false);
    const o = await prisma.order.findUniqueOrThrow({ where: { pancakeId: id } });
    expect(o.platformFeeEst).toBe(5839);
  });

  it("đơn thường, bản mới hỏng shape: lượt ghi bản cũ cuộn lại, đếm bản cũ — không 'Bỏ qua đơn'", async () => {
    const id = "585229755054269102";
    const L = await chen(SHOP_TIKTOK, id, DON(id, 16000, 3, T1), new Date(Date.now() - 60_000));

    const { R, stats, warnings } = await chayLoBiChen(SHOP_TIKTOK, [id], id, HONG_SHAPE(id, T2));

    expect(await ketCuc(L)).toBe(KET_CUC.SUPERSEDED);
    expect(await ketCuc(R)).toBe(KET_CUC.FAILED_SHAPE);
    expect(stats.skipped).toBe(0);
    expect(stats.ordersUpserted).toBe(0);
    expect(stats.ordersSkippedStale).toBe(1);
    expect(warnings.some((w) => w.startsWith("Bỏ qua đơn"))).toBe(false);
    // Bản đứng đầu hỏng shape ⇒ Silver KHÔNG được dựng bằng ảnh chụp cũ (hiện "cần xem" thay vào đó).
    expect(await prisma.order.count({ where: { pancakeId: id } })).toBe(0);
  });

  it("đơn thường, bản mới map được: guard giữ Silver bản mới, bản cũ là bản cũ", async () => {
    const id = "585229755054269103";
    const L = await chen(SHOP_TIKTOK, id, DON(id, 16000, 3, T1), new Date(Date.now() - 60_000));

    const { R, stats } = await chayLoBiChen(SHOP_TIKTOK, [id], id, DON(id, 5839, 4, T2));

    expect(await ketCuc(L)).toBe(KET_CUC.SUPERSEDED);
    expect(await ketCuc(R)).toBe(KET_CUC.APPLIED);
    expect(stats.skipped).toBe(0);
    expect(stats.ordersSkippedStale).toBe(1);
    const o = await prisma.order.findUniqueOrThrow({ where: { pancakeId: id } });
    expect(o.platformFeeEst).toBe(5839);
  });
});

describe("đóng bản dưới không chờ dòng đang bị khoá", () => {
  it("dòng dưới bị phiên khác khoá ⇒ bỏ qua tức thì; lượt đóng dấu sau đóng nốt", async () => {
    const id = "585229755054269104";
    const duoi = await chen(SHOP_TIKTOK, id, DON(id, 16000, 3, T1), new Date());
    const dau = await chen(SHOP_TIKTOK, id, DON(id, 5839, 4, T2), new Date(Date.now() - 60_000));

    let nhaKhoa!: () => void;
    const choNha = new Promise<void>((r) => (nhaKhoa = r));
    let baoDaKhoa!: () => void;
    const daKhoa = new Promise<void>((r) => (baoDaKhoa = r));
    const giuKhoa = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "RawPancakeOrder" WHERE "id" = ${duoi} FOR UPDATE`;
        baoDaKhoa();
        await choNha;
      },
      { timeout: 30_000 }
    );
    await daKhoa;
    let ketQua: string;
    try {
      ketQua = await Promise.race([
        dongDauKetCuc(prisma, dau, KET_CUC.APPLIED).then(() => "xong"),
        new Promise<string>((r) => setTimeout(() => r("treo"), 5_000)),
      ]);
      expect(await ketCuc(duoi)).toBeNull();
    } finally {
      nhaKhoa();
      await giuKhoa;
    }
    expect(ketQua).toBe("xong");
    expect(await ketCuc(dau)).toBe(KET_CUC.APPLIED);

    // Đóng lại cùng kết cục là no-op cho bản đầu (CAS `= ketCuc`), nhưng lượt này đóng nốt bản dưới.
    await dongDauKetCuc(prisma, dau, KET_CUC.APPLIED);
    expect(await ketCuc(duoi)).toBe(KET_CUC.SUPERSEDED);
  }, 30_000);
});
