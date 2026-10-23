import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi nạp route (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

import { POST as adsPost } from "@/app/api/ingest/ads/route";
import { hasBronzeBacklog, markBronzeBacklog } from "@/lib/bronze/bronze-only";
import { landRaw } from "@/lib/bronze/land-raw";
import { dungLaiGiaoDichTuKhoTho } from "@/lib/bronze/rebuild";
import { TIEN_TO_CANH_BAO_CAT_TAI_M } from "@/lib/bronze/transform-ads-expense";
import { transformFromRaw, type TransformStats } from "@/lib/bronze/transform-from-raw";
import { KEY_NO_PHAI_TRA_TU_NGAY } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { prisma } from "@/lib/prisma";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Lượt dựng lại từ kho thô CẮT TẠI MỐC NỢ PHẢI TRẢ M: đã bật ⇒ nhánh chi tiêu ads không tạo / sửa / hạ về 0đ
 * dòng `Expense` ADS_API ngày VN < M (quỹ cuối M−1 đã chốt bằng điều chỉnh mở sổ, ghi lại là "trôi quỹ"), đếm
 * `skippedTruocM` RIÊNG (không vào `skipped` — điều kiện hạ cờ backlog) + MỘT dòng cảnh báo mỗi nhánh. Chưa bật ⇒
 * y hành vi cũ. Đường n8n hằng ngày (`/api/ingest/ads`) giữ ngoại lệ: vẫn ghi ngày < M.
 */

const M = "2026-10-15";
const ACT = "act_415299582336742"; // ad account Meta
const ADV = "7129548444015902722"; // advertiser TikTok Business
const BC = "7129545797879726081"; // Business Center (hoá đơn)

const insights = (items: string) => `{"data":[${items}],"paging":{"cursors":{"after":"MjQZD"}}}`;
const dongMeta = (campaignId: string, ngay: string, spend: string) =>
  `{"spend":"${spend}","campaign_id":"${campaignId}","campaign_name":"Ao vay be gai",` +
  `"account_currency":"VND","date_start":"${ngay}","date_stop":"${ngay}","impressions":"1200"}`;

const baoCao = (items: string) => `{"code":0,"message":"OK","data":{"list":[${items}],"page_info":{"total_page":1}}}`;
const dongGmvMax = (campaignId: string, ngay: string, cost: string) =>
  `{"metrics":{"cost":"${cost}","campaign_name":"KM_Váy kẻ caravat_1106"},` +
  `"dimensions":{"campaign_id":"${campaignId}","stat_time_day":"${ngay} 00:00:00"}}`;
const hoaDon = (txId: string, taoLuc: string, subtotal: number, thue: number) =>
  `{"code":0,"message":"OK","data":{"transaction_list":[{"transaction_id":"${txId}",` +
  `"transaction_type":"BILL_PAYMENT","account_id":"${ADV}","bc_id":"${BC}",` +
  `"subtotal":${subtotal},"tax_amount":${thue},"amount":${subtotal + thue},"currency":"VND",` +
  `"create_time":"${taoLuc}"}],"page_info":{"total_page":1}}}`;

const vn = (ngay: string) => new Date(`${ngay}T00:00:00+07:00`);

const dungLai = (
  stream: "meta/report" | "tiktokbusiness/report",
  w: string[],
  mocNoPhaiTra?: Date | null,
): Promise<TransformStats> =>
  transformFromRaw(stream, w, mocNoPhaiTra === undefined ? { rebuild: true } : { rebuild: true, mocNoPhaiTra });

async function batM(): Promise<void> {
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
  await prisma.setting.create({ data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: M } });
}

async function cleanup(): Promise<void> {
  await truncateBusinessTables();
  // Mọi stream lượt dựng lại giao dịch (nút bấm) quét — dòng hỏng sót từ suite khác sẽ đẩy `skipped` lên và test
  // "vẫn hạ cờ" đỏ vì lý do sai.
  await prisma.rawMetaAdsReport.deleteMany();
  await prisma.rawTiktokBusinessReport.deleteMany();
  await prisma.rawTiktokBusinessInvoice.deleteMany();
  await prisma.rawPancakeOrder.deleteMany();
  await prisma.rawPancakeProduct.deleteMany();
  await prisma.rawTiktokShopStatement.deleteMany();
  await prisma.rawTiktokShopTransaction.deleteMany();
  await prisma.rawTiktokShopPayment.deleteMany();
  await prisma.rawShopeeWalletTxn.deleteMany();
  await prisma.syncLog.deleteMany();
  // M và cờ backlog sống trong Setting — sót lại là test file khác (import ads, khoá sổ) đỏ vì lý do sai.
  await prisma.setting.deleteMany({ where: { key: { in: [KEY_NO_PHAI_TRA_TU_NGAY, "bronzeBacklogPending"] } } });
}

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

