import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { gmvMaxTheoSanPham } from "@/lib/reports/marketing/gmv-max-theo-san-pham";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";
import { landFixture } from "./helpers/land-fixture";

/**
 * BẢNG CON "GMV Max theo sản phẩm" (bung từ một dòng chiến dịch).
 *
 * Ba lời khai:
 *  1. `cost` cấp item CHƯA VAT ⇒ quy về GỒM VAT bằng CÙNG hàm `buildVatByMonth` mà đường dựng lại
 *     `Expense` dùng — hai nơi không được ra hai con số cho cùng một khoản. Và phải nhân+làm tròn
 *     THEO TỪNG NGÀY rồi mới cộng (đúng khuôn `prepareAdsExpenseRow`), không nhân vào tổng.
 *  2. Breakdown thiếu ~0,6% so tổng campaign (đo P0) ⇒ dòng "Chưa phân bổ" hiện RIÊNG, không để
 *     người đọc tự trừ và không kéo giãn các dòng item cho khớp.
 *  3. Campaign không có tiền trong sổ ⇒ chưa phân bổ = 0, KHÔNG bịa số âm.
 *
 * BẤT BIẾN #2: số ở đây KHÔNG bao giờ là chi phí P&L — chi phí P&L là dòng sổ `Expense`.
 */

const KY = (tu: string, den: string) => ({
  from: new Date(`${tu}T00:00:00+07:00`),
  to: new Date(`${den}T00:00:00+07:00`),
});
const CAMPAIGN = "1873416520735281";
const ITEM_1 = "1729557518640450219"; // 15/08 cost 592 + 16/08 cost 25
const ITEM_2 = "1729557551540701867"; // 14/08 cost 14

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.rawTiktokBusinessGmvMaxItem.deleteMany();
  await prisma.rawTiktokBusinessInvoice.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Hoá đơn Business Center tháng 08/2026 — nguồn ĐO VAT (không phải hằng khai tay). */
async function seedHoaDon(subtotal: number, tax: number): Promise<void> {
  await prisma.rawTiktokBusinessInvoice.create({
    data: {
      shopId: "7180000000000000001",
      externalId: `hd-${subtotal}-${tax}`,
      payloadHash: `h-${subtotal}-${tax}`,
      payload: {
        transaction_id: `hd-${subtotal}-${tax}`,
        transaction_type: "BILL",
        create_time: "2026-08-10 09:00:00",
        subtotal: String(subtotal),
        tax_amount: String(tax),
        amount: String(subtotal + tax),
      },
    },
  });
}

