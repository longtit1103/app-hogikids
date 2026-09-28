import { expect, test } from "@playwright/test";

import { INGEST_SECRET_TEST } from "./test-constants";
import { ingestPancake, postRaw, resetRawPancake, SHOP_KHO, SHOP_TIKTOK, testPrisma } from "./ingest-raw";

/**
 * E2E ingest: gọi route /api/ingest/* qua HTTP tới dev server thật (webServer trỏ hogikids_test).
 * Luồng Bronze: POST /api/ingest/raw (land raw → transform Silver). Assert bằng dữ liệu SILVER
 * (Order/Variant) chứ không dựa vào `stats` — `stats` là số của TRANG NÀY, POST lại trang y hệt
 * sẽ dedupe ở Bronze (landed 0 → transform 0) dù Silver vẫn đúng 1 dòng.
 * Serial: các test cùng đụng DB, chạy tuần tự trong 1 worker để không giẫm chân nhau.
 */
test.describe.configure({ mode: "serial" });

const AUTH = { Authorization: `Bearer ${INGEST_SECRET_TEST}` };

test.beforeAll(async () => {
  // global-setup đã ép process.env.DATABASE_URL = TEST_DATABASE_URL trong runner.
  const prisma = testPrisma();
  try {
    for (const c of [
      { id: "shopee", name: "Shopee", color: "#cc785c", platformFeePct: 10, paymentFeePct: 2.5, sortOrder: 1 },
      { id: "tiktok", name: "TikTok", color: "#141413", platformFeePct: 6, paymentFeePct: 2, sortOrder: 2 },
      { id: "facebook", name: "Facebook", color: "#5db8a6", sortOrder: 3 },
    ]) {
      await prisma.channel.upsert({ where: { id: c.id }, create: c, update: {} });
    }
    await prisma.expenseCategory.upsert({
      where: { id: "ads" },
      create: { id: "ads", name: "Quảng cáo", isSystem: true },
      update: {},
    });
    await prisma.orderItem.deleteMany();
    await prisma.order.deleteMany();
    await prisma.variant.deleteMany();
    await prisma.product.deleteMany();
    await prisma.expense.deleteMany({ where: { source: "ADS_API" } });
  } finally {
    await prisma.$disconnect();
  }
  await resetRawPancake();
});

test("POST /api/ingest/raw sai bearer → 401", async () => {
  const res = await postRaw("orders", SHOP_TIKTOK, [], { auth: false });
  expect(res.status).toBe(401);
});

test("POST /api/ingest/raw → 200 + upsert Silver + chạy lại không nhân đôi", async () => {
  const products = [
    {
      id: "E2E-P1",
      name: "SP e2e",
      variations: [
        { id: "E2E-V1", display_id: "E2E-SKU", retail_price: 100000, remain_quantity: 3, average_imported_price: 40000 },
      ],
    },
  ];
  const orders = [
    {
      id: "E2E-O1",
      status: 3,
      inserted_at: "2026-07-01T10:00:00.000000",
      order_sources_name: "Tiktok",
      marketplace_id: "-9",
      total_price: 100000,
      items: [
        { quantity: 1, discount_each_product: 0, variation_info: { display_id: "E2E-SKU", name: "SP e2e", retail_price: 100000 } },
      ],
    },
  ];

  await ingestPancake({ products, orders, orderShopId: SHOP_TIKTOK });
  // POST lại y hệt → Bronze dedupe, Silver KHÔNG nhân đôi.
  await ingestPancake({ products, orders, orderShopId: SHOP_TIKTOK });

  const prisma = testPrisma();
  try {
    expect(await prisma.order.count({ where: { pancakeId: "E2E-O1" } })).toBe(1);
    expect(await prisma.orderItem.count({ where: { order: { pancakeId: "E2E-O1" } } })).toBe(1);
    const item = await prisma.orderItem.findFirst({ where: { order: { pancakeId: "E2E-O1" } }, include: { variant: true } });
    expect(item?.variant?.sku).toBe("E2E-SKU"); // tra variant qua SKU
    expect(item?.variant?.costPrice).toBe(40000); // prefill giá vốn từ kho
  } finally {
    await prisma.$disconnect();
  }
});

test("đơn mirror shop kho bị loại khỏi doanh thu (raw vẫn giữ)", async () => {
  const orders = [
    {
      id: "AF100975192O1",
      status: 3,
      inserted_at: "2026-07-01T10:00:00.000000",
      order_sources_name: "Affiliate",
      marketplace_id: "-9",
      total_price: 100000,
      items: [],
    },
  ];
  const res = await postRaw("orders", SHOP_KHO, orders);
  expect(res.json.ok, res.text).toBe(true);
  expect(res.json.stats?.ordersSkippedMirror).toBe(1);
  expect(res.json.stats?.ordersUpserted).toBe(0);

  const prisma = testPrisma();
  try {
    expect(await prisma.order.count({ where: { pancakeId: "AF100975192O1" } })).toBe(0);
    expect(await prisma.rawPancakeOrder.count({ where: { externalId: "AF100975192O1" } })).toBe(1);
  } finally {
    await prisma.$disconnect();
  }
});

test("payload vượt trần 10MB → 400", async ({ request }) => {
  const res = await request.post("/api/ingest/raw", {
    headers: AUTH,
    data: { stream: "orders", shopId: SHOP_TIKTOK, payload: "x".repeat(10_000_001) },
  });
  expect(res.status()).toBe(400);
});

test("POST /api/ingest/ads → idempotent theo refId (2 lần = 1 Expense, amount mới)", async ({ request }) => {
  // App là biên tiền: n8n gửi spendExVat + vatRate, route tự nhân VAT (amount = round(spendExVat × (1+vatRate))).
  const post = (spendExVat: number) =>
    request.post("/api/ingest/ads", {
      headers: AUTH,
      data: { source: "META", rows: [{ date: "2026-07-01", campaignId: "E2E-C1", spendExVat, vatRate: 0.1 }] },
    });
  expect((await post(100000)).status()).toBe(200);
  await post(250000);

  const prisma = testPrisma();
  try {
    const rows = await prisma.expense.findMany({ where: { refId: "META:2026-07-01:E2E-C1" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(275000); // 250000 × 1.1 (route nhân VAT 10%); idempotent → giữ lần áp mới nhất
  } finally {
    await prisma.$disconnect();
  }
});
