import { beforeEach, describe, expect, it } from "vitest";

import { landRaw } from "@/lib/bronze/land-raw";
import { SHOP_TIKTOK_SHOP } from "../helpers/shop-ids-fixture";
import { transformFromRaw } from "@/lib/bronze/transform-from-raw";
import { prisma } from "@/lib/prisma";

import { truncateBusinessTables } from "../helpers/test-db";

/**
 * TikTok Shop lồng mảng SÂU HƠN Pancake: `{code, message, data:{statements:[…]}}` thay vì
 * `{success, data:[…]}`. Bộ test này chốt: đường dẫn mảng lấy từ registry (`arrayPath`), envelope
 * sai đường dẫn phải THROW (không land trang rỗng giả), và int64 không bao giờ đi qua JSON.parse.
 */

/** Envelope THẬT của TikTok Shop Open API (mẫu lưu ở tts-payload-that.json). */
const tts = (arrayKey: string, items: string) =>
  `{"code":0,"message":"Success","request_id":"2026071400","data":{"${arrayKey}":[${items}],"next_page_token":"abc"}}`;

/** 2 statement thật (rút gọn) — id 19 chữ số, tiền là CHUỖI. */
const ST_1 = `{"id":"7639761649183852289","statement_time":1778803200,"settlement_amount":"159902","fee_amount":"-49098","currency":"VND"}`;
const ST_2 = `{"id":"7639761649183852290","statement_time":1778889600,"settlement_amount":"250000","fee_amount":"-60000","currency":"VND"}`;

/**
 * Đơn TikTok có id 18–19 chữ số. Ở đây để id dạng SỐ (không nháy) — vượt
 * Number.MAX_SAFE_INTEGER (9007199254740991): `JSON.parse` của JS sẽ làm tròn
 * 576748043428727748 → 576748043428727740. Postgres ::jsonb giữ nguyên numeric.
 */
const BIG_ORDER_ID = "576748043428727748";

beforeEach(async () => {
  // DB test dùng chung nhiều suite — dọn Silver để khẳng định "land TikTok KHÔNG đụng Silver" có nghĩa.
  await truncateBusinessTables();
  await prisma.rawTiktokShopStatement.deleteMany();
  await prisma.rawTiktokShopTransaction.deleteMany();
  await prisma.rawTiktokShopPayment.deleteMany();
  await prisma.rawTiktokShopOrder.deleteMany();
});

