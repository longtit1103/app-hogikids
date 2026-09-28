import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { creatorTiktok, donCuaCreator } from "@/lib/reports/marketing/creator-tiktok";

import { landJson } from "./helpers/land-fixture";

/**
 * BẢNG CREATOR (tab Creator) — gom DÒNG SKU affiliate theo `creator_username`.
 *
 * Bốn lời khai chính:
 *  1. Hoa hồng dòng = GỘP hai bucket LOẠI TRỪ NHAU (`paid_commission` + `paid_shop_ads_commission`
 *     — review 28/08): creator_1 đi đường shop-ads (6.141 × 2 dòng) phải ra 12.282, KHÔNG phải "—".
 *  2. 🔑 `{}` ≠ `{amount:"0"}` (đo 28/08): CẢ HAI bucket cùng `{}` (sàn KHÔNG báo) phải ra `null`,
 *     còn `{amount:"0"}` (sàn báo 0 TƯỜNG MINH) phải ra `0`. Đây là chỗ dễ "sửa cho xanh" nhất —
 *     ai đổi null thành 0 là bịa ra một phép đo chưa từng xảy ra.
 *  3. `donSan` đếm DISTINCT `_don_id` (đơn 2 SKU không được đếm 2 lần); `dongSkuSan` đếm dòng.
 *  4. `SHOP` là kênh nội dung thứ ba THẬT của chính creator (cột % Shop) — không phải "không có
 *     creator" (suy đoán cũ đã bị đo bác 28/08).
 *
 * Fixture: 3 đơn / 4 dòng SKU thật đã gột PII — số VND tuyệt đối lấy thẳng từ đó.
 */

const FIXTURE_PATH = path.resolve(process.cwd(), "tests/fixtures/tiktokshop/affiliate/orders-search.json");

type SkuAff = Record<string, unknown>;
type EnvelopeAff = {
  data: { orders: { id: string; create_time: number; delivery_time?: number; skus: SkuAff[] }[] };
};

const docFixtureAff = (): EnvelopeAff => JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as EnvelopeAff;

const vnFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Làm phẳng y luật workflow (bơm `_don_id`/`_create_time`/`_delivery_time`/`_ngay` vào từng dòng
 * SKU). Bản thu nhỏ CÓ CHỦ ĐÍCH cho test reader — luật làm phẳng THẬT của workflow đã bị
 * `tests/bronze/land-raw-tiktok-affiliate.test.ts` khoá bằng code cắt từ jsCode; suite này chỉ cần
 * dựng đúng SHAPE Bronze mà reader đọc.
 */
function lamPhang(env: EnvelopeAff): unknown {
  const records: SkuAff[] = [];
  for (const o of env.data.orders) {
    for (const sk of o.skus) {
      records.push({
        ...sk,
        _don_id: o.id,
        _create_time: o.create_time,
        _delivery_time: o.delivery_time,
        _ngay: vnFmt.format(new Date(o.create_time * 1000)),
      });
    }
  }
  return { data: { orders: records } };
}

const KY = (tu: string, den: string) => ({
  from: new Date(`${tu}T00:00:00+07:00`),
  to: new Date(`${den}T00:00:00+07:00`),
});

const landFixtureAff = () => landJson("tiktok/affiliate_orders", lamPhang(docFixtureAff()));

