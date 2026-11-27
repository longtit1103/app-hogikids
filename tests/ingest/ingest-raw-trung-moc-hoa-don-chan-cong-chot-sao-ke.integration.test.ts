import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi import route (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

import { POST } from "@/app/api/ingest/raw/route";
import { clearBronzeBacklog } from "@/lib/bronze/bronze-only";
import { demTrungMoc } from "@/lib/bronze/dem-trung-moc-phien-ban-bang-tien";
import { lyDoHoaDonTiktokChuaDu } from "@/lib/no-phai-tra/doi-chieu-sao-ke-voi-app";
import { prisma } from "@/lib/prisma";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";

/**
 * GHIM hành vi hiện tại (không phải khẳng định đúng-đắn nghiệp vụ): trang `tiktokbusiness/invoice` dính trùng mốc phiên
 * bản ⇒ route ghi SyncLog ERROR ⇒ cổng chốt sao kê thẻ (`lyDoHoaDonTiktokChuaDu`) coi lượt đó là "có trang LỖI" và CHẶN với
 * câu "hoá đơn có thể thiếu (trang lỗi chưa được kéo lại)" — dù lý do thật là trùng mốc, không phải thiếu hoá đơn. Lượt kéo
 * sau sạch (nội dung y hệt ⇒ không dòng mới ⇒ không soi lại) thì cổng MỞ trong khi Bronze vẫn còn trùng mốc.
 *
 * Đổi hành vi này (không chặn, hoặc câu lý do riêng, hoặc cổng đọc thẳng Bronze) là quyết định của chủ shop — test này đỏ
 * để buộc cố ý, không để trôi. Xem `docs/kien-truc-he-thong.md` mục phát hiện trùng mốc, "Tác động tới cổng chốt sao kê".
 */

const BC = "7000000000000000002"; // BC TikTok GIẢ (không dùng id thật của shop)
const ADV = "7000000000000000001"; // advertiser TikTok GIẢ (không dùng id thật của shop)
const STREAM = "tiktokbusiness/invoice";
const BANG = "RawTiktokBusinessInvoice";
const NGAY_MS = 24 * 3600 * 1000;
const MOC_EP = "2026-11-20 10:00:00";

const phanTu = (soTien: number) =>
  `{"transaction_id":"HD-CONG-1","transaction_type":"BILL_PAYMENT","billing_type":"CASH","amount_type":"POSITIVE",` +
  `"account_id":"${ADV}","bc_id":"${BC}","subtotal":${(soTien / 10) * 9},"tax_amount":${soTien / 10},"amount":${soTien},` +
  `"currency":"VND","create_time":"2026-10-23 15:38:00","timezone":"UTC+07:00"}`;
const trang = (soTien: number) =>
  `{"code":0,"message":"OK","data":{"transaction_list":[${phanTu(soTien)}],"page_info":{"total_page":1}}}`;

const post = (payload: string, luotId: string) =>
  POST(
    new Request("http://localhost/api/ingest/raw", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ stream: STREAM, shopId: BC, payload, luotId }),
    }),
  );

const cong = () =>
  lyDoHoaDonTiktokChuaDu(prisma, khoaNgayVn(new Date(Date.now() - 5 * NGAY_MS)), khoaNgayVn(new Date()));

async function batEpMoc(bat: boolean): Promise<void> {
  if (bat) {
    await prisma.setting.upsert({ where: { key: "test.ep_moc_hoa_don" }, create: { key: "test.ep_moc_hoa_don", value: "on" }, update: {} });
  } else {
    await prisma.setting.deleteMany({ where: { key: "test.ep_moc_hoa_don" } });
  }
}

async function cleanup(): Promise<void> {
  await prisma.tiktokBcHoaDon.deleteMany();
  await prisma.tiktokAdsHoaDon.deleteMany();
  await prisma.rawTiktokBusinessInvoice.deleteMany();
  await prisma.syncLog.deleteMany({ where: { kind: "TIKTOK_ADS" } });
  await clearBronzeBacklog();
}

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION test_ep_moc_hoa_don() RETURNS trigger AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM "Setting" WHERE key = 'test.ep_moc_hoa_don') THEN NEW."fetchedAt" := '${MOC_EP}'::timestamp; END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_ep_moc_hoa_don ON "${BANG}"`);
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER test_ep_moc_hoa_don BEFORE INSERT ON "${BANG}" FOR EACH ROW EXECUTE FUNCTION test_ep_moc_hoa_don()`,
  );
}, 60_000);

beforeEach(async () => {
  await batEpMoc(false);
  await cleanup();
});

afterAll(async () => {
  await batEpMoc(false);
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_ep_moc_hoa_don ON "${BANG}"`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_ep_moc_hoa_don()`);
  await cleanup();
  await prisma.$disconnect();
});

describe("trùng mốc ở hoá đơn TikTok Business ⇒ cổng chốt sao kê thẻ (hành vi hiện tại, ghim có chủ ý)", () => {
  it("lượt có trang dính trùng mốc ⇒ SyncLog ERROR ⇒ cổng CHẶN bằng câu 'trang LỖI chưa được kéo lại'; lượt sau sạch ⇒ cổng MỞ dù Bronze còn trùng mốc", async () => {
    await batEpMoc(true);
    try {
      expect((await post(trang(143_000), "T1")).status).toBe(200);
      const res = await post(trang(150_000), "T1");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { loiSauKhiGhi?: string };
      expect(body.loiSauKhiGhi).toMatch(/CÙNG mốc/);
      const dong = await prisma.syncLog.findFirstOrThrow({ where: { kind: "TIKTOK_ADS" }, orderBy: { startedAt: "desc" } });
      expect(dong.status).toBe("ERROR");
    } finally {
      await batEpMoc(false);
    }

    // Cổng đọc SyncLog, không đọc nguyên nhân: ERROR ⇒ "trang lỗi", câu lý do dẫn chủ shop tới "kéo lại".
    const lyDo = await cong();
    expect(lyDo).toContain(`mới nhất có trang LỖI (BC ${BC})`);
    expect(lyDo).toContain("trang lỗi chưa được kéo lại");

    // Lượt kéo sau (mã lượt mới) gửi lại nội dung y hệt: trùng hash ⇒ không dòng Bronze mới ⇒ không soi ⇒ SyncLog OK.
    expect((await post(trang(150_000), "T2")).status).toBe(200);
    expect(await cong()).toBeNull();

    // Trong khi đó trùng mốc ở Bronze KHÔNG tự hết (banner toàn app vẫn đỏ) — cổng mở không phản ánh điều này.
    expect(await demTrungMoc(prisma, BANG, { shopId: BC })).toMatchObject({ trungMocDau: 1 });
  });
});
