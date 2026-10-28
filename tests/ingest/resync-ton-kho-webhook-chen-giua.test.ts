import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi import route (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

/**
 * Móc chạy NGAY ĐẦU `transformFromRaw` — tức SAU khi route đã chụp danh sách tồn do webhook ghi và
 * TRƯỚC khi transform ghi tồn từ ảnh Bronze. Đúng khe 10–120 giây mà webhook thật vẫn ghi tiếp.
 * Không đặt móc ⇒ pass-through xuống bản thật.
 */
const moc = vi.hoisted(() => ({ truocTransform: null as null | (() => Promise<void>) }));

vi.mock("@/lib/bronze/transform-from-raw", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/bronze/transform-from-raw")>();
  const transformFromRaw: typeof actual.transformFromRaw = async (...args) => {
    const chay = moc.truocTransform;
    moc.truocTransform = null;
    if (chay) await chay();
    return actual.transformFromRaw(...args);
  };
  return { ...actual, transformFromRaw };
});

import { POST } from "@/app/api/ingest/resync-products/route";
import { empty } from "@/lib/bronze/transform-raw-helpers";
import { upsertOneProduct } from "@/lib/ingest/pancake-upsert";
import { pancakeProductSchema } from "@/lib/ingest/pancake-schemas";
import { prisma } from "@/lib/prisma";

import { SHOP_KHO } from "../helpers/shop-ids-fixture";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Webhook tồn kho chen GIỮA lúc lượt vá đêm chụp danh sách và lúc transform ghi biến thể đó.
 *
 * Trước đây `upsertOneProduct` ghi `stock` VÔ ĐIỀU KIỆN: số API (chụp trước đơn) đè số webhook
 * (sau đơn), còn mốc `stockUpdatedAt` của webhook thì vẫn giữ (mới hơn lúc chụp nên không bị dọn) ⇒
 * tồn sai MÀ mốc nói "đã có sự kiện mới", sự kiện tới trễ sau đó bị guard loại. Kỳ vọng: câu ghi
 * biến thể tự so mốc — webhook mới hơn lần API đi nhìn thì tồn webhook giữ nguyên.
 */

const VARIATION_ID = "8c1f6a52-0f6b-4d8e-9a43-2f0c6d1e7b90";
const PRODUCT_ID = "3b7e1d2c-5a4f-4c6b-8e9d-1a2b3c4d5e6f";

const SAN_PHAM = {
  id: PRODUCT_ID,
  name: "Váy bé gái",
  variations: [
    { id: VARIATION_ID, display_id: "SKU-CHEN-GIUA", retail_price: 100_000, remain_quantity: 30, average_imported_price: 60_000 },
  ],
};

const post = () =>
  POST(
    new Request("http://localhost/api/ingest/resync-products", {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
    }),
  );

/** Lượt kéo `products` shop kho — mốc "API đi nhìn Pancake" mà lượt vá dùng làm thước đo. */
async function ghiNhatKySync(startedAt: Date): Promise<void> {
  await prisma.syncLog.create({
    data: {
      kind: "PANCAKE",
      status: "OK",
      startedAt,
      finishedAt: startedAt,
      stats: { stream: "products", shopId: SHOP_KHO, landed: 0, mode: "land+transform" },
    },
  });
}

async function landBronze(fetchedAt: Date): Promise<void> {
  await prisma.rawPancakeProduct.create({
    data: { shopId: SHOP_KHO, externalId: PRODUCT_ID, payloadHash: `hash-${fetchedAt.getTime()}`, payload: SAN_PHAM, fetchedAt },
  });
}

const bienThe = () => prisma.variant.findUniqueOrThrow({ where: { pancakeId: VARIATION_ID } });

/** Webhook ghi tồn — đúng 2 cột mà `xuLyTonKho` chạm. */
const webhookGhi = (stock: number, luc: Date) =>
  prisma.variant.update({ where: { pancakeId: VARIATION_ID }, data: { stock, stockUpdatedAt: luc } });

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  moc.truocTransform = null;
  await truncateBusinessTables();
  await prisma.rawPancakeProduct.deleteMany();
  await prisma.syncLog.deleteMany();
});

