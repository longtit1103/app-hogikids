import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";

import type { DeXuatGiaVon } from "@/lib/gia-von/doi-chieu-gia-von";
import { ghiGiaVonTheoPancake } from "@/lib/gia-von/ghi-gia-von-theo-pancake";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * ĐƯỜNG GHI của công cụ đối chiếu giá vốn — chạy trên DB test thật.
 *
 * Hai lời hứa an toàn ở đây đều là lời hứa về TIỀN (`Variant.costPrice` quyết COGS, COGS quyết lãi),
 * và trước bộ test này cả hai đều chỉ tồn tại dưới dạng câu chữ: xoá điều kiện `costPrice` khỏi câu
 * UPDATE thì toàn bộ suite cũ vẫn xanh. Mỗi `it` dưới đây ép đúng một lời hứa tự đứng.
 */

const SKU = "SKU-GHI-GIA-VON";
let thuMucTam: string;

async function taoBienThe(costPrice: number): Promise<string> {
  const sp = await prisma.product.create({
    data: { pancakeId: `P-${SKU}`, name: "Áo dài test", status: "ACTIVE", syncedAt: new Date() },
  });
  const bt = await prisma.variant.create({
    data: {
      pancakeId: `V-${SKU}`,
      productId: sp.id,
      sku: SKU,
      label: "M/Đỏ",
      sellPrice: 300_000,
      costPrice,
      syncedAt: new Date(),
    },
  });
  return bt.id;
}

const deXuat = (variantId: string, giaHienTai: number, giaDeXuat: number): DeXuatGiaVon[] => [
  { variantId, pancakeId: `V-${SKU}`, sku: SKU, ten: "Áo dài test · M/Đỏ", giaHienTai, giaDeXuat, nguon: "nhap-cuoi" },
];

const layGiaVon = async (id: string) =>
  (await prisma.variant.findUniqueOrThrow({ where: { id }, select: { costPrice: true } })).costPrice;

beforeAll(async () => {
  await seedReference();
  thuMucTam = mkdtempSync(path.join(tmpdir(), "ghi-gia-von-"));
});
beforeEach(async () => {
  await truncateBusinessTables();
});
afterAll(() => {
  rmSync(thuMucTam, { recursive: true, force: true });
});

describe("guard chống ghi đè (H-2)", () => {
  it("giá vốn ĐÃ ĐỔI giữa chừng ⇒ KHÔNG ghi đè, số của chủ shop được giữ nguyên", async () => {
    // Chủ shop nhập tay 150.000đ SAU khi script đọc danh sách (lúc đọc còn là 100.000đ).
    const id = await taoBienThe(150_000);
    const backup = path.join(thuMucTam, "guard-chan.json");

    const kq = await ghiGiaVonTheoPancake(prisma, deXuat(id, 100_000, 180_000), {
      duongDanBackup: backup,
      cheDo: "theo-pancake",
      ghiLuc: new Date("2026-08-31T01:00:00.000Z"),
    });

    expect(kq.daGhi).toBe(0);
    expect(kq.boQua).toBe(1);
    expect(await layGiaVon(id)).toBe(150_000); // KHÔNG phải 180.000 — script không đè.
  });

  it("giá vốn còn đúng như lúc xem ⇒ ghi được", async () => {
    const id = await taoBienThe(100_000);
    const backup = path.join(thuMucTam, "guard-cho-qua.json");

    const kq = await ghiGiaVonTheoPancake(prisma, deXuat(id, 100_000, 180_000), {
      duongDanBackup: backup,
      cheDo: "theo-pancake",
      ghiLuc: new Date("2026-08-31T01:00:00.000Z"),
    });

    expect(kq.daGhi).toBe(1);
    expect(kq.boQua).toBe(0);
    expect(await layGiaVon(id)).toBe(180_000);
  });
});

describe("backup là cổng chặn (M-4)", () => {
  it("KHÔNG ghi được backup ⇒ ném lỗi và KHÔNG chạm DB một dòng nào", async () => {
    const id = await taoBienThe(100_000);
    // Thư mục không tồn tại ⇒ writeFileSync ném ENOENT.
    const backupHong = path.join(thuMucTam, "khong-co-thu-muc-nay", "backup.json");

    await expect(
      ghiGiaVonTheoPancake(prisma, deXuat(id, 100_000, 180_000), {
        duongDanBackup: backupHong,
        cheDo: "theo-pancake",
        ghiLuc: new Date("2026-08-31T01:00:00.000Z"),
      }),
    ).rejects.toThrow(/Không ghi được backup/);

    expect(await layGiaVon(id)).toBe(100_000); // giá vốn nguyên vẹn — không có backup thì không ghi.
  });

  it("backup ghi thành công mang mốc THẬT + đủ giá cũ/mới để hoàn nguyên", async () => {
    const id = await taoBienThe(100_000);
    const backup = path.join(thuMucTam, "backup-day-du.json");
    const moc = new Date("2026-08-31T01:23:45.000Z");

    await ghiGiaVonTheoPancake(prisma, deXuat(id, 100_000, 180_000), {
      duongDanBackup: backup,
      cheDo: "theo-pancake",
      ghiLuc: moc,
    });

    const doc = JSON.parse(readFileSync(backup, "utf8"));
    expect(doc.ghiLuc).toBe(moc.toISOString()); // KHÔNG phải null — bản chụp tự chứng minh mốc.
    expect(doc.cheDo).toBe("theo-pancake");
    expect(doc.soDong).toBe(1);
    expect(doc.dong[0]).toMatchObject({ variantId: id, costPriceCu: 100_000, costPriceMoi: 180_000 });
  });
});
