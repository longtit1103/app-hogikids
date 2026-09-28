/**
 * Task 0 — DISCOVERY: dò xem 3 API key của shop thật sự GỌI ĐƯỢC endpoint nào.
 *
 * Danh sách endpoint lấy từ OpenAPI spec CHÍNH THỨC (https://api-docs.pancake.vn/openapi.json,
 * 85 path) — KHÔNG đoán tên đường dẫn. Chỉ gọi GET (đọc), không ghi gì lên Pancake.
 *
 * Mục đích: trước khi thiết kế tầng Bronze (mỗi endpoint = 1 bảng raw), phải biết
 * THẬT stream nào có dữ liệu và key có quyền không.
 *
 * Chạy: npx tsx scripts/probe-pancake-endpoints.ts
 * Output: bảng tóm tắt + response 200 lưu nguyên bản vào tests/fixtures/pancake/_raw/probe/
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

process.loadEnvFile(path.resolve(process.cwd(), ".env"));

const BASE = "https://pos.pages.fm/api/v1";
const OUT_DIR = path.resolve(process.cwd(), "tests/fixtures/pancake/_raw/probe");

const SHOPS = [
  { name: "kho", id: process.env.PANCAKE_SHOP_ID_KHO!, key: process.env.PANCAKE_API_KEY_KHO! },
  { name: "shopee", id: process.env.PANCAKE_SHOP_ID_SHOPEE!, key: process.env.PANCAKE_API_KEY_SHOPEE! },
  { name: "tiktok", id: process.env.PANCAKE_API_ID_TIKTOK!, key: process.env.PANCAKE_API_KEY_TIKTOK! },
];

/** GET endpoint lấy từ spec chính thức. `{id}` sẽ thay bằng SHOP_ID. */
const GET_PATHS = [
  // đang dùng
  "orders",
  "products", // KHÔNG có trong doc nhưng code hiện đang gọi → kiểm chứng
  // sản phẩm / kho
  "products/variations", // doc ghi đây mới là "Product list"
  "categories",
  "brand",
  "combo_products",
  "materials_products",
  "warehouses",
  "inventory_histories",
  "inventory_analytics/inventory",
  "inventory_analytics/inventory_by_product",
  "stocktakings",
  "transfers",
  "supplier",
  // mua hàng / giá vốn
  "purchases",
  // đơn
  "orders_returned",
  "order_source",
  "orders/tags",
  "bank_payments",
  "partners",
  "projects",
  // tiền
  "transactions",
  "payment_accounts/get_payment_histories",
  "debt",
  // ads (Pancake tích hợp sẵn?)
  "ads_manager/ad_accounts",
  "ads_manager/campaigns_v2",
  "ads_manager/ad_sets_v2",
  "ads_manager/ads_v2",
  // khách + KM
  "customers",
  "customer_levels",
  "vouchers",
  "promotion_advance",
  // sàn
  "marketplace/get_account_info",
  "marketplace/products",
  "marketplace/reverse_order",
  "shopee/evaluate",
  // khác
  "users",
  "analytics/sale",
  "livestream_manager",
  "list_einvoices/",
];

type Row = { endpoint: string; shop: string; http: number | string; records: number | string; fields: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    return { status: -1, body: { error: String(e) } };
  }
}

/** Pancake hay bọc list trong `data`. */
function extractList(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    for (const k of ["data", "items", "results", "records", "categories", "warehouses"]) {
      if (Array.isArray(o[k])) return o[k] as unknown[];
    }
  }
  return null;
}

function summarize(body: unknown): { records: number | string; fields: string } {
  const list = extractList(body);
  if (list === null) {
    const keys = body && typeof body === "object" ? Object.keys(body as object) : [];
    return { records: "obj", fields: keys.slice(0, 6).join(",") || "-" };
  }
  if (list.length === 0) return { records: 0, fields: "(rỗng)" };
  const first = list[0];
  const keys = first && typeof first === "object" ? Object.keys(first as object) : [];
  return { records: list.length, fields: `${keys.length}f: ${keys.slice(0, 5).join(",")}` };
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const rows: Row[] = [];

  for (const s of SHOPS) {
    const { status, body } = await getJson(`${BASE}/shops?api_key=${encodeURIComponent(s.key)}`);
    rows.push({ endpoint: "/shops", shop: s.name, http: status, ...summarize(body) });
    if (status === 200) writeFileSync(path.join(OUT_DIR, `shops--${s.name}.json`), JSON.stringify(body, null, 2));
    await sleep(250);
  }

  for (const p of GET_PATHS) {
    for (const s of SHOPS) {
      const url = `${BASE}/shops/${s.id}/${p}?api_key=${encodeURIComponent(s.key)}&page_number=1&page=1&page_size=5`;
      const { status, body } = await getJson(url);
      const sum = summarize(body);
      rows.push({ endpoint: p, shop: s.name, http: status, ...sum });
      if (status === 200) {
        const safe = p.replace(/[/]/g, "_").replace(/_$/, "");
        writeFileSync(path.join(OUT_DIR, `${safe}--${s.name}.json`), JSON.stringify(body, null, 2));
      }
      await sleep(250);
    }
  }

  const hasData = rows.filter((r) => r.http === 200 && typeof r.records === "number" && r.records > 0);
  const empty = rows.filter((r) => r.http === 200 && r.records === 0);
  const objOk = rows.filter((r) => r.http === 200 && r.records === "obj");
  const failed = rows.filter((r) => r.http !== 200);

  console.log("\n########## CÓ DỮ LIỆU THẬT (200 + records > 0) ##########");
  console.table(hasData);
  console.log("\n########## 200 nhưng trả object (không phải list) ##########");
  console.table(objOk.map((r) => ({ endpoint: r.endpoint, shop: r.shop, fields: r.fields })));
  console.log("\n########## 200 nhưng RỖNG ##########");
  console.log(empty.map((r) => `${r.endpoint}(${r.shop})`).join(", ") || "-");
  console.log("\n########## LỖI / KHÔNG CÓ QUYỀN ##########");
  console.table(failed.map((r) => ({ endpoint: r.endpoint, shop: r.shop, http: r.http })));

  const streams = [...new Set(hasData.map((r) => r.endpoint))];
  console.log(`\n>>> ${streams.length} STREAM CÓ DỮ LIỆU: ${streams.join(" | ")}`);
  console.log(`>>> Response gốc: ${OUT_DIR}`);
}

main().catch((e) => {
  console.error("Probe lỗi:", e);
  process.exit(1);
});
