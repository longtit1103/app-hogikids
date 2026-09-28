import { beforeEach, describe, expect, it } from "vitest";

import { landRaw } from "@/lib/bronze/land-raw";
import { prisma } from "@/lib/prisma";

/**
 * Meta (Facebook) Marketing API — envelope `{data:[...], paging:{cursors:{after}}}`.
 * `shopId` = ad account (`act_...`). Dòng insights KHÔNG có `id` ⇒ khoá = (campaign, ngày).
 *
 * ⚠️ `spend` là số CHƯA THUẾ. Meta KHÔNG có API hoá đơn cho tài khoản trả thẻ ⇒ VAT nhân hệ số khai
 * tay, và workflow DỪNG nếu có chi tiêu mà chưa khai (không ghi chi phí sai vào sổ).
 */

const ACT = "act_415299582336742"; // HỘ KINH DOANH HOGI KIDS 2 — VND, giờ VN

/** Envelope THẬT của Graph API insights (level=campaign, time_increment=1). */
const ins = (items: string) =>
  `{"data":[${items}],"paging":{"cursors":{"before":"MAZDZD","after":"MjQZD"}}}`;

const dong = (campaignId: string, ngay: string, spend: string) =>
  `{"spend":"${spend}","campaign_id":"${campaignId}","campaign_name":"Ao vay be gai",` +
  `"account_currency":"VND","date_start":"${ngay}","date_stop":"${ngay}"}`;

beforeEach(async () => {
  await prisma.rawMetaAdsReport.deleteMany();
  await prisma.expense.deleteMany();
});

describe("landRaw — Meta Ads (chi tiêu quảng cáo Facebook)", () => {
  it("khoá tự dựng = campaign_id:ngày (insights không có `id`)", async () => {
    const r = await landRaw(
      "meta/report",
      ACT,
      ins(`${dong("23851", "2026-05-20", "120000")},${dong("23851", "2026-05-21", "95000")}`)
    );

    expect(r.landed).toBe(2);
    expect([...r.landedIds].sort()).toEqual(["23851:2026-05-20", "23851:2026-05-21"]);

    const row = await prisma.rawMetaAdsReport.findFirst();
    expect(row?.shopId).toBe(ACT); // shopId = ad account
  });

  it("kéo lại cùng ngày → dedupe, KHÔNG nhân bản chi phí", async () => {
    const body = ins(dong("23851", "2026-05-20", "120000"));

    await landRaw("meta/report", ACT, body);
    const r2 = await landRaw("meta/report", ACT, body);

    expect(r2.landed).toBe(0);
    expect(await prisma.rawMetaAdsReport.count()).toBe(1);
  });

  // Meta chỉnh spend hồi tố vài ngày → cùng khoá, khác nội dung ⇒ giữ CẢ HAI bản (có lịch sử).
  it("Meta chỉnh spend hồi tố → land bản mới, giữ bản cũ", async () => {
    await landRaw("meta/report", ACT, ins(dong("23851", "2026-05-20", "120000")));
    const r2 = await landRaw("meta/report", ACT, ins(dong("23851", "2026-05-20", "118500")));

    expect(r2.landed).toBe(1);
    expect(await prisma.rawMetaAdsReport.count()).toBe(2);
  });

  it("Meta trả lỗi (token chết — không có mảng data) → THROW, không land trang rỗng giả", async () => {
    await expect(
      landRaw(
        "meta/report",
        ACT,
        `{"error":{"message":"Error validating access token","type":"OAuthException","code":190}}`
      )
    ).rejects.toThrow(/data/);

    expect(await prisma.rawMetaAdsReport.count()).toBe(0);
  });

  it("kỳ không có chi tiêu (data rỗng) → land 0 dòng, KHÔNG throw", async () => {
    const r = await landRaw("meta/report", ACT, `{"data":[],"paging":{}}`);

    expect(r.landed).toBe(0);
    expect(r.skippedNoId).toBe(0);
  });
});

describe("landRaw — Meta: chỉ ghi kho thô, KHÔNG đụng sổ chi phí", () => {
  /**
   * Chi tiêu ads vào P&L đi qua `/api/ingest/ads`; kho thô chỉ giữ bản gốc để DỰNG LẠI khi cần
   * (nhánh đó nằm ở `transformFromRaw` và đòi cờ `rebuild` — xem `ads-expense-transform.test.ts`).
   * Land mà tự ghi `Expense` là chi phí quảng cáo được ghi 2 lần bằng 2 tỉ lệ VAT khác nhau.
   */
  it("land 1 trang insights → có dòng kho thô, KHÔNG có dòng chi phí nào", async () => {
    await landRaw("meta/report", ACT, ins(dong("23851", "2026-05-20", "120000")));

    expect(await prisma.rawMetaAdsReport.count()).toBe(1);
    expect(await prisma.expense.count()).toBe(0);
  });
});
