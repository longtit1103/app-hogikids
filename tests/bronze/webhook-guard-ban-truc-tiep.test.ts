import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Prisma } from "@/generated/prisma/client";
import { transformFromRaw } from "@/lib/bronze/transform-from-raw";
import { xuLySuKienWebhook } from "@/lib/ingest/webhook-processor";
import { prisma } from "@/lib/prisma";

import { SHOP_SHOPEE, SHOP_TIKTOK } from "../helpers/shop-ids-fixture";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * Guard land webhook với đơn BÁN TRỰC TIẾP (kênh `direct`, CLAUDE.md bất biến #2).
 *
 * Kênh `direct` chỉ được suy khi đủ cả ba dấu: nguồn rỗng + không `marketplace_id` +
 * `received_at_shop = true`. Tiền khách trả tại quầy (`Order.paidAtShop` — Sổ quỹ đọc thẳng cột này)
 * cộng từ `transfer_money`, `cash`, `charged_by_card`, `charged_by_momo`, `charged_by_qrpay`. Webhook
 * mới hơn mà vắng các khoá đó ⇒ mapping ra `website` + `paidAtShop = 0` ⇒ quỹ hụt đúng số tiền quầy,
 * tổng doanh thu không đổi nên không kiểm P&L tổng nào bắt được, và lượt API sau trùng hash nên KHÔNG
 * tự lành. Guard phải nhường bản API trong ca đó.
 *
 * Nhưng nhóm field này CHỈ được soi khi bản đứng đầu là đơn nhận tại shop: đơn sàn không dùng chúng,
 * soi cả đơn sàn mà webhook vắng có hệ thống thì mọi sự kiện Shopee/TikTok đều bị nhường ⇒ đơn hoàn
 * chỉ vào Silver qua lượt API hằng ngày, doanh thu tính thừa tới ~24h.
 */
const MOC_API = "2026-09-25T03:00:00.000000";
const MOC_WEBHOOK = "2026-09-25T04:00:00.000000";

type DonTho = Record<string, unknown>;

/** Đơn bán trực tiếp như API trả: đủ 16 khoá mapping chung + 6 khoá bán trực tiếp. */
const DON_TRUC_TIEP = (id: string, updatedAt: string): DonTho => ({
  id,
  system_id: id,
  status: 3,
  status_name: "delivered",
  inserted_at: "2026-09-25T02:55:19.015402",
  updated_at: updatedAt,
  status_history: [],
  order_sources_name: null,
  marketplace_id: null,
  received_at_shop: true,
  total_price: 559000,
  total_discount: 39000,
  shipping_fee: 0,
  fee_marketplace: 0,
  cod: 0,
  advanced_platform_fee: {},
  customer: { name: "Khách quầy" },
  transfer_money: 520000,
  cash: 0,
  charged_by_card: 0,
  charged_by_momo: 0,
  charged_by_qrpay: 0,
  items: [
    { quantity: 1, discount_each_product: 0, variation_info: { display_id: "SKU-QUAY-A", name: "Áo", retail_price: 440000 } },
    { quantity: 1, discount_each_product: 0, variation_info: { display_id: "SKU-QUAY-B", name: "Quần", retail_price: 119000 } },
  ],
});

/** Đơn Shopee như API trả — API Pancake cũng mang 6 khoá này trên đơn sàn (giá trị 0/false). */
const DON_SHOPEE = (id: string, status: number, updatedAt: string): DonTho => ({
  id,
  system_id: id,
  status,
  status_name: "x",
  inserted_at: "2026-09-25T02:00:00.000000",
  updated_at: updatedAt,
  status_history: [],
  order_sources_name: "Shopee",
  marketplace_id: "-3",
  received_at_shop: false,
  total_price: 200000,
  total_discount: 0,
  shipping_fee: 0,
  fee_marketplace: 15000,
  cod: 0,
  advanced_platform_fee: {},
  customer: { name: "Chị Lan" },
  transfer_money: 0,
  cash: 0,
  charged_by_card: 0,
  charged_by_momo: 0,
  charged_by_qrpay: 0,
  items: [{ quantity: 2, discount_each_product: 0, variation_info: { display_id: "SKU-SP-1", name: "Áo", retail_price: 100000 } }],
});

const bo = (don: DonTho, ...khoa: string[]): DonTho =>
  Object.fromEntries(Object.entries(don).filter(([k]) => !khoa.includes(k)));

/** Land bản API vào Bronze rồi dựng Silver — đúng đường lượt API đi. */
async function landBanApi(shopId: string, don: DonTho): Promise<void> {
  const id = String(don.id);
  await prisma.rawPancakeOrder.create({
    data: {
      shopId,
      externalId: id,
      payloadHash: `api-${id}-${String(don.updated_at)}`,
      payload: don as Prisma.InputJsonValue,
      fetchedAt: new Date(Date.now() - 60_000),
    },
  });
  await transformFromRaw("orders", [], { externalIds: [id], shopId });
}

const suKien = (shopId: string, don: DonTho) =>
  xuLySuKienWebhook({ shopId, payload: JSON.stringify({ type: "orders", ...don }) });

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.rawPancakeOrder.deleteMany();
  // Cờ backlog toàn cục còn bật thì nhánh bị chặn trả "cần xem" thay vì "cũ hơn" — test đo guard.
  await prisma.setting.deleteMany({ where: { key: "bronzeBacklogPending" } });
});

