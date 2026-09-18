import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Land 5 stream MỚI (4 analytics TikTok Shop + GMV Max cấp item) bằng ĐÚNG payload thật (fixture
 * Task 1) trên ĐÚNG bảng Bronze thật. Sáu lời khai suite này khoá:
 *
 *  1. `arrayPath` đúng — nhất là `data.live_stream_sessions` (spec §4.4 đoán `data.lives`; khai sai
 *     thì land 0 dòng mà KHÔNG có lỗi nào).
 *  2. `idExpr` đúng — khoá là thứ KHÔNG sửa lại được: Bronze append-only.
 *  3. `_ngay` nằm TRONG khoá VÀ TRONG payload lưu (nên cũng trong hash).
 *  4. Land lại không nhân bản; sàn chỉnh số ⇒ giữ cả hai bản.
 *  5. Envelope lỗi (code ≠ 0, không có mảng) ⇒ THROW, không land trang rỗng giả.
 *  6. HAI CỔNG tự đứng: (a) stream khai `chapNhanNgay` mà `idExpr` quên `_ngay` ⇒ THROW ngay tại
 *     cửa land; (b) `ngay` đúng khuôn nhưng KHÔNG có thật trên lịch ⇒ THROW.
 *
 * VÌ SAO CÓ MOCK: cổng (6a) chỉ nổ khi registry khai SAI, mà 5 stream thật khai ĐÚNG. Dựng một
 * stream khai sai bằng cách bật `chapNhanNgay` cho `tiktok/orders` (bảng có sẵn, registry ghi rõ
 * "hôm nay không workflow nào populate") và CỐ Ý để `idExpr` mặc định — không đụng một bit nào của
 * 5 stream thật, nên mọi ca còn lại vẫn chạy trên registry thật.
 */
vi.mock("@/lib/bronze/streams", async (importOriginal) => {
  const goc = await importOriginal<typeof import("@/lib/bronze/streams")>();
  return {
    ...goc,
    BRONZE_STREAMS: {
      ...goc.BRONZE_STREAMS,
      "tiktok/orders": {
        ...goc.BRONZE_STREAMS["tiktok/orders"],
        chapNhanNgay: true,
        // CỐ Ý KHÔNG khai `idExpr` ⇒ mặc định `elem->>'id'` ⇒ khoá KHÔNG có `_ngay`. Đây chính là
        // lỗi mà cổng (6a) sinh ra để bắt.
      },
    },
  };
});

import { landRaw } from "@/lib/bronze/land-raw";
import { prisma } from "@/lib/prisma";

import { SHOP_TIKTOK_SHOP } from "../helpers/shop-ids-fixture";

const F = (ten: string) =>
  readFileSync(path.join(process.cwd(), "tests/fixtures/tiktokshop/analytics", ten), "utf8");
const F_ADS = () =>
  readFileSync(path.join(process.cwd(), "tests/fixtures/tiktokbusiness/gmvmax-item.json"), "utf8");

/** advertiser_id (shop MỞ — `shops: null`), khớp SHAPE `^\d{6,}$` của `OPEN_SHOP_SHAPE`. */
const ADV = "7129548444015902722";
const NGAY = "2026-08-19";

/** Ngắn gọn cho 2 stream bắt buộc có `ngay`. */
const landNgay = (stream: "tiktok/analytics_products" | "tiktok/analytics_videos", body: string, ngay = NGAY) =>
  landRaw(stream, SHOP_TIKTOK_SHOP, body, undefined, undefined, undefined, ngay);

beforeEach(async () => {
  await prisma.rawTiktokShopAnalyticsShop.deleteMany();
  await prisma.rawTiktokShopAnalyticsProduct.deleteMany();
  await prisma.rawTiktokShopAnalyticsVideo.deleteMany();
  await prisma.rawTiktokShopAnalyticsLive.deleteMany();
  await prisma.rawTiktokBusinessGmvMaxItem.deleteMany();
  // Bảng campaign-level: dọn để ca "khoá item-level KHÔNG đụng bảng cũ" đo được số 0 THẬT, không
  // phải số sót lại của suite khác (mọi suite dùng CHUNG một DB test).
  await prisma.rawTiktokBusinessReport.deleteMany();
  await prisma.rawTiktokShopOrder.deleteMany();
});

