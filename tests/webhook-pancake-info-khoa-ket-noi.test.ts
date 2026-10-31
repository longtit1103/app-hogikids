import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  docTrangThaiWebhookPancake,
  LOC_SU_KIEN_CHUNG_MINH_CON_SONG,
} from "@/lib/ket-noi/webhook-pancake-info";
import { KHOA_SETTING_DUONG_DAN_WEBHOOK, VAI_WEBHOOK_PANCAKE } from "@/lib/n8n/provision/duong-dan-webhook-pancake";
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

/** Path GIẢ đúng dạng 32 hex — đứng thay path thật của instance trong `Setting`. */
const DUONG_DAN_GIA = {
  kho: "0123456789abcdef0123456789abcdef",
  shopee: "fedcba9876543210fedcba9876543210",
  tiktok: "00112233445566778899aabbccddeeff",
} as const;
const KHOA_PATH = VAI_WEBHOOK_PANCAKE.map((v) => KHOA_SETTING_DUONG_DAN_WEBHOOK[v]);

async function ghiDuongDanGia() {
  for (const vai of VAI_WEBHOOK_PANCAKE) {
    const key = KHOA_SETTING_DUONG_DAN_WEBHOOK[vai];
    await prisma.setting.upsert({ where: { key }, create: { key, value: DUONG_DAN_GIA[vai] }, update: { value: DUONG_DAN_GIA[vai] } });
  }
}

// DB test dùng chung: giữ nguyên trạng thái 3 khoá path trước file này để trả lại y nguyên.
let truocFile: Array<{ key: string; value: string }> = [];
beforeAll(async () => {
  truocFile = await prisma.setting.findMany({ where: { key: { in: KHOA_PATH } }, select: { key: true, value: true } });
  await ghiDuongDanGia();
});

afterAll(async () => {
  if (idSeed) await prisma.rawPancakeWebhookEvent.deleteMany({ where: { id: idSeed } });
  await prisma.setting.deleteMany({ where: { key: { in: KHOA_PATH } } });
  for (const r of truocFile) await prisma.setting.create({ data: r });
});

describe("docTrangThaiWebhookPancake", () => {
  it("đủ 3 shop, URL ghép từ base + ĐÚNG path của shop đó trong Setting", async () => {
    const ds = await docTrangThaiWebhookPancake();
    expect(ds.map((d) => d.ten)).toEqual(["Shop Kho Tổng", "Shop Shopee", "Shop TikTok"]);

    // Path đọc từ `Setting` (dữ liệu của instance) — CÙNG nguồn với lượt "Cài / cập nhật workflows".
    // Thứ khoá ở đây là PHÉP GHÉP (base + "/webhook/" + path của ĐÚNG shop): nối nhầm shop hoặc mất
    // đoạn "/webhook/" là đỏ. Path giả, không phải path thật — path thật không được nằm trong repo.
    for (const [i, vai] of VAI_WEBHOOK_PANCAKE.entries()) {
      expect(ds[i].url).toBe(`${BASE_MONG_DOI}/webhook/${DUONG_DAN_GIA[vai]}`);
      expect(ds[i].loi).toBeNull();
    }
    // 3 shop PHẢI có 3 path khác nhau — gán trùng là 3 shop đổ chung một hộp thư.
    expect(new Set(ds.map((d) => d.url)).size).toBe(3);
  });

  it("Setting THIẾU / HỎNG path một shop → shop đó KHÔNG có URL (không hiện placeholder), lỗi nêu đúng khoá", async () => {
    await prisma.setting.deleteMany({ where: { key: KHOA_SETTING_DUONG_DAN_WEBHOOK.shopee } });
    await prisma.setting.update({ where: { key: KHOA_SETTING_DUONG_DAN_WEBHOOK.tiktok }, data: { value: "__DUONG_DAN_WEBHOOK_TIKTOK__" } });
    try {
      const ds = await docTrangThaiWebhookPancake();
      const theoTen = new Map(ds.map((d) => [d.ten, d]));
      expect(theoTen.get("Shop Shopee")?.url).toBeNull();
      expect(theoTen.get("Shop Shopee")?.loi).toContain(KHOA_SETTING_DUONG_DAN_WEBHOOK.shopee);
      expect(theoTen.get("Shop TikTok")?.url).toBeNull();
      expect(theoTen.get("Shop TikTok")?.loi).toContain(KHOA_SETTING_DUONG_DAN_WEBHOOK.tiktok);
      // Shop còn path vẫn hiện URL — thiếu một shop không được làm sập cả khối.
      expect(theoTen.get("Shop Kho Tổng")?.url).toBe(`${BASE_MONG_DOI}/webhook/${DUONG_DAN_GIA.kho}`);
      expect(JSON.stringify(ds)).not.toContain("__DUONG_DAN_");
    } finally {
      await ghiDuongDanGia();
    }
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
