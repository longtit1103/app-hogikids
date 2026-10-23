import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { recomputeFeesInRange } from "@/lib/actions/settings-channels";
import { prisma } from "@/lib/prisma";

import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

/**
 * "Tính lại phí kỳ này" ghi bằng `updateMany` gom theo phí đích thay vì UPDATE từng đơn. Bài này chốt
 * KẾT QUẢ SỐ y hệt công thức từng đơn cũ — `Math.round(itemsTotal × (phí sàn % + phí thanh toán %) / 100)`
 * — trên fixture nhiều kênh, có ca làm tròn nửa đơn vị (kể cả số âm, nơi `round` của Postgres khác
 * `Math.round`), nhiều đơn chung một phí đích, đơn đã đúng phí (không đếm), đơn phí THẬT Shopee/TikTok
 * và đơn ngoài kỳ (không đụng). DB test thật (`hogikids_test`).
 */
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => {
  const { nguoiDungGia } = await import("../../helpers/nguoi-dung-gia");
  return {
    ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
    docNguoiDungPhien: vi.fn(async () => nguoiDungGia()),
  };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const RANGE = { from: new Date(2026, 6, 1), to: new Date(2026, 6, 31) };
const TRONG_KY = new Date(2026, 6, 15);
const NGOAI_KY = new Date(2026, 7, 15);

/** % gộp từng kênh trong bài (đặt ở `beforeEach`). */
const PCT: Record<string, number> = { facebook: 4.5, website: 2.5, direct: 0 };

type DonMau = { pancakeId: string; channelId: string; itemsTotal: number; platformFeeEst: number; orderedAt?: Date };

const DON: DonMau[] = [
  // Facebook 4,5%: 100 × 4,5% = 4,5 ⇒ 5; −100 ⇒ −4,5 ⇒ Math.round = −4 (Postgres round = −5).
  { pancakeId: "GN-FB-1", channelId: "facebook", itemsTotal: 100, platformFeeEst: 0 },
  { pancakeId: "GN-FB-2", channelId: "facebook", itemsTotal: -100, platformFeeEst: 0 },
  { pancakeId: "GN-FB-3", channelId: "facebook", itemsTotal: 333_333, platformFeeEst: 1 },
  // Ba đơn cùng phí đích (200k × 4,5% = 9000) — một nhóm `updateMany`.
  { pancakeId: "GN-FB-4", channelId: "facebook", itemsTotal: 200_000, platformFeeEst: 0 },
  { pancakeId: "GN-FB-5", channelId: "facebook", itemsTotal: 200_000, platformFeeEst: 123 },
  { pancakeId: "GN-FB-6", channelId: "facebook", itemsTotal: 200_000, platformFeeEst: 9000 }, // đã đúng
  // Website 2,5%: 60 × 2,5% = 1,5 ⇒ 2; 180k ⇒ 4500 — trùng phí đích với không đơn nào khác.
  { pancakeId: "GN-WEB-1", channelId: "website", itemsTotal: 60, platformFeeEst: 0 },
  { pancakeId: "GN-WEB-2", channelId: "website", itemsTotal: 180_000, platformFeeEst: 77 },
  // Bán trực tiếp 0% ⇒ mọi đơn về 0, chung một nhóm với đơn khác kênh cũng về 0.
  { pancakeId: "GN-DIR-1", channelId: "direct", itemsTotal: 500_000, platformFeeEst: 999 },
  { pancakeId: "GN-DIR-2", channelId: "direct", itemsTotal: 1_000, platformFeeEst: 0 }, // đã đúng
  // Phí THẬT — KHÔNG được chạm dù % kênh là bao nhiêu.
  { pancakeId: "GN-SHOPEE", channelId: "shopee", itemsTotal: 100_000, platformFeeEst: 12_345 },
  { pancakeId: "GN-TIKTOK", channelId: "tiktok", itemsTotal: 100_000, platformFeeEst: 6_789 },
  // Ngoài kỳ — không đụng.
  { pancakeId: "GN-FB-NGOAI", channelId: "facebook", itemsTotal: 300_000, platformFeeEst: 777, orderedAt: NGOAI_KY },
];

/** Công thức từng đơn của bản cũ — thước đo "y hệt". */
function phiTheoCongThucCu(d: DonMau): number {
  if (d.channelId === "shopee" || d.channelId === "tiktok" || d.orderedAt === NGOAI_KY) return d.platformFeeEst;
  return Math.round((d.itemsTotal * (PCT[d.channelId] ?? 0)) / 100);
}

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.channel.update({ where: { id: "facebook" }, data: { platformFeePct: 3, paymentFeePct: 1.5 } });
  await prisma.channel.update({ where: { id: "website" }, data: { platformFeePct: 2.5, paymentFeePct: 0 } });
  await prisma.channel.update({ where: { id: "direct" }, data: { platformFeePct: 0, paymentFeePct: 0 } });
  // Shopee/TikTok giữ % seed (10+2,5 / 6+2, khác 0) — chính hàng rào phí thật giữ số, không phải % = 0.
  await prisma.order.createMany({
    data: DON.map((d, i) => ({
      pancakeId: d.pancakeId,
      code: `GN${i}`,
      channelId: d.channelId,
      status: "COMPLETED" as const,
      orderedAt: d.orderedAt ?? TRONG_KY,
      syncedAt: d.orderedAt ?? TRONG_KY,
      itemsTotal: d.itemsTotal,
      platformFeeEst: d.platformFeeEst,
    })),
  });
});

