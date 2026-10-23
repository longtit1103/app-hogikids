import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

import { POST } from "@/app/api/ingest/raw/route";
import type { Prisma } from "@/generated/prisma/client";
import { doiSoatDonConDo } from "@/lib/bronze/doi-soat-don-con-do";
import {
  demCanXem,
  dongDauKetCuc,
  dongDauKetCucBoiLuotTay,
  dsDonCanXem,
  KET_CUC,
  ketCucHienTaiCuaDon,
  locDonChuaDongDau,
  locDonQuaHanChuaDongDau,
} from "@/lib/bronze/ket-cuc-silver";
import { transformFromRaw } from "@/lib/bronze/transform-from-raw";
import { latestPayloads } from "@/lib/bronze/transform-raw-helpers";
import { prisma } from "@/lib/prisma";

import { SHOP_TIKTOK } from "../helpers/shop-ids-fixture";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * MỘT THỨ TỰ PHIÊN BẢN cho đơn Pancake: đường dựng Silver (`latestPayloads`, mọi đường) và sổ kết cục
 * (`ket-cuc-silver.ts`) cùng xếp `mốc updated_at DESC NULLS LAST, fetchedAt DESC, id DESC`.
 *
 * Ca gốc: sự kiện webhook mang nội dung MỚI (T2) land trước, trang API CHỤP TRƯỚC đó (T1) POST tới sau ⇒
 * dòng T1 có `fetchedAt` mới hơn mà nội dung cũ hơn. Hai thứ tự lệch nhau thì hoặc đường theo từng đơn
 * dựng T1 khi Silver chưa có đơn, hoặc dòng T1 không bao giờ được đóng dấu và đối soát đêm thử lại nó tới
 * `FAILED_RETRY_LIMIT` (báo đơn kẹt giả). `updated_at` naive là giờ UTC (bất biến #3).
 */
const T1 = "2026-07-01T05:00:00.000000";
const T2 = "2026-07-01T06:30:00.123456";

/** Đơn TikTok tối giản đủ map — `fee` + `status` là hai thứ ca lỗi thật từng làm sai. */
const DON = (id: string, fee: number, status: number, updatedAt?: string) => ({
  id,
  system_id: id,
  status,
  status_name: "x",
  inserted_at: "2026-07-01T03:00:00.000000",
  ...(updatedAt === undefined ? {} : { updated_at: updatedAt }),
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
/** Chèn thẳng dòng Bronze để ĐẶT ĐƯỢC `fetchedAt` — chính thứ tự land là biến của bài toán. */
async function chen(
  externalId: string,
  payload: Prisma.InputJsonValue,
  fetchedAt: Date,
  silverOutcome: string | null = null
): Promise<string> {
  const r = await prisma.rawPancakeOrder.create({
    data: { shopId: SHOP_TIKTOK, externalId, payloadHash: `h-tt-${++soHash}`, payload, fetchedAt, silverOutcome },
    select: { id: true },
  });
  return r.id;
}

const dong = (id: string) =>
  prisma.rawPancakeOrder.findUniqueOrThrow({
    where: { id },
    select: { silverOutcome: true, silverAttempts: true },
  });

/** Trang API như n8n gửi — đi ĐÚNG đường theo từng trang của `/api/ingest/raw`. */
const goiTrang = (don: object) =>
  POST(
    new Request("http://localhost/api/ingest/raw", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({
        stream: "orders",
        shopId: SHOP_TIKTOK,
        payload: JSON.stringify({ success: true, data: [don] }),
      }),
    })
  );

/** Lùi MỌI `fetchedAt` cùng một khoảng (giữ nguyên thứ tự land) để lượt đối soát đêm chịu nhặt. */
const lui1Ngay = () =>
  prisma.$executeRaw`UPDATE "RawPancakeOrder" SET "fetchedAt" = "fetchedAt" - interval '1 day'`;

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.rawPancakeOrder.deleteMany();
  await prisma.setting.deleteMany({ where: { key: "bronzeBacklogPending" } });
});

