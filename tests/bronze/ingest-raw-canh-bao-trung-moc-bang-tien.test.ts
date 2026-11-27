import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi import route (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

import { POST } from "@/app/api/ingest/raw/route";
import { clearBronzeBacklog, hasBronzeBacklog } from "@/lib/bronze/bronze-only";
import { prisma } from "@/lib/prisma";

import { SHOP_TIKTOK_SHOP } from "../helpers/shop-ids-fixture";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Lượt ingest bốn stream TIỀN TikTok phải KÊU TO (SyncLog ERROR, HTTP 200 — n8n không dừng các trang sau) khi:
 *  - cùng khoá lặp ≥ 2 lần với nội dung khác nhau trong CÙNG trang; hoặc
 *  - lượt này đẻ hai phiên bản cùng mốc ở bản đầu của khoá.
 * Lượt sạch không đổi hành vi: OK, 0 cảnh báo trùng mốc. Trùng mốc thật (cùng mili-giây) không tái hiện ổn định bằng
 * hai POST — trigger tạm ép `fetchedAt` hằng số trên bảng Bronze trong test này (xoá ở `afterAll`).
 */

const BC = "7000000000000000002"; // BC TikTok GIẢ (không dùng id thật của shop)
const ADV = "7000000000000000001"; // advertiser TikTok GIẢ (không dùng id thật của shop)
const MOC_EP = "2026-11-20 10:00:00";

const post = (stream: string, shopId: string, payload: string, ngay?: string) =>
  POST(
    new Request("http://localhost/api/ingest/raw", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ stream, shopId, payload, ...(ngay ? { ngay } : {}) }),
    }),
  );

const phanTuPayment = (id: string, soTien: number) =>
  `{"id":"${id}","status":"PAID","paid_time":1792040400,"amount":{"value":"${soTien}","currency":"VND"},` +
  `"settlement_amount":{"value":"${soTien}","currency":"VND"},"reserve_amount":{"value":"0","currency":"VND"}}`;
const payments = (...items: string[]) => `{"code":0,"message":"Success","data":{"payments":[${items.join(",")}]}}`;

const phanTuGiaoDich = (id: string, soTien: number) =>
  `{"id":"${id}","type":"GMV_PAYMENT_FOR_TIKTOK_ADS","order_create_time":"1778770412",` +
  `"settlement_amount":"${-soTien}","adjustment_id":"ADJ-${id}"}`;
const giaoDich = (...items: string[]) => `{"code":0,"message":"Success","data":{"transactions":[${items.join(",")}]}}`;

const phanTuHoaDon = (id: string, soTien: number) =>
  `{"transaction_id":"${id}","transaction_type":"BILL_PAYMENT","billing_type":"CASH","amount_type":"POSITIVE",` +
  `"account_id":"${ADV}","bc_id":"${BC}","subtotal":${(soTien / 10) * 9},"tax_amount":${soTien / 10},"amount":${soTien},` +
  `"currency":"VND","create_time":"2026-10-14 10:00:00","timezone":"UTC+07:00"}`;
const hoaDon = (...items: string[]) =>
  `{"code":0,"message":"OK","data":{"transaction_list":[${items.join(",")}],"page_info":{"total_page":1}}}`;

/** Ảnh chụp chi phí NGÀY — một phần tử `ban_chup`; `requestId` đổi ⇒ hash đổi ⇒ phiên bản mới của cùng khoá ngày. */
const anhChup = (requestId: string, grant: number) =>
  `{"ban_chup":[{"_ngay":"2026-11-20","trang":[{"code":0,"message":"OK","request_id":"${requestId}","data":{"cost_list":[` +
  `{"advertiser_id":"${ADV}","amount":-1000,"cash_amount":-1000,"grant_amount":${-grant},"tax_amount":0,"currency":"VND"}],` +
  `"page_info":{"page":1,"page_size":50,"total_number":1,"total_page":1}}}]}]}`;

type Ca = {
  ten: string;
  stream: string;
  shopId: string;
  bang: string;
  ngay?: string;
  /** Hai nội dung KHÁC NHAU của CÙNG một khoá. */
  banA: string;
  banB: string;
  /** Trang chứa cả hai nội dung (null = stream không thể lặp khoá trong trang: Cost 1 phần tử/lần). */
  trangLap: string | null;
  /** Số dòng Silver của khoá trong fixture — trùng mốc KHÔNG được chặn dựng Silver. */
  demSilver: () => Promise<number>;
};

