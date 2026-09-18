import { PrismaClient } from "@prisma/client";
import { expect, request as pwRequest, type APIResponse } from "@playwright/test";

import { INGEST_SECRET_TEST } from "./test-constants";
import { e2eDatabaseUrlFromEnv } from "./test-database-url";

/**
 * Helper e2e cho ingest Bronze (`POST /api/ingest/raw`) — thay hẳn endpoint cũ `/api/ingest/pancake`.
 *
 * Body: `{ stream, shopId, payload }` với `payload` là CHUỖI `JSON.stringify({ data: [...] })`
 * (n8n đẩy TEXT THÔ Pancake trả về — JS không parse, int64 an toàn).
 *
 * 2 điều bắt buộc khi seed qua luồng này:
 *  1. PRODUCTS đi TRƯỚC ORDERS — item đơn tra `Variant` theo SKU để có giá vốn.
 *  2. PRODUCTS phải land vào shop KHO (transform chỉ đọc products của shop kho — nguồn giá vốn).
 */

// Import + re-export từ fixture chung (đường dẫn tương đối — Playwright không resolve alias "@"):
// MỘT nguồn giá trị với vitest + các lượt seed Setting, hết cảnh hai bản chép tay trôi nhau.
import { SHOP_KHO, SHOP_SHOPEE, SHOP_TIKTOK, SHOP_TIKTOK_SHOP } from "../helpers/shop-ids-fixture";

// `SHOP_TIKTOK` (Pancake, vai "tiktok") ≠ `SHOP_TIKTOK_SHOP` (TikTok Shop OPEN API, vai
// "tiktokShop") — hai hệ đánh số KHÁC HẲN nhau (xem docblock `streams.ts`). Stream
// `tiktok/analytics_*` whitelist theo `SHOP_TIKTOK_SHOP`; land bằng `SHOP_TIKTOK` bị 400.
export { SHOP_KHO, SHOP_SHOPEE, SHOP_TIKTOK, SHOP_TIKTOK_SHOP };

/**
 * PrismaClient của worker e2e — CHỈ khi DATABASE_URL đúng bằng URL DB test của e2e.
 * (`global-setup` ép DATABASE_URL trước khi runner fork worker.) DB dev nối chung DB THẬT của shop,
 * nên tuyệt đối không để một `deleteMany()` nào chạy nhầm chỗ.
 *
 * Dùng bản THÔ `e2eDatabaseUrlFromEnv()`: ở worker chỉ cần biết URL nào ĐƯỢC PHÉP đụng để so với
 * `DATABASE_URL` runner đã ép; guard đầy đủ (đuôi `_test`, khác DB thật) đã chạy ở runner rồi.
 */
export function testPrisma(): PrismaClient {
  const url = process.env.DATABASE_URL;
  const mongDoi = e2eDatabaseUrlFromEnv();
  if (!url || !mongDoi || url !== mongDoi) {
    throw new Error("DATABASE_URL không trỏ DB test của e2e — từ chối đụng DB (DB dev = DB thật).");
  }
  return new PrismaClient();
}

/**
 * Dọn Bronze orders + products TRƯỚC khi spec seed.
 *
 * Land dedupe theo (shopId, externalId, md5 payload): raw còn sót từ lần chạy trước ⇒ land 0 dòng ⇒
 * transform (chỉ chạy trên entity vừa land) không dựng lại Silver ⇒ spec thấy bảng rỗng. Xoá raw để
 * mỗi lần chạy đều land + transform thật.
 */
