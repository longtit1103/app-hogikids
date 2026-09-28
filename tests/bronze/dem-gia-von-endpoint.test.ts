import { beforeAll, beforeEach, describe, expect, it } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi import route (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

import { POST } from "@/app/api/ingest/dem-gia-von/route";
import { thuGiuKhoaPhucHoi, traKhoaPhucHoi } from "@/lib/backup/khoa-bao-tri";
import {
  KEY_MOC_KIEM_GIA_VON,
  KEY_SO_LECH_GIA_VON,
} from "@/lib/gia-von/trang-thai-lech-gia-von";
import { prisma } from "@/lib/prisma";

import { SHOP_KHO } from "../helpers/shop-ids-fixture";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * `POST /api/ingest/dem-gia-von` — bước đếm cho nút "Đồng bộ ngay".
 *
 * VÌ SAO CÓ: bước đếm vốn nằm ở cuối lượt đêm, mà nút "Đồng bộ ngay" chạy workflow khác. Chủ shop
 * nhập hàng xong bấm nút, giá vốn mới ĐÃ về app nhưng dải nhắc việc im tới 03:00 hôm sau ⇒ tưởng
 * nút không ăn. Endpoint này lấp đúng khe đó.
 */

const VARIATION_ID = "cc000000-0000-4000-8000-000000000001";
const PRODUCT_ID = "dd000000-0000-4000-8000-000000000001";

const post = () =>
  POST(
    new Request("http://localhost/api/ingest/dem-gia-von", {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
    }),
  );

async function landBronze(giaPancake: number): Promise<void> {
  await prisma.rawPancakeProduct.create({
    data: {
      shopId: SHOP_KHO,
      externalId: PRODUCT_ID,
      payloadHash: `hash-${giaPancake}`,
      payload: {
        id: PRODUCT_ID,
        name: "Áo Dài Lụa",
        variations: [
          {
            id: VARIATION_ID,
            display_id: "SP-DEM-1",
            retail_price: 300_000,
            remain_quantity: 10,
            average_imported_price: giaPancake,
            fields: [{ name: "Size", value: "M" }],
          },
        ],
      },
    },
  });
}

async function taoBienThe(costPrice: number): Promise<void> {
  const sp = await prisma.product.create({
    data: { pancakeId: PRODUCT_ID, name: "Áo Dài Lụa", status: "ACTIVE", syncedAt: new Date() },
  });
  await prisma.variant.create({
    data: {
      pancakeId: VARIATION_ID,
      productId: sp.id,
      sku: "SP-DEM-1",
      label: "M",
      sellPrice: 300_000,
      costPrice,
      syncedAt: new Date(),
    },
  });
}

const docSetting = (key: string) => prisma.setting.findUnique({ where: { key } });

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.rawPancakeProduct.deleteMany();
  // `Setting` không nằm trong `truncateBusinessTables` (dữ liệu cấu hình) ⇒ dọn tay để phép kiểm
  // "chưa đếm lần nào" nói đúng sự thật.
  await prisma.setting.deleteMany({
    where: { key: { in: [KEY_SO_LECH_GIA_VON, KEY_MOC_KIEM_GIA_VON] } },
  });
});

describe("POST /api/ingest/dem-gia-von", () => {
  it("từ chối khi thiếu bearer", async () => {
    const res = await POST(new Request("http://localhost/api/ingest/dem-gia-von", { method: "POST" }));
    expect(res.status).toBe(401);
  });

  it("đếm đúng số mã lệch và chốt vào Setting", async () => {
    await taoBienThe(120_000);
    await landBronze(90_000); // Pancake 90.000 vs app 120.000 ⇒ 1 mã lệch

    const res = await post();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.stats.soLechGiaVon).toBe(1);
    expect((await docSetting(KEY_SO_LECH_GIA_VON))?.value).toBe("1");
    expect((await docSetting(KEY_MOC_KIEM_GIA_VON))?.value).toBeTruthy();
  });

  it("app khớp Pancake ⇒ ghi 0 (KHÁC hẳn 'chưa đếm lần nào')", async () => {
    await taoBienThe(90_000);
    await landBronze(90_000);

    const res = await post();

    expect((await res.json()).stats.soLechGiaVon).toBe(0);
    expect((await docSetting(KEY_SO_LECH_GIA_VON))?.value).toBe("0");
  });

  it("TUYỆT ĐỐI không chạm giá vốn — chỉ đếm, không ghi", async () => {
    await taoBienThe(120_000);
    await landBronze(90_000);

    await post();

    const v = await prisma.variant.findUniqueOrThrow({ where: { pancakeId: VARIATION_ID } });
    expect(v.costPrice).toBe(120_000); // giá app giữ nguyên, endpoint không phải đường ghi
  });

  it("đang PHỤC HỒI ⇒ từ chối, không ghi ô nào", async () => {
    await taoBienThe(120_000);
    await landBronze(90_000);

    const the = thuGiuKhoaPhucHoi();
    try {
      const res = await post();
      expect(res.status).toBeGreaterThanOrEqual(400);
    } finally {
      if (the) traKhoaPhucHoi(the);
    }

    expect(await docSetting(KEY_SO_LECH_GIA_VON)).toBeNull();
  });
});