beforeEach(async () => {
  await prisma.rawTiktokShopAffiliateOrder.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("creatorTiktok", () => {
  it("gom theo creator, sắp GMV ↓ — số tuyệt đối từ fixture (đơn 2 SKU đếm 1 đơn / 2 dòng)", async () => {
    await landFixtureAff();

    const r = await creatorTiktok(KY("2026-04-18", "2026-04-19"));

    expect(r.dong.map((d) => d.creatorUsername)).toEqual(["creator_1", "creator_3", "creator_2"]);

    const c1 = r.dong[0];
    expect(c1.donSan).toBe(1); // 1 đơn — KHÔNG phải 2, dù có 2 dòng SKU
    expect(c1.dongSkuSan).toBe(2);
    expect(c1.gmvSan).toBe(409_400); // 204.700 × 1 + 204.700 × 1
    // Hợp tác shop-ads: bucket chuẩn {} nhưng bucket shop_ads có 6.141/dòng ⇒ 12.282, KHÔNG phải "—".
    expect(c1.hoaHongUocTinh).toBe(12_282);
    expect(c1.hoaHongDaTra).toBe(12_282);
    expect(c1.tiTrongVideo).toBe(1);
    expect(c1.tiTrongLive).toBe(0);
    expect(c1.tiTrongShop).toBe(0);
    expect(c1.soDongKhongRoLoai).toBe(0);
    expect(c1.dongIneligible).toBe(0);
    expect(c1.dongHoanToanBo).toBe(0);
    expect(c1.dongChoChot).toBe(0); // cả 2 dòng SETTLED

    const c3 = r.dong[1];
    expect(c3.gmvSan).toBe(330_000);
    expect(c3.hoaHongUocTinh).toBe(23_100);
    expect(c3.hoaHongDaTra).toBe(23_100);
    expect(c3.tiTrongLive).toBe(1);

    const c2 = r.dong[2];
    expect(c2.gmvSan).toBe(294_400);
    expect(c2.hoaHongUocTinh).toBe(14_720);
    expect(c2.tiTrongShop).toBe(1); // SHOP = kênh của CHÍNH creator_2, không phải "không có creator"
    expect(c2.dongIneligible).toBe(1);
    expect(c2.dongHoanToanBo).toBe(1);
    expect(c2.dongChoChot).toBe(0); // INELIGIBLE là trạng thái CUỐI — không phải "chờ"

    expect(r.ngayDonMoiNhat).toBe("2026-04-19");
  });

  it("🔑 {} ≠ 0: CẢ HAI bucket {} ⇒ null; sàn báo 0 TƯỜNG MINH ⇒ 0; bucket shop_ads có số ⇒ cộng", async () => {
    // creator_3 gốc có actual_paid_commission 23.100 — sửa thành {} để CẢ HAI bucket cùng rỗng:
    // đây mới là ca "sàn không báo gì" sau khi gộp bucket (creator_1 nay KHÔNG còn là ca đó).
    const sua = docFixtureAff();
    sua.data.orders[2].skus[0].actual_paid_commission = {};
    await landJson("tiktok/affiliate_orders", lamPhang(sua));

    const r = await creatorTiktok(KY("2026-04-18", "2026-04-19"));
    const c1 = r.dong.find((d) => d.creatorUsername === "creator_1")!;
    const c2 = r.dong.find((d) => d.creatorUsername === "creator_2")!;
    const c3 = r.dong.find((d) => d.creatorUsername === "creator_3")!;

    // creator_3 (đã sửa): actual_paid_commission {} VÀ actual_paid_shop_ads_commission {} ⇒ null.
    expect(c3.hoaHongDaTra).toBeNull();
    // creator_2: actual_paid_commission = {amount:"0",currency:"VND"} — 0 THẬT (đơn INELIGIBLE),
    // bucket shop_ads {} không kéo 0 thành null.
    expect(c2.hoaHongDaTra).toBe(0);
    expect(c2.hoaHongDaTra).not.toBeNull();
    // creator_1: bucket chuẩn {} + bucket shop_ads 6.141×2 ⇒ 12.282 (không phải null, không phải 0).
    expect(c1.hoaHongDaTra).toBe(12_282);
  });

  it("dongChoChot đếm fail-open y drawer: To-SETTLE và THIẾU settlement_status đều là chờ; SETTLED/INELIGIBLE không", async () => {
    // Fixture gốc toàn SETTLED/INELIGIBLE ⇒ 0 khắp nơi (đã khoá ở test đầu). Sửa hai chỗ: creator_1 dòng thứ
    // hai thành `To-SETTLE` (trạng thái chờ THẬT đo trên prod 28–30/08), creator_3 XOÁ hẳn trường (sàn không
    // báo) — ca "thiếu" phải đếm là chờ, KHÔNG được coi là đã chốt.
    const sua = docFixtureAff();
    sua.data.orders[0].skus[1].settlement_status = "To-SETTLE";
    delete sua.data.orders[2].skus[0].settlement_status;
    await landJson("tiktok/affiliate_orders", lamPhang(sua));

    const r = await creatorTiktok(KY("2026-04-18", "2026-04-19"));
    const c1 = r.dong.find((d) => d.creatorUsername === "creator_1")!;
    const c2 = r.dong.find((d) => d.creatorUsername === "creator_2")!;
    const c3 = r.dong.find((d) => d.creatorUsername === "creator_3")!;

    expect(c1.dongChoChot).toBe(1); // 1 SETTLED + 1 To-SETTLE
    expect(c1.dongSkuSan).toBe(2);
    expect(c3.dongChoChot).toBe(1); // thiếu trường ⇒ chờ
    expect(c2.dongChoChot).toBe(0); // INELIGIBLE
    // Đếm dòng chờ KHÔNG đụng tiền: hoa hồng vẫn cộng y như cũ.
    expect(c1.hoaHongDaTra).toBe(12_282);
    expect(c3.hoaHongDaTra).toBe(23_100);
  });

  it("lọc kỳ bằng chuỗi _ngay: kỳ chỉ 18/04 không có creator_3 (đơn LIVE tạo 19/04)", async () => {
    await landFixtureAff();

    const r = await creatorTiktok(KY("2026-04-18", "2026-04-18"));

    expect(r.dong.map((d) => d.creatorUsername)).toEqual(["creator_1", "creator_2"]);
    // ngayDonMoiNhat đo TOÀN KHO (app đã ghi nhận tới đâu), không bị kỳ cắt.
    expect(r.ngayDonMoiNhat).toBe("2026-04-19");
  });

  it("sàn chỉnh số hồi tố ⇒ bản fetchedAt mới nhất thắng (DISTINCT ON)", async () => {
    await landFixtureAff();
    const sua = docFixtureAff();
    (sua.data.orders[2].skus[0].actual_paid_commission as { amount: string }).amount = "24000";
    await landJson("tiktok/affiliate_orders", lamPhang(sua));

    const r = await creatorTiktok(KY("2026-04-18", "2026-04-19"));
    const c3 = r.dong.find((d) => d.creatorUsername === "creator_3")!;

    expect(c3.hoaHongDaTra).toBe(24_000); // KHÔNG phải 23.100 (bản cũ) và không cộng dồn 2 bản
    expect(c3.dongSkuSan).toBe(1);
  });

  it("kho rỗng ⇒ dong = [], ngayDonMoiNhat = null (không bịa)", async () => {
    const r = await creatorTiktok(KY("2026-04-18", "2026-04-19"));

    expect(r.dong).toEqual([]);
    expect(r.ngayDonMoiNhat).toBeNull();
  });

  it("content_type lạ ⇒ đếm soDongKhongRoLoai, KHÔNG vào tỉ trọng; price {} ⇒ gmvSan lan null", async () => {
    // Hai nhánh chưa từng chạy trên fixture gốc (review 28/08): (a) content_type ngoài 3 giá trị
    // đã biết, (b) tiền price rỗng. Sửa từ fixture thật rồi land qua đúng đường ghi.
    const sua = docFixtureAff();
    sua.data.orders[2].skus[0].content_type = "LOAI_MOI_CHUA_BIET"; // creator_3: 1 dòng duy nhất
    sua.data.orders[0].skus[0].price = {}; // creator_1: 1 trong 2 dòng mất giá
    await landJson("tiktok/affiliate_orders", lamPhang(sua));

    const r = await creatorTiktok(KY("2026-04-18", "2026-04-19"));
    const c1 = r.dong.find((d) => d.creatorUsername === "creator_1")!;
    const c3 = r.dong.find((d) => d.creatorUsername === "creator_3")!;

    // creator_3: dòng duy nhất không rõ loại ⇒ mẫu số tỉ trọng = 0 ⇒ ba cột null, đếm riêng = 1.
    expect(c3.soDongKhongRoLoai).toBe(1);
    expect(c3.tiTrongVideo).toBeNull();
    expect(c3.tiTrongLive).toBeNull();
    expect(c3.tiTrongShop).toBeNull();
    // creator_1: một dòng mất giá ⇒ GMV cả creator là "không biết" (lan null), KHÔNG phải 204.700.
    expect(c1.gmvSan).toBeNull();
    expect(c1.dongSkuSan).toBe(2); // đếm dòng không bị tiền hỏng kéo theo
  });
});

describe("donCuaCreator (drawer)", () => {
  it("creator_1: 2 dòng SKU cùng đơn, hoa hồng {} ⇒ null từng dòng", async () => {
    await landFixtureAff();

    const dong = await donCuaCreator(KY("2026-04-18", "2026-04-19"), "creator_1");

    expect(dong).toHaveLength(2);
    for (const d of dong) {
      expect(d.donId).toBe("583585276075082966");
      expect(d.loaiNoiDung).toBe("VIDEO");
      expect(d.ngay).toBe("2026-04-18");
      // Bucket chuẩn {} nhưng shop_ads có 6.141 ⇒ từng dòng 6.141 (gộp bucket, review 28/08).
      expect(d.hoaHongUocTinh).toBe(6_141);
      expect(d.hoaHongDaTra).toBe(6_141);
      expect(d.hoanToanBo).toBe(false);
    }
    expect(new Set(dong.map((d) => d.skuId)).size).toBe(2);
  });

  it("creator_2: INELIGIBLE + hoàn toàn bộ + đã trả 0 tường minh", async () => {
    await landFixtureAff();

    const [d] = await donCuaCreator(KY("2026-04-18", "2026-04-19"), "creator_2");

    expect(d.trangThaiChot).toBe("INELIGIBLE");
    expect(d.hoanToanBo).toBe(true);
    expect(d.hoaHongUocTinh).toBe(14_720);
    expect(d.hoaHongDaTra).toBe(0);
    expect(d.contentId).toBe("7494427587222669489");
  });

  it("creator không có trong kỳ ⇒ []", async () => {
    await landFixtureAff();

    expect(await donCuaCreator(KY("2026-04-18", "2026-04-19"), "creator_99")).toEqual([]);
  });
});