afterAll(async () => {
  // Trả % về giá trị seed (seedReference không ghi đè kênh đã có) — file test sau không thừa hưởng % lạ.
  await prisma.channel.update({ where: { id: "facebook" }, data: { platformFeePct: 0, paymentFeePct: 0 } });
  await prisma.channel.update({ where: { id: "website" }, data: { platformFeePct: 0, paymentFeePct: 0 } });
  await prisma.$disconnect();
});

describe("recomputeFeesInRange — gom updateMany, kết quả số y hệt công thức từng đơn", () => {
  it("mọi đơn mang đúng phí của công thức cũ; `updated` = số đơn thực sự đổi phí", async () => {
    const res = await recomputeFeesInRange(RANGE);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const sauKhi = new Map(
      (await prisma.order.findMany({ select: { pancakeId: true, platformFeeEst: true } })).map((o) => [
        o.pancakeId,
        o.platformFeeEst,
      ]),
    );
    for (const d of DON) {
      expect({ don: d.pancakeId, phi: sauKhi.get(d.pancakeId) }).toEqual({ don: d.pancakeId, phi: phiTheoCongThucCu(d) });
    }

    // Ghim vài con số tay để thước đo không tự lừa mình.
    expect(sauKhi.get("GN-FB-1")).toBe(5);
    expect(sauKhi.get("GN-FB-2")).toBe(-4);
    expect(sauKhi.get("GN-FB-3")).toBe(15_000);
    expect(sauKhi.get("GN-WEB-1")).toBe(2);
    expect(sauKhi.get("GN-SHOPEE")).toBe(12_345);
    expect(sauKhi.get("GN-TIKTOK")).toBe(6_789);
    expect(sauKhi.get("GN-FB-NGOAI")).toBe(777);

    const soDonDoi = DON.filter((d) => phiTheoCongThucCu(d) !== d.platformFeeEst).length;
    expect(soDonDoi).toBe(8);
    expect(res.data.updated).toBe(soDonDoi);
  });

  it("chạy lần 2 ⇒ updated = 0, không đổi gì", async () => {
    await recomputeFeesInRange(RANGE);
    const truoc = await prisma.order.findMany({ select: { pancakeId: true, platformFeeEst: true }, orderBy: { pancakeId: "asc" } });

    const lan2 = await recomputeFeesInRange(RANGE);
    expect(lan2.ok && lan2.data.updated).toBe(0);
    expect(
      await prisma.order.findMany({ select: { pancakeId: true, platformFeeEst: true }, orderBy: { pancakeId: "asc" } }),
    ).toEqual(truoc);
  });
});
