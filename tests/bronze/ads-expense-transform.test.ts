import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi nạp route (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

// `importAdsExpenses` chạy như server action: `requireUser` gọi `cookies()` và `revalidatePath` cần
// request scope — không có trong vitest. Phần auth thật đã phủ ở e2e.
vi.mock("@/lib/session", () => ({ requireUser: vi.fn(async () => "test-user-id") }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { POST as adsPost } from "@/app/api/ingest/ads/route";
import { POST as rawPost } from "@/app/api/ingest/raw/route";
import { importAdsExpenses } from "@/lib/actions/ads-import";
import { landRaw } from "@/lib/bronze/land-raw";
import { transformFromRaw, type TransformStats } from "@/lib/bronze/transform-from-raw";
import { giuKhoaGhiChiTieuAds } from "@/lib/ingest/khoa-ghi-chi-tieu-ads";
import { prisma } from "@/lib/prisma";

import { seedReference } from "../helpers/test-db";

/**
 * Dựng lại CHI TIÊU QUẢNG CÁO từ kho thô (`hogikids_test`).
 *
 * Bất biến kiểm ở đây, theo thứ tự nguy hiểm giảm dần:
 *  1. Chi phí chủ shop NHẬP TAY — và ngày chủ shop đã ghi đè bằng file — không bao giờ bị lượt dựng
 *     lại chạm tới.
 *  2. Chỉ ĐÚNG lượt dựng lại mới được ghi chi phí; trang ingest thường ngày không đụng sổ.
 *  3. Khoá `refId` sinh từ kho thô TRÙNG KHÍT khoá `/api/ingest/ads` sinh — lệch là đẻ dòng trùng,
 *     chi phí quảng cáo đếm 2 lần.
 *  4. Số tiền = chi tiêu chưa thuế × (1 + VAT), VAT TikTok đo từ hoá đơn trong kho thô.
 *  5. Dòng chi tiêu 0đ không đẻ thêm dòng chi phí mới (kho thô có hàng chục nghìn dòng như thế).
 *
 * Payload dùng SHAPE THẬT đo trên prod 28/07 (tiền là CHUỖI ở cả 2 sàn).
 */

const ACT = "act_415299582336742"; // ad account Meta
const ADV = "7129548444015902722"; // advertiser TikTok Business
const BC = "7129545797879726081"; // Business Center (hoá đơn)

const insights = (items: string) => `{"data":[${items}],"paging":{"cursors":{"after":"MjQZD"}}}`;

const dongMeta = (campaignId: string, ngay: string, spend: string, tienTe = "VND") =>
  `{"spend":"${spend}","campaign_id":"${campaignId}","campaign_name":"Ao vay be gai",` +
  `"account_currency":"${tienTe}","date_start":"${ngay}","date_stop":"${ngay}","impressions":"1200"}`;

const baoCao = (items: string) =>
  `{"code":0,"message":"OK","data":{"list":[${items}],"page_info":{"total_page":1}}}`;

/** GMV Max: metric tên `cost` (endpoint /gmv_max/report/get/). */
const dongGmvMax = (campaignId: string, ngay: string, cost: string) =>
  `{"metrics":{"cost":"${cost}","campaign_name":"KM_Váy kẻ caravat_1106"},` +
  `"dimensions":{"campaign_id":"${campaignId}","stat_time_day":"${ngay} 00:00:00"}}`;

/**
 * Auction: metric tên `spend` (endpoint /report/integrated/get/). Prod chưa có dòng nào loại này
 * (shop chỉ chạy GMV Max) nên payload dựng TAY theo hợp đồng `keoReport` của n8n.
 */
const dongAuction = (campaignId: string, ngay: string, spend: string) =>
  `{"metrics":{"spend":"${spend}","campaign_name":"Auction_Ao thun"},` +
  `"dimensions":{"campaign_id":"${campaignId}","stat_time_day":"${ngay} 00:00:00"}}`;

const hoaDon = (txId: string, taoLuc: string, subtotal: number, thue: number, loai = "BILL_PAYMENT") =>
  `{"code":0,"message":"OK","data":{"transaction_list":[{"transaction_id":"${txId}",` +
  `"transaction_type":"${loai}","account_id":"${ADV}","bc_id":"${BC}",` +
  `"subtotal":${subtotal},"tax_amount":${thue},"amount":${subtotal + thue},"currency":"VND",` +
  `"create_time":"${taoLuc}"}],"page_info":{"total_page":1}}}`;

const req = (body: unknown) =>
  new Request("http://t/api/ingest/ads", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
    body: JSON.stringify(body),
  });

/** Lượt DỰNG LẠI — cờ `rebuild` là điều kiện bắt buộc để nhánh chi tiêu ads chạy. */
const dungLai = (stream: "meta/report" | "tiktokbusiness/report", w: string[]): Promise<TransformStats> =>
  transformFromRaw(stream, w, { rebuild: true });

async function cleanup(): Promise<void> {
  await prisma.expense.deleteMany();
  await prisma.rawMetaAdsReport.deleteMany();
  await prisma.rawTiktokBusinessReport.deleteMany();
  await prisma.rawTiktokBusinessInvoice.deleteMany();
  await prisma.syncLog.deleteMany();
}

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("dựng lại chi tiêu Meta từ kho thô", () => {
  it("báo cáo Meta → 1 dòng chi phí đúng khoá, đúng tiền (×1,1), neo ngày giờ VN", async () => {
    await landRaw("meta/report", ACT, insights(dongMeta("23851", "2026-05-20", "120000")));

    const w: string[] = [];
    const stats = await dungLai("meta/report", w);

    expect(stats.adsExpensesUpserted).toBe(1);
    const exp = await prisma.expense.findUnique({ where: { refId: "META:2026-05-20:23851" } });
    expect(exp).not.toBeNull();
    expect(exp!.amount).toBe(132_000); // 120.000 × 1,1 — VAT Meta là hằng số khai tay
    expect(exp!.source).toBe("ADS_API");
    expect(exp!.adsSource).toBe("META");
    expect(exp!.categoryId).toBe("ads");
    expect(exp!.channelId).toBe("facebook");
    expect(exp!.description).toBe("Ao vay be gai");
    // 2026-05-20 00:00 +07 = 17:00Z hôm trước (bất biến múi giờ)
    expect(exp!.date.toISOString()).toBe("2026-05-19T17:00:00.000Z");
  });

  it("chạy lại 2 lượt → vẫn 1 dòng (idempotent theo refId)", async () => {
    await landRaw("meta/report", ACT, insights(dongMeta("23851", "2026-05-20", "120000")));
    const w: string[] = [];
    await dungLai("meta/report", w);
    await dungLai("meta/report", w);

    expect(await prisma.expense.count()).toBe(1);
  });

  it("Meta sửa chi tiêu hồi tố → dựng lại ghi ĐÈ đúng số mới, không đẻ dòng thứ 2", async () => {
    await landRaw("meta/report", ACT, insights(dongMeta("23851", "2026-05-20", "120000")));
    await landRaw("meta/report", ACT, insights(dongMeta("23851", "2026-05-20", "90000")));

    const w: string[] = [];
    await dungLai("meta/report", w);

    const rows = await prisma.expense.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(99_000); // bản MỚI NHẤT thắng: 90.000 × 1,1
  });

  it("payload thiếu campaign_id/spend → bỏ dòng + cảnh báo, KHÔNG ghi 0đ vào sổ", async () => {
    await prisma.rawMetaAdsReport.create({
      data: { shopId: ACT, externalId: "23851:2026-05-20", payloadHash: "h", payload: { date_start: "2026-05-20" } },
    });

    const w: string[] = [];
    const stats = await dungLai("meta/report", w);

    expect(stats.adsExpensesUpserted).toBe(0);
    expect(stats.skipped).toBe(1);
    expect(w.join(" ")).toContain("23851:2026-05-20");
    expect(await prisma.expense.count()).toBe(0);
  });

  it("kho thô mang 1 dòng ngày ngoài biên → bỏ ĐÚNG dòng đó + cảnh báo, dòng hợp lệ vẫn dựng lại", async () => {
    // Cùng biên với `/api/ingest/ads` (`prepareAdsExpenseRow`), nhưng lượt dựng lại là đường phục
    // hồi: ném cả lượt là mất luôn phần đã dựng, nên chỉ bỏ dòng hỏng. Ghi thẳng bảng thô để lách
    // cửa sổ ngày của `landRaw` — mô phỏng dòng đã nằm sẵn trong kho từ trước khi có cổng.
    await landRaw("meta/report", ACT, insights(dongMeta("23851", "2026-05-20", "120000")));
    await prisma.rawMetaAdsReport.create({
      data: {
        shopId: ACT,
        externalId: "99999:1970-01-01",
        payloadHash: "h-epoch",
        payload: JSON.parse(dongMeta("99999", "1970-01-01", "50000")),
      },
    });

    const w: string[] = [];
    const stats = await dungLai("meta/report", w);

    expect(stats.adsExpensesUpserted).toBe(1);
    expect(stats.skipped).toBe(1);
    expect(w.join(" ")).toMatch(/1970-01-01.*99999.*ngoài khoảng/);
    expect(await prisma.expense.count()).toBe(1);
    expect(await prisma.expense.count({ where: { refId: "META:2026-05-20:23851" } })).toBe(1);
  });

  /**
   * Workflow n8n DỪNG hẳn khi ad account đổi tiền tệ (spend 1.500 USD ghi thành 1.650đ = hụt
   * ~26.000 lần). Lượt dựng lại đọc thẳng kho thô nên phải tự giữ lấy guard đó.
   */
  it("ad account đổi sang USD → bỏ dòng + cảnh báo, tuyệt đối không ghi 1.500 thành 1.650đ", async () => {
    await landRaw("meta/report", ACT, insights(dongMeta("23851", "2026-05-20", "1500", "USD")));

    const w: string[] = [];
    const stats = await dungLai("meta/report", w);

    expect(stats.adsExpensesUpserted).toBe(0);
    expect(stats.skipped).toBe(1);
    expect(w.join(" ")).toMatch(/USD/);
    expect(await prisma.expense.count()).toBe(0);
  });

  it("payload đời cũ không có account_currency → vẫn dựng lại bình thường", async () => {
    await prisma.rawMetaAdsReport.create({
      data: {
        shopId: ACT,
        externalId: "23851:2026-05-20",
        payloadHash: "h",
        payload: { date_start: "2026-05-20", campaign_id: "23851", campaign_name: "Cũ", spend: "120000" },
      },
    });

    const w: string[] = [];
    expect((await dungLai("meta/report", w)).adsExpensesUpserted).toBe(1);
  });
});

describe("dựng lại chi tiêu TikTok từ kho thô", () => {
  it("GMV Max (metrics.cost) → khoá TRẦN, đúng tiền", async () => {
    await landRaw("tiktokbusiness/report", ADV, baoCao(dongGmvMax("1801578870018114", "2026-05-20", "81617")));

    const w: string[] = [];
    const stats = await dungLai("tiktokbusiness/report", w);

    expect(stats.adsExpensesUpserted).toBe(1);
    const exp = await prisma.expense.findUnique({
      where: { refId: "TIKTOK_ADS:2026-05-20:1801578870018114" },
    });
    expect(exp!.amount).toBe(89_779); // round(81.617 × 1,1) — không có hoá đơn ⇒ VAT mặc định 10%
    expect(exp!.channelId).toBe("tiktok");
    expect(exp!.adsSource).toBe("TIKTOK_ADS");
    expect(exp!.description).toBe("KM_Váy kẻ caravat_1106");
  });

  it("auction (metrics.spend) → khoá mang infix `auction:`, KHÔNG đè dòng GMV Max cùng ngày", async () => {
    const ngay = "2026-05-20";
    const campaign = "1801578870018114";
    await landRaw("tiktokbusiness/report", ADV, baoCao(dongGmvMax(campaign, ngay, "81617")));
    await landRaw("tiktokbusiness/report", ADV, baoCao(dongAuction(campaign, ngay, "50000")));

    const w: string[] = [];
    const stats = await dungLai("tiktokbusiness/report", w);

    expect(stats.adsExpensesUpserted).toBe(2); // 2 loại chiến dịch = 2 khoản chi khác nhau
    const auction = await prisma.expense.findUnique({
      where: { refId: `TIKTOK_ADS:auction:${ngay}:${campaign}` },
    });
    expect(auction!.amount).toBe(55_000);
    expect(auction!.description).toBe("Auction_Ao thun");
    const gmvMax = await prisma.expense.findUnique({ where: { refId: `TIKTOK_ADS:${ngay}:${campaign}` } });
    expect(gmvMax!.amount).toBe(89_779);
  });

  /**
   * Loại chiến dịch suy từ metric nào CÓ MẶT, nên hai node `keoReport` của n8n buộc phải xin hai bộ
   * metric rời nhau. Ngày nào ai đó thêm `cost` vào node auction, dòng raw có cả hai và không còn
   * biết thuộc loại nào — phải kêu, không được im lặng chọn auction rồi ghi sai khoá.
   */
  it("payload có CẢ metrics.spend lẫn metrics.cost → bỏ dòng + cảnh báo, không tự đoán loại", async () => {
    await landRaw(
      "tiktokbusiness/report",
      ADV,
      baoCao(
        `{"metrics":{"spend":"50000","cost":"81617","campaign_name":"Lẫn lộn"},` +
          `"dimensions":{"campaign_id":"C9","stat_time_day":"2026-05-20 00:00:00"}}`
      )
    );

    const w: string[] = [];
    const stats = await dungLai("tiktokbusiness/report", w);

    expect(stats.adsExpensesUpserted).toBe(0);
    expect(stats.skipped).toBe(1);
    expect(w.join(" ")).toMatch(/CẢ metrics\.spend lẫn metrics\.cost/);
    expect(await prisma.expense.count()).toBe(0);
  });

  it("2 tài khoản quảng cáo trùng (chiến dịch, ngày) → giữ dòng đầu + cảnh báo, không im lặng ghi đè", async () => {
    const body = baoCao(dongGmvMax("1801578870018114", "2026-05-20", "81617"));
    await landRaw("tiktokbusiness/report", ADV, body);
    await landRaw("tiktokbusiness/report", "7529815666497536001", body);

    const w: string[] = [];
    const stats = await dungLai("tiktokbusiness/report", w);

    expect(stats.adsExpensesUpserted).toBe(1);
    expect(stats.skipped).toBe(1);
    expect(w.join(" ")).toContain("TIKTOK_ADS:2026-05-20:1801578870018114");
  });
});

describe("VAT quảng cáo TikTok đo từ hoá đơn trong kho thô", () => {
  it("tháng CÓ hoá đơn → dùng đúng tỉ lệ đo được, không dùng mặc định", async () => {
    // Hoá đơn tháng 5: 100.000 + 8.000 ⇒ 8%, khác hẳn mặc định 10% nên phân biệt được nguồn số.
    await landRaw("tiktokbusiness/invoice", BC, hoaDon("TX1", "2026-05-18 10:00:00", 100_000, 8_000));
    await landRaw("tiktokbusiness/report", ADV, baoCao(dongGmvMax("C1", "2026-05-20", "100000")));

    const w: string[] = [];
    await dungLai("tiktokbusiness/report", w);

    const exp = await prisma.expense.findUnique({ where: { refId: "TIKTOK_ADS:2026-05-20:C1" } });
    expect(exp!.amount).toBe(108_000);
  });

  it("tháng KHÔNG có hoá đơn → fallback 10% (hoá đơn chỉ phủ một quãng, chi tiêu trải dài hơn)", async () => {
    await landRaw("tiktokbusiness/invoice", BC, hoaDon("TX1", "2026-05-18 10:00:00", 100_000, 8_000));
    await landRaw("tiktokbusiness/report", ADV, baoCao(dongGmvMax("C2", "2026-01-15", "100000")));

    const w: string[] = [];
    await dungLai("tiktokbusiness/report", w);

    const exp = await prisma.expense.findUnique({ where: { refId: "TIKTOK_ADS:2026-01-15:C2" } });
    expect(exp!.amount).toBe(110_000);
  });

  it("tỉ lệ VAT vô lý → KHÔNG ghi chi tiêu tháng đó + cảnh báo", async () => {
    await landRaw("tiktokbusiness/invoice", BC, hoaDon("TX9", "2026-05-18 10:00:00", 100_000, 90_000));
    await landRaw("tiktokbusiness/report", ADV, baoCao(dongGmvMax("C3", "2026-05-20", "100000")));

    const w: string[] = [];
    const stats = await dungLai("tiktokbusiness/report", w);

    expect(stats.adsExpensesUpserted).toBe(0);
    expect(stats.skipped).toBe(1);
    expect(w.join(" ")).toMatch(/VAT quảng cáo TikTok tháng 2026-05/);
    expect(await prisma.expense.count()).toBe(0);
  });

  /**
   * Hoá đơn TikTok xuất theo NGƯỠNG nên trễ và lệch tháng — đo prod tháng 2026-07 chỉ có ĐÚNG 1 hoá
   * đơn. Bỏ trắng cả tháng chi tiêu vì một hoá đơn loại lạ là mất chi phí THẬT, tệ hơn hẳn việc
   * dùng mặc định 10% kèm cảnh báo to.
   */
  it("tháng có hoá đơn nhưng không dòng nào khớp BILL|PAYMENT → vẫn dựng lại bằng VAT mặc định + cảnh báo", async () => {
    await landRaw(
      "tiktokbusiness/invoice",
      BC,
      hoaDon("TX7", "2026-05-18 10:00:00", 100_000, 10_000, "LOAI_LA_HOAC_MOI")
    );
    await landRaw("tiktokbusiness/report", ADV, baoCao(dongGmvMax("C4", "2026-05-20", "100000")));

    const w: string[] = [];
    const stats = await dungLai("tiktokbusiness/report", w);

    expect(stats.adsExpensesUpserted).toBe(1);
    const exp = await prisma.expense.findUnique({ where: { refId: "TIKTOK_ADS:2026-05-20:C4" } });
    expect(exp!.amount).toBe(110_000);
    expect(w.join(" ")).toMatch(/không dòng nào khớp loại BILL\|PAYMENT/);
  });
});

describe("dòng chi tiêu 0đ", () => {
  it("chưa có dòng nào → KHÔNG đẻ dòng chi phí 0đ", async () => {
    await landRaw("tiktokbusiness/report", ADV, baoCao(dongGmvMax("C0", "2026-05-20", "0")));

    const w: string[] = [];
    const stats = await dungLai("tiktokbusiness/report", w);

    expect(stats.adsExpensesUpserted).toBe(0);
    expect(await prisma.expense.count()).toBe(0);
  });

  it("chiến dịch từng có chi tiêu, nay báo cáo trả 0 → HẠ dòng cũ về 0", async () => {
    await landRaw("tiktokbusiness/report", ADV, baoCao(dongGmvMax("C0", "2026-05-20", "81617")));
    const w: string[] = [];
    await dungLai("tiktokbusiness/report", w);

    await landRaw("tiktokbusiness/report", ADV, baoCao(dongGmvMax("C0", "2026-05-20", "0")));
    await dungLai("tiktokbusiness/report", w);

    const exp = await prisma.expense.findUnique({ where: { refId: "TIKTOK_ADS:2026-05-20:C0" } });
    expect(exp!.amount).toBe(0);
  });
});

describe("khoá refId sinh từ kho thô khớp khoá /api/ingest/ads", () => {
  it("n8n đẩy trước rồi dựng lại từ kho thô → vẫn ĐÚNG 1 dòng cho mỗi khoản chi", async () => {
    const rows = [
      { date: "2026-05-20", campaignId: "1801578870018114", campaignName: "KM", spendExVat: 81_617, vatRate: 0.1, adType: "gmv_max" },
      { date: "2026-05-20", campaignId: "1801578870018114", campaignName: "Auction", spendExVat: 50_000, vatRate: 0.1, adType: "auction" },
    ];
    expect((await adsPost(req({ source: "TIKTOK_ADS", rows }))).status).toBe(200);
    const res = await adsPost(
      req({
        source: "META",
        rows: [{ date: "2026-05-20", campaignId: "23851", campaignName: "Ao vay be gai", spendExVat: 120_000, vatRate: 0.1 }],
      }),
    );
    expect(res.status).toBe(200);
    expect(await prisma.expense.count()).toBe(3);

    await landRaw("tiktokbusiness/report", ADV, baoCao(dongGmvMax("1801578870018114", "2026-05-20", "81617")));
    await landRaw("tiktokbusiness/report", ADV, baoCao(dongAuction("1801578870018114", "2026-05-20", "50000")));
    await landRaw("meta/report", ACT, insights(dongMeta("23851", "2026-05-20", "120000")));

    const w: string[] = [];
    await dungLai("tiktokbusiness/report", w);
    await dungLai("meta/report", w);

    // Khoá lệch dù chỉ một ký tự là thành 6 dòng — chi phí quảng cáo đếm 2 lần.
    expect(await prisma.expense.count()).toBe(3);
    const tong = await prisma.expense.aggregate({ _sum: { amount: true } });
    expect(tong._sum.amount).toBe(89_779 + 55_000 + 132_000);
  });
});

/**
 * Chi phí quảng cáo chỉ được ghi bởi ĐÚNG hai đường: `/api/ingest/ads` mỗi đêm, và lượt dựng lại có
 * chủ đích. Trang báo cáo mà n8n land vào kho thô KHÔNG được tự ghi sổ: nó dùng tỉ lệ VAT gộp theo
 * THÁNG, còn lượt POST chính thức dùng tỉ lệ đo trên cửa sổ 7 ngày — đêm nào lượt POST hỏng (mạng
 * chập / app restart lúc deploy) thì số tiền đã bị ghi bằng thuật toán khác mà không ai biết.
 */
describe("chỉ lượt dựng lại mới được ghi sổ chi phí", () => {
  it("n8n land trang báo cáo qua /api/ingest/raw → kho thô có bản gốc, sổ chi phí đứng yên", async () => {
    const res = await rawPost(
      new Request("http://t/api/ingest/raw", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({
          stream: "meta/report",
          shopId: ACT,
          payload: insights(dongMeta("23851", "2026-05-20", "120000")),
        }),
      })
    );

    expect(res.status).toBe(200);
    expect(await prisma.rawMetaAdsReport.count()).toBe(1);
    expect(await prisma.expense.count()).toBe(0);
  });

  it("gọi transform kèm externalIds (đường ingest) mà thiếu cờ dựng lại → không ghi dòng nào", async () => {
    await landRaw("tiktokbusiness/report", ADV, baoCao(dongGmvMax("C1", "2026-05-20", "81617")));

    const w: string[] = [];
    const stats = await transformFromRaw("tiktokbusiness/report", w, {
      externalIds: ["C1:2026-05-20"],
    });

    expect(stats.adsExpensesUpserted).toBe(0);
    expect(await prisma.expense.count()).toBe(0);
  });
});

describe("cổng chặn: chi phí nhập tay KHÔNG bị chạm", () => {
  it("chi phí nhập tay giữ nguyên sau lượt dựng lại", async () => {
    const tay = await prisma.expense.create({
      data: {
        date: new Date("2026-05-20T00:00:00+07:00"),
        categoryId: "ads",
        description: "Thuê KOC quay video",
        amount: 3_000_000,
        source: "MANUAL",
      },
    });
    await landRaw("meta/report", ACT, insights(dongMeta("23851", "2026-05-20", "120000")));
    await landRaw("tiktokbusiness/report", ADV, baoCao(dongGmvMax("C1", "2026-05-20", "81617")));

    const w: string[] = [];
    await dungLai("meta/report", w);
    await dungLai("tiktokbusiness/report", w);

    const sau = await prisma.expense.findUnique({ where: { id: tay.id } });
    expect(sau).toEqual(tay); // không đổi một field nào
  });

  it("dòng nhập tay lỡ mang đúng refId của ads → giữ nguyên + cảnh báo, tuyệt đối không ghi đè", async () => {
    const tay = await prisma.expense.create({
      data: {
        date: new Date("2026-05-20T00:00:00+07:00"),
        categoryId: "ads",
        description: "Ghi tay nhầm khoá",
        amount: 3_000_000,
        source: "MANUAL",
        refId: "META:2026-05-20:23851",
      },
    });
    await landRaw("meta/report", ACT, insights(dongMeta("23851", "2026-05-20", "120000")));

    const w: string[] = [];
    const stats = await dungLai("meta/report", w);

    expect(stats.adsExpensesUpserted).toBe(0);
    // Bỏ CÓ CHỦ ĐÍCH (chi phí nhập tay được ưu tiên tuyệt đối), KHÔNG phải record kẹt: `skipped`
    // là điều kiện hạ cờ backlog, nhét ca này vào đó là cờ dính vĩnh viễn sau MỘT lần gõ trùng khoá.
    expect(stats.boQuaCoChuDich).toBe(1);
    expect(stats.skipped).toBe(0);
    expect(w.join(" ")).toContain("META:2026-05-20:23851");
    expect(await prisma.expense.findUnique({ where: { id: tay.id } })).toEqual(tay);
    expect(await prisma.expense.count()).toBe(1);
  });

  /**
   * Chủ shop import file ads ở chế độ GHI ĐÈ = cố ý XOÁ số API của ngày đó và thay bằng số trong
   * file (`ads-import.ts`). Dựng lại mà tạo lại dòng API là bày CẢ HAI lên sổ ⇒ chi phí ngày đó
   * đếm 2 lần, lãi ròng tụt trong im lặng. Chủ shop đã ra quyết định — lượt máy không được lật.
   */
  it("ngày chủ shop đã ghi đè bằng file → dựng lại KHÔNG tạo lại dòng API + cảnh báo", async () => {
    // 1. n8n đẩy số API cho 2026-05-20 (dòng ADS_API).
    const res = await adsPost(
      req({
        source: "META",
        rows: [{ date: "2026-05-20", campaignId: "23851", campaignName: "Ao vay be gai", spendExVat: 120_000, vatRate: 0.1 }],
      })
    );
    expect(res.status).toBe(200);
    expect(await prisma.expense.count({ where: { source: "ADS_API" } })).toBe(1);

    // 2. Chủ shop import file cho ĐÚNG ngày đó, chọn ghi đè → xoá dòng API, thay bằng dòng IMPORT.
    const csv = "Ngày,Tên chiến dịch,Số tiền đã chi tiêu (VND)\n2026-05-20,Số theo file,90000\n";
    const fd = new FormData();
    fd.set("file", new Blob([csv]), "ads.csv");
    fd.set("preset", "META");
    fd.set("channelId", "facebook");
    fd.set("conflictMode", "overwrite");
    const nhap = await importAdsExpenses(fd);
    expect(nhap.ok).toBe(true);
    expect(await prisma.expense.count({ where: { source: "ADS_API" } })).toBe(0);

    // 3. Kho thô vẫn còn bản gốc báo cáo của ngày đó — lượt dựng lại phải TÔN TRỌNG quyết định trên.
    await landRaw("meta/report", ACT, insights(dongMeta("23851", "2026-05-20", "120000")));
    const w: string[] = [];
    const stats = await dungLai("meta/report", w);

    expect(stats.adsExpensesUpserted).toBe(0);
    // Kết cục ĐÚNG Ý chủ shop ⇒ `boQuaCoChuDich`, KHÔNG phải `skipped`. Chỉ cần import ghi đè MỘT
    // lần mà đếm vào `skipped` là mọi lượt dựng lại về sau đều "còn record kẹt" ⇒ cờ backlog không
    // bao giờ hạ được nữa.
    expect(stats.boQuaCoChuDich).toBe(1);
    expect(stats.skipped).toBe(0);
    expect(w.join(" ")).toMatch(/đã được ghi đè bằng file import/);

    const rows = await prisma.expense.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("IMPORT");
    expect(rows[0].amount).toBe(90_000);
  });

  it("lượt ingest đêm cũng không lật quyết định ghi đè bằng file của chủ shop", async () => {
    const csv = "Ngày,Tên chiến dịch,Số tiền đã chi tiêu (VND)\n2026-05-20,Số theo file,90000\n";
    const fd = new FormData();
    fd.set("file", new Blob([csv]), "ads.csv");
    fd.set("preset", "META");
    fd.set("channelId", "facebook");
    fd.set("conflictMode", "overwrite");
    expect((await importAdsExpenses(fd)).ok).toBe(true);

    const res = await adsPost(
      req({
        source: "META",
        rows: [{ date: "2026-05-20", campaignId: "23851", campaignName: "Ao vay be gai", spendExVat: 120_000, vatRate: 0.1 }],
      })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      stats: { rowsUpserted: number; rowsSkipped: number; rowsBoQuaCoChuDich: number };
    };
    expect(json.stats.rowsUpserted).toBe(0);
    // `rowsSkipped` GIỮ nghĩa cũ = MỌI dòng gửi lên mà không vào sổ — n8n/nhật ký đọc số này để biết
    // "chưa ghi đủ", thu hẹp lại là mất tín hiệu. Phần bỏ đúng ý chủ shop tách ra ở field riêng.
    expect(json.stats.rowsSkipped).toBe(1);
    expect(json.stats.rowsBoQuaCoChuDich).toBe(1);

    const rows = await prisma.expense.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("IMPORT");
  });

  /**
   * Lượt dựng lại ghi bằng client thường, ngoài mọi transaction: cặp "hỏi ngày này đã ghi đè bằng
   * file chưa" + "tạo dòng" nằm ở 2 câu lệnh rời. Transaction dưới đây mô phỏng ĐÚNG thứ tự của
   * `importAdsExpenses` (giành khoá → ghi dòng IMPORT → commit ở cuối) và giữ mở thêm 400ms; lượt
   * dựng lại chạy chen vào giữa. Không đi qua khoá thì nó không thấy dòng IMPORT chưa commit ⇒ tạo
   * lại dòng ADS_API ⇒ ngày đó 2 dòng ⇒ P&L trừ chi phí ads 2 lần.
   */
  it("import đang mở transaction, lượt dựng lại chen vào → ngày đó vẫn chỉ 1 dòng chi phí", async () => {
    await landRaw("meta/report", ACT, insights(dongMeta("23851", "2026-05-20", "120000")));

    let daGhiDongImport!: () => void;
    const dongImportDaGhi = new Promise<void>((r) => (daGhiDongImport = r));
    const nhapFile = prisma.$transaction(
      async (tx) => {
        await giuKhoaGhiChiTieuAds(tx);
        await tx.expense.create({
          data: {
            date: new Date("2026-05-20T00:00:00+07:00"),
            categoryId: "ads",
            adsSource: "META",
            description: "Số theo file",
            channelId: "facebook",
            amount: 90_000,
            source: "IMPORT",
          },
        });
        daGhiDongImport(); // đã ghi, CHƯA commit — mốc để lượt dựng lại bắt đầu
        await new Promise((r) => setTimeout(r, 400));
      },
      { timeout: 30_000 }
    );

    await dongImportDaGhi; // không dùng sleep đoán: chờ đúng trạng thái "đã ghi, chưa commit"
    const w: string[] = [];
    const stats = await dungLai("meta/report", w);
    await nhapFile;

    expect(stats.adsExpensesUpserted).toBe(0);
    expect(stats.boQuaCoChuDich).toBe(1);
    expect(stats.skipped).toBe(0);
    expect(w.join(" ")).toMatch(/đã được ghi đè bằng file import/);

    const rows = await prisma.expense.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("IMPORT");
    expect(rows[0].amount).toBe(90_000);
  });
});
