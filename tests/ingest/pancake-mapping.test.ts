import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  calcPlatformFeeEst,
  isAffiliateMirror,
  mapChannel,
  mapPancakeOrder,
  mapPancakeProduct,
  mapStatus,
  parseVnDate,
  UNKNOWN_STATUS_WARNING,
  type MapOrderCtx,
} from "@/lib/ingest/pancake-mapping";
import { ingestPancakeBodySchema, pancakeOrderSchema, pancakeProductSchema } from "@/lib/ingest/pancake-schemas";

const fixture = (name: string) =>
  JSON.parse(readFileSync(path.resolve(process.cwd(), "tests/fixtures/pancake", name), "utf8"));

const rawOrders = fixture("orders-sample.json") as unknown[];
const rawProducts = fixture("products-sample.json") as unknown[];

// ctx: shopee/tiktok là marketplace (dùng fee_marketplace thật); facebook có % dự phòng.
const CTX: MapOrderCtx = {
  channels: {
    shopee: { platformFeePct: 0, paymentFeePct: 0 },
    tiktok: { platformFeePct: 0, paymentFeePct: 0 },
    facebook: { platformFeePct: 8, paymentFeePct: 2 },
    website: { platformFeePct: 0, paymentFeePct: 0 },
  },
};

const round = (n: number) => Math.round(n);
/** `discount_each_product` là giảm giá MỖI ĐƠN VỊ ⇒ phải × quantity mới cùng cơ sở với `total_price`. */
const sumEach = (o: { items?: { discount_each_product?: number; quantity?: number }[] }) =>
  (o.items ?? []).reduce(
    (s, it) => s + round(Number(it.discount_each_product) || 0) * (Number(it.quantity) || 0),
    0
  );
/** Phần khuyến mãi SÀN trả thay khách (kẹp vào [0, Σ giảm giá dòng]) — shop không mất tiền khoản này. */
const voucherSan = (o: {
  items?: { discount_each_product?: number; quantity?: number }[];
  advanced_platform_fee?: { marketplace_voucher?: number | null } | null;
}) => Math.min(Math.max(0, round(Number(o.advanced_platform_fee?.marketplace_voucher) || 0)), sumEach(o));
/** Giảm giá SHOP thật sự chịu = Σ giảm giá dòng − voucher sàn tài trợ. */
const giamGiaShop = (o: Parameters<typeof voucherSan>[0]) => sumEach(o) - voucherSan(o);

describe("schemas parse dữ liệu Pancake thật", () => {
  it("fixtures qua ingestPancakeBodySchema không lỗi", () => {
    expect(() => ingestPancakeBodySchema.parse({ orders: rawOrders, products: rawProducts })).not.toThrow();
  });
});

