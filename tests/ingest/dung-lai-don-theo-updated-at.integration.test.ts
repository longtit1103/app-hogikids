import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Prisma } from "@/generated/prisma/client";
import { transformFromRaw } from "@/lib/bronze/transform-from-raw";
import { latestPayloads } from "@/lib/bronze/transform-raw-helpers";
import { prisma } from "@/lib/prisma";

import { SHOP_TIKTOK } from "../helpers/shop-ids-fixture";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * DỰNG LẠI ĐƠN TỪ KHO THÔ — bản thắng xếp theo `updated_at` Pancake trước, `fetchedAt` sau.
 *
 * Ca thật: sự kiện webhook mang nội dung MỚI (T2) land trước, rồi một trang API CHỤP TRƯỚC đó (T1)
 * POST tới sau ⇒ dòng T1 có `fetchedAt` mới hơn. Khi Silver RỖNG (DR) mà dựng lại theo `fetchedAt`
 * thì guard ở upsert không có bản nào để so ⇒ T1 thắng, đơn RETURNED quay lại COMPLETED, phí thật
 * tụt về số tạm — và không tự lành vì lượt API kế tiếp trùng hash nên không land lại.
 *
 * Dòng Bronze chèn thẳng (không qua `landRaw`) để ĐẶT ĐƯỢC `fetchedAt` — chính thứ tự land là biến
 * của bài toán. `updated_at` naive là giờ UTC (bất biến #3).
 */
const MOC_LAND_SOM = new Date("2026-07-01T10:00:00+07:00");
const MOC_LAND_MUON = new Date("2026-07-01T10:05:00+07:00");
const T1 = "2026-07-01T05:00:00.000000";
const T2 = "2026-07-01T06:30:00.123456";

/** Đơn TikTok tối giản đủ map — `fee` + `status` là hai thứ ca lỗi thật từng làm sai. */
const DON = (id: string, fee: number, status: number, updatedAt: string) => ({
  id,
  system_id: id,
  status,
  status_name: "x",
  inserted_at: "2026-07-01T03:00:00.000000",
  updated_at: updatedAt,
  status_history: [],
  order_sources_name: "Tiktok",
  marketplace_id: "-9",
  total_price: 200000,
  total_discount: 0,
  shipping_fee: 0,
  fee_marketplace: fee,
  advanced_platform_fee: { payment_fee: 0 },
  customer: { name: "Chị Hoa" },
  items: [
    {
      quantity: 2,
      discount_each_product: 0,
      variation_info: { display_id: "SKU-TT-1", name: "Áo thun", retail_price: 100000 },
    },
  ],
});

let soHash = 0;
async function chen(externalId: string, payload: Prisma.InputJsonValue, fetchedAt: Date): Promise<string> {
  const r = await prisma.rawPancakeOrder.create({
    data: { shopId: SHOP_TIKTOK, externalId, payloadHash: `h-${++soHash}`, payload, fetchedAt },
    select: { id: true },
  });
  return r.id;
}

const ketCuc = async (id: string) =>
  (await prisma.rawPancakeOrder.findUniqueOrThrow({ where: { id }, select: { silverOutcome: true } }))
    .silverOutcome;

/** Bản thắng của mỗi đơn khi QUÉT CẢ BẢNG — đánh dấu bằng field `v` trong payload. */
async function banThang(): Promise<Record<string, string>> {
  const rows = await latestPayloads("RawPancakeOrder", {});
  return Object.fromEntries(rows.map((r) => [r.externalId, (r.payload as { v: string }).v]));
}

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.rawPancakeOrder.deleteMany();
});

