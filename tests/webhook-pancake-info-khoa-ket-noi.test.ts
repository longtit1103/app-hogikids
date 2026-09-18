import { afterAll, describe, expect, it } from "vitest";

import { docTrangThaiWebhookPancake } from "@/lib/ket-noi/webhook-pancake-info";
import { prisma } from "@/lib/prisma";

/**
 * Khối webhook trong thẻ Pancake (Khóa kết nối): 3 shop đủ URL đúng path n8n, và mốc
 * "sự kiện gần nhất" đọc từ hộp thư webhook. DB thật (`hogikids_test`) dùng chung với các
 * file test khác nên chỉ assert theo hướng "có sự kiện ⇒ có mốc gần đây" — không assert
 * "chưa từng nhận" cho shop khác (file khác có thể vừa seed sự kiện cho shop đó).
 */

const PAYLOAD = `{"test":"webhook-info-${Date.now()}"}`;
let idSeed: string | null = null;

afterAll(async () => {
  if (idSeed) await prisma.rawPancakeWebhookEvent.deleteMany({ where: { id: idSeed } });
});

describe("docTrangThaiWebhookPancake", () => {
  it("đủ 3 shop, URL đúng path n8n đã chốt trong huong-dan-cai-dat-workflows.md", async () => {
    const ds = await docTrangThaiWebhookPancake();
    expect(ds.map((d) => d.ten)).toEqual(["Shop Kho Tổng", "Shop Shopee", "Shop TikTok"]);
    expect(ds.map((d) => d.url)).toEqual([
      "https://n8n.example.com/webhook/pancake-pos",
      "https://n8n.example.com/webhook/pancake-pos-hogikids1",
      "https://n8n.example.com/webhook/pancake-pos-hogikids2",
    ]);
  });

  it("shop vừa nhận sự kiện live → mốc gần nhất hiện dạng tương đối", async () => {
    const row = await prisma.rawPancakeWebhookEvent.create({
      data: { shopId: "1942992175", payload: PAYLOAD, payloadHash: `h-${Date.now()}`, source: "webhook" },
    });
    idSeed = row.id;

    const ds = await docTrangThaiWebhookPancake();
    const shopee = ds.find((d) => d.ten === "Shop Shopee");
    expect(shopee?.ganNhat).toBeTruthy();
    // Sự kiện vừa seed (hoặc mới hơn từ file test khác) — kiểu gì cũng phải là mốc rất gần.
    expect(shopee?.ganNhat).toMatch(/vừa xong|phút trước/);
  });
});