describe("đường theo TỪNG ĐƠN dùng chung thứ tự phiên bản với sổ kết cục", () => {
  it("Silver rỗng, T2 land sớm (dựng hỏng) rồi trang API T1 land muộn ⇒ dựng T2, T1 SUPERSEDED ngay lượt đó", async () => {
    const ID = "585229755054263001";
    // Webhook T2 đã land nhưng transform của nó chết (dòng ở "chưa xong", Silver chưa có đơn).
    const dongT2 = await chen(ID, DON(ID, 5_839, 4, T2), new Date(Date.now() - 10 * 60_000));

    const json = await (await goiTrang(DON(ID, 16_000, 3, T1))).json();

    expect(json.ok).toBe(true);
    expect(json.stats.landed).toBe(1);
    expect(json.stats.ordersUpserted).toBe(1);
    // Không bật cổng "đã land vs đã hạch toán" oan.
    expect(json.stats.warnings.some((w: string) => w.includes("hạch toán"))).toBe(false);
    const don = await prisma.order.findUniqueOrThrow({ where: { pancakeId: ID } });
    expect(don.status).toBe("RETURNED");
    expect(don.platformFeeEst).toBe(5_839);

    const dongT1 = await prisma.rawPancakeOrder.findFirstOrThrow({
      where: { externalId: ID, NOT: { id: dongT2 } },
      select: { id: true },
    });
    expect((await dong(dongT2)).silverOutcome).toBe(KET_CUC.APPLIED);
    expect((await dong(dongT1.id)).silverOutcome).toBe(KET_CUC.SUPERSEDED);
  });

  it("đối soát đêm sau đó KHÔNG thử lại T1 — không đơn dở, không tăng lượt thử", async () => {
    const ID = "585229755054263002";
    const dongT2 = await chen(ID, DON(ID, 5_839, 4, T2), new Date(Date.now() - 10 * 60_000));
    await goiTrang(DON(ID, 16_000, 3, T1));
    await lui1Ngay();

    expect(await locDonChuaDongDau(SHOP_TIKTOK, [ID])).toEqual([]);
    expect(await locDonQuaHanChuaDongDau(0, 100)).toEqual([]);

    const kq = await doiSoatDonConDo([]);

    expect(kq.pendingTotal).toBe(0);
    expect(kq.banCuDaDong).toBe(0); // đã đóng ngay ở lượt trang, không còn gì cho lượt quét
    expect(kq.applied + kq.superseded + kq.failedShape + kq.failedRetryLimit).toBe(0);
    for (const r of await prisma.rawPancakeOrder.findMany({ where: { externalId: ID } })) {
      expect(r.silverAttempts).toBe(0);
    }
    expect((await dong(dongT2)).silverOutcome).toBe(KET_CUC.APPLIED);
  });

  it("dòng T1 còn ở NULL từ trước (dữ liệu cũ) ⇒ đối soát đêm đóng SUPERSEDED bằng SQL, KHÔNG dựng lại", async () => {
    const ID = "585229755054263003";
    const dongT2 = await chen(ID, DON(ID, 5_839, 4, T2), new Date(Date.now() - 2 * 86_400_000), KET_CUC.APPLIED);
    const dongT1 = await chen(ID, DON(ID, 16_000, 3, T1), new Date(Date.now() - 86_400_000));

    // Bản đứng đầu là T2 (đã APPLIED) ⇒ không có đơn dở, dù T1 land muộn hơn và còn NULL.
    expect(await locDonQuaHanChuaDongDau(0, 100)).toEqual([]);
    expect(await ketCucHienTaiCuaDon([{ shopId: SHOP_TIKTOK, externalId: ID }])).toEqual([
      { shopId: SHOP_TIKTOK, externalId: ID, silverOutcome: KET_CUC.APPLIED },
    ]);

    const kq = await doiSoatDonConDo([]);

    expect(kq.banCuDaDong).toBe(1);
    expect(kq.pendingTotal).toBe(0);
    expect(await dong(dongT1)).toEqual({ silverOutcome: KET_CUC.SUPERSEDED, silverAttempts: 0 });
    expect((await dong(dongT2)).silverOutcome).toBe(KET_CUC.APPLIED);
    expect(await prisma.order.count()).toBe(0); // chỉ đóng dấu, không dựng
  });

  it("updated_at bằng nhau ⇒ bản land muộn thắng; dựng lại lần hai ghi lại CÙNG dòng (idempotent)", async () => {
    const ID = "585229755054263004";
    // Cùng mili-giây .123 (khác separator + micro-giây) — Pancake sửa phí lúc đối soát mà giữ mốc.
    const som = await chen(ID, DON(ID, 16_000, 3, "2026-07-01T06:30:00.123456"), new Date("2026-07-01T10:00:00+07:00"));
    const muon = await chen(ID, DON(ID, 5_839, 4, "2026-07-01 06:30:00.123"), new Date("2026-07-01T10:05:00+07:00"));

    const [ban] = await latestPayloads("RawPancakeOrder", { externalIds: [ID], shopId: SHOP_TIKTOK });
    expect(ban?.id).toBe(muon);

    await transformFromRaw("orders", [], { externalIds: [ID], shopId: SHOP_TIKTOK });
    const lan1 = await prisma.order.findUniqueOrThrow({ where: { pancakeId: ID } });
    expect(lan1.platformFeeEst).toBe(5_839);
    expect(lan1.rawFetchedAt?.getTime()).toBe(new Date("2026-07-01T10:05:00+07:00").getTime());
    expect((await dong(muon)).silverOutcome).toBe(KET_CUC.APPLIED);
    expect((await dong(som)).silverOutcome).toBe(KET_CUC.SUPERSEDED);

    const lan2 = await transformFromRaw("orders", [], { externalIds: [ID], shopId: SHOP_TIKTOK });
    expect(lan2.ordersUpserted).toBe(1);
    expect(lan2.ordersSkippedStale).toBe(0);
    const sau = await prisma.order.findUniqueOrThrow({ where: { pancakeId: ID } });
    expect(sau.platformFeeEst).toBe(5_839);
    expect(sau.rawFetchedAt?.getTime()).toBe(lan1.rawFetchedAt?.getTime());
    expect((await dong(muon)).silverOutcome).toBe(KET_CUC.APPLIED);
    expect((await dong(som)).silverOutcome).toBe(KET_CUC.SUPERSEDED);
  });

  it("thiếu / sai khuôn updated_at ⇒ xếp SAU dòng có mốc ở cả đường dựng lẫn sổ kết cục", async () => {
    const ID = "585229755054263005";
    const coMoc = await chen(ID, DON(ID, 5_839, 4, T1), new Date("2026-07-01T10:00:00+07:00"));
    const khongMoc = await chen(ID, DON(ID, 16_000, 3), new Date("2026-07-01T10:05:00+07:00"));
    const ngayAo = await chen(ID, DON(ID, 16_000, 3, "2026-02-31T10:00:00"), new Date("2026-07-01T10:06:00+07:00"));

    const [ban] = await latestPayloads("RawPancakeOrder", { externalIds: [ID], shopId: SHOP_TIKTOK });
    expect(ban?.id).toBe(coMoc);
    expect(await locDonChuaDongDau(SHOP_TIKTOK, [ID])).toEqual([ID]); // bản đứng đầu (có mốc) còn dở

    await transformFromRaw("orders", [], { externalIds: [ID], shopId: SHOP_TIKTOK });

    expect((await prisma.order.findUniqueOrThrow({ where: { pancakeId: ID } })).platformFeeEst).toBe(5_839);
    expect((await dong(coMoc)).silverOutcome).toBe(KET_CUC.APPLIED);
    expect((await dong(khongMoc)).silverOutcome).toBe(KET_CUC.SUPERSEDED);
    expect((await dong(ngayAo)).silverOutcome).toBe(KET_CUC.SUPERSEDED);
    expect(await locDonChuaDongDau(SHOP_TIKTOK, [ID])).toEqual([]);
  });
});

