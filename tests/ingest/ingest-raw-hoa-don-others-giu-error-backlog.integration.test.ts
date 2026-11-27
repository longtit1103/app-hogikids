import { afterAll, beforeEach, describe, expect, it } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi import route (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

import { POST } from "@/app/api/ingest/raw/route";
import { clearBronzeBacklog } from "@/lib/bronze/bronze-only";
import { KEY_NO_PHAI_TRA_TU_NGAY } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { docGiaoDichThe, docKyNeoThe } from "@/lib/no-phai-tra/du-no-the";
import { duNo } from "@/lib/no-phai-tra/ky-sao-ke";
import { prisma } from "@/lib/prisma";

import {
  BC,
  DONG_NAP,
  DONG_OTHERS,
  DONG_P8,
  ID_NAP,
  ID_OTHERS,
  ID_P8,
  INVOICE_TACH_DOI,
  NAP,
  P8,
  STREAM_HOA_DON as STREAM,
  trangHoaDon as trang,
} from "../helpers/hoa-don-tiktok-others-fixture";
import { truncateBusinessTables } from "../helpers/test-db";

/**
 * GHIM hành vi với 8 hoá đơn TikTok Business `amount_type = "OTHERS"` NGOÀI tập dấu băm đã xác minh (shape payload thật,
 * id / ngày giờ / số tiền GIẢ — fixture chung `tests/helpers/hoa-don-tiktok-others-fixture.ts`; id giả không thuộc tập thật, file
 * này dùng tập THẬT, không mock), qua route THẬT `/api/ingest/raw` (land + transform + SyncLog):
 *  - mapping bỏ 8 dòng ⇒ `skipped = 8` ⇒ SyncLog ERROR + cờ `bronzeBacklogPending` bật, HTTP vẫn 200;
 *  - Bronze giữ đủ mọi dòng, Silver `TiktokAdsHoaDon` chỉ có lần nạp `ADD_BALANCE` + nửa `POSITIVE` của bill tách đôi;
 *  - dư nợ thẻ phần TikTok = N + P8, có hay không 8 dòng OTHERS trong Bronze cũng vậy.
 * Chủ shop chốt CHỈ bỏ có chủ đích đúng tập đã xác minh (ca trong tập: `ingest-raw-hoa-don-others-tru-so-du-da-xac-minh…`);
 * đổi bất kỳ kỳ vọng dưới đây cho dòng NGOÀI tập phải là quyết định có chủ ý.
 */

const post = (payload: string, luotId: string) =>
  POST(
    new Request("http://localhost/api/ingest/raw", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ stream: STREAM, shopId: BC, payload, luotId }),
    }),
  );

const dongMoiNhat = () =>
  prisma.syncLog.findFirstOrThrow({ where: { kind: "TIKTOK_ADS" }, orderBy: { startedAt: "desc" } });

const coBacklog = async () =>
  (await prisma.setting.findUnique({ where: { key: "bronzeBacklogPending" } }))?.value;

