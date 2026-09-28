import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi import route (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

// Công tắc mô phỏng transform CHẾT Ở MỨC BATCH (vd query Channel lỗi vì DB chập) — khi không bật
// thì pass-through xuống bản THẬT, để retry/happy-path chạy trên hành vi thực chứ không phải stub.
const transformControl = vi.hoisted(() => ({ failNextWith: null as Error | null }));

vi.mock("@/lib/bronze/transform-from-raw", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/bronze/transform-from-raw")>();
  const transformFromRaw: typeof actual.transformFromRaw = async (...args) => {
    if (transformControl.failNextWith) {
      const err = transformControl.failNextWith;
      transformControl.failNextWith = null; // chỉ chết 1 lần — lần gọi sau chạy bản thật
      throw err;
    }
    return actual.transformFromRaw(...args);
  };
  return { ...actual, transformFromRaw };
});

import { POST } from "@/app/api/ingest/raw/route";
import { demDaHachToan } from "@/lib/bronze/doi-soat-hach-toan";
import { SHOP_SHOPEE, SHOP_TIKTOK_SHOP } from "../helpers/shop-ids-fixture";
import { prisma } from "@/lib/prisma";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Land OK nhưng transform THROW ngoài ý (không phải BRONZE_ONLY): Bronze đã COMMIT dòng, n8n retry
 * cùng payload trùng hash ⇒ `landedIds` rỗng ⇒ transform 0 dòng ⇒ nếu không có cờ backlog thì route
 * trả OK im lặng trong khi đơn KHÔNG BAO GIỜ vào Silver — mất doanh thu mà SyncLog vẫn xanh.
 * Suite này khoá hành vi fail-loud: throw ⇒ bật cờ + 500; retry ⇒ cảnh báo cho tới khi rebuild.
 */

const ORDER = `{
  "id":"ORD-TF-1","status":3,"inserted_at":"2026-07-01T10:00:00.000000",
  "order_sources_name":"Shopee","marketplace_id":"-3",
  "total_price":200000,"total_discount":0,"fee_marketplace":15000,
  "items":[{"quantity":2,"discount_each_product":0,
    "variation_info":{"display_id":"SKU-TF1","name":"SP","retail_price":100000}}]}`;

const STATEMENTS = `{"code":0,"message":"Success","data":{"statements":[
  {"id":"7639761649183852290","statement_time":1778803200,"settlement_amount":"159902","currency":"VND"}]}}`;

/** Statement THIẾU `statement_time`: land được (có `id`) nhưng mapStatement trả null ⇒ không vào Silver. */
const STATEMENT_THIEU_MOC = `{"code":0,"message":"Success","data":{"statements":[
  {"id":"7639761649183852291","settlement_amount":"159902","currency":"VND"}]}}`;

/**
 * 2 giao dịch của một statement: 1 đơn hàng thường + 1 khoản TikTok trừ tiền quảng cáo. CHỈ khoản
 * quảng cáo có bảng Silver (nhận diện DUY NHẤT bằng `type` — bất biến #2), nên stream này land 2 mà
 * hạch toán 1 là ĐÚNG, không được coi là mất dòng.
 */
const TXNS = `{"code":0,"message":"Success","data":{"transactions":[
  {"id":"7659815619889563399","type":"ORDER","order_id":"583746432390628764"},
  {"id":"7646274335216338706","type":"GMV_PAYMENT_FOR_TIKTOK_ADS",
   "adjustment_id":"3626821605450483371","order_create_time":1778770412,
   "settlement_amount":"-143000"}]}}`;

const post = (body: { stream: string; shopId: string; payload: string }) =>
  POST(
    new Request("http://localhost/api/ingest/raw", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(body),
    })
  );

const postOrder = () =>
  post({ stream: "orders", shopId: SHOP_SHOPEE, payload: `{"success":true,"data":[${ORDER}]}` });

const backlogFlag = async (): Promise<string | null> => {
  const row = await prisma.setting.findUnique({ where: { key: "bronzeBacklogPending" } });
  return row?.value ?? null;
};

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.rawPancakeOrder.deleteMany();
  await prisma.rawTiktokShopStatement.deleteMany();
  await prisma.rawTiktokShopTransaction.deleteMany();
  // Cờ backlog sống trong Setting, ngoài truncateBusinessTables() — không xoá thì cờ của test
  // trước sống sót và test sau pass/fail vì lý do sai.
  await prisma.setting.deleteMany({ where: { key: "bronzeBacklogPending" } });
  transformControl.failNextWith = null;
});

