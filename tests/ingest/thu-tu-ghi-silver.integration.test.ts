import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { demDaHachToan } from "@/lib/bronze/doi-soat-hach-toan";
import { landRaw } from "@/lib/bronze/land-raw";
import { transformFromRaw } from "@/lib/bronze/transform-from-raw";
import { mapPancakeOrder } from "@/lib/ingest/pancake-mapping";
import { upsertOneOrder, type UpsertStats } from "@/lib/ingest/pancake-upsert";
import { prisma } from "@/lib/prisma";

import { SHOP_TIKTOK } from "../helpers/shop-ids-fixture";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * LUẬT THỨ TỰ GHI SILVER — bản ghi CŨ không được đè bản MỚI.
 *
 * Bối cảnh: bước dựng Silver cố ý nằm NGOÀI khoá land (giữ khoá suốt cả bước upsert thì mọi webhook
 * sau phải xếp hàng chờ). Nên hai lượt dựng Silver của CÙNG một đơn có thể ghi ngược thứ tự: lượt
 * đọc bản mới bị hệ điều hành cho ngủ, lượt đọc bản cũ ghi sau và thắng. Hậu quả đúng bằng lỗi mà
 * khoá land vừa bịt: phí sàn THẬT bị số tạm đè, đơn RETURNED lùi về PENDING rồi được tính lại vào
 * doanh thu (phá bất biến #1).
 *
 * `Order.rawFetchedAt` là số phiên bản, và điều kiện so sánh nằm TRONG câu UPDATE nên an toàn cả
 * khi hai lượt chạy song song.
 */
const MOC_CU = new Date("2026-07-01T10:00:00+07:00");
const MOC_MOI = new Date("2026-07-01T10:05:00+07:00");

/** Đơn TikTok: `fee` và `status` là hai thứ ca lỗi thật từng làm sai (phí tạm đè phí thật). */
const DON = (id: string, fee: number, status: number, updatedAt = "2026-07-01T05:00:00.000000") => ({
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

function statsRong(): UpsertStats {
  return {
    ordersUpserted: 0,
    productsUpserted: 0,
    variantsUpserted: 0,
    ordersSkippedMirror: 0,
    ordersSkippedStale: 0,
      ordersDiscardedGiuaChung: 0,
    skipped: 0,
    boQuaCoChuDich: 0,
    unknownStatusOrders: 0,
    settlementsUpserted: 0,
    adsUpserted: 0,
    paymentsUpserted: 0,
    shopeeUpserted: 0,
    adsExpensesUpserted: 0,
  };
}

async function ghi(
  id: string,
  fee: number,
  status: number,
  moc?: Date,
  updatedAt?: string
): Promise<{ stats: UpsertStats }> {
  const raw = DON(id, fee, status, updatedAt);
  const stats = statsRong();
  await upsertOneOrder(mapPancakeOrder(raw as never, { channels: {} }), raw, stats, [], moc);
  return { stats };
}

const docDon = (id: string) =>
  prisma.order.findUnique({
    where: { pancakeId: id },
    select: { platformFeeEst: true, status: true, rawFetchedAt: true },
  });

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
});

describe("thứ tự ghi Silver theo mốc nguồn", () => {
  it("bản CŨ tới sau KHÔNG đè bản mới — phí sàn thật giữ nguyên", async () => {
    await ghi("D-1", 5_839, 4, MOC_MOI); // bản THẬT (đã đối soát)
    const { stats } = await ghi("D-1", 16_000, 3, MOC_CU); // bản TẠM tới muộn

    const don = await docDon("D-1");
    expect(don?.platformFeeEst).toBe(5_839);
    expect(stats.ordersUpserted).toBe(0);
    // Bộ đếm RIÊNG, KHÔNG phải `skipped`: `skipped` nghĩa là "mất dòng thật" và bị hai cổng đối
    // soát coi là phải-kêu; nhét ca đúng-ý vào đó sẽ bật cờ backlog + tô đỏ panel oan.
    expect(stats.ordersSkippedStale).toBe(1);
    expect(stats.skipped).toBe(0);
  });

  it("đơn RETURNED không bị bản cũ kéo về trạng thái tính doanh thu", async () => {
    await ghi("D-2", 5_000, 4, MOC_MOI); // 4 = RETURNED (bị loại khỏi doanh thu)
    await ghi("D-2", 5_000, 3, MOC_CU);

    expect((await docDon("D-2"))?.status).toBe("RETURNED");
  });

  it("bản MỚI vẫn đè bản cũ như thường", async () => {
    await ghi("D-3", 16_000, 3, MOC_CU);
    const { stats } = await ghi("D-3", 5_839, 4, MOC_MOI);

    const don = await docDon("D-3");
    expect(don?.platformFeeEst).toBe(5_839);
    expect(don?.rawFetchedAt?.getTime()).toBe(MOC_MOI.getTime());
    expect(stats.ordersUpserted).toBe(1);
  });

  it("cùng mốc vẫn ghi (land lại đúng bản đó — không được kẹt)", async () => {
    await ghi("D-4", 16_000, 3, MOC_MOI);
    const { stats } = await ghi("D-4", 7_000, 3, MOC_MOI);

    expect((await docDon("D-4"))?.platformFeeEst).toBe(7_000);
    expect(stats.ordersUpserted).toBe(1);
  });

  it("đơn CŨ chưa có mốc (dữ liệu trước khi thêm cột) vẫn được ghi đè — tự lành dần", async () => {
    await ghi("D-5", 16_000, 3); // không mốc ⇒ rawFetchedAt = null
    expect((await docDon("D-5"))?.rawFetchedAt).toBeNull();

    await ghi("D-5", 5_839, 4, MOC_CU);
    const don = await docDon("D-5");
    expect(don?.platformFeeEst).toBe(5_839);
    expect(don?.rawFetchedAt?.getTime()).toBe(MOC_CU.getTime());
  });

  it("hai lượt ghi CHẠY SONG SONG: bản mới luôn thắng, bất kể ai xong trước", async () => {
    await Promise.all([ghi("D-6", 16_000, 3, MOC_CU), ghi("D-6", 5_839, 4, MOC_MOI)]);

    const don = await docDon("D-6");
    expect(don?.platformFeeEst).toBe(5_839);
    expect(don?.rawFetchedAt?.getTime()).toBe(MOC_MOI.getTime());
  });

  it("hai lượt cùng TẠO một đơn CHƯA có: không lượt nào bị bỏ với lỗi trùng khoá", async () => {
    // Ca hồi quy: đổi `upsert` (một câu INSERT … ON CONFLICT, nguyên tử) sang updateMany+create làm
    // hai lượt song song cùng thấy "chưa có" rồi cùng INSERT ⇒ lượt sau dính P2002. Nếu lượt thua
    // cầm bản MỚI thì Silver giữ số cũ (phí tạm đè phí thật) — đúng thứ bất biến #1 phải chặn.
    const canhBao: string[] = [];
    const chay = async (fee: number, status: number, moc: Date) => {
      const raw = DON("D-8", fee, status);
      const stats = statsRong();
      await upsertOneOrder(mapPancakeOrder(raw as never, { channels: {} }), raw, stats, canhBao, moc);
      return stats;
    };
    const [s1, s2] = await Promise.all([chay(16_000, 3, MOC_CU), chay(5_839, 4, MOC_MOI)]);

    expect(canhBao.filter((c) => c.includes("Bỏ qua đơn"))).toEqual([]);
    // Đúng một lượt ghi được, lượt kia hoặc cũng ghi (nếu chạy nối tiếp) hoặc bị từ chối vì cũ hơn —
    // KHÔNG bao giờ rơi vào `skipped` (nghĩa "mất dòng").
    expect(s1.skipped + s2.skipped).toBe(0);
    expect(s1.ordersUpserted + s2.ordersUpserted).toBeGreaterThanOrEqual(1);

    // Dù ai xong trước, BẢN MỚI phải là bản còn lại.
    const don = await docDon("D-8");
    expect(don?.platformFeeEst).toBe(5_839);
    expect(don?.status).toBe("RETURNED");
  });

  it("bỏ qua vì cũ hơn VẪN được tính là đã hạch toán (không bật cờ backlog oan)", async () => {
    // Hai cổng đối soát (`/api/ingest/raw`, webhook) so `đã land` với `đã hạch toán`; thiếu bộ đếm
    // này thì mỗi lần hai lượt dựng Silver chạy so le sẽ bật cờ backlog + tô đỏ panel, dù dữ liệu
    // hoàn toàn đúng. Cờ đó chỉ hạ được bằng lượt rebuild toàn bảng — mà lượt ấy kéo tồn kho lùi.
    await ghi("D-9", 5_839, 4, MOC_MOI);
    const { stats } = await ghi("D-9", 16_000, 3, MOC_CU);

    const daHachToan = demDaHachToan(stats);
    expect(daHachToan).toBe(1); // 1 đơn land → 1 đơn hạch toán ⇒ không kêu
  });

  it("dòng hàng trong đơn không bị nhân đôi khi ghi lại nhiều lần", async () => {
    await ghi("D-7", 16_000, 3, MOC_CU);
    await ghi("D-7", 5_839, 3, MOC_MOI);

    const don = await prisma.order.findUnique({
      where: { pancakeId: "D-7" },
      select: { items: { select: { id: true } } },
    });
    expect(don?.items).toHaveLength(1);
  });
});

/**
 * THỨ TỰ THEO `updated_at` (mốc NỘI DUNG Pancake) — xếp TRƯỚC mốc land.
 *
 * Ca thật: trang API (lịch kéo, "Đồng bộ ngay") CHỤP trước một sự kiện webhook nhưng POST tới sau
 * ⇒ land muộn hơn ⇒ nếu chỉ so mốc land thì bản cũ thắng, Silver lùi (RETURNED → COMPLETED, đơn
 * quay lại doanh thu) cho tới lượt API kế tiếp. `updated_at` naive là giờ UTC (bất biến #3).
 */
const T1 = "2026-07-01T05:00:00.000000";
const T2 = "2026-07-01T06:30:00.123456";

describe("thứ tự ghi Silver theo updated_at của Pancake", () => {
  it("webhook T2 rồi trang API T1 (land SAU) ⇒ Silver giữ T2, đếm SUPERSEDED", async () => {
    await ghi("U-1", 5_839, 4, MOC_CU, T2); // webhook: RETURNED, phí thật
    const { stats } = await ghi("U-1", 16_000, 3, MOC_MOI, T1); // trang API chụp trước, tới sau

    const don = await docDon("U-1");
    expect(don?.status).toBe("RETURNED");
    expect(don?.platformFeeEst).toBe(5_839);
    expect(don?.rawFetchedAt?.getTime()).toBe(MOC_CU.getTime());
    expect(stats.ordersUpserted).toBe(0);
    expect(stats.ordersSkippedStale).toBe(1);
    expect(stats.skipped).toBe(0);
    expect(demDaHachToan(stats)).toBe(1); // bỏ qua đúng ý ⇒ không bật backlog oan
  });

  it("T1 rồi T2 ⇒ T2 (đường bình thường không đổi)", async () => {
    await ghi("U-2", 16_000, 3, MOC_CU, T1);
    const { stats } = await ghi("U-2", 5_839, 4, MOC_MOI, T2);

    expect((await docDon("U-2"))?.platformFeeEst).toBe(5_839);
    expect(stats.ordersUpserted).toBe(1);
  });

  it("dựng Silver SO LE: bản T1 land muộn dựng trước, bản T2 land sớm dựng sau ⇒ T2 vẫn thắng", async () => {
    await ghi("U-3", 16_000, 3, MOC_MOI, T1);
    const { stats } = await ghi("U-3", 5_839, 4, MOC_CU, T2);

    const don = await docDon("U-3");
    expect(don?.status).toBe("RETURNED");
    expect(don?.rawFetchedAt?.getTime()).toBe(MOC_CU.getTime());
    expect(stats.ordersUpserted).toBe(1);
  });

  it("cùng updated_at, mốc land mới hơn ⇒ ghi (Pancake đối soát phí mà giữ nguyên mốc)", async () => {
    await ghi("U-4", 16_000, 3, MOC_CU, T2);
    const { stats } = await ghi("U-4", 5_839, 3, MOC_MOI, T2);

    expect((await docDon("U-4"))?.platformFeeEst).toBe(5_839);
    expect(stats.ordersUpserted).toBe(1);
  });

  it("cùng updated_at, mốc land cũ hơn ⇒ luật mốc land cũ vẫn chặn", async () => {
    await ghi("U-5", 5_839, 3, MOC_MOI, T2);
    const { stats } = await ghi("U-5", 16_000, 3, MOC_CU, T2);

    expect((await docDon("U-5"))?.platformFeeEst).toBe(5_839);
    expect(stats.ordersSkippedStale).toBe(1);
  });

  it("dựng lại đúng bản đang giữ (cùng updated_at + cùng mốc land) ⇒ ghi, idempotent", async () => {
    await ghi("U-6", 5_839, 4, MOC_CU, T2);
    const { stats } = await ghi("U-6", 5_839, 4, MOC_CU, T2);

    expect(stats.ordersUpserted).toBe(1);
    expect(await prisma.orderItem.count({ where: { order: { pancakeId: "U-6" } } })).toBe(1);
  });

  it("separator khác (khoảng trắng vs T) vẫn so theo thời điểm, không so chuỗi", async () => {
    await ghi("U-7", 5_839, 4, MOC_CU, "2026-07-01 06:30:00");
    // Chuỗi "2026-07-01T05:00:00" > "2026-07-01 06:30:00" nếu so theo ký tự — so chuỗi là đè nhầm.
    const { stats } = await ghi("U-7", 16_000, 3, MOC_MOI, "2026-07-01T05:00:00");

    expect((await docDon("U-7"))?.status).toBe("RETURNED");
    expect(stats.ordersSkippedStale).toBe(1);
  });

  it("updated_at SAI khuôn ⇒ giữ luật mốc land cũ + cảnh báo nêu rõ không so được", async () => {
    await ghi("U-8", 5_839, 4, MOC_CU, T2);
    const raw = DON("U-8", 16_000, 3, "01/07/2026 05:00");
    const stats = statsRong();
    const canhBao: string[] = [];
    await upsertOneOrder(mapPancakeOrder(raw as never, { channels: {} }), raw, stats, canhBao, MOC_MOI);

    expect((await docDon("U-8"))?.platformFeeEst).toBe(16_000); // mốc land mới hơn ⇒ ghi như cũ
    expect(canhBao.some((c) => c.includes("U-8") && c.includes("không so được updated_at"))).toBe(true);
  });

  it("KHÔNG truyền mốc nguồn ⇒ ghi vô điều kiện như hợp đồng cũ, kể cả updated_at cũ hơn", async () => {
    await ghi("U-9", 5_839, 4, MOC_CU, T2);
    const { stats } = await ghi("U-9", 16_000, 3, undefined, T1);

    expect((await docDon("U-9"))?.platformFeeEst).toBe(16_000);
    expect(stats.ordersUpserted).toBe(1);
  });
});

/**
 * Đường THẬT qua kho thô: land Bronze rồi dựng Silver — đúng chuỗi `/api/ingest/raw` chạy cho mỗi
 * trang. Bronze VẪN land bản cũ (append-only, không bỏ raw); chỉ Silver không lùi, và dòng Bronze
 * bị bỏ qua mang kết cục SUPERSEDED (đã hạch toán — lượt đối soát đêm không nhặt lại).
 */
describe("trang API cũ land sau webhook mới — qua landRaw + transformFromRaw", () => {
  const ID = "585229755054261999";
  const trang = (fee: number, status: number, updatedAt: string) =>
    JSON.stringify({ success: true, data: [DON(ID, fee, status, updatedAt)] });

  beforeEach(async () => {
    await prisma.rawPancakeOrder.deleteMany();
  });

  it("Silver giữ bản T2, Bronze giữ cả hai dòng, dòng T1 đóng dấu SUPERSEDED", async () => {
    const w1: string[] = [];
    const l1 = await landRaw("orders", SHOP_TIKTOK, trang(5_839, 4, T2));
    await transformFromRaw("orders", w1, { externalIds: l1.landedIds, shopId: SHOP_TIKTOK });

    const w2: string[] = [];
    const l2 = await landRaw("orders", SHOP_TIKTOK, trang(16_000, 3, T1));
    expect(l2.landed).toBe(1); // Bronze KHÔNG bỏ raw
    const t = await transformFromRaw("orders", w2, { externalIds: l2.landedIds, shopId: SHOP_TIKTOK });

    const don = await prisma.order.findUniqueOrThrow({ where: { pancakeId: ID } });
    expect(don.status).toBe("RETURNED");
    expect(don.platformFeeEst).toBe(5_839);
    expect(t.ordersSkippedStale).toBe(1);
    expect(demDaHachToan(t)).toBe(1);
    expect(await prisma.rawPancakeOrder.count({ where: { externalId: ID } })).toBe(2);
    const moiNhat = await prisma.rawPancakeOrder.findFirstOrThrow({
      where: { externalId: ID },
      orderBy: [{ fetchedAt: "desc" }, { id: "desc" }],
    });
    expect(moiNhat.silverOutcome).toBe("SUPERSEDED");
  });
});

/**
 * Precondition `chanKhiCoDonKhacCungKenhMa` — chống đếm đôi cho script bù đơn.
 *
 * Check phải nằm TRONG chính transaction ghi: script bù chụp danh sách "đã có" một lần ở đầu lượt,
 * còn sync/webhook chạy song song có thể chen đơn gốc vào giữa chừng — check ngoài transaction là
 * hai bước rời, đơn gốc lọt khe là doanh thu Shopee đếm đôi. Đường sync/webhook KHÔNG truyền cờ
 * này nên hành vi của chúng không đổi.
 */
/** Mô phỏng đúng đường gọi của script bù: ghi đè `code` về mã đơn gốc + truyền cờ chặn. */
async function ghiVoiChan(id: string, code: string): Promise<{ stats: UpsertStats; warnings: string[] }> {
  const raw = DON(id, 0, 3);
  const stats = statsRong();
  const warnings: string[] = [];
  const mo = mapPancakeOrder(raw as never, { channels: {} });
  mo.code = code;
  await upsertOneOrder(mo, raw, stats, warnings, undefined, {
    backfilledFromMirror: true,
    chanKhiCoDonKhacCungKenhMa: true,
  });
  return { stats, warnings };
}

describe("upsertOneOrder — chanKhiCoDonKhacCungKenhMa", () => {

  it("đơn KHÁC cùng (kênh, mã) đã tồn tại → CHẶN ghi, đếm boQuaCoChuDich + warning nêu cả hai id", async () => {
    await ghi("GOC-88", 16_000, 3); // đơn gốc (code = system_id = GOC-88, kênh tiktok)

    const { stats, warnings } = await ghiVoiChan("AF-BU-88", "GOC-88");

    expect(await prisma.order.findUnique({ where: { pancakeId: "AF-BU-88" } })).toBeNull();
    expect(stats.boQuaCoChuDich).toBe(1);
    expect(stats.ordersUpserted).toBe(0);
    expect(warnings.some((w) => w.includes("AF-BU-88") && w.includes("GOC-88"))).toBe(true);
  });

  it("chỉ có CHÍNH NÓ từ lượt trước (cùng pancakeId) → vẫn upsert idempotent, không tự chặn mình", async () => {
    await ghiVoiChan("AF-BU-99", "MA-99");
    const { stats } = await ghiVoiChan("AF-BU-99", "MA-99");

    expect(stats.ordersUpserted).toBe(1);
    expect(stats.boQuaCoChuDich).toBe(0);
    expect(await prisma.order.count({ where: { code: "MA-99" } })).toBe(1);
  });

  it("KHÔNG truyền cờ → đường sync/webhook ghi như cũ dù trùng (kênh, mã)", async () => {
    await ghi("GOC-77", 16_000, 3);
    const raw = DON("KHAC-77", 0, 3);
    const stats = statsRong();
    const mo = mapPancakeOrder(raw as never, { channels: {} });
    mo.code = "GOC-77";
    await upsertOneOrder(mo, raw, stats, []);

    expect(stats.ordersUpserted).toBe(1); // mã Pancake không duy nhất — sync không được phép chặn
  });
});

/**
 * KHOÁ (kênh, mã) trong transaction upsert — tái dựng ĐÚNG kịch bản đua đã tái hiện được trước
 * khi có khoá: transaction bù đọc "chưa có" → ingest commit đơn gốc → đơn bù vẫn commit ⇒ 2 đơn
 * cùng (kênh, mã). Với khoá, lượt bù phải CHỜ transaction đang giữ khoá nhả ra rồi mới kiểm —
 * lúc đó đơn gốc đã thấy được và lượt bù bị chặn.
 */
describe("upsertOneOrder — khoá (kênh, mã) chặn đua ghi đồng thời", () => {
  it("transaction khác giữ khoá + chèn đơn gốc rồi mới nhả → đơn bù bị chặn, không đếm đôi", { timeout: 60_000 }, async () => {
    let moKhoa!: () => void;
    const choMoKhoa = new Promise<void>((r) => (moKhoa = r));
    let daGiu!: () => void;
    const khoaSanSang = new Promise<void>((r) => (daGiu = r));
    // Vai "ingest chen ngang": giữ khoá của (tiktok, MA-RACE) rồi chèn đơn gốc TRONG transaction
    // đang mở — chỉ thấy được từ ngoài sau khi commit (lúc nhả khoá).
    const phienChenNgang = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"don:tiktok|MA-RACE"}, 0))`;
        await tx.order.create({
          data: {
            pancakeId: "GOC-RACE",
            code: "MA-RACE",
            channelId: "tiktok",
            status: "COMPLETED",
            orderedAt: new Date("2026-07-01T10:00:00+07:00"),
            syncedAt: new Date(),
            itemsTotal: 200_000,
          },
        });
        daGiu();
        await choMoKhoa;
      },
      { timeout: 60_000, maxWait: 10_000 }
    );
    await khoaSanSang;

    const luotBu = ghiVoiChan("AF-RACE", "MA-RACE"); // phải đứng chờ ở khoá, KHÔNG được kiểm sớm
    // Nhường thời gian cho lượt bù chạy tới khoá — nếu khoá bị gỡ khỏi upsert, lượt bù sẽ kiểm
    // ngay trong khe này (đơn gốc chưa commit, vô hình ở READ COMMITTED) rồi ghi ⇒ test đỏ.
    await new Promise((r) => setTimeout(r, 300));
    moKhoa();
    await phienChenNgang;

    const { stats } = await luotBu;
    expect(stats.boQuaCoChuDich).toBe(1);
    expect(stats.ordersUpserted).toBe(0);
    expect(await prisma.order.findUnique({ where: { pancakeId: "AF-RACE" } })).toBeNull();
    expect(await prisma.order.count({ where: { channelId: "tiktok", code: "MA-RACE" } })).toBe(1);
  });
});