describe("POST /api/ingest/resync-products — webhook chen giữa chụp và ghi", () => {
  it("webhook ghi 29 SAU lúc chụp ⇒ tồn GIỮ 29, mốc webhook giữ, không cảnh báo giả", async () => {
    const apiNhin = new Date(Date.now() - 10 * 60_000);
    await ghiNhatKySync(apiNhin);
    await landBronze(apiNhin);
    await post(); // tạo biến thể, tồn API = 30
    expect((await bienThe()).stock).toBe(30);

    const webhook = { luc: new Date(0) };
    moc.truocTransform = async () => {
      // Muộn hơn lúc route chụp ⇒ không nằm trong danh sách giữ lại. Đặt +1s thay vì `new Date()`: trên
      // runner CI nhanh, mốc webhook có thể TRÙNG mili-giây với mốc chụp của route ⇒ bước dọn mốc
      // (`stockUpdatedAt <= lúc chụp`) xoá marker dù tồn 29 vẫn giữ — đỏ giả (CI public 28/10).
      webhook.luc = new Date(Date.now() + 1_000);
      await webhookGhi(29, webhook.luc);
    };
    const res = await post();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.stats.mode).toBe("resynced");
    expect(body.stats.skipped).toBe(0);
    expect((body.stats.warnings ?? []).filter((w: string) => w.includes("Bỏ qua"))).toEqual([]);
    const v = await bienThe();
    expect(v.stock).toBe(29); // KHÔNG bị ảnh API cũ hơn đè về 30
    expect(v.stockUpdatedAt?.toISOString()).toBe(webhook.luc.toISOString());
  });

  it("đối chứng: webhook CŨ HƠN lần API đi nhìn ⇒ API vẫn thắng, mốc được dọn", async () => {
    const apiNhin = new Date(Date.now() - 10 * 60_000);
    await ghiNhatKySync(apiNhin);
    await landBronze(apiNhin);
    await post();

    moc.truocTransform = () => webhookGhi(29, new Date(Date.now() - 20 * 60_000)).then(() => undefined);
    await post();

    const v = await bienThe();
    expect(v.stock).toBe(30);
    expect(v.stockUpdatedAt).toBeNull();
  });
});

describe("upsertOneProduct — mốc API cho tồn kho", () => {
  const sanPham = pancakeProductSchema.parse(SAN_PHAM);
  const chay = async (mocApi?: Date) => {
    const stats = empty();
    const warnings: string[] = [];
    await upsertOneProduct(sanPham, stats, warnings, mocApi);
    return { stats, warnings };
  };

  it("webhook mới hơn mốc API ⇒ không ghi tồn, các cột khác vẫn cập nhật", async () => {
    await chay(); // tạo biến thể (tồn 30)
    const mocWebhook = new Date();
    await webhookGhi(29, mocWebhook);

    const { stats, warnings } = await chay(new Date(mocWebhook.getTime() - 60_000));

    expect(stats.skipped).toBe(0);
    expect(warnings).toEqual([]);
    const v = await bienThe();
    expect(v.stock).toBe(29);
    expect(v.stockUpdatedAt?.toISOString()).toBe(mocWebhook.toISOString());
    expect(v.sku).toBe("SKU-CHEN-GIUA");
  });

  it("webhook đúng bằng hoặc cũ hơn mốc API ⇒ API ghi tồn", async () => {
    await chay();
    const mocWebhook = new Date(Date.now() - 60_000);
    await webhookGhi(29, mocWebhook);

    await chay(mocWebhook);

    expect((await bienThe()).stock).toBe(30);
  });

  it("không truyền mốc ⇒ hành vi cũ (ghi tồn vô điều kiện — lượt rebuild trả quyền cho API)", async () => {
    await chay();
    await webhookGhi(29, new Date());

    await chay();

    expect((await bienThe()).stock).toBe(30);
  });
});