describe("mapPancakeOrder — công thức tiền (chống trừ giảm giá 2 lần)", () => {
  const parsed = rawOrders.map((o) => pancakeOrderSchema.parse(o));

  it("itemsTotal = total_price − giảm giá SHOP chịu; discount = total_discount (mọi đơn fixture)", () => {
    for (const raw of parsed) {
      const m = mapPancakeOrder(raw, CTX);
      expect(m.itemsTotal).toBe(round(raw.total_price) - giamGiaShop(raw));
      expect(m.discount).toBe(round(raw.total_discount));
    }
  });

  it("Σ doanh thu dòng === itemsTotal ở MỌI đơn fixture (khoá parity với tab Sản phẩm)", () => {
    for (const raw of parsed) {
      const m = mapPancakeOrder(raw, CTX);
      const sumDong = m.items.reduce((s, it) => s + it.unitPrice * it.quantity - it.lineDiscount, 0);
      expect(sumDong).toBe(m.itemsTotal);
    }
  });

  it("platformFeeEst = fee_marketplace THẬT cho đơn Shopee/TikTok", () => {
    for (const raw of parsed) {
      const m = mapPancakeOrder(raw, CTX);
      if (m.channelId === "shopee" || m.channelId === "tiktok") {
        expect(m.platformFeeEst).toBe(round(raw.fee_marketplace));
      }
    }
  });

  it("số cố định: đơn NHIỀU item + qty>1 + giảm giá dòng + voucher đơn (khoá tương tác)", () => {
    // total_price 350000 = 2×100000 + 3×50000 (gộp).
    // discount_each_product là giảm giá MỖI ĐƠN VỊ ⇒ Σ giảm giá = 2×30000 + 3×15000 = 105000.
    // voucher đơn 5000 độc lập (KHÔNG trừ vào itemsTotal).
    const raw = pancakeOrderSchema.parse({
      id: "TEST-MULTI-1",
      status: 3,
      inserted_at: "2026-07-01T10:00:00.000000",
      order_sources_name: "Shopee",
      marketplace_id: "-3",
      total_price: 350000,
      total_discount: 5000,
      fee_marketplace: 20000,
      items: [
        { quantity: 2, variation_id: "v-a", discount_each_product: 30000, variation_info: { display_id: "SKU-A", name: "SP A", retail_price: 100000 } },
        { quantity: 3, variation_id: "v-b", discount_each_product: 15000, variation_info: { display_id: "SKU-B", name: "SP B", retail_price: 50000 } },
      ],
    });
    const m = mapPancakeOrder(raw, CTX);
    expect(m.itemsTotal).toBe(245000); // 350000 − 105000, trừ giảm giá dòng ĐÚNG 1 lần
    expect(m.discount).toBe(5000); // voucher đơn độc lập
    expect(m.platformFeeEst).toBe(20000);
    // `variantDetail` = "" vì payload này không có `variation_info.detail`. Giữ `toEqual` (so khớp
    // ĐỦ KHOÁ) chứ không đổi sang `toMatchObject`: thêm/bớt trường ở dòng hàng phải làm test vỡ.
    expect(m.items).toEqual([
      { variationPancakeId: "v-a", sku: "SKU-A", productName: "SP A", variantDetail: "", quantity: 2, unitPrice: 100000, lineDiscount: 60000 },
      { variationPancakeId: "v-b", sku: "SKU-B", productName: "SP B", variantDetail: "", quantity: 3, unitPrice: 50000, lineDiscount: 45000 },
    ]);
    // Σ doanh thu dòng khớp itemsTotal: (2×100000−60000) + (3×50000−45000) = 140000 + 105000.
    expect(m.items.reduce((s, it) => s + it.unitPrice * it.quantity - it.lineDiscount, 0)).toBe(245000);
  });

  it("variation_info.detail đi thẳng vào variantDetail, KHÔNG chuẩn hoá gì", () => {
    // `variantDetail` là một phần KHOÁ của bảng ghép biến thể thủ công, mà bảng đó so khớp bằng
    // nhau tuyệt đối. Nếu mapping lỡ trim/lowercase/đổi dấu phẩy thì khoá lệch và ghép trượt CÂM
    // (COGS về 0 mà không ai biết vì sao). Ca này khoá lại: giữ nguyên từng ký tự payload trả.
    const raw = pancakeOrderSchema.parse({
      id: "TEST-DETAIL-1",
      status: 3,
      inserted_at: "2026-08-13T08:34:53.000000",
      order_sources_name: "Shopee",
      marketplace_id: "-3",
      total_price: 350000,
      items: [
        {
          quantity: 1,
          discount_each_product: 0,
          variation_info: { name: " SP có  khoảng trắng ", detail: " Phân loại A,Cỡ 1 ", retail_price: 350000 },
        },
      ],
    });
    const m = mapPancakeOrder(raw, CTX);
    expect(m.items[0].variantDetail).toBe(" Phân loại A,Cỡ 1 "); // khoảng trắng GIỮ NGUYÊN
    expect(m.items[0].productName).toBe(" SP có  khoảng trắng "); // giữ nguyên, không trim
  });

  it("thiếu variation_info.detail → variantDetail rỗng, không phải undefined/null", () => {
    const raw = pancakeOrderSchema.parse({
      id: "TEST-DETAIL-2",
      status: 3,
      inserted_at: "2026-08-13T08:34:53.000000",
      order_sources_name: "Shopee",
      marketplace_id: "-3",
      total_price: 100000,
      items: [{ quantity: 1, discount_each_product: 0, variation_info: { name: "SP", retail_price: 100000 } }],
    });
    expect(mapPancakeOrder(raw, CTX).items[0].variantDetail).toBe("");
  });

  it("đơn ĐÃ GIAO có total_discount ÂM: sàn gánh trọn khoản giảm, doanh thu KHÔNG bị hụt", () => {
    // Đơn thật 583311185310680831 (đo prod 2026-08-07). `total_discount` âm là cách Pancake ghi
    // khoản SÀN gánh — không phải dữ liệu dị. Từng có một cổng chặn "âm ⇒ từ chối suy" và nó cắt
    // đúng khoản cần cứu: doanh thu prod tụt 80.170 đ ngay lượt dựng lại. Ca này khoá lại điều đó.
    const raw = pancakeOrderSchema.parse({
      id: "583311185310680831",
      status: 3,
      inserted_at: "2026-04-02T03:00:00.000000",
      order_sources_name: "Tiktok",
      marketplace_id: "-9",
      total_price: 230000,
      total_discount: -20700,
      fee_marketplace: 52326,
      cod: 177674,
      items: [
        { quantity: 1, variation_id: "v-td", discount_each_product: 20700, variation_info: { display_id: "SKU-TD", name: "SP TD", retail_price: 230000 } },
      ],
    });
    const m = mapPancakeOrder(raw, CTX);
    expect(m.itemsTotal).toBe(230000); // sàn gánh trọn 20.700 ⇒ tiền hàng đúng bằng giá niêm yết
    expect(m.items[0].lineDiscount).toBe(0); // shop không chịu đồng nào
    expect(m.discount).toBe(0); // voucher mức đơn lưu Silver vẫn kẹp ≥ 0
  });

  it("đơn RETURNED không được suy voucher sàn từ cod — itemsTotal giữ nguyên sau giảm giá dòng", () => {
    // Shape thật từ đo prod 2026-08-06 (đơn hoàn `total_discount` ÂM — Pancake đảo khoản, `cod` ≈ tổng
    // gộp): trước đây luật suy coi TOÀN BỘ giảm giá dòng là sàn tài trợ và thổi itemsTotal 574.000 →
    // 910.000 "từ hư không". Đơn hoàn nằm NGOÀI vùng luật được chứng minh (314 đơn hợp lệ) nên phải
    // đứng ngoài tuyệt đối; GMV và dải tổng trang Đơn hàng đọc itemsTotal của cả đơn hoàn.
    const raw = pancakeOrderSchema.parse({
      id: "TEST-RETURNED-1",
      status: 4, // returning → RETURNED
      inserted_at: "2026-05-10T03:00:00.000000",
      order_sources_name: "Shopee",
      marketplace_id: "-3",
      total_price: 910000,
      total_discount: -213630,
      fee_marketplace: 0,
      cod: 910000,
      items: [
        { quantity: 1, variation_id: "v-r", discount_each_product: 336000, variation_info: { display_id: "SKU-R", name: "SP R", retail_price: 910000 } },
      ],
    });
    const m = mapPancakeOrder(raw, CTX);
    expect(m.status).toBe("RETURNED");
    expect(m.itemsTotal).toBe(574000); // 910000 − 336000, KHÔNG bị suy ngược lên 910000
    expect(m.items[0].lineDiscount).toBe(336000); // toàn bộ giảm giá dòng vẫn là shop chịu
  });

  it("đơn Shopee mẫu (260620HR6W3JSW) map đúng từng trường", () => {
    const raw = parsed.find((o) => o.id === "260620HR6W3JSW");
    expect(raw).toBeDefined();
    const m = mapPancakeOrder(raw!, CTX);
    expect(m).toMatchObject({
      pancakeId: "260620HR6W3JSW",
      code: "80",
      channelId: "shopee",
      status: "COMPLETED",
      itemsTotal: 790000,
      discount: 0,
      platformFeeEst: 286690, // = fee_marketplace thật, KHÔNG phải ước tính %
    });
    // inserted_at naive Pancake = giờ UTC (neo Z), KHÔNG phải +07.
    expect(m.orderedAt.getTime()).toBe(Date.parse("2026-06-19T23:15:18Z"));
    expect(m.items[0]).toMatchObject({ sku: "SP000168", quantity: 1, unitPrice: 490000 });
    expect(m.items[0].productName).toContain("Sản phẩm mẫu");
  });

  it("có ít nhất 1 đơn TikTok giảm giá dòng do SHOP chịu — itemsTotal trừ đúng 1 lần", () => {
    const raw = parsed.find((o) => o.order_sources_name === "Tiktok" && giamGiaShop(o) > 0);
    expect(raw, "fixture cần 1 đơn TikTok có discount_each shop chịu").toBeDefined();
    const m = mapPancakeOrder(raw!, CTX);
    expect(m.itemsTotal).toBe(round(raw!.total_price) - giamGiaShop(raw!));
    expect(m.itemsTotal).toBeLessThan(round(raw!.total_price)); // đã trừ giảm
  });

  it("đơn TikTok mà TOÀN BỘ giảm giá do sàn tài trợ → itemsTotal = total_price (shop không mất tiền)", () => {
    const raw = parsed.find((o) => o.order_sources_name === "Tiktok" && voucherSan(o) > 0 && giamGiaShop(o) === 0);
    expect(raw, "fixture cần 1 đơn TikTok voucher sàn phủ hết giảm giá dòng").toBeDefined();
    const m = mapPancakeOrder(raw!, CTX);
    expect(sumEach(raw!)).toBeGreaterThan(0); // có giảm giá dòng thật
    expect(m.itemsTotal).toBe(round(raw!.total_price)); // nhưng KHÔNG trừ vào doanh thu
    expect(m.items.every((it) => it.lineDiscount === 0)).toBe(true);
  });

  it("kênh KHÔNG marketplace (facebook) → dùng ước tính % dự phòng", () => {
    const fb = pancakeOrderSchema.parse({
      id: "FB1",
      status: 3,
      inserted_at: "2026-07-01T10:00:00.000000",
      order_sources_name: "Facebook",
      total_price: 200000,
      fee_marketplace: 0,
      items: [{ quantity: 1, variation_info: { display_id: "X1", retail_price: 200000 } }],
    });
    const m = mapPancakeOrder(fb, CTX);
    expect(m.channelId).toBe("facebook");
    expect(m.platformFeeEst).toBe(calcPlatformFeeEst(200000, CTX.channels.facebook)); // round(200000×10%)=20000
    expect(m.platformFeeEst).toBe(20000);
  });

  it("item thiếu SKU → warning (không tra được giá vốn)", () => {
    const noSku = pancakeOrderSchema.parse({
      id: "NS1",
      status: 3,
      inserted_at: "2026-07-01T10:00:00.000000",
      order_sources_name: "Shopee",
      total_price: 100000,
      items: [{ quantity: 1, variation_info: { retail_price: 100000 } }],
    });
    const m = mapPancakeOrder(noSku, CTX);
    expect(m.items[0].sku).toBe("");
    expect(m.warnings.some((w) => w.includes("không có SKU"))).toBe(true);
  });

  it("đơn có CẢ voucher-đơn + giảm-giá-dòng → mỗi lớp trừ đúng 1 lần (real: #584178745311135053)", () => {
    // total_discount (1500) < Σ discount_each (34500) ⇒ độc lập; itemsTotal chỉ trừ line-discount, discount giữ voucher đơn.
    const o = pancakeOrderSchema.parse({
      id: "MIX1",
      status: 3,
      inserted_at: "2026-07-01T10:00:00.000000",
      order_sources_name: "Tiktok",
      total_price: 230000,
      total_discount: 1500,
      fee_marketplace: 20000,
      items: [{ quantity: 1, discount_each_product: 34500, variation_info: { display_id: "X1", retail_price: 230000 } }],
    });
    const m = mapPancakeOrder(o, CTX);
    expect(m.itemsTotal).toBe(195500); // 230000 − 34500 (KHÔNG trừ thêm 1500 ở đây)
    expect(m.discount).toBe(1500); // voucher đơn riêng
    expect(m.platformFeeEst).toBe(20000);
    // net = itemsTotal − discount − fee = 195500 − 1500 − 20000 = 174000 (mỗi lớp giảm đúng 1 lần)
    expect(m.itemsTotal - m.discount - m.platformFeeEst).toBe(174000);
  });

  it("discount_each âm bị clamp về 0 (không thổi phồng doanh thu)", () => {
    const o = pancakeOrderSchema.parse({
      id: "NEG1",
      status: 3,
      inserted_at: "2026-07-01T10:00:00.000000",
      order_sources_name: "Shopee",
      total_price: 100000,
      items: [{ quantity: 1, discount_each_product: -50000, variation_info: { display_id: "X1", retail_price: 100000 } }],
    });
    const m = mapPancakeOrder(o, CTX);
    expect(m.itemsTotal).toBe(100000); // KHÔNG thành 150000
  });
});

