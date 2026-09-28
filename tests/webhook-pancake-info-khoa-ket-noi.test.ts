import { afterAll, describe, expect, it } from "vitest";

import {
  docTrangThaiWebhookPancake,
  LOC_SU_KIEN_CHUNG_MINH_CON_SONG,
} from "@/lib/ket-noi/webhook-pancake-info";
import { WEBHOOK_PANCAKE_PATH } from "@/lib/n8n/provision/doc-goi-workflow-tu-repo";
import { prisma } from "@/lib/prisma";

/**
 * Khối webhook trong thẻ Pancake (Khóa kết nối): 3 shop đủ URL đúng path n8n, và mốc
 * "sự kiện gần nhất" đọc từ hộp thư webhook. DB thật (`hogikids_test`) dùng chung với các
 * file test khác nên chỉ assert theo hướng "có sự kiện ⇒ có mốc gần đây" — không assert
 * "chưa từng nhận" cho shop khác (file khác có thể vừa seed sự kiện cho shop đó).
 */

/** Base mặc định khi `Setting.n8nWebhookPublicBase` chưa điền — khớp `webhook-pancake-info.ts`. */
const BASE_MONG_DOI = "https://n8n.example.com";

const PAYLOAD = `{"test":"webhook-info-${Date.now()}"}`;
let idSeed: string | null = null;

afterAll(async () => {
  if (idSeed) await prisma.rawPancakeWebhookEvent.deleteMany({ where: { id: idSeed } });
});

describe("docTrangThaiWebhookPancake", () => {
  it("đủ 3 shop, URL ghép từ base + ĐÚNG path của chính workflow n8n", async () => {
    const ds = await docTrangThaiWebhookPancake();
    expect(ds.map((d) => d.ten)).toEqual(["Shop Kho Tổng", "Shop Shopee", "Shop TikTok"]);

    // Suy kỳ vọng TỪ NGUỒN SỰ THẬT (`WEBHOOK_PANCAKE_PATH`, rút từ chính file workflow) chứ KHÔNG
    // ghi cứng chuỗi path. Hai lý do, cả hai đều đã cắn thật:
    //  1. Path webhook bị XOAY khi cần (lần gần nhất 21/09 sau audit bảo mật). Ghi cứng nghĩa là
    //     mỗi lượt xoay lại vỡ test ở một chỗ chẳng liên quan gì tới thứ test này bảo vệ.
    //  2. Path đang dùng là thứ KHÔNG nên rải thêm bản sao trong repo — càng nhiều chỗ chép lại,
    //     càng nhiều cửa để nó rò ra bản public (đúng lỗ hổng H-03 của đợt audit).
    // Thứ đáng khoá ở đây là PHÉP GHÉP (base + "/webhook/" + path của đúng shop đó), không phải
    // giá trị path — nếu ai nối nhầm shop hoặc bỏ mất đoạn "/webhook/" thì test này đỏ.
    for (const [i, vai] of (["kho", "shopee", "tiktok"] as const).entries()) {
      expect(WEBHOOK_PANCAKE_PATH[vai]).not.toBe(""); // rút path hỏng ⇒ URL cụt, phải đỏ
      expect(ds[i].url).toBe(`${BASE_MONG_DOI}/webhook/${WEBHOOK_PANCAKE_PATH[vai]}`);
    }
    // 3 shop PHẢI có 3 path khác nhau — gán trùng là 3 shop đổ chung một hộp thư.
    expect(new Set(ds.map((d) => d.url)).size).toBe(3);
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

  it("PING THỬ không làm tươi mốc — nó không chứng minh Pancake còn bắn về", async () => {
    // Shop KHO cố ý chọn riêng: các file test khác seed sự kiện cho shop này nên mốc "thật" có thể
    // đã có sẵn. Phép khoá vì thế là "mốc KHÔNG ĐỔI sau khi thêm ping", đúng thứ cần bảo vệ, thay vì
    // "phải là chưa từng nhận" (assert đó vốn mù vì phụ thuộc thứ tự chạy file).
    const truoc = (await docTrangThaiWebhookPancake()).find((d) => d.ten === "Shop Kho Tổng")?.ganNhat;

    const ping = await prisma.rawPancakeWebhookEvent.create({
      data: {
        shopId: "714995134",
        payload: `{"test":true}`,
        payloadHash: `ping-${Date.now()}`,
        source: "webhook",
        processedAs: "ping-thu",
      },
    });
    try {
      const sau = (await docTrangThaiWebhookPancake()).find((d) => d.ten === "Shop Kho Tổng")?.ganNhat;
      expect(sau).toBe(truoc);
    } finally {
      await prisma.rawPancakeWebhookEvent.delete({ where: { id: ping.id } });
    }
  });

});

/**
 * Khoá THẲNG phép lọc, trên một shopId GIẢ không file test nào khác đụng tới — đi qua
 * `docTrangThaiWebhookPancake` thì phép kiểm MÙ: hàm đó chỉ đọc 3 shop thật, mà file test khác vẫn
 * seed sự kiện cho chúng, nên assert "có mốc gần đây" xanh kể cả khi phép lọc hỏng.
 */
describe("LOC_SU_KIEN_CHUNG_MINH_CON_SONG", () => {
  const SHOP_GIA = `TEST-LOC-${Date.now()}`;

  afterAll(async () => {
    await prisma.rawPancakeWebhookEvent.deleteMany({ where: { shopId: SHOP_GIA } });
  });

  it("nhận dòng THẬT + dòng NULL, LOẠI ping thử và dòng nạp bù", async () => {
    await prisma.rawPancakeWebhookEvent.createMany({
      data: [
        { shopId: SHOP_GIA, payload: "{}", payloadHash: "a", source: "webhook", processedAs: "don-hang" },
        // NULL = ghi kết cục THẤT BẠI — sự kiện CÓ THẬT, phải được tính. Đây là cái bẫy SQL: đo thật
        // trên DB này, `{ not: "ping-thu" }` trần trả 0 cho dòng NULL, dạng OR trả 1.
        { shopId: SHOP_GIA, payload: "{}", payloadHash: "b", source: "webhook", processedAs: null },
        { shopId: SHOP_GIA, payload: `{"test":true}`, payloadHash: "c", source: "webhook", processedAs: "ping-thu" },
        { shopId: SHOP_GIA, payload: "{}", payloadHash: "d", source: "file", processedAs: "don-hang" },
      ],
    });

    const khop = await prisma.rawPancakeWebhookEvent.findMany({
      where: { ...LOC_SU_KIEN_CHUNG_MINH_CON_SONG, shopId: SHOP_GIA },
      select: { payloadHash: true },
    });

    expect(khop.map((r) => r.payloadHash).sort()).toEqual(["a", "b"]);
  });
});
