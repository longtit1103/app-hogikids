/**
 * Task 1 (phase 2) — Khám phá Pancake API + topology NHIỀU KEY.
 *
 * Chạy: `npx tsx scripts/explore-pancake-api.ts`
 *
 * Bối cảnh: shop dùng 3 key Pancake (kho chính + Shopee-sync + TikTok-sync) — lệch giả định
 * "1 key" của plan. Script này KHÁM PHÁ topology thật để chốt trước khi viết mapping:
 *   - Mỗi key thấy shop nào (GET /shops)?
 *   - Đơn cùng `id` có xuất hiện ở >1 key không (⇒ nguy cơ đếm-2-lần, bất biến #2)?
 *   - Nguyên liệu cho 4 câu chặn: B3 (total_discount vs Σ quantity×discount_each_product),
 *     B4 (mọi mã status), D1 (lọc theo updated hay chỉ inserted_at), D3 (TZ — xem ads riêng).
 *
 * AN TOÀN PII: dump THÔ ghi vào tests/fixtures/pancake/_raw/ (đã .gitignore). Fixtures ẩn danh
 * dùng cho test (orders-sample.json…) chỉ tạo SAU khi soi shape thật + xác nhận đúng field PII.
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// ---- Nạp .env (script standalone không đi qua Next auto-load) ----
// Dùng parser built-in của Node (xử lý đúng quote + comment inline) — Node ≥20.12.
if (existsSync(".env")) process.loadEnvFile(".env");

// Base URL Pancake POS — thử lần lượt, chốt base trả 200 cho /shops.
const BASES = ["https://pos.pages.fm/api/v1", "https://pages.fm/api/public_api/v1"];
const OUT_DIR = "tests/fixtures/pancake/_raw";

type KeyEntry = { label: string; apiKey: string; shopId?: string };
const KEYS: KeyEntry[] = [
  { label: "kho", apiKey: process.env.PANCAKE_API_KEY_KHO ?? "", shopId: process.env.PANCAKE_SHOP_ID_KHO },
  { label: "shopee", apiKey: process.env.PANCAKE_API_KEY_SHOPEE ?? "", shopId: process.env.PANCAKE_SHOP_ID_SHOPEE },
  {
    label: "tiktok",
    apiKey: process.env.PANCAKE_API_KEY_TIKTOK ?? "",
    shopId: process.env.PANCAKE_API_ID_TIKTOK ?? process.env.PANCAKE_SHOP_ID_TIKTOK,
  },
].filter((k) => k.apiKey.trim().length > 0);

async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  try {
    const res = await fetch(url);
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: { fetchError: String(e) } };
  }
}

/** Lấy mảng dữ liệu từ response bất kể vỏ bọc ({data}/{shops}/mảng thẳng). */
function asArray(body: unknown): any[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    for (const k of ["data", "shops", "orders", "products", "categories"]) {
      if (Array.isArray(o[k])) return o[k] as any[];
    }
  }
  return [];
}

async function detectBase(apiKey: string): Promise<string | null> {
  for (const base of BASES) {
    const { status } = await getJson(`${base}/shops?api_key=${encodeURIComponent(apiKey)}`);
    console.log(`  probe ${base}/shops → HTTP ${status}`);
    if (status === 200) return base;
  }
  return null;
}

const PII_KEY =
  /phone|email|address|full_name|bill_full|street|ward|district|province|note|fb_id|psid|conversation|referral|^lat$|^lng$|^lon$/i;
const MASK_SUBTREE = /^(customer|customers|partner)$/i; // mask nguyên khối định danh khách
const CUSTOMERISH = /customer|partner|shipping|recipient|bill/i;

/** Mask sâu MỌI giá trị con (chuỗi/số/mảng/object) — dùng cho subtree PII. */
function maskDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(maskDeep);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = maskDeep(x);
    return o;
  }
  return typeof v === "number" ? 0 : "***";
}

/** Ẩn danh: mask nguyên subtree cho key PII/customer; "name" chỉ mask khi cha là customer/shipping. */
function anonymize(value: unknown, parentKey = ""): unknown {
  if (Array.isArray(value)) return value.map((v) => anonymize(v, parentKey));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const isName = k.toLowerCase() === "name" && CUSTOMERISH.test(parentKey);
      if (MASK_SUBTREE.test(k) || PII_KEY.test(k) || isName) out[k] = maskDeep(v);
      else out[k] = anonymize(v, k);
    }
    return out;
  }
  return value;
}

function keysOf(o: unknown): string[] {
  return o && typeof o === "object" ? Object.keys(o as object) : [];
}