describe("isAffiliateMirror — chống đếm 2 lần (invariant #2)", () => {
  it("đơn Affiliate + marketplace Shopee/TikTok → true (loại khỏi doanh thu)", () => {
    expect(isAffiliateMirror({ order_sources_name: "Affiliate", marketplace_id: "-9" })).toBe(true);
    expect(isAffiliateMirror({ order_sources_name: "Affiliate", marketplace_id: "-3" })).toBe(true);
  });
  it("đơn gốc Shopee/TikTok → false (tính doanh thu)", () => {
    expect(isAffiliateMirror({ order_sources_name: "Shopee", marketplace_id: "-3" })).toBe(false);
    expect(isAffiliateMirror({ order_sources_name: "Tiktok", marketplace_id: "-9" })).toBe(false);
    // Affiliate nhưng KHÔNG marketplace mirror (vd FB affiliate tương lai) → không loại nhầm
    expect(isAffiliateMirror({ order_sources_name: "Affiliate", marketplace_id: null })).toBe(false);
  });
  it("mọi đơn fixture (đơn gốc) KHÔNG bị coi là mirror", () => {
    for (const raw of rawOrders as { order_sources_name?: string; marketplace_id?: string }[]) {
      expect(isAffiliateMirror(raw)).toBe(false);
    }
  });
});