describe("quét cả bảng: bản đứng đầu quyết định cả dựng lẫn mục 'cần xem'", () => {
  it("T1 FAILED_SHAPE (land muộn) + T2 map được ⇒ dựng lại tay dựng T2, T1 SUPERSEDED, hết 'cần xem'", async () => {
    const ID = "585229755054263006";
    const dongT2 = await chen(ID, DON(ID, 5_839, 4, T2), new Date("2026-07-01T10:00:00+07:00"));
    // Trang cũ mang payload không map được (đã bị đóng FAILED_SHAPE ở lượt trước).
    const dongT1 = await chen(
      ID,
      { id: ID, updated_at: T1 },
      new Date("2026-07-01T10:05:00+07:00"),
      KET_CUC.FAILED_SHAPE
    );

    await transformFromRaw("orders", [], { luotTayDuocGhiDe: true });

    expect((await prisma.order.findUniqueOrThrow({ where: { pancakeId: ID } })).status).toBe("RETURNED");
    expect((await dong(dongT2)).silverOutcome).toBe(KET_CUC.APPLIED);
    expect((await dong(dongT1)).silverOutcome).toBe(KET_CUC.SUPERSEDED);
    expect(await demCanXem()).toBe(0);
    expect(await dsDonCanXem(20)).toEqual([]);
  });

  it("đường THƯỜNG không đè kết cục đã chốt của bản dưới, nhưng 'cần xem' vẫn theo bản đứng đầu", async () => {
    const ID = "585229755054263007";
    const dongT2 = await chen(ID, DON(ID, 5_839, 4, T2), new Date("2026-07-01T10:00:00+07:00"));
    const dongT1 = await chen(
      ID,
      { id: ID, updated_at: T1 },
      new Date("2026-07-01T10:05:00+07:00"),
      KET_CUC.FAILED_SHAPE
    );

    await transformFromRaw("orders", []);

    expect((await dong(dongT2)).silverOutcome).toBe(KET_CUC.APPLIED);
    // Quyền đè `FAILED_*` là của lượt tay; bản dưới không còn được đếm nên không hiện "cần xem".
    expect((await dong(dongT1)).silverOutcome).toBe(KET_CUC.FAILED_SHAPE);
    expect(await demCanXem()).toBe(0);
  });
});