const CA: Ca[] = [
  {
    ten: "tiktok/payments",
    stream: "tiktok/payments",
    shopId: SHOP_TIKTOK_SHOP,
    bang: "RawTiktokShopPayment",
    banA: payments(phanTuPayment("PAY-TM-1", 100_000)),
    banB: payments(phanTuPayment("PAY-TM-1", 120_000)),
    trangLap: payments(phanTuPayment("PAY-TM-1", 100_000), phanTuPayment("PAY-TM-1", 120_000)),
    demSilver: () => prisma.tiktokPayment.count({ where: { paymentId: "PAY-TM-1" } }),
  },
  {
    ten: "tiktok/statement_transactions",
    stream: "tiktok/statement_transactions",
    shopId: SHOP_TIKTOK_SHOP,
    bang: "RawTiktokShopTransaction",
    banA: giaoDich(phanTuGiaoDich("TX-TM-1", 143_000)),
    banB: giaoDich(phanTuGiaoDich("TX-TM-1", 150_000)),
    trangLap: giaoDich(phanTuGiaoDich("TX-TM-1", 143_000), phanTuGiaoDich("TX-TM-1", 150_000)),
    demSilver: () => prisma.tiktokAdsSettlement.count({ where: { transactionId: "TX-TM-1" } }),
  },
  {
    ten: "tiktokbusiness/invoice",
    stream: "tiktokbusiness/invoice",
    shopId: BC,
    bang: "RawTiktokBusinessInvoice",
    banA: hoaDon(phanTuHoaDon("HD-TM-1", 143_000)),
    banB: hoaDon(phanTuHoaDon("HD-TM-1", 150_000)),
    trangLap: hoaDon(phanTuHoaDon("HD-TM-1", 143_000), phanTuHoaDon("HD-TM-1", 150_000)),
    demSilver: () => prisma.tiktokAdsHoaDon.count({ where: { transactionId: "HD-TM-1" } }),
  },
  {
    ten: "tiktokbusiness/cost",
    stream: "tiktokbusiness/cost",
    shopId: BC,
    bang: "RawTiktokBusinessCost",
    ngay: "2026-11-20",
    banA: anhChup("req-A", 5_000),
    banB: anhChup("req-B", 6_000),
    trangLap: null,
    demSilver: () => prisma.tiktokAdsTinDung.count({ where: { advertiserId: ADV } }),
  },
];

beforeAll(async () => {
  await seedReference();
  // Ép mọi dòng Bronze mới của bốn bảng về CÙNG một mốc ⇒ hai POST khác nội dung cùng khoá luôn trùng mốc. Hàm + trigger
  // chỉ sống trong file test này (afterAll xoá); hai test khác không bao giờ thấy chúng vì chạy tuần tự (`fileParallelism: false`).
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION test_ep_moc_bronze_tien() RETURNS trigger AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM "Setting" WHERE key = 'test.ep_moc') THEN NEW."fetchedAt" := '${MOC_EP}'::timestamp; END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  for (const c of CA) {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_ep_moc ON "${c.bang}"`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER test_ep_moc BEFORE INSERT ON "${c.bang}" FOR EACH ROW EXECUTE FUNCTION test_ep_moc_bronze_tien()`,
    );
  }
}, 60_000);

afterAll(async () => {
  await batEpMoc(false);
  for (const c of CA) await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_ep_moc ON "${c.bang}"`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_ep_moc_bronze_tien()`);
  await prisma.$executeRawUnsafe(`DELETE FROM "RawTiktokBusinessReport"`);
  // Không để lại bản trùng mốc ở Bronze cho file test khác (banner đếm toàn bảng).
  for (const c of CA) await prisma.$executeRawUnsafe(`DELETE FROM "${c.bang}"`);
  await prisma.syncLog.deleteMany();
  await clearBronzeBacklog();
});

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.syncLog.deleteMany();
  for (const c of CA) await prisma.$executeRawUnsafe(`DELETE FROM "${c.bang}"`);
  await clearBronzeBacklog();
  // Transform tín dụng chỉ ghi advertiser ĐÃ TỪNG có báo cáo chi tiêu trong kho thô (chống trừ nhầm ads advertiser khác) —
  // dựng một dòng báo cáo để Silver `TiktokAdsTinDung` của fixture Cost có thể được ghi.
  await prisma.$executeRawUnsafe(`DELETE FROM "RawTiktokBusinessReport"`);
  await prisma.$executeRawUnsafe(
    `INSERT INTO "RawTiktokBusinessReport" ("id","shopId","externalId","payloadHash","payload") VALUES ('tm-bao-cao','${ADV}','2026-11-20','h-bao-cao','{}'::jsonb)`,
  );
});