describe("guard webhook — đơn bán trực tiếp", () => {
  it("webhook mới hơn THIẾU received_at_shop + transfer_money ⇒ nhường API, Silver giữ direct + tiền quầy", async () => {
    const id = "ORD-QUAY-THIEU";
    await landBanApi(SHOP_TIKTOK, DON_TRUC_TIEP(id, MOC_API));
    const truoc = await prisma.order.findUniqueOrThrow({ where: { pancakeId: id } });
    expect([truoc.channelId, truoc.paidAtShop]).toEqual(["direct", 520000]);

    const kq = await suKien(SHOP_TIKTOK, bo(DON_TRUC_TIEP(id, MOC_WEBHOOK), "received_at_shop", "transfer_money"));

    expect(kq.processedAs).toBe("don-hang-cu-hon");
    expect(kq.note).toContain("received_at_shop");
    expect(kq.note).toContain("transfer_money");
    expect(await prisma.rawPancakeOrder.count({ where: { externalId: id } })).toBe(1); // KHÔNG land
    const sau = await prisma.order.findUniqueOrThrow({ where: { pancakeId: id } });
    expect(sau.channelId).toBe("direct");
    expect(sau.paidAtShop).toBe(520000);
  });

  it("webhook mới hơn thiếu MỘT khoản thanh toán (charged_by_qrpay) ⇒ vẫn nhường", async () => {
    const id = "ORD-QUAY-THIEU-QR";
    await landBanApi(SHOP_TIKTOK, DON_TRUC_TIEP(id, MOC_API));

    const kq = await suKien(SHOP_TIKTOK, bo(DON_TRUC_TIEP(id, MOC_WEBHOOK), "charged_by_qrpay"));

    expect(kq.processedAs).toBe("don-hang-cu-hon");
    expect(kq.note).toContain("charged_by_qrpay");
    expect(await prisma.rawPancakeOrder.count({ where: { externalId: id } })).toBe(1);
  });

  it("webhook mới hơn mang received_at_shop = null và cash = null ⇒ coi như VẮNG, nhường API", async () => {
    const id = "ORD-QUAY-NULL";
    await landBanApi(SHOP_TIKTOK, DON_TRUC_TIEP(id, MOC_API));

    const kq = await suKien(SHOP_TIKTOK, { ...DON_TRUC_TIEP(id, MOC_WEBHOOK), received_at_shop: null, cash: null });

    expect(kq.processedAs).toBe("don-hang-cu-hon");
    expect(kq.note).toContain("received_at_shop");
    expect(kq.note).toContain("cash");
    expect(await prisma.rawPancakeOrder.count({ where: { externalId: id } })).toBe(1);
    const sau = await prisma.order.findUniqueOrThrow({ where: { pancakeId: id } });
    expect([sau.channelId, sau.paidAtShop]).toEqual(["direct", 520000]);
  });

  it("webhook mới hơn mang ĐỦ 6 khoá ⇒ vẫn land và dựng (guard không chặn oan đơn quầy)", async () => {
    const id = "ORD-QUAY-DU";
    await landBanApi(SHOP_TIKTOK, DON_TRUC_TIEP(id, MOC_API));

    const kq = await suKien(SHOP_TIKTOK, { ...DON_TRUC_TIEP(id, MOC_WEBHOOK), transfer_money: 500000, cash: 20000 });

    expect(kq.processedAs).toBe("don-hang");
    expect(await prisma.rawPancakeOrder.count({ where: { externalId: id } })).toBe(2);
    const sau = await prisma.order.findUniqueOrThrow({ where: { pancakeId: id } });
    expect([sau.channelId, sau.paidAtShop]).toEqual(["direct", 520000]);
  });
});

describe("guard webhook — đơn sàn KHÔNG bị nhóm field bán trực tiếp chặn", () => {
  it("đơn Shopee: webhook mới hơn thiếu charged_by_card ⇒ vẫn land, trạng thái hoàn vào Silver ngay", async () => {
    const id = "ORD-SHOPEE-THIEU-THE";
    await landBanApi(SHOP_SHOPEE, DON_SHOPEE(id, 3, MOC_API));
    expect((await prisma.order.findUniqueOrThrow({ where: { pancakeId: id } })).status).toBe("COMPLETED");

    const kq = await suKien(SHOP_SHOPEE, bo(DON_SHOPEE(id, 4, MOC_WEBHOOK), "charged_by_card"));

    expect(kq.processedAs).toBe("don-hang");
    expect(await prisma.rawPancakeOrder.count({ where: { externalId: id } })).toBe(2);
    const sau = await prisma.order.findUniqueOrThrow({ where: { pancakeId: id } });
    expect(sau.status).toBe("RETURNED");
    expect(sau.channelId).toBe("shopee");
  });

  it("đơn Shopee: webhook vắng CẢ 6 khoá bán trực tiếp ⇒ vẫn land", async () => {
    const id = "ORD-SHOPEE-THIEU-6";
    await landBanApi(SHOP_SHOPEE, DON_SHOPEE(id, 3, MOC_API));

    const kq = await suKien(
      SHOP_SHOPEE,
      bo(DON_SHOPEE(id, 4, MOC_WEBHOOK), "received_at_shop", "transfer_money", "cash", "charged_by_card", "charged_by_momo", "charged_by_qrpay"),
    );

    expect(kq.processedAs).toBe("don-hang");
    expect((await prisma.order.findUniqueOrThrow({ where: { pancakeId: id } })).status).toBe("RETURNED");
  });
});
