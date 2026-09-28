import { beforeEach, describe, expect, it } from "vitest";

import { landRaw } from "@/lib/bronze/land-raw";
import { prisma } from "@/lib/prisma";

/**
 * TikTok Business (chi tiêu quảng cáo) — envelope `{code, message, data:{list:[...], page_info}}`.
 *
 * KHÁC MỌI STREAM KHÁC: dòng báo cáo KHÔNG có `id`. Khoá tự dựng = `<campaign_id>:<ngày>` — khoá tự
 * nhiên vì một chiến dịch một ngày đúng một dòng chi tiêu. Sai khoá ⇒ dedupe hỏng ⇒ kéo lại là nhân
 * bản dòng, và chi phí quảng cáo trong báo cáo phình lên.
 *
 * `shopId` của stream này = **advertiser_id** (không phải shop).
 */

const ADV = "7129548444015902722"; // tài khoản "Hogikids" — cái duy nhất đang tiêu tiền
const ADV_KHAC = "7529815666497536001"; // "Hogikids 2"

/** Envelope THẬT của TikTok Business report. `campaign_id` là CHUỖI (đã kiểm trên API thật). */
const rpt = (items: string) => `{"code":0,"message":"OK","data":{"list":[${items}],"page_info":{"total_page":1}}}`;

const dong = (campaignId: string, ngay: string, cost: number) =>
  `{"dimensions":{"campaign_id":"${campaignId}","stat_time_day":"${ngay} 00:00:00"},` +
  `"metrics":{"campaign_name":"GMV Max - Ao vay","cost":${cost}}}`;

beforeEach(async () => {
  await prisma.rawTiktokBusinessReport.deleteMany();
  await prisma.rawTiktokBusinessInvoice.deleteMany();
  await prisma.expense.deleteMany();
});

/** Hoá đơn THẬT (Business Center): `amount` = `subtotal` + `tax_amount` (VAT 10%). */
const BC = "7129545797879726081";
const hoaDon = (txId: string, subtotal: number, thue: number) =>
  `{"code":0,"message":"OK","data":{"transaction_list":[{"transaction_id":"${txId}",` +
  `"transaction_type":"BILL_PAYMENT","account_id":"7129548444015902722","bc_id":"${BC}",` +
  `"subtotal":${subtotal},"tax_amount":${thue},"amount":${subtotal + thue},"currency":"VND",` +
  `"invoice_id":"7657322667854365458","create_time":"2026-06-16 15:02:54"}],"page_info":{"total_page":1}}}`;

describe("landRaw — TikTok Business (chi tiêu quảng cáo)", () => {
  it("khoá tự dựng = campaign_id:ngày (báo cáo ads không có `id`)", async () => {
    const r = await landRaw(
      "tiktokbusiness/report",
      ADV,
      rpt(`${dong("1864314018521233", "2026-05-20", 81617)},${dong("1864314018521233", "2026-05-21", 96406)}`)
    );

    expect(r.landed).toBe(2);
    expect([...r.landedIds].sort()).toEqual(["1864314018521233:2026-05-20", "1864314018521233:2026-05-21"]);

    const rows = await prisma.rawTiktokBusinessReport.findMany({ orderBy: { externalId: "asc" } });
    expect(rows[0].shopId).toBe(ADV); // shopId = advertiser_id
  });

  it("kéo lại cùng ngày → dedupe, KHÔNG nhân bản chi phí", async () => {
    const body = rpt(dong("1864314018521233", "2026-05-20", 81617));

    const r1 = await landRaw("tiktokbusiness/report", ADV, body);
    const r2 = await landRaw("tiktokbusiness/report", ADV, body);

    expect(r1.landed).toBe(1);
    expect(r2.landed).toBe(0);
    expect(await prisma.rawTiktokBusinessReport.count()).toBe(1);
  });

  // TikTok chỉnh spend hồi tố vài ngày → cùng khoá, khác nội dung ⇒ phải giữ CẢ HAI bản (có lịch sử).
  it("TikTok chỉnh spend hồi tố → land bản mới, giữ bản cũ", async () => {
    await landRaw("tiktokbusiness/report", ADV, rpt(dong("1864314018521233", "2026-05-20", 81617)));
    const r2 = await landRaw("tiktokbusiness/report", ADV, rpt(dong("1864314018521233", "2026-05-20", 79000)));

    expect(r2.landed).toBe(1);
    expect(await prisma.rawTiktokBusinessReport.count()).toBe(2);
  });

  // Cùng chiến dịch + cùng ngày nhưng KHÁC tài khoản quảng cáo là 2 dòng chi phí khác nhau.
  it("2 advertiser khác nhau → 2 dòng riêng (không đè nhau)", async () => {
    const body = rpt(dong("1864314018521233", "2026-05-20", 81617));

    await landRaw("tiktokbusiness/report", ADV, body);
    await landRaw("tiktokbusiness/report", ADV_KHAC, body);

    expect(await prisma.rawTiktokBusinessReport.count()).toBe(2);
  });

  it("advertiser_id LẠ vẫn land được (chủ shop tự tạo tài khoản mới — không được chặn)", async () => {
    const r = await landRaw("tiktokbusiness/report", "9999999999999999999", rpt(dong("1", "2026-05-20", 1000)));

    expect(r.landed).toBe(1);
  });

  it("advertiser_id RỖNG → THROW (không biết chi tiêu của tài khoản nào)", async () => {
    await expect(
      landRaw("tiktokbusiness/report", "  ", rpt(dong("1", "2026-05-20", 1000)))
    ).rejects.toThrow(/shopId rỗng/);
  });

  it("TikTok trả lỗi (code != 0, không có data.list) → THROW, không land trang rỗng giả", async () => {
    await expect(
      landRaw("tiktokbusiness/report", ADV, `{"code":40105,"message":"access token is invalid"}`)
    ).rejects.toThrow(/data\.list/);

    expect(await prisma.rawTiktokBusinessReport.count()).toBe(0);
  });

  it("dòng thiếu campaign_id → bị bỏ nhưng ĐƯỢC ĐẾM, không im lặng", async () => {
    const r = await landRaw(
      "tiktokbusiness/report",
      ADV,
      rpt(`${dong("1864314018521233", "2026-05-20", 81617)},{"dimensions":{"stat_time_day":"2026-05-21 00:00:00"},"metrics":{"cost":100}}`)
    );

    expect(r.landed).toBe(1);
    expect(r.skippedNoId).toBe(1);
  });
});