describe("gmvMaxTheoSanPham", () => {
  it("chi GỒM VAT cộng theo NGÀY, tên SP nối Product.code, dòng Chưa phân bổ = chi sổ − Σ item", async () => {
    await seedHoaDon(100_000, 10_000); // VAT 10%
    await prisma.product.create({
      data: { pancakeId: "p1", code: ITEM_1, name: "Bộ đồ bé gái", syncedAt: new Date() },
    });
    await landFixture("tiktokbusiness/gmvmax_item", "gmvmax-item.json", undefined, "7129548444015902722");

    const r = await gmvMaxTheoSanPham(KY("2026-08-14", "2026-08-16"), { [CAMPAIGN]: 700 });

    const bang = r[CAMPAIGN];
    expect(bang.dong).toHaveLength(2);
    const d1 = bang.dong.find((d) => d.itemGroupId === ITEM_1)!;
    expect(d1.ten).toBe("Bộ đồ bé gái");
    expect(d1.chiChuaVat).toBe(617); // 592 + 25
    // round(592×1,1)=651 + round(25×1,1)=28 — cộng theo NGÀY rồi mới cộng lại (679 ≠ round(617×1,1)=679
    // ở ca này thì bằng nhau, nhưng phép cộng phải giống đường ghi sổ, không giống cho tiện).
    expect(d1.chiGomVat).toBe(679);
    expect(d1.donSan).toBe(0);
    expect(d1.gmvSan).toBe(0);

    const d2 = bang.dong.find((d) => d.itemGroupId === ITEM_2)!;
    expect(d2.ten).toBe(ITEM_2); // không nối được ⇒ id trần, KHÔNG ẩn dòng
    expect(d2.chiChuaVat).toBe(14);
    expect(d2.chiGomVat).toBe(15);

    expect(bang.chuaPhanBoGomVat).toBe(6); // 700 − 679 − 15
  });

  it("cắt kỳ theo stat_time_day", async () => {
    await seedHoaDon(100_000, 10_000);
    await landFixture("tiktokbusiness/gmvmax_item", "gmvmax-item.json", undefined, "7129548444015902722");

    const r = await gmvMaxTheoSanPham(KY("2026-08-15", "2026-08-15"), { [CAMPAIGN]: 700 });

    expect(r[CAMPAIGN].dong).toHaveLength(1);
    expect(r[CAMPAIGN].dong[0].chiGomVat).toBe(651);
    expect(r[CAMPAIGN].chuaPhanBoGomVat).toBe(49); // 700 − 651
  });

  it("campaign không có trong sổ ⇒ chưa phân bổ = 0, không bịa số âm", async () => {
    await seedHoaDon(100_000, 10_000);
    await landFixture("tiktokbusiness/gmvmax_item", "gmvmax-item.json", undefined, "7129548444015902722");

    const r = await gmvMaxTheoSanPham(KY("2026-08-14", "2026-08-16"), {});

    expect(r[CAMPAIGN].dong).toHaveLength(2);
    expect(r[CAMPAIGN].chuaPhanBoGomVat).toBe(0);
  });

  it("VAT lấy từ hoá đơn THẬT của tháng, không phải hằng 10%", async () => {
    await seedHoaDon(100_000, 8_000); // VAT 8%
    await landFixture("tiktokbusiness/gmvmax_item", "gmvmax-item.json", undefined, "7129548444015902722");

    const r = await gmvMaxTheoSanPham(KY("2026-08-14", "2026-08-16"), { [CAMPAIGN]: 700 });

    // round(592×1,08)=639 + round(25×1,08)=27
    expect(r[CAMPAIGN].dong.find((d) => d.itemGroupId === ITEM_1)!.chiGomVat).toBe(666);
    expect(r[CAMPAIGN].dong.find((d) => d.itemGroupId === ITEM_2)!.chiGomVat).toBe(15); // round(14×1,08)
  });

  it("tháng có VAT VÔ LÝ ⇒ bỏ ngày đó khỏi chi gồm VAT, phần đó rơi vào Chưa phân bổ (không về 0,1)", async () => {
    await seedHoaDon(100_000, 50_000); // 50% — ngoài dải 3–20%
    await landFixture("tiktokbusiness/gmvmax_item", "gmvmax-item.json", undefined, "7129548444015902722");

    const r = await gmvMaxTheoSanPham(KY("2026-08-14", "2026-08-16"), { [CAMPAIGN]: 700 });

    expect(r[CAMPAIGN].dong.every((d) => d.chiGomVat === 0)).toBe(true);
    expect(r[CAMPAIGN].dong.find((d) => d.itemGroupId === ITEM_1)!.chiChuaVat).toBe(617);
    expect(r[CAMPAIGN].chuaPhanBoGomVat).toBe(700);
  });

  it("Σ item VƯỢT chi sổ ⇒ Chưa phân bổ ÂM, hiện đúng số âm chứ không kéo giãn dòng item", async () => {
    await seedHoaDon(100_000, 10_000);
    await landFixture("tiktokbusiness/gmvmax_item", "gmvmax-item.json", undefined, "7129548444015902722");

    // Sổ chỉ ghi 100đ cho campaign trong khi breakdown báo 694đ — dấu hiệu sổ hụt/lệch kỳ. Số âm là
    // TÍN HIỆU phải thấy; ép về 0 (hay chia lại cho các dòng item) là xoá đúng cái tín hiệu đó.
    const r = await gmvMaxTheoSanPham(KY("2026-08-14", "2026-08-16"), { [CAMPAIGN]: 100 });

    expect(r[CAMPAIGN].chuaPhanBoGomVat).toBe(-594); // 100 − 679 − 15
    expect(r[CAMPAIGN].dong.find((d) => d.itemGroupId === ITEM_1)!.chiGomVat).toBe(679);
  });

  it("tiền tệ khác VND ⇒ bỏ tiền của dòng đó (không cộng đô-la vào đồng)", async () => {
    await seedHoaDon(100_000, 10_000);
    await prisma.rawTiktokBusinessGmvMaxItem.create({
      data: {
        shopId: "7129548444015902722",
        externalId: `${CAMPAIGN}:${ITEM_2}:2026-08-14`,
        payloadHash: "h-usd",
        // Land SAU bản fixture cùng khoá ⇒ bản này thắng (DISTINCT ON theo fetchedAt).
        fetchedAt: new Date(Date.now() + 60_000),
        payload: {
          dimensions: { campaign_id: CAMPAIGN, item_group_id: ITEM_2, stat_time_day: "2026-08-14 00:00:00" },
          metrics: { cost: "14", currency: "USD", gross_revenue: "100", orders: "2" },
        },
      },
    });
    await landFixture("tiktokbusiness/gmvmax_item", "gmvmax-item.json", undefined, "7129548444015902722");

    const d2 = (await gmvMaxTheoSanPham(KY("2026-08-14", "2026-08-16"), { [CAMPAIGN]: 700 }))[
      CAMPAIGN
    ].dong.find((d) => d.itemGroupId === ITEM_2)!;

    expect(d2.chiChuaVat).toBe(0);
    expect(d2.chiGomVat).toBe(0);
    expect(d2.gmvSan).toBeNull(); // không đọc chắc chắn được ⇒ null, KHÔNG phải 0
    expect(d2.donSan).toBe(2); // `orders` không phải tiền ⇒ vẫn đọc
  });

  it("kỳ không có dòng item nào ⇒ không có bảng con (empty-state của UI, không phải bảng 0đ)", async () => {
    await seedHoaDon(100_000, 10_000);
    await landFixture("tiktokbusiness/gmvmax_item", "gmvmax-item.json", undefined, "7129548444015902722");

    const r = await gmvMaxTheoSanPham(KY("2026-08-20", "2026-08-21"), { [CAMPAIGN]: 700 });

    expect(r[CAMPAIGN]).toBeUndefined();
  });
});