/** Bật/tắt ép mốc bằng một dòng `Setting` (trigger đọc nó) — hiệu lực cho MỌI kết nối của pool ngay lập tức. */
async function batEpMoc(bat: boolean): Promise<void> {
  if (bat) {
    await prisma.setting.upsert({ where: { key: "test.ep_moc" }, create: { key: "test.ep_moc", value: "on" }, update: {} });
  } else {
    await prisma.setting.deleteMany({ where: { key: "test.ep_moc" } });
  }
}

/** Xoá Silver của cả bốn stream (fixture dùng khoá riêng) — để chứng minh lượt kế tiếp tự dựng lại. */
async function silverXoaHet(): Promise<void> {
  await prisma.tiktokPayment.deleteMany({ where: { paymentId: "PAY-TM-1" } });
  await prisma.tiktokAdsSettlement.deleteMany({ where: { transactionId: "TX-TM-1" } });
  await prisma.tiktokAdsHoaDon.deleteMany({ where: { transactionId: "HD-TM-1" } });
  await prisma.tiktokAdsTinDung.deleteMany({ where: { advertiserId: ADV } });
}

const logsMoiNhat = () => prisma.syncLog.findMany({ orderBy: { startedAt: "desc" } });
const coCanhBaoTrungMoc = (ws: unknown): boolean =>
  Array.isArray(ws) && ws.some((w) => typeof w === "string" && /phiên bản CÙNG mốc|lặp ≥ 2 lần/.test(w));