describe("mapStatus", () => {
  it("map mã đã biết", () => {
    const w: string[] = [];
    expect(mapStatus(3, w)).toBe("COMPLETED");
    expect(mapStatus("4", w)).toBe("RETURNED");
    expect(mapStatus(6, w)).toBe("CANCELLED");
    expect(mapStatus(2, w)).toBe("SHIPPING"); // đã gửi hàng
    // Đơn đang xử lý (đã xác nhận nghĩa với chủ shop) đều TÍNH doanh thu:
    expect(mapStatus(0, w)).toBe("PENDING"); // mới
    expect(mapStatus(1, w)).toBe("PENDING"); // đã xác nhận
    expect(mapStatus(8, w)).toBe("PENDING"); // đang đóng hàng
    expect(w).toHaveLength(0);
  });
  it("mã lạ → CANCELLED (loại khỏi P&L) + warning có prefix để transform đếm cảnh báo", () => {
    const w: string[] = [];
    expect(mapStatus(99, w)).toBe("CANCELLED");
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("99");
    expect(w[0].startsWith(UNKNOWN_STATUS_WARNING)).toBe(true); // transform đếm theo prefix này
  });
  it("mã lạ nhưng khớp status_name → map theo tên + warning (KHÔNG tính là mã lạ mất doanh thu)", () => {
    const w: string[] = [];
    expect(mapStatus(99, w, "delivered")).toBe("COMPLETED");
    expect(w).toHaveLength(1);
    // Nhánh khớp tên map đúng → warning KHÔNG mang prefix mã-lạ (không đội số unknownStatusOrders).
    expect(w[0].startsWith(UNKNOWN_STATUS_WARNING)).toBe(false);
    expect(mapStatus(98, w, "canceled")).toBe("CANCELLED");
  });
});