export async function resetRawPancake(): Promise<void> {
  const prisma = testPrisma();
  try {
    await prisma.rawPancakeOrder.deleteMany();
    await prisma.rawPancakeProduct.deleteMany();
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Dọn 4 bảng Bronze TikTok Shop Analytics — dùng cho spec seed dữ liệu marketing thật (mục
 * `/marketing`). Bronze là append-only trong PROD, nhưng ở DB e2e (dùng chung một lần cho cả lượt
 * chạy, KHÔNG tự dọn giữa các file) phải reset thủ công: land một lần rồi để nguyên sẽ làm
 * `mocSanSang` hết còn là `null`, phá mọi test "chưa kết nối" (`KhuTrongMarketing`) chạy SAU nó
 * trong cùng lượt/lượt kế tiếp. Gọi TRƯỚC khi seed VÀ SAU khi test xong (afterAll) để trả DB e2e
 * về trạng thái sạch cho cả hai chiều thứ tự chạy.
 */
export async function resetRawTiktokShopAnalytics(): Promise<void> {
  const prisma = testPrisma();
  try {
    await prisma.rawTiktokShopAnalyticsShop.deleteMany();
    await prisma.rawTiktokShopAnalyticsProduct.deleteMany();
    await prisma.rawTiktokShopAnalyticsVideo.deleteMany();
    await prisma.rawTiktokShopAnalyticsLive.deleteMany();
    // Affiliate (P3) đi cùng lượt 02:30 + cùng nhóm spec /marketing — dọn cùng chỗ, nếu không dữ
    // liệu sót làm empty-state "Kỳ này chưa có đơn affiliate" đỏ vĩnh viễn ở lượt sau.
    await prisma.rawTiktokShopAffiliateOrder.deleteMany();
  } finally {
    await prisma.$disconnect();
  }
}

/** Kết quả đã ĐỌC XONG body — request context bị dispose ngay sau lời gọi, không đọc lại được. */
export type RawResponse = {
  status: number;
  ok: boolean;
  text: string;
  /** `{ ok, stats }` hoặc `{ ok:false, error }`; `stats` là số của TRANG NÀY. */
  json: { ok?: boolean; error?: string; stats?: Record<string, number> };
};

/** Lõi dùng chung — POST thẳng `payload` (chuỗi) đã dựng sẵn, không tự bọc envelope. */
async function postRawPayload(
  stream: string,
  shopId: string,
  payload: string,
  opts: { auth?: boolean; ngay?: string } = {}
): Promise<RawResponse> {
  const ctx = await pwRequest.newContext({ baseURL: "http://localhost:3000" });
  try {
    const res: APIResponse = await ctx.post("/api/ingest/raw", {
      headers: opts.auth === false ? {} : { Authorization: `Bearer ${INGEST_SECRET_TEST}` },
      data: { stream, shopId, payload, ...(opts.ngay !== undefined ? { ngay: opts.ngay } : {}) },
    });
    const text = await res.text();
    let json: RawResponse["json"] = {};
    try {
      json = JSON.parse(text) as RawResponse["json"];
    } catch {
      // không phải JSON (vd 500 HTML) → giữ `text` để báo lỗi cho người đọc
    }
    return { status: res.status(), ok: res.ok(), text, json };
  } finally {
    await ctx.dispose();
  }
}

/**
 * POST 1 trang raw. `auth: false` để test 401.
 *
 * Bọc `records` thành envelope `{data: records}` — ĐÚNG cho các stream Pancake (`arrayPath:
 * ["data"]`, vd "orders"/"products"). Stream có `arrayPath` LỒNG SÂU HƠN (TikTok Shop Analytics:
 * `["data","products"]`/`["data","videos"]`/…) KHÔNG dùng hàm này — dùng `postRawEnvelope` với
 * envelope THẬT (shape lấy từ `tests/fixtures/tiktokshop/analytics/*.json`).
 */
export async function postRaw(
  stream: string,
  shopId: string,
  records: unknown[],
  opts: { auth?: boolean } = {}
): Promise<RawResponse> {
  return postRawPayload(stream, shopId, JSON.stringify({ data: records }), opts);
}

/**
 * POST envelope THẬT (nguyên vẹn, không tự bọc `{data: ...}`) — cho stream có `arrayPath` lồng sâu
 * hơn một cấp (vd TikTok Shop Analytics: `tiktok/analytics_products` đọc `data.products`). Truyền
 * `ngay` cho stream khai `chapNhanNgay` (analytics_products/analytics_videos — record không mang
 * trường ngày, xem `src/lib/bronze/streams.ts`); thiếu/thừa đều bị route trả 400 (fail-closed).
 */
export async function postRawEnvelope(
  stream: string,
  shopId: string,
  envelope: unknown,
  opts: { auth?: boolean; ngay?: string } = {}
): Promise<RawResponse> {
  return postRawPayload(stream, shopId, JSON.stringify(envelope), opts);
}

export type IngestInput = {
  products?: unknown[];
  orders?: unknown[];
  /** Shop của ĐƠN (shop bán). Mặc định Shopee. Products luôn đi shop KHO. */
  orderShopId?: string;
};

/** Seed qua đúng luồng ingest thật: products (shop kho) → orders (shop bán). Fail-fast nếu route không 2xx. */
export async function ingestPancake({ products = [], orders = [], orderShopId = SHOP_SHOPEE }: IngestInput): Promise<void> {
  if (products.length) {
    const res = await postRaw("products", SHOP_KHO, products);
    expect(res.ok, `ingest products: ${res.text}`).toBe(true);
  }
  if (orders.length) {
    const res = await postRaw("orders", orderShopId, orders);
    expect(res.ok, `ingest orders: ${res.text}`).toBe(true);
  }
}
