import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi import route (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

import { POST } from "@/app/api/ingest/webhook/[shop]/route";
import { prisma } from "@/lib/prisma";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Endpoint hộp thư + xử lý pha 2.
 *
 * BẤT BIẾN được khoá ở đây: **hộp thư ghi TRƯỚC, xử lý SAU, và xử lý hỏng KHÔNG làm mất sự kiện**
 * (Pancake không có API lấy lại lịch sử webhook — mất raw là mất vĩnh viễn). Kèm theo: mọi dòng
 * đều phải có KẾT CỤC (`processedAs`) để sự kiện app chưa hiểu hiện lên /cai-dat mà còn vào fix.
 */

const DON = (id: string) =>
  `{"type":"orders","id":"${id}","status":3,"inserted_at":"2026-07-01T10:00:00.000000",` +
  `"order_sources_name":"Tiktok","marketplace_id":"-9","total_price":150000,"total_discount":0,` +
  `"fee_marketplace":9000,"items":[{"quantity":1,"discount_each_product":0,` +
  `"variation_info":{"display_id":"EP-SKU","name":"SP","retail_price":150000}}]}`;

const post = (shop: string, body: string, secret = SECRET) =>
  POST(
    new Request(`http://localhost/api/ingest/webhook/${shop}`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      body,
    }),
    { params: Promise.resolve({ shop }) },
  );

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.rawPancakeOrder.deleteMany();
  await prisma.rawPancakeWebhookEvent.deleteMany();
});

// `truncateBusinessTables()` KHÔNG đụng hộp thư (nó là bảng raw, không phải bảng nghiệp vụ) ⇒ dòng
// do suite này chèn sẽ sống sang suite khác. E2E `settings.spec.ts` khẳng định "chưa nhận sự kiện
// nào" nên phải dọn ở đây, nếu không thứ tự chạy đổi là đỏ ngẫu nhiên.
afterAll(async () => {
  await prisma.rawPancakeWebhookEvent.deleteMany();
});

describe("POST /api/ingest/webhook/:shop", () => {
  it("đơn hàng: hộp thư giữ payload NGUYÊN XI + dựng Silver + ghi kết cục lên đúng dòng", async () => {
    const id = "585229755054261862";
    const payload = DON(id);

    const res = await post("tiktok", payload);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, processedAs: "don-hang" });
    const dong = await prisma.rawPancakeWebhookEvent.findFirst();
    expect(dong?.payload).toBe(payload); // từng byte, không parse lại
    expect(dong?.processedAs).toBe("don-hang");
    expect(await prisma.order.findUnique({ where: { pancakeId: id } })).not.toBeNull();
  });

  it("payload rác: VẪN 200 + VẪN giữ trong hộp thư, kết cục `khong-nhan-dien` để còn vào fix", async () => {
    const res = await post("shopee", "<html>502 Bad Gateway</html>");

    expect(res.status).toBe(200); // n8n không retry vô ích; nightly API vẫn vét bù
    const dong = await prisma.rawPancakeWebhookEvent.findFirst();
    expect(dong?.payload).toBe("<html>502 Bad Gateway</html>");
    expect(dong?.processedAs).toBe("khong-nhan-dien");
  });

  it("đơn hỏng shape: sự kiện KHÔNG mất, kết cục `loi` kèm ghi chú chẩn đoán", async () => {
    const res = await post("tiktok", `{"type":"orders","id":"HONG-EP","status":3,"items":[]}`);

    expect(res.status).toBe(200);
    const dong = await prisma.rawPancakeWebhookEvent.findFirst();
    expect(dong?.processedAs).toBe("loi");
    expect(dong?.processedNote).toBeTruthy();
    expect(await prisma.order.count()).toBe(0);
  });

  it("loại cố ý bỏ qua vẫn được ĐẾM (không nuốt im lặng)", async () => {
    await post("kho", `{"type":"products","id":"P-1","name":"Áo","variations":[]}`);

    const dong = await prisma.rawPancakeWebhookEvent.findFirst();
    expect(dong?.processedAs).toBe("san-pham-bo-qua");
  });

  it("ping thử: 200, hộp thư giữ NGUYÊN XI payload, kết cục `ping-thu` (vẫn ĐẾM, thôi tô đỏ)", async () => {
    const res = await post("shopee", `{"test":true}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, processedAs: "ping-thu" });
    // Hộp thư BẤT BIẾN vẫn là bất biến với ping: nhận là ghi, payload không bị đụng.
    const dong = await prisma.rawPancakeWebhookEvent.findFirst();
    expect(dong?.payload).toBe(`{"test":true}`);
    expect(dong?.processedAs).toBe("ping-thu");
    expect(await prisma.order.count()).toBe(0);
  });

  it("sai bearer → 401 và KHÔNG ghi gì vào hộp thư", async () => {
    const res = await post("tiktok", DON("X-401"), "sai-secret");

    expect(res.status).toBe(401);
    expect(await prisma.rawPancakeWebhookEvent.count()).toBe(0);
  });

  it("slug shop lạ → 400, không đoán shop (Bronze append-only, land nhầm là nằm vĩnh viễn)", async () => {
    const res = await post("shoppee", DON("X-400"));

    expect(res.status).toBe(400);
    expect(await prisma.rawPancakeWebhookEvent.count()).toBe(0);
  });
});