describe("mapChannel", () => {
  it("nhận diện kênh", () => {
    const w: string[] = [];
    expect(mapChannel("Shopee", w)).toBe("shopee");
    expect(mapChannel("Tiktok", w)).toBe("tiktok");
    expect(mapChannel("Facebook", w)).toBe("facebook");
    expect(w).toHaveLength(0);
  });
  it("nguồn lạ/rỗng → website + warning", () => {
    const w: string[] = [];
    expect(mapChannel("Zalo", w)).toBe("website");
    expect(mapChannel(null, w)).toBe("website");
    expect(w).toHaveLength(2);
  });
});

describe("calcPlatformFeeEst", () => {
  it("tính % và làm tròn nửa lên", () => {
    expect(calcPlatformFeeEst(100000, { platformFeePct: 10, paymentFeePct: 2.5 })).toBe(12500);
    expect(calcPlatformFeeEst(10, { platformFeePct: 5, paymentFeePct: 0 })).toBe(1); // round(0.5)=1
  });
});

describe("parseVnDate", () => {
  it("naive Pancake → neo UTC (Z), KHÔNG phải +07", () => {
    expect(parseVnDate("2026-06-19T23:15:18.000000").getTime()).toBe(Date.parse("2026-06-19T23:15:18Z"));
  });
  it("giữ nguyên TZ nếu có sẵn", () => {
    expect(parseVnDate("2026-06-19T23:15:18+00:00").getTime()).toBe(Date.parse("2026-06-19T23:15:18Z"));
  });
  it("đơn rạng sáng VN không lùi về hôm trước (regression đơn TikTok #578)", () => {
    // Pancake gửi inserted_at naive "2026-07-21T19:38" = giờ UTC = 02:38 sáng 22/07 giờ VN.
    // Bug cũ neo +07 → hiểu thành 19:38 tối 21/07 → lọt nhầm sang ngày 21/07.
    const d = parseVnDate("2026-07-21T19:38:00.000000");
    expect(d.toISOString()).toBe("2026-07-21T19:38:00.000Z");
    // Ngày theo giờ VN phải là 22/07, không phải 21/07.
    const vnDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
    expect(vnDay).toBe("2026-07-22");
  });
  it("mép nửa đêm VN: 17:00:00Z = 00:00 hôm sau, 16:59:59Z = 23:59 cùng ngày", () => {
    const vnDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
    expect(vnDay(parseVnDate("2026-07-21T17:00:00.000000"))).toBe("2026-07-22"); // 00:00 sáng hôm sau
    expect(vnDay(parseVnDate("2026-07-21T16:59:59.000000"))).toBe("2026-07-21"); // 23:59 cùng ngày
  });
  it("chấp nhận separator khoảng trắng, vẫn neo UTC", () => {
    expect(parseVnDate("2026-06-19 23:15:18").getTime()).toBe(Date.parse("2026-06-19T23:15:18Z"));
  });
  it("datetime THIẾU giây vẫn neo UTC (bù :00), KHÔNG suy diễn giờ LOCAL", () => {
    // "2026-07-06T02:10" (thiếu giây): phải = 02:10:00Z. Bug cũ rơi vào new Date() → LOCAL (+07)
    // = 2026-07-05T19:10:00Z, lệch 7h.
    expect(parseVnDate("2026-07-06T02:10").getTime()).toBe(Date.parse("2026-07-06T02:10:00Z"));
    expect(parseVnDate("2026-07-06 02:10").getTime()).toBe(Date.parse("2026-07-06T02:10:00Z"));
    // Thiếu giây nhưng có sẵn offset → giữ offset.
    expect(parseVnDate("2026-07-06T02:10+07:00").getTime()).toBe(Date.parse("2026-07-06T02:10:00+07:00"));
  });
  it("ngày tràn lịch → Invalid Date, KHÔNG để JS chuẩn hoá sang tháng sau", () => {
    // V8 chuẩn hoá "2026-02-31T10:00:00Z" thành 03/03 thay vì báo lỗi — ngày dị phải bị chặn
    // trước, không được lặng lẽ thành một ngày khác trên màn đối chiếu.
    expect(Number.isNaN(parseVnDate("2026-02-31T10:00:00.000000").getTime())).toBe(true);
    expect(Number.isNaN(parseVnDate("2026-04-31 07:00:00").getTime())).toBe(true);
    expect(Number.isNaN(parseVnDate("2026-02-29T00:00:00").getTime())).toBe(true); // 2026 không nhuận
    expect(Number.isNaN(parseVnDate("2026-13-01T00:00:00").getTime())).toBe(true);
    expect(Number.isNaN(parseVnDate("2026-06-19T25:15:18").getTime())).toBe(true); // giờ 25
  });
  it("năm nhuận: 29/02/2024 vẫn hợp lệ", () => {
    expect(parseVnDate("2024-02-29T10:00:00.000000").getTime()).toBe(Date.parse("2024-02-29T10:00:00Z"));
  });
  it("date-only cũng bị kiểm lịch — V8 chuẩn hoá cả dạng này ('2026-02-31' → 03/03)", () => {
    expect(Number.isNaN(parseVnDate("2026-02-31").getTime())).toBe(true);
    // Date-only hợp lệ giữ hành vi cũ: nửa đêm UTC.
    expect(parseVnDate("2026-05-20").getTime()).toBe(Date.parse("2026-05-20T00:00:00Z"));
  });
  it("đuôi rác sau giây → Invalid Date, KHÔNG lặng lẽ neo Z", () => {
    expect(Number.isNaN(parseVnDate("2026-01-01T10:00:00garbage").getTime())).toBe(true);
    expect(Number.isNaN(parseVnDate("2026-01-01T10:00:00.000000xyz").getTime())).toBe(true);
    // TZ thật vẫn qua: Z, +07:00, +0700.
    expect(parseVnDate("2026-01-01T10:00:00+0700").getTime()).toBe(Date.parse("2026-01-01T10:00:00+07:00"));
  });
  it("định dạng ngoài khuôn → Invalid Date, KHÔNG rơi vào parser hệ (nó cũng chuẩn hoá ngày tràn)", () => {
    expect(Number.isNaN(parseVnDate("2026-2-31").getTime())).toBe(true); // tháng 1 chữ số
    expect(Number.isNaN(parseVnDate("02/31/2026").getTime())).toBe(true); // kiểu Mỹ
    expect(Number.isNaN(parseVnDate("2026/02/31").getTime())).toBe(true); // gạch chéo
    expect(Number.isNaN(parseVnDate("").getTime())).toBe(true);
  });
  it("GIỮ phần lẻ giây; phần lẻ không có giây đi trước là chuỗi hỏng", () => {
    // Bản cũ cắt fraction ("…10:00:00.500Z" → 10:00:00 tròn) — webhook tồn kho phải tự vá lại mili.
    expect(parseVnDate("2026-01-01T10:00:00.500Z").getTime()).toBe(Date.parse("2026-01-01T10:00:00.500Z"));
    expect(parseVnDate("2026-06-19T23:15:18.123456").getTime()).toBe(Date.parse("2026-06-19T23:15:18.123Z"));
    expect(Number.isNaN(parseVnDate("2026-01-01T10:00.500Z").getTime())).toBe(true); // fraction sau PHÚT
  });
});

