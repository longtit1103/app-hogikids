import { beforeEach, describe, expect, it } from "vitest";

import type { Prisma } from "@/generated/prisma/client";
import { khaoSatLegacy } from "@/lib/bronze/backfill-ket-cuc-legacy";
import {
  demTonDong,
  dsDonCanXem,
  KET_CUC,
  locDonChuaDongDau,
  locDonLegacy,
} from "@/lib/bronze/ket-cuc-silver";
import { prisma } from "@/lib/prisma";

import { SHOP_TIKTOK } from "../helpers/shop-ids-fixture";

/**
 * Các câu sổ kết cục PHẢI đọc "bản đứng đầu" theo thứ tự phiên bản chung (`updated_at` trước,
 * `fetchedAt` sau), không phải dòng land muộn nhất. Mỗi ca dựng ĐÚNG MỘT đơn hai dòng mà hai thứ tự
 * cho ra hai bản đầu KHÁC nhau: dòng nội dung MỚI (T2) land SỚM mang kết cục cần hỏi, dòng trang API
 * cũ (T1) land MUỘN đã `APPLIED`. Câu nào lùi về `fetchedAt` thì thấy T1 và trả kết quả rỗng ⇒ đỏ.
 */
const T1 = "2026-07-01T05:00:00.000000";
const T2 = "2026-07-01T06:30:00.123456";

const GIO = 3_600_000;
let soHash = 0;
async function chen(
  externalId: string,
  updatedAt: string,
  fetchedAt: Date,
  silverOutcome: string | null
): Promise<string> {
  const r = await prisma.rawPancakeOrder.create({
    data: {
      shopId: SHOP_TIKTOK,
      externalId,
      payloadHash: `h-skc-${++soHash}`,
      payload: { id: externalId, updated_at: updatedAt } as Prisma.InputJsonValue,
      fetchedAt,
      silverOutcome,
      ...(silverOutcome ? { silverProcessedAt: fetchedAt } : {}),
    },
    select: { id: true },
  });
  return r.id;
}

/** Đơn hai dòng: T2 (nội dung mới, land 2 giờ trước) mang `ketCucDau`; T1 (cũ, land 1 giờ trước) APPLIED. */
async function donHaiDong(externalId: string, ketCucDau: string | null): Promise<void> {
  await chen(externalId, T2, new Date(Date.now() - 2 * GIO), ketCucDau);
  await chen(externalId, T1, new Date(Date.now() - 1 * GIO), KET_CUC.APPLIED);
}

beforeEach(async () => {
  await prisma.rawPancakeOrder.deleteMany();
});

describe("sổ kết cục đọc bản đứng đầu theo updated_at", () => {
  it("locDonChuaDongDau: bản đầu còn NULL dù dòng land muộn đã APPLIED ⇒ là đơn dở", async () => {
    await donHaiDong("585229755054269201", null);
    expect(await locDonChuaDongDau(SHOP_TIKTOK, ["585229755054269201"])).toEqual(["585229755054269201"]);
  });

  it("demTonDong: đếm theo bản đầu, mốc cũ nhất là mốc land của bản đầu", async () => {
    await donHaiDong("585229755054269202", null);
    const kq = await demTonDong(30);
    expect(kq.tong).toBe(1);
    const dau = await prisma.rawPancakeOrder.findFirstOrThrow({
      where: { externalId: "585229755054269202", silverOutcome: null },
      select: { fetchedAt: true },
    });
    expect(kq.cuNhat?.getTime()).toBe(dau.fetchedAt.getTime());
  });

  it("dsDonCanXem: bản đầu FAILED_SHAPE ⇒ hiện cần xem dù dòng land muộn đã APPLIED", async () => {
    await donHaiDong("585229755054269203", KET_CUC.FAILED_SHAPE);
    const ds = await dsDonCanXem(10);
    expect(ds.map((d) => [d.externalId, d.silverOutcome])).toEqual([
      ["585229755054269203", KET_CUC.FAILED_SHAPE],
    ]);
  });

  it("locDonLegacy + khaoSatLegacy: bản đầu LEGACY ⇒ thuộc lô backfill, khảo sát đếm khớp", async () => {
    await donHaiDong("585229755054269204", KET_CUC.LEGACY);
    expect(await locDonLegacy(10)).toEqual([{ shopId: SHOP_TIKTOK, externalId: "585229755054269204" }]);
    const ks = await khaoSatLegacy();
    expect(ks.legacyMoiNhat).toBe(1);
    expect(ks.legacyBanCu).toBe(0);
  });
});