describe("đóng dấu bản dưới — chỉ dòng XẾP SAU, đúng quyền hạn", () => {
  it("KHÔNG đóng dòng xếp TRÊN (bản mới hơn vừa land giữa lúc đọc và lúc đóng dấu)", async () => {
    const ID = "585229755054263008";
    const moiHon = await chen(ID, DON(ID, 5_839, 4, T2), new Date("2026-07-01T10:00:00+07:00"));
    const dangXuLy = await chen(ID, DON(ID, 16_000, 3, T1), new Date("2026-07-01T10:05:00+07:00"));

    await dongDauKetCuc(prisma, dangXuLy, KET_CUC.SUPERSEDED);

    // Đóng nhầm bản mới hơn là CAS của chính lượt dựng nó trượt ⇒ bản mới nhất không vào Sổ.
    expect((await dong(moiHon)).silverOutcome).toBeNull();
  });

  it("đường thường chỉ đóng dòng NULL; lượt tay đè cả DISCARDED/LEGACY của bản dưới", async () => {
    const ID = "585229755054263009";
    const dau = await chen(ID, DON(ID, 5_839, 4, T2), new Date("2026-07-01T10:00:00+07:00"));
    const xoa = await chen(ID, DON(ID, 16_000, 3, T1), new Date("2026-07-01T10:05:00+07:00"), KET_CUC.DISCARDED);
    const cu = await chen(ID, DON(ID, 16_000, 3, "2026-07-01T04:00:00"), new Date("2026-07-01T10:06:00+07:00"), KET_CUC.LEGACY);
    const dangDo = await chen(ID, DON(ID, 16_000, 3, "2026-07-01T03:30:00"), new Date("2026-07-01T10:07:00+07:00"));

    await dongDauKetCuc(prisma, dau, KET_CUC.APPLIED);
    expect((await dong(xoa)).silverOutcome).toBe(KET_CUC.DISCARDED);
    expect((await dong(cu)).silverOutcome).toBe(KET_CUC.LEGACY);
    expect((await dong(dangDo)).silverOutcome).toBe(KET_CUC.SUPERSEDED);

    await dongDauKetCucBoiLuotTay(prisma, dau, KET_CUC.APPLIED);
    expect((await dong(xoa)).silverOutcome).toBe(KET_CUC.SUPERSEDED);
    expect((await dong(cu)).silverOutcome).toBe(KET_CUC.SUPERSEDED);
  });
});