afterAll(async () => {
  await prisma.rawPancakeOrder.deleteMany();
  await prisma.rawTiktokShopStatement.deleteMany();
  await prisma.rawTiktokShopTransaction.deleteMany();
  await prisma.setting.deleteMany({ where: { key: "bronzeBacklogPending" } });
});

describe("POST /api/ingest/raw — land OK nhưng transform THROW ngoài ý", () => {
  it("lần đầu: 500 + Bronze ĐÃ commit + cờ backlog BẬT", async () => {
    transformControl.failNextWith = new Error("mô phỏng DB chập giữa transform");

    const res = await postOrder();
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.ok).toBe(false);
    expect(await prisma.rawPancakeOrder.count()).toBe(1); // Bronze đã có dòng (land commit trước transform)
    expect(await prisma.order.count()).toBe(0); // Silver chưa dựng được
    expect(await backlogFlag()).toBe("1"); // cờ bật để lần ingest sau KÊU TO
  });

  it("retry cùng payload: TỰ CHỮA — đơn vào Silver dù hash trùng nên không land lại", async () => {
    // Trước đây đây là CÁI BẪY: lượt gửi lại trùng `payloadHash` ⇒ `landedIds` rỗng ⇒ transform
    // không có gì để làm ⇒ HTTP 200 sạch trơn trong khi đơn kẹt vĩnh viễn ở Bronze. Nay `landRaw`
    // trả thêm `seenIds` (mọi khoá NHÌN THẤY trong trang, kể cả record trùng hash), route hỏi lại
    // Bronze xem đơn nào chưa đóng dấu kết cục và dựng nốt.
    transformControl.failNextWith = new Error("mô phỏng DB chập giữa transform");
    await postOrder(); // lần 1: land + throw

    const json = await (await postOrder()).json(); // lần 2: transform thật, hash trùng

    expect(json.ok).toBe(true);
    expect(json.stats.landed).toBe(0); // vẫn dedupe theo hash — KHÔNG land lại
    expect(await prisma.order.count()).toBe(1); // nhưng đơn ĐÃ vào Silver: bẫy đã đóng
    expect(json.stats.warnings.some((w: string) => w.includes("còn dở từ lượt trước"))).toBe(true);
    // Dòng Bronze nay mang dấu bền vững, không còn phải suy đoán từ con số.
    const raw = await prisma.rawPancakeOrder.findFirstOrThrow();
    expect(raw.silverOutcome).toBe("APPLIED");
    expect(raw.silverProcessedAt).not.toBeNull();
    // Cờ backlog TOÀN CỤC vẫn bật: nó nói "có thể còn thứ khác chưa dựng", chỉ lượt rebuild toàn
    // bảng mới được hạ. Dấu theo từng dòng mới là thứ trả lời chính xác cho ĐƠN NÀY.
    expect(json.stats.warnings.some((w: string) => w.includes("BACKLOG"))).toBe(true);
    expect(await backlogFlag()).toBe("1");
  });

  it("happy-path: land = hạch toán, KHÔNG kích backlog oan (chống false-positive đối soát)", async () => {
    const res = await postOrder();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.stats.mode).toBe("land+transform");
    expect(await prisma.order.findUnique({ where: { pancakeId: "ORD-TF-1" } })).not.toBeNull();
    // Công thức đã-hạch-toán dùng CHUNG với route (`doi-soat-hach-toan.ts`) — tính lại ở đây là mở
    // đường cho hai bên trôi khỏi nhau mà test vẫn xanh.
    const accounted = demDaHachToan(json.stats);
    expect(json.stats.landed).toBe(accounted);
    expect(json.stats.warnings.some((w: string) => w.includes("hạch toán"))).toBe(false);
    expect(await backlogFlag()).not.toBe("1");
  });

  it("order HỎNG SHAPE (safeParse fail): 200 nhưng đối soát KÊU + backlog BẬT — không kẹt im lặng (ING-H1)", async () => {
    // Đơn chỉ có `id` (land được) nhưng thiếu status/inserted_at/... ⇒ safeParse fail ⇒ skipped, KHÔNG
    // vào Silver. Trước đây `skipped` bị gộp vào `accounted` nên đối soát im, hash-dedupe chặn transform
    // lại ⇒ đơn kẹt vĩnh viễn ở Bronze = thiếu doanh thu âm thầm. Nay phải bật backlog để KÊU TO.
    const res = await post({
      stream: "orders",
      shopId: SHOP_SHOPEE,
      payload: `{"success":true,"data":[{"id":"ORD-BAD-SHAPE"}]}`,
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.stats.skipped).toBe(1); // shape-fail
    expect(await prisma.rawPancakeOrder.count()).toBe(1); // ĐÃ land vào Bronze
    expect(await prisma.order.count()).toBe(0); // nhưng KHÔNG vào Silver
    expect(json.stats.warnings.some((w: string) => w.includes("hạch toán"))).toBe(true); // đối soát kêu
    expect(await backlogFlag()).toBe("1"); // backlog bật → lần sau KÊU TO tới khi rebuild
  });

  it("đơn MÃ TRẠNG THÁI LẠ: vẫn vào Silver (CANCELLED) nhưng stats.unknownStatusOrders đếm để cảnh báo (#1b)", async () => {
    // status 99 = mã lạ (Pancake không công khai bảng số) → map CANCELLED. KHÁC shape-fail: vẫn upsert
    // được, không skipped, không backlog. Nhưng phải ĐẾM để UI cảnh báo (có thể là mã hợp lệ bị loại nhầm).
    const ORDER_UNK = `{
      "id":"ORD-UNK-99","status":99,"inserted_at":"2026-07-01T10:00:00.000000",
      "order_sources_name":"Shopee","marketplace_id":"-3",
      "total_price":200000,"total_discount":0,"fee_marketplace":15000,
      "items":[{"quantity":1,"discount_each_product":0,
        "variation_info":{"display_id":"SKU-TF1","name":"SP","retail_price":100000}}]}`;
    const res = await post({
      stream: "orders",
      shopId: SHOP_SHOPEE,
      payload: `{"success":true,"data":[${ORDER_UNK}]}`,
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.stats.unknownStatusOrders).toBe(1); // đếm cảnh báo
    expect(json.stats.ordersUpserted).toBe(1); // vẫn vào Silver như CANCELLED (không shape-fail)
    expect(await backlogFlag()).not.toBe("1"); // mã lạ ≠ mất record → không backlog
  });

  it("statement hợp lệ: 1 id land = 1 dòng Silver ⇒ đối soát im, không backlog", async () => {
    const res = await post({ stream: "tiktok/statements", shopId: SHOP_TIKTOK_SHOP, payload: STATEMENTS });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.stats.landed).toBe(1);
    expect(json.stats.settlementsUpserted).toBe(1); // vào Silver "Tiền đã về"
    expect(demDaHachToan(json.stats)).toBe(1); // bỏ settlementsUpserted khỏi công thức là kêu oan ngay
    expect(json.stats.warnings.some((w: string) => w.includes("hạch toán"))).toBe(false);
    expect(await backlogFlag()).not.toBe("1");
  });

  it("statement THIẾU mốc thời gian: 200 nhưng đối soát KÊU + backlog BẬT — 'Tiền đã về' không kẹt im lặng", async () => {
    // mapStatement trả null khi thiếu `statement_time` ⇒ skipped, KHÔNG vào Silver. Gửi lại cùng
    // payload thì dedupe theo hash chặn transform lại ⇒ nếu cổng đối soát bỏ qua stream này thì dòng
    // kẹt ở Bronze vĩnh viễn mà SyncLog vẫn xanh.
    const res = await post({
      stream: "tiktok/statements",
      shopId: SHOP_TIKTOK_SHOP,
      payload: STATEMENT_THIEU_MOC,
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.stats.skipped).toBe(1);
    expect(await prisma.rawTiktokShopStatement.count()).toBe(1); // ĐÃ land vào Bronze
    expect(await prisma.tiktokSettlement.count()).toBe(0); // nhưng KHÔNG vào Silver
    expect(json.stats.warnings.some((w: string) => w.includes("hạch toán"))).toBe(true);
    expect(await backlogFlag()).toBe("1");
  });

  it("stream KHÔNG 1:1 (tiktok/statement_transactions): land mọi giao dịch, chỉ khoản quảng cáo vào Silver — không kêu oan", async () => {
    const res = await post({
      stream: "tiktok/statement_transactions",
      shopId: SHOP_TIKTOK_SHOP,
      payload: TXNS,
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.stats.landed).toBe(2);
    expect(json.stats.adsUpserted).toBe(1); // chỉ txn GMV_PAYMENT_FOR_TIKTOK_ADS có bảng Silver
    expect(json.stats.warnings.some((w: string) => w.includes("hạch toán"))).toBe(false);
    expect(await backlogFlag()).not.toBe("1");
  });
});