const req = (body: unknown) =>
  new Request("http://t/api/ingest/ads", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
    body: JSON.stringify(body),
  });

describe("dựng lại chi tiêu ads khi ĐÃ bật Nợ phải trả", () => {
  it("dòng 14/10 bỏ qua (skippedTruocM), dòng 15/10 ghi; skipped không tăng; một dòng cảnh báo", async () => {
    await batM();
    await landRaw("meta/report", ACT, insights(`${dongMeta("23851", "2026-10-14", "100000")},${dongMeta("23851", M, "200000")}`));

    const w: string[] = [];
    const stats = await dungLai("meta/report", w); // không truyền mốc ⇒ nhánh tự đọc M từ DB

    expect(stats.adsExpensesUpserted).toBe(1);
    expect(stats.skippedTruocM).toBe(1);
    expect(stats.skipped).toBe(0);
    expect(stats.boQuaCoChuDich).toBe(0);
    expect(await prisma.expense.findMany({ select: { refId: true, amount: true, date: true } })).toEqual([
      { refId: `META:${M}:23851`, amount: 220_000, date: vn(M) },
    ]);
    const catTaiM = w.filter((x) => x.startsWith(TIEN_TO_CANH_BAO_CAT_TAI_M));
    expect(catTaiM).toEqual(["Đã bật Nợ phải trả từ 15/10/2026: bỏ qua 1 dòng ads Meta trước mốc (giữ số đã chốt)"]);
  });

  it("dòng ADS_API < M đã có trong sổ GIỮ NGUYÊN số — kể cả khi kho thô báo 0đ (không hạ, không sửa)", async () => {
    await batM();
    await prisma.expense.createMany({
      data: [
        { refId: "META:2026-10-13:A", date: vn("2026-10-13"), categoryId: "ads", adsSource: "META", channelId: "facebook", description: "A", amount: 111_000, source: "ADS_API" },
        { refId: "META:2026-10-14:B", date: vn("2026-10-14"), categoryId: "ads", adsSource: "META", channelId: "facebook", description: "B", amount: 222_000, source: "ADS_API" },
      ],
    });
    await landRaw("meta/report", ACT, insights(`${dongMeta("A", "2026-10-13", "999999")},${dongMeta("B", "2026-10-14", "0")}`));

    const w: string[] = [];
    const stats = await dungLai("meta/report", w);

    expect(stats.skippedTruocM).toBe(2);
    expect(stats.adsExpensesUpserted).toBe(0);
    expect(stats.skipped).toBe(0);
    expect(
      await prisma.expense.findMany({ orderBy: { refId: "asc" }, select: { refId: true, amount: true, description: true } }),
    ).toEqual([
      { refId: "META:2026-10-13:A", amount: 111_000, description: "A" },
      { refId: "META:2026-10-14:B", amount: 222_000, description: "B" },
    ]);
  });

  it("TikTok: cắt TRƯỚC tra VAT — tháng < M có VAT vô lý không làm `skipped` tăng (không giữ cờ)", async () => {
    await batM();
    // Hoá đơn tháng 9: 100.000 + 50.000 ⇒ 50% — ngoài dải, tháng 9 bị từ chối VAT. Dòng 30/09 < M nên phải rơi vào
    // `skippedTruocM` trước khi kịp chạm cổng VAT.
    await landRaw("tiktokbusiness/invoice", BC, hoaDon("TX-9", "2026-09-20 10:00:00", 100_000, 50_000));
    await landRaw(
      "tiktokbusiness/report",
      ADV,
      baoCao(`${dongGmvMax("C1", "2026-09-30", "81617")},${dongGmvMax("C1", M, "81617")}`),
    );

    const w: string[] = [];
    const stats = await dungLai("tiktokbusiness/report", w);

    expect(stats.skipped).toBe(0);
    expect(stats.skippedTruocM).toBe(1);
    expect(stats.adsExpensesUpserted).toBe(1);
    expect(await prisma.expense.findMany({ select: { refId: true } })).toEqual([{ refId: `TIKTOK_ADS:${M}:C1` }]);
    expect(w.filter((x) => x.startsWith(TIEN_TO_CANH_BAO_CAT_TAI_M))).toEqual([
      "Đã bật Nợ phải trả từ 15/10/2026: bỏ qua 1 dòng ads TikTok trước mốc (giữ số đã chốt)",
    ]);
  });

  it("mốc người gọi truyền xuống là căn cứ DUY NHẤT — không đọc lại DB mỗi nhánh", async () => {
    // DB chưa bật, nhưng lượt dựng lại đã đọc M lúc trước và truyền xuống ⇒ vẫn cắt theo mốc đó.
    await landRaw("meta/report", ACT, insights(`${dongMeta("23851", "2026-10-14", "100000")},${dongMeta("23851", M, "200000")}`));
    const w: string[] = [];
    const cat = await dungLai("meta/report", w, vn(M));
    expect(cat.skippedTruocM).toBe(1);
    expect(cat.adsExpensesUpserted).toBe(1);

    // Ngược lại: DB đã bật nhưng người gọi truyền `null` (đọc lúc chưa bật) ⇒ không cắt.
    await cleanup();
    await batM();
    await landRaw("meta/report", ACT, insights(`${dongMeta("23851", "2026-10-14", "100000")},${dongMeta("23851", M, "200000")}`));
    const khongCat = await dungLai("meta/report", [], null);
    expect(khongCat.skippedTruocM).toBe(0);
    expect(khongCat.adsExpensesUpserted).toBe(2);
  });

  it("lượt dựng lại giao dịch (nút bấm) cộng `skippedTruocM` riêng và VẪN HẠ cờ backlog", async () => {
    await batM();
    await landRaw("meta/report", ACT, insights(`${dongMeta("23851", "2026-10-14", "100000")},${dongMeta("23851", M, "200000")}`));
    await markBronzeBacklog();

    const w: string[] = [];
    const stats = await dungLaiGiaoDichTuKhoTho(w);

    expect(stats.skippedTruocM).toBe(1);
    expect(stats.skipped).toBe(0);
    expect(stats.adsExpensesUpserted).toBe(1);
    expect(await hasBronzeBacklog()).toBe(false);
    expect(w.some((x) => x.startsWith(TIEN_TO_CANH_BAO_CAT_TAI_M))).toBe(true);
  });

  it("đường n8n hằng ngày GIỮ ngoại lệ: vẫn ghi chi tiêu ngày < M (nền tảng chốt lại số ngày cũ)", async () => {
    await batM();
    const res = await adsPost(
      req({
        source: "META",
        rows: [{ date: "2026-10-14", campaignId: "23851", campaignName: "Ao vay be gai", spendExVat: 100_000, vatRate: 0.1 }],
      }),
    );
    expect(res.status).toBe(200);
    expect(await prisma.expense.findMany({ select: { refId: true, amount: true, source: true } })).toEqual([
      { refId: "META:2026-10-14:23851", amount: 110_000, source: "ADS_API" },
    ]);
  });
});

describe("dựng lại chi tiêu ads khi CHƯA bật Nợ phải trả", () => {
  it("M null ⇒ ghi cả hai ngày, skippedTruocM = 0, không có cảnh báo cắt tại M", async () => {
    await landRaw("meta/report", ACT, insights(`${dongMeta("23851", "2026-10-14", "100000")},${dongMeta("23851", M, "200000")}`));

    const w: string[] = [];
    const stats = await dungLai("meta/report", w);

    expect(stats.adsExpensesUpserted).toBe(2);
    expect(stats.skippedTruocM).toBe(0);
    expect(stats.skipped).toBe(0);
    expect(w.some((x) => x.startsWith(TIEN_TO_CANH_BAO_CAT_TAI_M))).toBe(false);
    expect(await prisma.expense.count({ where: { source: "ADS_API" } })).toBe(2);
  });
});