describe("landRaw — TikTok Shop analytics", () => {
  it("shop/performance: 3 ngày, khoá = start_date", async () => {
    const r = await landRaw("tiktok/analytics_shop", SHOP_TIKTOK_SHOP, F("shop-performance.json"));

    expect(r.landed).toBe(3);
    expect([...r.landedIds].sort()).toEqual(["2026-08-15", "2026-08-19", "2026-08-20"]);
    expect(r.skippedNoId).toBe(0);
  });

  it("shop_products: khoá = _ngay:id, 3 SP", async () => {
    const r = await landNgay("tiktok/analytics_products", F("shop-products.json"));

    expect(r.landed).toBe(3);
    expect([...r.landedIds].sort()).toEqual([
      "2026-08-19:1729557518640450219",
      "2026-08-19:1729557551540701867",
      "2026-08-19:1733583824365520555",
    ]);
  });

  it("shop_products: `_ngay` nằm TRONG payload lưu (nên cũng trong hash), trường gốc còn nguyên", async () => {
    await landNgay("tiktok/analytics_products", F("shop-products.json"));

    const row = await prisma.rawTiktokShopAnalyticsProduct.findFirstOrThrow({
      where: { externalId: "2026-08-19:1733583824365520555" },
    });
    const payload = row.payload as Record<string, unknown>;
    expect(payload._ngay).toBe(NGAY);
    expect(payload.id).toBe("1733583824365520555");
    // Khối nguồn KHÔNG bị merge làm mất — `||` chỉ cộng thêm khoá.
    expect(payload.total_performance).toBeTruthy();
  });

  it("shop_products: CÙNG payload, HAI ngày ⇒ hai dòng (chuỗi ngày không sập về 1 điểm)", async () => {
    const body = F("shop-products.json");
    await landNgay("tiktok/analytics_products", body, "2026-08-19");
    const r2 = await landNgay("tiktok/analytics_products", body, "2026-08-20");

    expect(r2.landed).toBe(3);
    expect(await prisma.rawTiktokShopAnalyticsProduct.count()).toBe(6);
    const khoa = await prisma.rawTiktokShopAnalyticsProduct.findMany({ select: { externalId: true } });
    expect(new Set(khoa.map((k) => k.externalId)).size).toBe(6);
  });

  it('shop_videos: record id "0" (video không xác định) VẪN land', async () => {
    const r = await landNgay("tiktok/analytics_videos", F("shop-videos.json"));

    expect(r.landed).toBe(3);
    expect(r.skippedNoId).toBe(0);
    expect(r.landedIds).toContain("2026-08-19:0");
  });

  it("shop_lives: mảng ở data.live_stream_sessions, khoá = id phiên", async () => {
    const r = await landRaw("tiktok/analytics_lives", SHOP_TIKTOK_SHOP, F("shop-lives.json"));

    expect(r.landed).toBe(3);
    expect([...r.landedIds].sort()).toEqual([
      "7668935874625751828",
      "7670797759402822421",
      "7671268054237514504",
    ]);
  });

  it("shop_lives: KHÔNG nhận 'ngay' (record đã có start_time/end_time riêng)", async () => {
    await expect(
      landRaw("tiktok/analytics_lives", SHOP_TIKTOK_SHOP, F("shop-lives.json"), undefined, undefined, undefined, NGAY)
    ).rejects.toThrow(/không nhận 'ngay'/i);
    expect(await prisma.rawTiktokShopAnalyticsLive.count()).toBe(0);
  });

  it("GMV Max item-level: khoá = campaign:item_group:ngày, shopId = advertiser", async () => {
    const r = await landRaw("tiktokbusiness/gmvmax_item", ADV, F_ADS());

    expect(r.landed).toBe(3);
    expect([...r.landedIds].sort()).toEqual([
      "1873416520735281:1729557518640450219:2026-08-15",
      "1873416520735281:1729557518640450219:2026-08-16",
      "1873416520735281:1729557551540701867:2026-08-14",
    ]);
    const row = await prisma.rawTiktokBusinessGmvMaxItem.findFirstOrThrow();
    expect(row.shopId).toBe(ADV);
  });

  it("khoá item-level KHÔNG đụng bảng campaign-level (bẫy P0)", async () => {
    await landRaw("tiktokbusiness/gmvmax_item", ADV, F_ADS());

    expect(await prisma.rawTiktokBusinessReport.count()).toBe(0);
  });

  it("GMV Max item-level: shopId sai SHAPE (act_… của Meta) ⇒ THROW", async () => {
    await expect(landRaw("tiktokbusiness/gmvmax_item", "act_123456", F_ADS())).rejects.toThrow(
      /sai định dạng/i
    );
    expect(await prisma.rawTiktokBusinessGmvMaxItem.count()).toBe(0);
  });

  it("land lại ⇒ dedupe; đổi số ⇒ bản mới", async () => {
    const goc = F("shop-performance.json");
    expect((await landRaw("tiktok/analytics_shop", SHOP_TIKTOK_SHOP, goc)).landed).toBe(3);
    expect((await landRaw("tiktok/analytics_shop", SHOP_TIKTOK_SHOP, goc)).landed).toBe(0);

    const sua = goc.replace('"avg_visitors": 171', '"avg_visitors": 999');
    expect(sua).not.toBe(goc); // fixture đổi tên field là ca này im lặng vô hiệu
    expect((await landRaw("tiktok/analytics_shop", SHOP_TIKTOK_SHOP, sua)).landed).toBe(1);
    expect(await prisma.rawTiktokShopAnalyticsShop.count()).toBe(4);
  });

  it("shop_products: land lại CÙNG ngày ⇒ dedupe, `seen` vẫn đủ", async () => {
    const body = F("shop-products.json");
    await landNgay("tiktok/analytics_products", body);
    const r2 = await landNgay("tiktok/analytics_products", body);

    expect(r2.landed).toBe(0);
    expect(r2.seenIds).toHaveLength(3);
    expect(await prisma.rawTiktokShopAnalyticsProduct.count()).toBe(3);
  });

  it("envelope lỗi 105005 (thiếu scope) ⇒ THROW, không land", async () => {
    await expect(landNgay("tiktok/analytics_products", F("loi-105005.json"))).rejects.toThrow(
      /không có mảng tại 'data.products'/
    );
    expect(await prisma.rawTiktokShopAnalyticsProduct.count()).toBe(0);
  });

  it("envelope lỗi 36009004 (page_size > 100) ⇒ THROW", async () => {
    await expect(landNgay("tiktok/analytics_videos", F("loi-36009004.json"))).rejects.toThrow(
      /không có mảng tại 'data.videos'/
    );
    expect(await prisma.rawTiktokShopAnalyticsVideo.count()).toBe(0);
  });
});

