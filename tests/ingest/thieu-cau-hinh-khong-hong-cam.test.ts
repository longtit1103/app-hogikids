import { beforeEach, describe, expect, it } from "vitest";

import { POST as webhookPost } from "@/app/api/ingest/webhook/[shop]/route";
import { transformFromRaw } from "@/lib/bronze/transform-from-raw";
import { xuLyTonKho } from "@/lib/ingest/webhook-stock";
import { KEY_SHOP_ID, KEY_WAREHOUSE_KHO_TONG, xoaCacheCauHinhShop } from "@/lib/ket-noi/cau-hinh-shop";
import { prisma } from "@/lib/prisma";

import { SEED_SHOP_ID, SHOP_KHO } from "../helpers/shop-ids-fixture";

/**
 * Các nhánh "thiếu cấu hình" phải HỎNG ĐÚNG CÁCH — kêu đúng chỗ, không mất dữ liệu, không ngập
 * panel. Suite chính không chạy tới các nhánh này (luôn được seed đủ) nên khoá riêng ở đây
 * (review đối kháng 21/08: 4 nhánh mới không có test nào).
 */

const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

async function seedLai(): Promise<void> {
  for (const [key, value] of SEED_SHOP_ID) {
    await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }
  xoaCacheCauHinhShop();
}

beforeEach(seedLai);

describe("webhook route khi chưa cấu hình shop ID", () => {
  it("trả 503 kèm hướng dẫn, KHÔNG ghi hộp thư, KHÔNG lộ lỗi hạ tầng", async () => {
    await prisma.setting.deleteMany({
      where: { key: { in: [KEY_SHOP_ID.kho, KEY_SHOP_ID.shopee, KEY_SHOP_ID.tiktok] } },
    });
    xoaCacheCauHinhShop();
    const truoc = await prisma.rawPancakeWebhookEvent.count();

    const res = await webhookPost(
      new Request("http://localhost/api/ingest/webhook/shopee", {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}` },
        body: '{"type":"orders","id":"1"}',
      }),
      { params: Promise.resolve({ shop: "shopee" }) }
    );

    expect(res.status).toBe(503); // tạm-bận: Pancake/n8n gửi lại được, nhánh ghi file n8n vẫn giữ
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Chưa cấu hình shop ID");
    expect(await prisma.rawPancakeWebhookEvent.count()).toBe(truoc);
    await seedLai();
  });

  it("slug lạ vẫn 400 tĩnh — không đụng DB, không phụ thuộc cấu hình", async () => {
    const res = await webhookPost(
      new Request("http://localhost/api/ingest/webhook/abc", {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}` },
        body: "{}",
      }),
      { params: Promise.resolve({ shop: "abc" }) }
    );
    expect(res.status).toBe(400);
  });
});

describe("tồn kho realtime khi chưa cấu hình warehouse", () => {
  it("kết cục 'chua-cau-hinh' nêu tên key — KHÔNG phải can-xem (không ngập panel)", async () => {
    await prisma.setting.deleteMany({ where: { key: KEY_WAREHOUSE_KHO_TONG } });
    xoaCacheCauHinhShop();

    const r = await xuLyTonKho(
      SHOP_KHO,
      JSON.stringify({
        type: "variations_warehouses",
        inserted_at: "2026-08-21T10:00:00",
        variation_id: "v-1",
        product_id: "p-1",
        warehouse_id: "w-1",
        remain_quantity: 5,
        actual_remain_quantity: 5,
      })
    );

    expect(r.ket).toBe("chua-cau-hinh");
    expect(r.note).toContain(KEY_WAREHOUSE_KHO_TONG);
  });
});

describe("transform TikTok Shop khi nguồn tuỳ chọn chưa bật", () => {
  it("bỏ qua KÈM cảnh báo nêu tên key, không throw (rebuild bản clone không chết)", async () => {
    await prisma.setting.deleteMany({ where: { key: KEY_SHOP_ID.tiktokShop } });
    xoaCacheCauHinhShop();
    const warnings: string[] = [];

    const stats = await transformFromRaw("tiktok/statements", warnings);

    expect(warnings.some((w) => w.includes("tiktokShopShopId"))).toBe(true);
    expect(stats.settlementsUpserted).toBe(0);
  });
});