describe("mapPancakeProduct", () => {
  const parsed = rawProducts.map((p) => pancakeProductSchema.parse(p));

  it("map SP kho: costPrice = average_imported_price, sku = display_id, label từ fields", () => {
    const withCost = parsed
      .flatMap((p) => p.variations.map((v) => ({ p, v })))
      .find(({ v }) => Number(v.average_imported_price) > 0);
    expect(withCost, "fixture cần 1 biến thể có average_imported_price").toBeDefined();
    const mapped = mapPancakeProduct(withCost!.p);
    const mv = mapped.variants.find((x) => x.pancakeId === String(withCost!.v.id));
    expect(mv).toBeDefined();
    expect(mv!.costPrice).toBe(round(Number(withCost!.v.average_imported_price)));
    expect(mv!.sku).toBe(withCost!.v.display_id);
    expect(mv!.label.length).toBeGreaterThan(0);
  });

  it("costPrice fallback: average_imported_price=0 → last_imported_price", () => {
    const p = pancakeProductSchema.parse({
      id: "P1",
      name: "SP",
      variations: [{ id: "V1", display_id: "SKU1", retail_price: 200000, average_imported_price: 0, last_imported_price: 88000 }],
    });
    expect(mapPancakeProduct(p).variants[0].costPrice).toBe(88000);
  });

  it("is_hidden → status HIDDEN", () => {
    const hidden = pancakeProductSchema.parse({ id: "H1", name: "SP ẩn", is_hidden: true, variations: [] });
    expect(mapPancakeProduct(hidden).status).toBe("HIDDEN");
  });

  it("mặc định ACTIVE", () => {
    expect(mapPancakeProduct(parsed[0]).status).toBe("ACTIVE");
  });
});