describe("landRaw — hai cổng chặn khoá hỏng câm", () => {
  it("stream khai chapNhanNgay mà idExpr THIẾU `_ngay` ⇒ THROW (không land khoá trùng qua mọi ngày)", async () => {
    // `tiktok/orders` đã bị mock thành "khai cờ nhưng quên `_ngay`" ở đầu file.
    await expect(
      landRaw(
        "tiktok/orders",
        SHOP_TIKTOK_SHOP,
        `{"code":0,"data":{"orders":[{"id":"1"}]}}`,
        undefined,
        undefined,
        undefined,
        NGAY
      )
    ).rejects.toThrow(/idExpr [\s\S]*KHÔNG chứa/);
    expect(await prisma.rawTiktokShopOrder.count()).toBe(0);
  });

  it.each(["2026-02-31", "2026-13-01", "2026-00-10", "0026-08-19"])(
    "ngay đúng khuôn nhưng KHÔNG có thật trên lịch (%s) ⇒ THROW",
    async (ngay) => {
      await expect(landNgay("tiktok/analytics_products", F("shop-products.json"), ngay)).rejects.toThrow(
        /không phải ngày có thật trên lịch/
      );
      expect(await prisma.rawTiktokShopAnalyticsProduct.count()).toBe(0);
    }
  );

  it.each(["1970-01-01", "2126-08-19"])(
    "ngày CÓ THẬT nhưng ngoài cửa sổ hợp lý (%s) ⇒ THROW",
    async (ngay) => {
      // Hai ca này đi lọt cả regex khuôn LẪN phép kiểm lịch — chỉ cổng cửa sổ mới bắt được.
      await expect(landNgay("tiktok/analytics_products", F("shop-products.json"), ngay)).rejects.toThrow(
        /nằm ngoài cửa sổ hợp lý/
      );
      expect(await prisma.rawTiktokShopAnalyticsProduct.count()).toBe(0);
    }
  );

  it("ngày có thật ở năm nhuận, TRONG cửa sổ (2024-02-29) vẫn land bình thường", async () => {
    const r = await landNgay("tiktok/analytics_products", F("shop-products.json"), "2024-02-29");
    expect(r.landed).toBe(3);
  });

  it("cận trên là NGÀY MAI giờ VN (chừa biên múi giờ), ngày kia thì chặn", async () => {
    const ngayVn = (lech: number) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Ho_Chi_Minh",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(Date.now() + lech * 86_400_000));

    expect((await landNgay("tiktok/analytics_products", F("shop-products.json"), ngayVn(1))).landed).toBe(3);
    await expect(
      landNgay("tiktok/analytics_products", F("shop-products.json"), ngayVn(2))
    ).rejects.toThrow(/nằm ngoài cửa sổ hợp lý/);
  });

  it("REGISTRY THẬT: mọi stream khai chapNhanNgay đều có `_ngay` trong idExpr", async () => {
    // `importActual` — registry THẬT, không dính bản mock ở đầu file.
    const { BRONZE_STREAMS } = await vi.importActual<typeof import("@/lib/bronze/streams")>(
      "@/lib/bronze/streams"
    );
    const khaiCo = Object.entries(BRONZE_STREAMS).filter(([, def]) => def.chapNhanNgay);

    expect(khaiCo.map(([ten]) => ten).sort()).toEqual([
      "tiktok/analytics_products",
      "tiktok/analytics_videos",
    ]);
    for (const [ten, def] of khaiCo) {
      expect(def.idExpr, `stream "${ten}" khai chapNhanNgay mà idExpr không ghép '_ngay'`).toContain(
        "_ngay"
      );
    }
  });
});
