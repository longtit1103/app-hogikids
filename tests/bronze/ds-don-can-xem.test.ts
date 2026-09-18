import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { demCanXem, dsDonCanXem } from "@/lib/bronze/ket-cuc-silver";
import { SHOP_SHOPEE } from "../helpers/shop-ids-fixture";
import { prisma } from "@/lib/prisma";

import { seedReference } from "../helpers/test-db";

/**
 * `dsDonCanXem` nuôi khối "Đơn chưa vào Sổ" ở /cai-dat: các đơn đã DỪNG thử lại tự động
 * (FAILED_SHAPE / FAILED_RETRY_LIMIT). Phải lấy BẢN MỚI NHẤT mỗi khoá và KHÔNG lẫn kết cục khác.
 */

async function taoDong(
  externalId: string,
  outcome: string | null,
  fetchedAt: Date,
  hash: string
): Promise<void> {
  await prisma.rawPancakeOrder.create({
    data: {
      shopId: SHOP_SHOPEE,
      externalId,
      payloadHash: hash,
      payload: { id: externalId },
      fetchedAt,
      silverOutcome: outcome,
      silverProcessedAt: outcome ? new Date() : null,
      silverNote: outcome === "FAILED_SHAPE" ? "Lỗi shape: thiếu field" : null,
    },
  });
}

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await prisma.rawPancakeOrder.deleteMany();
});

afterAll(async () => {
  await prisma.rawPancakeOrder.deleteMany();
});

describe("dsDonCanXem", () => {
  it("chỉ lấy FAILED_SHAPE và FAILED_RETRY_LIMIT, kèm ghi chú", async () => {
    await taoDong("ORD-A", "FAILED_SHAPE", new Date(), "h-a");
    await taoDong("ORD-B", "FAILED_RETRY_LIMIT", new Date(), "h-b");
    await taoDong("ORD-C", "APPLIED", new Date(), "h-c"); // KHÔNG được lấy
    await taoDong("ORD-D", null, new Date(), "h-d"); // đang chờ — KHÔNG phải "cần xem"

    const ds = await dsDonCanXem(20);

    expect(ds.map((d) => d.externalId).sort()).toEqual(["ORD-A", "ORD-B"]);
    expect(ds.find((d) => d.externalId === "ORD-A")?.silverNote).toContain("thiếu field");
  });

  it("lấy BẢN MỚI NHẤT của khoá — đơn đã được sửa (bản mới APPLIED) không còn hiện", async () => {
    // v1 hỏng shape, v2 (mới hơn) đã dựng được. Panel không được hiện đơn đã lành.
    await taoDong("ORD-X", "FAILED_SHAPE", new Date("2026-07-01T10:00:00Z"), "h-x1");
    await taoDong("ORD-X", "APPLIED", new Date("2026-07-01T11:00:00Z"), "h-x2");

    const ds = await dsDonCanXem(20);

    expect(ds).toHaveLength(0);
  });

  it("badge phải dùng TỔNG THẬT (demCanXem), không phải độ dài danh sách bị LIMIT", async () => {
    // 25 đơn cần xem: danh sách hiển thị bị cắt còn 20, nhưng badge phải báo 25 — nếu badge đếm
    // theo `list.length` thì chủ shop tưởng chỉ có 20 việc trong khi thực tế còn 5 đơn bị giấu.
    for (let i = 0; i < 25; i++) {
      await taoDong(`ORD-${String(i).padStart(3, "0")}`, "FAILED_SHAPE", new Date(), `h-${i}`);
    }

    const [ds, tong] = await Promise.all([dsDonCanXem(20), demCanXem()]);

    expect(ds).toHaveLength(20); // danh sách bị cắt
    expect(tong).toBe(25); // tổng thật cho badge
  });
});
