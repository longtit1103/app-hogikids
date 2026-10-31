import { afterAll, beforeEach, describe, expect, it } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi import route (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

import { POST } from "@/app/api/ingest/raw/route";
import { clearBronzeBacklog } from "@/lib/bronze/bronze-only";
import { lyDoHoaDonTiktokChuaDu } from "@/lib/no-phai-tra/doi-chieu-sao-ke-voi-app";
import { prisma } from "@/lib/prisma";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";

/**
 * `/api/ingest/raw` nhận `luotId` (mã lượt kéo — n8n gửi id execution) và gắn vào `stats.luotId` của MỌI dòng SyncLog
 * của trang (OK lẫn ERROR nhánh 500). Cổng chốt sao kê thẻ (`lyDoHoaDonTiktokChuaDu`) gom trang hoá đơn theo đúng mã
 * này; thiếu mã thì đoán theo khoảng cách 30' — đoán sai hai chiều:
 *  - lượt chạy tay sạch bấm trong 30' sau lượt lỗi bị gộp vào lượt lỗi ⇒ chặn oan;
 *  - một lượt có quãng nghỉ > 30' bị tách đôi ⇒ trang lỗi nửa trước bị nửa sau sạch che ⇒ MỞ SAI (đòi trả thiếu).
 * Chạy qua route THẬT (land + transform + SyncLog) rồi hỏi cổng THẬT. Giờ thật: ngày sao kê = hôm nay − 5 ⇒ D+2 đã qua.
 */

const BC = "7129545797879726081";
const ADV = "7129548444015902722";
const STREAM = "tiktokbusiness/invoice";
const NGAY_MS = 24 * 3600 * 1000;
const PHUT_MS = 60 * 1000;

const trang = (id: string) =>
  `{"code":0,"message":"OK","data":{"transaction_list":[{"transaction_id":"${id}","transaction_type":"BILL_PAYMENT",` +
  `"billing_type":"CASH","amount_type":"POSITIVE","account_id":"${ADV}","bc_id":"${BC}","subtotal":130000,` +
  `"tax_amount":13000,"amount":143000,"currency":"VND","create_time":"2026-10-23 15:38:00","timezone":"UTC+07:00"}],` +
  `"page_info":{"total_page":1}}}`;

/** Envelope lỗi (không có mảng) ⇒ land ném ⇒ route 500 + SyncLog ERROR. */
const TRANG_LOI = `{"code":40100,"message":"rate limit","data":{}}`;

const post = (payload: string, them: Record<string, unknown> = {}) =>
  POST(
    new Request("http://localhost/api/ingest/raw", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ stream: STREAM, shopId: BC, payload, ...them }),
    }),
  );

const dongMoiNhat = () =>
  prisma.syncLog.findFirstOrThrow({ where: { kind: "TIKTOK_ADS" }, orderBy: { startedAt: "desc" } });

/** Lùi `startedAt` của dòng SyncLog mới nhất — giả lập trang đó chạy `truocMs` trước. */
async function lui(truocMs: number): Promise<void> {
  const d = await dongMoiNhat();
  const luc = new Date(Date.now() - truocMs);
  await prisma.syncLog.update({ where: { id: d.id }, data: { startedAt: luc, finishedAt: luc } });
}

const cong = () =>
  lyDoHoaDonTiktokChuaDu(prisma, khoaNgayVn(new Date(Date.now() - 5 * NGAY_MS)), khoaNgayVn(new Date()));

