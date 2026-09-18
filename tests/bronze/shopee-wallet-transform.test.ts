import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { landRaw } from "@/lib/bronze/land-raw";
import { SHOP_SHOPEE } from "../helpers/shop-ids-fixture";
import { transformFromRaw } from "@/lib/bronze/transform-from-raw";
import { prisma } from "@/lib/prisma";

/**
 * Integration land Bronze `RawShopeeWalletTxn` → transform Silver `ShopeeSettlement`
 * (`hogikids_test`). Bất biến kiểm:
 *  - khoá idExpr tổng hợp `txnTime|type|orderCode|amount` (Rút Tiền orderCode null → '-').
 *  - idempotent qua RE-LAND (cùng dòng land lần 2 → count không đổi).
 *  - amount CÓ DẤU giữ nguyên; ĐỘC LẬP các bảng khác.
 */

const ROWS = [
  { txnTime: "2026-06-26T10:26:33+07:00", type: "REVENUE", orderCode: "ORD1", amount: 503310, status: "Giao dịch thành công", runningBalance: 645328 },
  { txnTime: "2026-05-18T00:53:10+07:00", type: "ADJUSTMENT", orderCode: "ORD2", amount: -172007, status: "Giao dịch thành công", runningBalance: -18037 },
  { txnTime: "2026-05-05T19:36:02+07:00", type: "WITHDRAWAL", orderCode: null, amount: -2097069, status: "Giao dịch thành công", runningBalance: 0 },
];

const payload = () => JSON.stringify({ data: ROWS });

async function cleanup(): Promise<void> {
  await prisma.shopeeSettlement.deleteMany({});
  await prisma.rawShopeeWalletTxn.deleteMany({});
}

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("land + transform shopee/wallet", () => {
  it("land 3 dòng → khoá idExpr đúng (Rút Tiền orderCode null → '-')", async () => {
    const res = await landRaw("shopee/wallet", SHOP_SHOPEE, payload());
    expect(res.landed).toBe(3);
    expect(res.skippedNoId).toBe(0);
    expect(res.landedIds.sort()).toEqual(
      [
        "2026-06-26T10:26:33+07:00|REVENUE|ORD1|503310",
        "2026-05-18T00:53:10+07:00|ADJUSTMENT|ORD2|-172007",
        "2026-05-05T19:36:02+07:00|WITHDRAWAL|-|-2097069",
      ].sort(),
    );
  });

  it("transform → ShopeeSettlement đúng số + dấu + orderCode null cho Rút Tiền", async () => {
    const res = await landRaw("shopee/wallet", SHOP_SHOPEE, payload());
    const w: string[] = [];
    const stats = await transformFromRaw("shopee/wallet", w, { externalIds: res.landedIds });
    expect(stats.shopeeUpserted).toBe(3);

    const all = await prisma.shopeeSettlement.findMany();
    expect(all).toHaveLength(3);

    const wd = all.find((r) => r.type === "WITHDRAWAL");
    expect(wd?.orderCode).toBeNull();
    expect(wd?.amount).toBe(-2097069);

    const rev = all.find((r) => r.type === "REVENUE");
    expect(rev?.amount).toBe(503310);
    // txnTime neo +07 → UTC 03:26:33.
    expect(rev?.txnTime.toISOString()).toBe("2026-06-26T03:26:33.000Z");

    const adj = all.find((r) => r.type === "ADJUSTMENT");
    expect(adj?.amount).toBe(-172007);
  });

  it("idempotent: re-land cùng dòng → landed 0; transform full → vẫn 3", async () => {
    const first = await landRaw("shopee/wallet", SHOP_SHOPEE, payload());
    const w: string[] = [];
    await transformFromRaw("shopee/wallet", w, { externalIds: first.landedIds });

    // Land lần 2 CÙNG payload → dedupe theo (shopId, externalId, payloadHash) → 0 dòng mới.
    const second = await landRaw("shopee/wallet", SHOP_SHOPEE, payload());
    expect(second.landed).toBe(0);

    // Rebuild full (không externalIds) → upsert theo externalId, không nhân đôi.
    await transformFromRaw("shopee/wallet", w);
    const all = await prisma.shopeeSettlement.findMany();
    expect(all).toHaveLength(3);
  });
});