describe("landRaw — TikTok Shop", () => {
  it("land statements ở data.statements → đúng số dòng, đúng externalId, đúng shop TikTok Shop", async () => {
    const r = await landRaw("tiktok/statements", SHOP_TIKTOK_SHOP, tts("statements", `${ST_1},${ST_2}`));

    expect(r.landed).toBe(2);
    expect(r.skippedNoId).toBe(0);
    expect([...r.landedIds].sort()).toEqual(["7639761649183852289", "7639761649183852290"]);

    const rows = await prisma.rawTiktokShopStatement.findMany({ orderBy: { externalId: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0].externalId).toBe("7639761649183852289");
    expect(rows[0].shopId).toBe(SHOP_TIKTOK_SHOP);
  });

  it("land 2 lần cùng payload → dedupe theo hash, chỉ 1 dòng", async () => {
    const body = tts("statements", ST_1);

    const r1 = await landRaw("tiktok/statements", SHOP_TIKTOK_SHOP, body);
    const r2 = await landRaw("tiktok/statements", SHOP_TIKTOK_SHOP, body);

    expect(r1.landed).toBe(1);
    expect(r2.landed).toBe(0);
    expect(r2.landedIds).toEqual([]);
    expect(await prisma.rawTiktokShopStatement.count()).toBe(1);
  });

  it("payload ĐỔI (statement đối soát lại) → ghi bản mới, giữ lịch sử", async () => {
    await landRaw("tiktok/statements", SHOP_TIKTOK_SHOP, tts("statements", ST_1));
    const r2 = await landRaw(
      "tiktok/statements",
      SHOP_TIKTOK_SHOP,
      tts("statements", ST_1.replace(`"159902"`, `"149902"`))
    );

    expect(r2.landed).toBe(1);
    expect(await prisma.rawTiktokShopStatement.count()).toBe(2);
  });

  it("id đơn int64 giữ NGUYÊN (JS parse sẽ làm tròn …748 → …740)", async () => {
    await landRaw("tiktok/orders", SHOP_TIKTOK_SHOP, tts("orders", `{"id":${BIG_ORDER_ID},"status":"COMPLETED"}`));

    const rows = await prisma.rawTiktokShopOrder.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe(BIG_ORDER_ID);
    expect(rows[0].externalId).not.toBe("576748043428727740");
  });

  it("envelope Pancake gửi nhầm vào stream TikTok → THROW, nêu đúng đường dẫn, DB 0 dòng", async () => {
    await expect(
      landRaw("tiktok/statements", SHOP_TIKTOK_SHOP, `{"success":true,"data":[${ST_1}]}`)
    ).rejects.toThrow(/data\.statements/);

    expect(await prisma.rawTiktokShopStatement.count()).toBe(0);
  });

  it("TikTok trả LỖI (code != 0, không có data) → THROW, không land trang rỗng giả", async () => {
    await expect(
      landRaw("tiktok/statements", SHOP_TIKTOK_SHOP, `{"code":105000,"message":"access token is invalid"}`)
    ).rejects.toThrow(/data\.statements/);

    expect(await prisma.rawTiktokShopStatement.count()).toBe(0);
  });

  it("mảng nằm SAI key (payments trả về statements) → THROW, không land nhầm bảng", async () => {
    await expect(
      landRaw("tiktok/payments", SHOP_TIKTOK_SHOP, tts("statements", ST_1))
    ).rejects.toThrow(/data\.payments/);

    expect(await prisma.rawTiktokShopPayment.count()).toBe(0);
  });

  // Bản 202501 để mảng ở `data.transactions` (bản 202309 là `data.statement_transactions`, và KHÔNG
  // có `type`). Phải bám 202501 vì `type` là cách duy nhất nhận ra tiền quảng cáo GMV Pay.
  it("record thiếu id → bị bỏ nhưng ĐƯỢC ĐẾM, không im lặng", async () => {
    const r = await landRaw(
      "tiktok/statement_transactions",
      SHOP_TIKTOK_SHOP,
      tts(
        "transactions",
        `{"id":"7659815619889563399","type":"ORDER","order_id":"583746432390628764"},{"type":"ORDER"}`
      )
    );

    expect(r.landed).toBe(1);
    expect(r.skippedNoId).toBe(1);
    expect(await prisma.rawTiktokShopTransaction.count()).toBe(1);
  });

  // GMV Pay = TikTok Ads trừ tiền quảng cáo vào số dư shop khi chi tiêu chạm NGƯỠNG. Ngưỡng thay đổi
  // theo thời gian ⇒ nhận diện bằng `type`, KHÔNG bằng số tiền. Giao dịch này KHÔNG có `order_id`.
  it("land giao dịch GMV Pay (tiền quảng cáo) — phân biệt bằng `type`, không phải số tiền", async () => {
    const r = await landRaw(
      "tiktok/statement_transactions",
      SHOP_TIKTOK_SHOP,
      tts(
        "transactions",
        `{"id":"7646274335216338706","type":"GMV_PAYMENT_FOR_TIKTOK_ADS",` +
          `"adjustment_id":"3626821605450483371","settlement_amount":"-143000"}`
      )
    );

    expect(r.landed).toBe(1);
    const row = await prisma.rawTiktokShopTransaction.findFirst();
    const payload = row?.payload as { type?: string; order_id?: string };
    expect(payload.type).toBe("GMV_PAYMENT_FOR_TIKTOK_ADS");
    expect(payload.order_id).toBeUndefined(); // không gắn đơn nào — là tiền quảng cáo, không phải doanh thu
  });

  it("payments land đúng bảng riêng (không lẫn sang statements)", async () => {
    const r = await landRaw(
      "tiktok/payments",
      SHOP_TIKTOK_SHOP,
      tts("payments", `{"id":"3651225439618565803","status":"PAID","amount":{"currency":"VND","value":"1800000"}}`)
    );

    expect(r.landed).toBe(1);
    expect(await prisma.rawTiktokShopPayment.count()).toBe(1);
    expect(await prisma.rawTiktokShopStatement.count()).toBe(0);
  });
});

describe("transformFromRaw — TikTok settlement transform (Phase 2)", () => {
  it("tiktok/statements → TiktokSettlement (KHÔNG còn land-only, không đụng Silver đơn)", async () => {
    await landRaw("tiktok/statements", SHOP_TIKTOK_SHOP, tts("statements", ST_1));

    const stats = await transformFromRaw("tiktok/statements", []);

    expect(stats.settlementsUpserted).toBe(1);
    expect(await prisma.tiktokSettlement.count()).toBe(1);
    const s = await prisma.tiktokSettlement.findFirst();
    expect(s?.settlementAmount).toBe(159902);
    expect(s?.feeAmount).toBe(-49098); // âm giữ nguyên
    expect(await prisma.order.count()).toBe(0); // độc lập Silver đơn
  });

  it("stream chưa khai báo cách transform → THROW (không im lặng coi là thành công)", async () => {
    await expect(transformFromRaw("stream-la" as never, [])).rejects.toThrow(/chưa khai báo cách transform/);
  });
});