async function cleanup(): Promise<void> {
  // Bảng bền trạng thái BC (chế độ dấu lượt, BC từng đọc được) — sót lại từ file test khác là đổi luật cổng.
  await prisma.tiktokBcHoaDon.deleteMany();
  await prisma.tiktokAdsHoaDon.deleteMany();
  await prisma.rawTiktokBusinessInvoice.deleteMany();
  await prisma.syncLog.deleteMany({ where: { kind: "TIKTOK_ADS" } });
  await clearBronzeBacklog();
}

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("/api/ingest/raw — luotId lên stats của mọi dòng SyncLog", () => {
  it("trang OK mang luotId ⇒ stats.luotId trên dòng OK (cạnh stream/shopId/mode)", async () => {
    const res = await post(trang("TX-OK"), { luotId: "104563" });

    expect(res.status).toBe(200);
    const d = await dongMoiNhat();
    expect(d.status).toBe("OK");
    expect(d.stats).toMatchObject({ stream: STREAM, shopId: BC, mode: "land+transform", luotId: "104563" });
  });

  it("trang land ném (500) mang luotId ⇒ dòng ERROR vẫn có stats.luotId", async () => {
    const res = await post(TRANG_LOI, { luotId: "104564" });

    expect(res.status).toBe(500);
    const d = await dongMoiNhat();
    expect(d.status).toBe("ERROR");
    expect(d.stats).toMatchObject({ stream: STREAM, shopId: BC, mode: "loi-land", luotId: "104564" });
  });

  it("không gửi luotId ⇒ như cũ: stats không có khoá luotId (đối chứng)", async () => {
    expect((await post(trang("TX-CU"))).status).toBe(200);
    const d = await dongMoiNhat();
    expect(d.stats).not.toHaveProperty("luotId");
  });

  it("luotId đúng trần 64 ký tự [A-Za-z0-9_-] ⇒ nhận", async () => {
    const dai = "a".repeat(30) + "_" + "B-9".repeat(11);
    expect(dai).toHaveLength(64);
    expect((await post(trang("TX-64"), { luotId: dai })).status).toBe(200);
    expect((await dongMoiNhat()).stats).toMatchObject({ luotId: dai });
  });

  it.each([
    ["chuỗi rỗng", ""],
    ["có dấu cách", "exec 101"],
    ["ký tự ngoài khuôn", "exec/101"],
    ["65 ký tự", "x".repeat(65)],
    ["kiểu số", 104563],
    ["null", null],
  ])("luotId sai khuôn (%s) ⇒ 400 trước khi land: không SyncLog, không kho thô", async (_ten, luotId) => {
    const res = await post(trang("TX-SAI"), { luotId });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/luotId/);
    expect(await prisma.syncLog.count({ where: { kind: "TIKTOK_ADS" } })).toBe(0);
    expect(await prisma.rawTiktokBusinessInvoice.count()).toBe(0);
  });
});

describe("cổng chốt sao kê thẻ gom trang hoá đơn theo luotId route ghi", () => {
  it("hai lượt KHÁC luotId cách 5': lượt trước có trang LỖI, lượt mới nhất sạch ⇒ MỞ", async () => {
    expect((await post(TRANG_LOI, { luotId: "201" })).status).toBe(500);
    await lui(5 * PHUT_MS);
    expect((await post(trang("TX-201"), { luotId: "202" })).status).toBe(200);

    // Đoán theo khoảng cách (cách 5' < 30') thì hai trang cùng một lượt có trang lỗi ⇒ chặn oan.
    expect(await cong()).toBeNull();
  });

  it("CÙNG luotId: trang LỖI rồi trang OK cách 45' ⇒ vẫn một lượt có trang lỗi ⇒ CHẶN; lượt mã mới sạch ⇒ mở", async () => {
    expect((await post(TRANG_LOI, { luotId: "301" })).status).toBe(500);
    await lui(45 * PHUT_MS);
    expect((await post(trang("TX-301"), { luotId: "301" })).status).toBe(200);

    // Đoán theo khoảng cách (cách 45' ≥ 30') thì trang OK là lượt mới sạch ⇒ mở sai, trang lỗi chưa được kéo lại.
    expect(await cong()).toContain(`mới nhất có trang LỖI (BC ${BC})`);

    expect((await post(trang("TX-302"), { luotId: "302" })).status).toBe(200);
    expect(await cong()).toBeNull();
  });
});