describe("landRaw — hoá đơn quảng cáo TikTok (số THỰC TRẢ, gồm VAT)", () => {
  /**
   * `cost` trong report ads là số CHƯA THUẾ ⇒ ghi P&L theo report là thiếu 10% chi phí.
   * Hoá đơn là nguồn số THỰC TRẢ: 130.000 + 13.000 = 143.000 — đúng bằng khoản GMV Pay mà TikTok
   * Shop trừ vào số dư bán hàng.
   */
  it("land hoá đơn, khoá = transaction_id, giữ đủ subtotal/tax/amount", async () => {
    const r = await landRaw("tiktokbusiness/invoice", BC, hoaDon("7657315630890860807", 130_000, 13_000));

    expect(r.landed).toBe(1);
    expect(r.landedIds).toEqual(["7657315630890860807"]);

    const row = await prisma.rawTiktokBusinessInvoice.findFirst();
    const p = row?.payload as { subtotal?: number; tax_amount?: number; amount?: number };
    expect(p.subtotal).toBe(130_000);
    expect(p.tax_amount).toBe(13_000);
    expect(p.amount).toBe(143_000); // = khoản GMV Pay TikTok Shop trừ vào số dư
    expect(row?.shopId).toBe(BC); // shopId = bc_id (Business Center), KHÔNG phải advertiser
  });

  it("kéo lại cùng hoá đơn → dedupe", async () => {
    const body = hoaDon("7657315630890860807", 130_000, 13_000);
    await landRaw("tiktokbusiness/invoice", BC, body);
    const r2 = await landRaw("tiktokbusiness/invoice", BC, body);

    expect(r2.landed).toBe(0);
    expect(await prisma.rawTiktokBusinessInvoice.count()).toBe(1);
  });
});

describe("landRaw — TikTok Business: chỉ ghi kho thô, KHÔNG đụng sổ chi phí", () => {
  /**
   * Chi tiêu ads vào P&L đi qua `/api/ingest/ads`; kho thô chỉ giữ bản gốc để DỰNG LẠI khi cần
   * (nhánh đó nằm ở `transformFromRaw` và đòi cờ `rebuild` — xem `ads-expense-transform.test.ts`).
   * Land mà tự ghi `Expense` là chi phí quảng cáo được ghi 2 lần bằng 2 tỉ lệ VAT khác nhau.
   */
  it("land 1 trang báo cáo → có dòng kho thô, KHÔNG có dòng chi phí nào", async () => {
    await landRaw("tiktokbusiness/report", ADV, rpt(dong("1864314018521233", "2026-05-20", 81617)));

    expect(await prisma.rawTiktokBusinessReport.count()).toBe(1);
    expect(await prisma.expense.count()).toBe(0);
  });
});