async function main() {
  if (KEYS.length === 0) {
    console.error(
      "✗ Chưa có key. Điền vào .env: PANCAKE_API_KEY (kho chính), PANCAKE_API_KEY_SHOPEE, PANCAKE_API_KEY_TIKTOK.",
    );
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });

  console.log(`\n== Dò base URL (dùng key '${KEYS[0].label}') ==`);
  const base = await detectBase(KEYS[0].apiKey);
  if (!base) {
    console.error("✗ Không base nào trả 200 cho /shops. Kiểm tra key / mạng.");
    process.exit(1);
  }
  console.log(`✓ base = ${base}\n`);

  // orderIds theo key để phát hiện trùng (đếm-2-lần) giữa các key/shop.
  const orderIdsByKey: Record<string, Set<string>> = {};
  const statusSeen = new Set<string>();
  const sourceSeen = new Set<string>();

  for (const { label, apiKey, shopId } of KEYS) {
    console.log(`\n================= KEY: ${label} =================`);
    const qKey = `api_key=${encodeURIComponent(apiKey)}`;

    const shopsRes = await getJson(`${base}/shops?${qKey}`);
    let shops = asArray(shopsRes.body);
    // Fallback: key chỉ scope 1 shop, /shops có thể rỗng → dùng SHOP_ID cấu hình trong .env.
    if (shops.length === 0 && shopId) {
      shops = [{ id: shopId, name: `(từ .env ${label})` }];
      console.log(`  /shops rỗng → fallback dùng SHOP_ID ${shopId} từ .env`);
    }
    console.log(`shops (${shops.length}):`, shops.map((s) => `${s.id}=${s.name}`).join(" | ") || "(rỗng)");
    writeFileSync(join(OUT_DIR, `shops-${label}.json`), JSON.stringify(shopsRes.body, null, 2));

    orderIdsByKey[label] = new Set();

    for (const shop of shops) {
      const shopId = shop.id;
      // ---- Products (trang 1) ----
      const pRes = await getJson(`${base}/shops/${shopId}/products?${qKey}&page_number=1`);
      const products = asArray(pRes.body);
      writeFileSync(join(OUT_DIR, `products-${label}-${shopId}.json`), JSON.stringify(anonymize(pRes.body), null, 2));

      // ---- Orders (trang 1, size 30) ----
      const oRes = await getJson(`${base}/shops/${shopId}/orders?${qKey}&page_number=1&page_size=30`);
      const orders = asArray(oRes.body);
      writeFileSync(join(OUT_DIR, `orders-${label}-${shopId}.json`), JSON.stringify(anonymize(oRes.body), null, 2));

      // Tổng hợp status / nguồn / trùng id
      for (const o of orders) {
        if (o.id != null) orderIdsByKey[label].add(String(o.id));
        if (o.status != null) statusSeen.add(`${o.status}${o.status_name ? `=${o.status_name}` : ""}`);
        const src = o.order_sources_name ?? o.order_sources ?? o.source ?? "";
        if (src) sourceSeen.add(String(src));
      }

      console.log(
        `  shop ${shopId} (${shop.name}) → products HTTP ${pRes.status} n=${products.length} | orders HTTP ${oRes.status} n=${orders.length}`,
      );

      // B3 — so total_discount vs Σ quantity×discount_each_product trên đơn có cả 2 loại giảm.
      // `discount_each_product` là giảm giá MỖI ĐƠN VỊ (OpenAPI: "Giảm giá cho từng sản phẩm") nên
      // PHẢI × quantity mới ra giảm giá của dòng — cộng thẳng là hụt ở mọi đơn có quantity > 1.
      const b3 = orders.find(
        (o) => Number(o.total_discount) > 0 && (o.items ?? []).some((it: any) => Number(it.discount_each_product) > 0),
      );
      if (b3) {
        const sumLine = (b3.items ?? []).reduce(
          (s: number, it: any) => s + Number(it.discount_each_product || 0) * Number(it.quantity || 0),
          0,
        );
        console.log(
          `    [B3] đơn ${b3.id}: total_discount=${b3.total_discount} vs Σ quantity×discount_each_product=${sumLine} → ${
            Number(b3.total_discount) === sumLine ? "BẰNG (nghi total_discount ĐÃ gộp dòng ⇒ dễ trừ 2 lần)" : "KHÁC (khả năng độc lập)"
          }`,
        );
      }
      // D1 — field thời gian có trên đơn (updated?)
      if (orders[0]) {
        const timeKeys = keysOf(orders[0]).filter((k) => /at$|time|update/i.test(k));
        console.log(`    [D1] field thời gian trên đơn: ${timeKeys.join(", ") || "(không thấy — chỉ inserted_at?)"}`);
        if (orders[0].items?.[0]) console.log(`    [shape] item keys: ${keysOf(orders[0].items[0]).join(", ")}`);
      }
    }
  }

  // ---- Trùng đơn giữa các key (đếm-2-lần) ----
  console.log(`\n================= TRÙNG ĐƠN GIỮA KEY (đếm-2-lần?) =================`);
  const labels = Object.keys(orderIdsByKey);
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const a = orderIdsByKey[labels[i]];
      const b = orderIdsByKey[labels[j]];
      const overlap = [...a].filter((x) => b.has(x));
      console.log(`  ${labels[i]} ∩ ${labels[j]} = ${overlap.length} đơn trùng${overlap.length ? " ⚠️ RỦI RO ĐẾM-2-LẦN: " + overlap.slice(0, 5).join(",") : " ✓ không trùng"}`);
    }
  }

  console.log(`\n================= TỔNG HỢP =================`);
  console.log(`[B4] mọi status quan sát được: ${[...statusSeen].join(" | ") || "(none)"}`);
  console.log(`[channel] mọi nguồn đơn quan sát được: ${[...sourceSeen].join(" | ") || "(none)"}`);
  console.log(`\n✓ Raw + anon dump ở ${OUT_DIR}/ (đã .gitignore). Soi shape rồi mới tạo fixtures ẩn danh commit.`);
  console.log(`  Tiếp: trả 4 câu B3/B4/D1/D3 vào tests/fixtures/pancake/ghi-chu-shape-thuc-te.md.`);
}

main();