describe("dựng lại đơn từ kho thô — bản thắng theo updated_at rồi fetchedAt", () => {
  it("Silver RỖNG, webhook T2 land sớm + trang API T1 land muộn ⇒ dựng ra T2", async () => {
    const ID = "585229755054262001";
    const dongT2 = await chen(ID, DON(ID, 5_839, 4, T2), MOC_LAND_SOM); // webhook: RETURNED, phí thật
    const dongT1 = await chen(ID, DON(ID, 16_000, 3, T1), MOC_LAND_MUON); // trang API chụp trước

    const t = await transformFromRaw("orders", []);

    const don = await prisma.order.findUniqueOrThrow({ where: { pancakeId: ID } });
    expect(don.status).toBe("RETURNED");
    expect(don.platformFeeEst).toBe(5_839);
    expect(don.rawFetchedAt?.getTime()).toBe(MOC_LAND_SOM.getTime());
    expect(t.ordersUpserted).toBe(1);
    expect(await ketCuc(dongT2)).toBe("APPLIED");
    // Dòng T1 nằm DƯỚI bản đứng đầu theo thứ tự phiên bản chung ⇒ đóng SUPERSEDED ngay lượt này.
    expect(await ketCuc(dongT1)).toBe("SUPERSEDED");

    // Đường theo từng đơn (ingest trang / đối soát đêm) chọn CÙNG bản T2 ⇒ ghi lại idempotent,
    // Silver không lùi, T1 giữ dấu, không báo kẹt.
    const dem = await transformFromRaw("orders", [], { externalIds: [ID], shopId: SHOP_TIKTOK });
    expect(dem.ordersUpserted).toBe(1);
    expect(dem.ordersSkippedStale).toBe(0);
    expect(await ketCuc(dongT1)).toBe("SUPERSEDED");
    expect((await prisma.order.findUniqueOrThrow({ where: { pancakeId: ID } })).status).toBe("RETURNED");
  });

  it("dựng lại lần nữa (sau sửa mapping) GHI LẠI bản T2 chứ không bị trang T1 chặn", async () => {
    const ID = "585229755054262002";
    await chen(ID, DON(ID, 5_839, 4, T2), MOC_LAND_SOM);
    await chen(ID, DON(ID, 16_000, 3, T1), MOC_LAND_MUON);
    await transformFromRaw("orders", []);

    const lan2 = await transformFromRaw("orders", []);

    // Chọn theo `fetchedAt` thì lượt này cầm T1 ⇒ CU_HON ⇒ bỏ qua: mapping mới không bao giờ áp
    // lên đơn tới lượt API kế tiếp.
    expect(lan2.ordersUpserted).toBe(1);
    expect(lan2.ordersSkippedStale).toBe(0);
    expect((await prisma.order.findUniqueOrThrow({ where: { pancakeId: ID } })).platformFeeEst).toBe(5_839);
  });

  it("cùng updated_at (khác separator + phần micro-giây) ⇒ bản land MUỘN thắng như cũ", async () => {
    const ID = "585229755054262003";
    // Cùng mili-giây .123 — Pancake có sửa phí lúc đối soát mà giữ nguyên `updated_at` (đo 27/07).
    await chen(ID, DON(ID, 16_000, 3, "2026-07-01T06:30:00.123456"), MOC_LAND_SOM);
    await chen(ID, DON(ID, 5_839, 4, "2026-07-01 06:30:00.123"), MOC_LAND_MUON);

    await transformFromRaw("orders", []);

    const don = await prisma.order.findUniqueOrThrow({ where: { pancakeId: ID } });
    expect(don.platformFeeEst).toBe(5_839);
    expect(don.rawFetchedAt?.getTime()).toBe(MOC_LAND_MUON.getTime());
  });

  it("so THỜI ĐIỂM, không so chuỗi: naive = UTC, đuôi +07:00 quy đổi đúng", async () => {
    // "07:00:00" naive = 07:00Z (MỚI hơn); "13:00:00+07:00" = 06:00Z. So chuỗi thì "13" > "07";
    // hiểu naive là giờ VN thì 07:00 VN = 00:00Z — cả hai cách sai đều chọn bản land muộn.
    await chen("TZ", { id: "TZ", updated_at: "2026-07-01T07:00:00", v: "moi" }, MOC_LAND_SOM);
    await chen("TZ", { id: "TZ", updated_at: "2026-07-01T13:00:00+07:00", v: "cu" }, MOC_LAND_MUON);

    expect((await banThang()).TZ).toBe("moi");
  });

  it("thiếu / sai khuôn updated_at ⇒ xếp SAU dòng có mốc; giữa chúng vẫn luật fetchedAt; câu không nổ", async () => {
    await chen("THIEU-1", { id: "THIEU-1", updated_at: T1, v: "co-moc" }, MOC_LAND_SOM);
    await chen("THIEU-1", { id: "THIEU-1", v: "khong-moc" }, MOC_LAND_MUON);
    await chen("THIEU-2", { id: "THIEU-2", v: "som" }, MOC_LAND_SOM);
    await chen("THIEU-2", { id: "THIEU-2", v: "muon" }, MOC_LAND_MUON);
    // Ngày không có thật: ép kiểu thẳng sẽ NÉM và làm hỏng cả lượt dựng lại vì một dòng.
    await chen("SAI-1", { id: "SAI-1", updated_at: T1, v: "hop-le" }, MOC_LAND_SOM);
    await chen("SAI-1", { id: "SAI-1", updated_at: "2026-02-31T10:00:00", v: "ngay-ao" }, MOC_LAND_MUON);
    await chen("SAI-2", { id: "SAI-2", updated_at: T1, v: "hop-le" }, MOC_LAND_SOM);
    await chen("SAI-2", { id: "SAI-2", updated_at: "hôm qua", v: "rac" }, MOC_LAND_MUON);

    expect(await banThang()).toEqual({
      "THIEU-1": "co-moc",
      "THIEU-2": "muon",
      "SAI-1": "hop-le",
      "SAI-2": "hop-le",
    });
  });

  it("đường theo TỪNG ĐƠN (externalIds) dùng CÙNG thứ tự với quét cả bảng", async () => {
    await chen("TUNG-DON", { id: "TUNG-DON", updated_at: T2, v: "T2" }, MOC_LAND_SOM);
    await chen("TUNG-DON", { id: "TUNG-DON", updated_at: T1, v: "T1" }, MOC_LAND_MUON);

    const [row] = await latestPayloads("RawPancakeOrder", { externalIds: ["TUNG-DON"], shopId: SHOP_TIKTOK });
    expect((row?.payload as { v: string }).v).toBe("T2");
    expect((await banThang())["TUNG-DON"]).toBe("T2");
  });
});