describe.each(CA)("POST /api/ingest/raw — $ten", (ca) => {
  it("lượt sạch (một bản, không lặp) ⇒ HTTP 200, SyncLog không có cảnh báo trùng mốc", async () => {
    await batEpMoc(true);
    try {
      const res = await post(ca.stream, ca.shopId, ca.banA, ca.ngay);
      expect(res.status).toBe(200);
      const logs = await logsMoiNhat();
      const cuoi = logs[0];
      expect(coCanhBaoTrungMoc((cuoi.stats as { warnings?: unknown } | null)?.warnings)).toBe(false);
      expect(cuoi.error ?? "").not.toMatch(/trùng mốc|CÙNG mốc|lặp ≥ 2/);
    } finally {
      await batEpMoc(false);
    }
  });

  it("hai phiên bản khác nội dung cùng mốc ở bản đầu ⇒ HTTP 200 + SyncLog ERROR nêu bảng", async () => {
    await batEpMoc(true);
    try {
      expect((await post(ca.stream, ca.shopId, ca.banA, ca.ngay)).status).toBe(200);
      const res = await post(ca.stream, ca.shopId, ca.banB, ca.ngay);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; loiSauKhiGhi?: string };
      expect(body.ok).toBe(true);
      expect(body.loiSauKhiGhi).toContain(ca.bang);
      expect(body.loiSauKhiGhi).toMatch(/CÙNG mốc/);
      const cuoi = (await logsMoiNhat())[0];
      expect(cuoi.status).toBe("ERROR");
      expect(cuoi.error).toContain(ca.bang);
      // Dữ liệu đã land — kêu to, KHÔNG nuốt.
      const [{ n }] = await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${ca.bang}"`);
      expect(n).toBe(2);
      // Trùng mốc CHỈ kêu: Silver vẫn được dựng (đã có dòng từ lượt A, lượt B không xoá/chặn) và backlog KHÔNG bật
      // (dựng lại từ kho thô không cứu được ca này — bật cờ chỉ đánh lừa).
      expect(await ca.demSilver()).toBe(1);
      expect(await hasBronzeBacklog()).toBe(false);
    } finally {
      await batEpMoc(false);
    }
  });

  it("lượt kêu to vì trùng mốc vẫn TỰ dựng lại Silver đã mất (không return sớm trước transform)", async () => {
    // Ép mốc từ lượt A để lượt B chắc chắn trùng mốc với A.
    await batEpMoc(true);
    try {
      expect((await post(ca.stream, ca.shopId, ca.banA, ca.ngay)).status).toBe(200);
      // Xoá Silver do lượt A dựng: lượt B (có trùng mốc) phải TỰ dựng lại, chứng minh transform chạy SAU nhánh kêu to.
      await silverXoaHet();
      expect(await ca.demSilver()).toBe(0);
      const res = await post(ca.stream, ca.shopId, ca.banB, ca.ngay);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { loiSauKhiGhi?: string }).loiSauKhiGhi).toMatch(/CÙNG mốc/);
      expect(await ca.demSilver()).toBe(1);
      expect(await hasBronzeBacklog()).toBe(false);
    } finally {
      await batEpMoc(false);
    }
  });

  it("phép soi tự hỏng ⇒ HTTP 200, SyncLog OK, Silver vẫn dựng, chỉ ghi cảnh báo 'không soi được'", async () => {
    // Chỉ ép lỗi câu đếm trùng mốc (`HAVING count(*) >= 2`); mọi truy vấn khác đi thẳng xuống DB thật.
    const that = prisma.$queryRaw.bind(prisma);
    const gianDiep = vi.spyOn(prisma, "$queryRaw").mockImplementation(((...args: unknown[]) => {
      const mau = args[0];
      const chuoi = Array.isArray(mau) ? (mau as string[]).join("?") : "";
      if (chuoi.includes("HAVING count(*) >= 2")) return Promise.reject(new Error("phép soi hỏng giả lập"));
      return (that as (...a: unknown[]) => unknown)(...args);
    }) as typeof prisma.$queryRaw);
    const loi = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await post(ca.stream, ca.shopId, ca.banA, ca.ngay);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; loiSauKhiGhi?: string };
      expect(body.ok).toBe(true);
      expect(body.loiSauKhiGhi ?? "").not.toMatch(/CÙNG mốc|lặp ≥ 2/);
      // Phép soi THỰC SỰ đã chạy và bị ép hỏng (không phải test lướt qua nhánh khác).
      expect(gianDiep.mock.calls.some((c) => Array.isArray(c[0]) && (c[0] as string[]).join("?").includes("HAVING count(*) >= 2"))).toBe(true);
      const cuoi = (await logsMoiNhat())[0];
      expect(cuoi.status).toBe("OK");
      const ws = ((cuoi.stats as { warnings?: unknown } | null)?.warnings ?? []) as unknown[];
      expect(ws.some((w) => typeof w === "string" && /không soi được trùng mốc/.test(w) && w.includes(ca.bang))).toBe(true);
      expect(await ca.demSilver()).toBe(1);
      expect(await hasBronzeBacklog()).toBe(false);
    } finally {
      gianDiep.mockRestore();
      loi.mockRestore();
    }
  });

  it("lượt đầu của khoá (chưa có bản thứ hai) ngay sau lượt trùng KHÔNG bị tính oan", async () => {
    // Lượt A sạch ⇒ OK. (Trigger tắt: hai lượt cách nhau ≥ 1 ms ⇒ không trùng mốc ⇒ lượt B cũng sạch.)
    expect((await post(ca.stream, ca.shopId, ca.banA, ca.ngay)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 15));
    const res = await post(ca.stream, ca.shopId, ca.banB, ca.ngay);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { loiSauKhiGhi?: string };
    expect(body.loiSauKhiGhi ?? "").not.toMatch(/CÙNG mốc|lặp ≥ 2/);
  });

  it("BRONZE_ONLY (chỉ land) vẫn kêu to: trùng mốc ⇒ SyncLog ERROR, HTTP 200", async () => {
    process.env.BRONZE_ONLY = "true";
    await batEpMoc(true);
    try {
      expect((await post(ca.stream, ca.shopId, ca.banA, ca.ngay)).status).toBe(200);
      const res = await post(ca.stream, ca.shopId, ca.banB, ca.ngay);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { loiSauKhiGhi?: string };
      expect(body.loiSauKhiGhi).toContain(ca.bang);
      expect((await logsMoiNhat())[0].status).toBe("ERROR");
    } finally {
      delete process.env.BRONZE_ONLY;
      await clearBronzeBacklog(); // chế độ chỉ-land bật cờ backlog dùng chung — không để rò sang file khác
      await batEpMoc(false);
    }
  });

  if (ca.trangLap !== null) {
    it("một trang lặp cùng khoá với nội dung khác ⇒ HTTP 200 + SyncLog ERROR nêu 'lặp' (kể cả khi mốc lệch nhau)", async () => {
      const res = await post(ca.stream, ca.shopId, ca.trangLap as string, ca.ngay);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; loiSauKhiGhi?: string };
      expect(body.loiSauKhiGhi).toContain(ca.bang);
      expect(body.loiSauKhiGhi).toMatch(/lặp ≥ 2 lần/);
      const cuoi = (await logsMoiNhat())[0];
      expect(cuoi.status).toBe("ERROR");
    });
  }
});