async function cleanup(): Promise<void> {
  await truncateBusinessTables(); // TiktokAdsHoaDon, thẻ / kỳ sao kê / gắn nền tảng, mốc M
  await prisma.tiktokBcHoaDon.deleteMany();
  await prisma.rawTiktokBusinessInvoice.deleteMany();
  await prisma.syncLog.deleteMany({ where: { kind: "TIKTOK_ADS" } });
  await clearBronzeBacklog();
}

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("/api/ingest/raw — trang hoá đơn có 8 dòng OTHERS (ngoài tập, ghim)", () => {
  it("một trang N + 8 OTHERS + P8 ⇒ HTTP 200, SyncLog ERROR skipped 8, backlog bật, Bronze 10, Silver chỉ N + P8", async () => {
    const res = await post(trang([DONG_NAP, ...DONG_OTHERS, DONG_P8]), "luot-others-1");

    // HTTP 200 (không 500): n8n không thử lại trang, các trang sau của lượt vẫn được gửi.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { loiSauKhiGhi?: string };
    expect(body.loiSauKhiGhi).toContain("8 record đã vào kho thô nhưng KHÔNG dựng được Silver");

    // Bỏ dòng tiền là báo ĐỎ: SyncLog ERROR, đếm đúng 8 dòng bỏ, 2 dòng lên Silver.
    const log = await dongMoiNhat();
    expect(log.status).toBe("ERROR");
    expect(log.error).toContain("dư nợ thẻ tín dụng đang THIẾU");
    expect(log.stats).toMatchObject({ stream: STREAM, shopId: BC, luotId: "luot-others-1", skipped: 8, hoaDonAdsUpserted: 2 });
    const canhBao = (log.stats as { warnings?: string[] }).warnings ?? [];
    for (const id of ID_OTHERS) {
      expect(canhBao.some((w) => w.includes(id) && w.includes("không biết chiều tiền")), id).toBe(true);
    }

    // Cờ backlog bật: dedupe theo hash chặn dựng lại theo trang — chỉ dựng lại từ kho thô (sau khi sửa mapping) cứu được.
    expect(await coBacklog()).toBe("1");

    // Bronze giữ đủ 10 dòng (không lọc khi land).
    const bronze = await prisma.rawTiktokBusinessInvoice.findMany({ where: { shopId: BC }, select: { externalId: true } });
    expect(bronze.map((b) => b.externalId).sort()).toEqual([ID_NAP, ...ID_OTHERS, ID_P8].sort());

    // Silver đúng 2 dòng: nạp ADD_BALANCE + nửa POSITIVE của bill tách đôi; không dòng OTHERS nào.
    const silver = await prisma.tiktokAdsHoaDon.findMany({
      select: { transactionId: true, amount: true, amountType: true, invoiceId: true },
      orderBy: { transactionId: "asc" },
    });
    expect(silver).toEqual([
      { transactionId: ID_NAP, amount: NAP, amountType: "POSITIVE", invoiceId: "7000000000000000200" },
      { transactionId: ID_P8, amount: P8, amountType: "POSITIVE", invoiceId: INVOICE_TACH_DOI },
    ]);
  });
});

describe("dư nợ thẻ phần TikTok với 8 dòng OTHERS (ngoài tập, ghim)", () => {
  const vn = (ngay: string, gio = "00:00:00") => new Date(`${ngay}T${gio}+07:00`);

  /** M = 01/09, thẻ gánh TIKTOK_ADS từ 01/09, neo mở sổ 0 cuối 31/08 — khuôn `du-no-the.integration.test.ts`. */
  async function dungThe(): Promise<string> {
    await prisma.setting.create({ data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: "2026-09-01" } });
    const { id } = await prisma.theTinDung.create({ data: { ten: "Thẻ TikTok", ngayChotSaoKe: 20, ngayHanTra: 5 } });
    await prisma.ganNenTangThe.create({ data: { cardId: id, nenTang: "TIKTOK_ADS", tuNgay: vn("2026-09-01") } });
    await prisma.kySaoKeThe.create({ data: { cardId: id, ngayChot: vn("2026-08-31"), soDu: 0, laNeoMoSo: true } });
    return id;
  }

  async function duNoCuoi30(cardId: string): Promise<number | null> {
    const t = vn("2026-09-30", "12:00:00");
    return duNo(await docKyNeoThe(cardId), await docGiaoDichThe(cardId, t), t);
  }

  it("chỉ N + P8 ⇒ dư nợ N + P8; thêm 8 OTHERS vào Bronze ⇒ số KHÔNG đổi", async () => {
    const the = await dungThe();
    expect((await post(trang([DONG_NAP, DONG_P8]), "luot-others-2")).status).toBe(200);
    expect((await dongMoiNhat()).status).toBe("OK");
    expect(await duNoCuoi30(the)).toBe(NAP + P8);

    // Trang thứ hai chỉ có 8 dòng OTHERS: land vào Bronze nhưng mapping bỏ ⇒ không chạm nợ thẻ (và báo đỏ như trên).
    expect((await post(trang(DONG_OTHERS), "luot-others-3")).status).toBe(200);
    expect((await dongMoiNhat()).status).toBe("ERROR");
    expect(await prisma.rawTiktokBusinessInvoice.count({ where: { shopId: BC } })).toBe(10);
    expect(await duNoCuoi30(the)).toBe(NAP + P8);
  });

  it("một trang đủ N + 8 OTHERS + P8 ⇒ cùng dư nợ N + P8 (OTHERS không cộng, không trừ)", async () => {
    // Nếu sau này OTHERS bị đọc nhầm là trừ thẻ (cộng tổng nạp lần nữa) hay hoàn (trừ tổng nạp) mà không qua tập đã xác minh ⇒ đỏ.
    const the = await dungThe();
    expect((await post(trang([DONG_NAP, ...DONG_OTHERS, DONG_P8]), "luot-others-4")).status).toBe(200);
    expect(await duNoCuoi30(the)).toBe(NAP + P8);
  });
});
