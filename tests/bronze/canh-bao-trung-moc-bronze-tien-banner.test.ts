import { beforeEach, describe, expect, it } from "vitest";

import { canhBaoTrungMocBanner } from "@/lib/bronze/dem-trung-moc-phien-ban-bang-tien";
import { prisma } from "@/lib/prisma";
import {
  ERROR_WINDOW_HOURS,
  getRecentDataErrorKinds,
  getTrungMocBronzeTien,
  TTL_TRUNG_MOC_MS,
  xoaCacheTrungMocBronzeTien,
} from "@/lib/queries/sync-health";

/**
 * Nguồn của banner toàn app: đọc Bronze (KHÔNG đọc SyncLog) nên đỏ bền sau cửa sổ 48 giờ của `getRecentDataErrorKinds`, tắt
 * khi khoá có phiên bản mới hơn; cache ngắn để layout không quét bốn bảng mỗi request.
 */

const MOC = new Date("2026-11-20T10:00:00.000Z");

async function chenCost(id: string, externalId: string, hash: string, fetchedAt: Date): Promise<void> {
  await prisma.rawTiktokBusinessCost.create({
    data: { id, shopId: "BC-BANNER", externalId, payload: {}, payloadHash: hash, fetchedAt },
  });
}

beforeEach(async () => {
  xoaCacheTrungMocBronzeTien();
  // Cả BỐN bảng soi: banner đếm toàn bảng, dòng sót của file test khác (route ingest để lại bản trùng mốc) làm sai kết quả.
  await prisma.rawTiktokBusinessCost.deleteMany();
  await prisma.rawTiktokBusinessInvoice.deleteMany();
  await prisma.rawTiktokShopTransaction.deleteMany();
  await prisma.rawTiktokShopPayment.deleteMany();
  await prisma.syncLog.deleteMany();
});

describe("getTrungMocBronzeTien (nguồn banner)", () => {
  it("Bronze sạch ⇒ rỗng, câu banner null", async () => {
    await chenCost("b1", "2026-11-20", "h1", MOC);
    const ds = await getTrungMocBronzeTien();
    expect(ds).toEqual([]);
    expect(canhBaoTrungMocBanner(ds)).toBeNull();
  });

  it("còn ca ⇒ đỏ DÙ SyncLog ERROR đã quá cửa sổ 48 giờ; có bản mới hơn ⇒ tắt", async () => {
    await chenCost("b1", "2026-11-20", "h1", MOC);
    await chenCost("b2", "2026-11-20", "h2", MOC);
    // Lượt ERROR cũ 72 giờ: banner đồng bộ chung (48 giờ) đã im — tín hiệu Bronze phải còn.
    const cu = new Date(Date.now() - (ERROR_WINDOW_HOURS + 24) * 3_600_000);
    await prisma.syncLog.create({
      data: { kind: "TIKTOK_ADS", status: "ERROR", startedAt: cu, finishedAt: cu, error: "trùng mốc" },
    });
    expect(await getRecentDataErrorKinds()).toEqual([]);

    const ds = await getTrungMocBronzeTien();
    expect(ds).toEqual([{ bang: "RawTiktokBusinessCost", trungMocDau: 1, lapTrongLuot: 0 }]);
    expect(canhBaoTrungMocBanner(ds)).toContain("RawTiktokBusinessCost");

    await chenCost("b3", "2026-11-20", "h3", new Date(MOC.getTime() + 60_000)); // phiên bản mới hơn
    xoaCacheTrungMocBronzeTien();
    expect(await getTrungMocBronzeTien()).toEqual([]);
  });

  it("cache: trong TTL không đọc lại; hết TTL đọc lại", async () => {
    const t0 = 1_000_000_000_000;
    expect(await getTrungMocBronzeTien(t0)).toEqual([]);
    await chenCost("b1", "2026-11-20", "h1", MOC);
    await chenCost("b2", "2026-11-20", "h2", MOC);
    expect(await getTrungMocBronzeTien(t0 + 1_000)).toEqual([]); // vừa đo xong ⇒ số cũ
    expect(await getTrungMocBronzeTien(t0 + TTL_TRUNG_MOC_MS - 1)).toEqual([]); // còn trong TTL ⇒ số cũ
    expect(await getTrungMocBronzeTien(t0 + TTL_TRUNG_MOC_MS)).toHaveLength(1); // hết TTL ⇒ đo lại
  });

  it("nhiều request đồng thời dùng chung một lượt đo", async () => {
    await chenCost("b1", "2026-11-20", "h1", MOC);
    await chenCost("b2", "2026-11-20", "h2", MOC);
    const [a, b, c] = await Promise.all([getTrungMocBronzeTien(), getTrungMocBronzeTien(), getTrungMocBronzeTien()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).toHaveLength(1);
  });
});
