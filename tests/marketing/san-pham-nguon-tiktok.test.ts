import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { sanPhamNguonTiktok } from "@/lib/reports/marketing/san-pham-nguon-tiktok";

import { seedReference, truncateBusinessTables } from "../helpers/test-db";
import { landFixture } from "./helpers/land-fixture";

/**
 * BẢNG "SẢN PHẨM × NGUỒN" — nối tên qua `Product.code` (A3: id sản phẩm analytics CHÍNH LÀ
 * `Product.code`; đo đầy đủ ở checkpoint P2: 133/148 = 89,9% khớp).
 *
 * ~10% dòng hiện ID TRẦN là ĐÚNG, không phải lỗi và KHÔNG được ẩn dòng: sản phẩm ngốn hiển thị mà
 * app chưa có trong danh mục là THÔNG TIN. Ẩn đi là giấu đúng thứ chủ shop cần thấy.
 *
 * Ba tỉ lệ đều TÍNH LẠI từ tử/mẫu cộng được (A13 mục 5) và phải trùng chuỗi sàn trả — phép đối
 * chứng cho thấy định nghĩa của app khớp định nghĩa của sàn.
 */

const KY = (tu: string, den: string) => ({
  from: new Date(`${tu}T00:00:00+07:00`),
  to: new Date(`${den}T00:00:00+07:00`),
});
const SP_AO_DAI = "1733583824365520555";

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.rawTiktokShopAnalyticsProduct.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function seedSanPham(): Promise<void> {
  await prisma.product.create({
    data: { pancakeId: "p1", code: SP_AO_DAI, name: "Áo dài lụa", syncedAt: new Date() },
  });
}

describe("sanPhamNguonTiktok", () => {
  it("khối total: tên nối từ Product.code, ba tỉ lệ tính lại khớp chuỗi sàn", async () => {
    await seedSanPham();
    await landFixture("tiktok/analytics_products", "shop-products.json", "2026-08-19");

    const r = await sanPhamNguonTiktok(KY("2026-08-19", "2026-08-19"), "total");

    expect(r.dong).toHaveLength(3);
    const d = r.dong[0];
    expect(d.id).toBe(SP_AO_DAI);
    expect(d.ten).toBe("Áo dài lụa");
    expect(d.gmvSan).toBe(330_000);
    expect(d.donSan).toBe(1);
    expect(d.hienThi).toBe(5_156);
    expect(d.click).toBe(374);
    // Sàn trả "0.0725" / "0.0829" / "0.0027" — app tính lại từ 374/5156, 31/374, 1/374.
    expect(d.ctr).toBeCloseTo(0.0725, 4);
    expect(d.tiLeThemGio).toBeCloseTo(0.0829, 4);
    expect(d.tiLeClickRaDon).toBeCloseTo(0.0027, 4);
  });

  it("SP không nối được tên ⇒ hiện ID TRẦN, KHÔNG ẩn dòng", async () => {
    await seedSanPham();
    await landFixture("tiktok/analytics_products", "shop-products.json", "2026-08-19");

    const r = await sanPhamNguonTiktok(KY("2026-08-19", "2026-08-19"), "total");

    // Thứ tự: GMV giảm dần, rồi hiển thị giảm dần (41 > 20), rồi id — có chốt phụ để hai lượt
    // chạy không ra hai thứ tự khác nhau khi cả cột GMV cùng bằng 0.
    expect(r.dong.map((x) => x.ten)).toEqual([
      "Áo dài lụa",
      "1729557518640450219",
      "1729557551540701867",
    ]);
  });

  it("khối vắng ở SP nào thì SP đó không có dòng trong bảng của khối đó", async () => {
    await landFixture("tiktok/analytics_products", "shop-products.json", "2026-08-19");

    const aff = await sanPhamNguonTiktok(KY("2026-08-19", "2026-08-19"), "affiliate_video");
    expect(aff.dong.map((x) => x.id).sort()).toEqual([
      "1729557551540701867",
      SP_AO_DAI,
    ]);

    const live = await sanPhamNguonTiktok(KY("2026-08-19", "2026-08-19"), "seller_live");
    expect(live.dong.map((x) => x.id)).toEqual([SP_AO_DAI]);
  });

  it("khối shop_tab: không có khái niệm đơn ⇒ donSan/tiLeClickRaDon null, và không có thêm giỏ", async () => {
    await landFixture("tiktok/analytics_products", "shop-products.json", "2026-08-19");

    const r = await sanPhamNguonTiktok(KY("2026-08-19", "2026-08-19"), "shop_tab");
    const d = r.dong.find((x) => x.id === SP_AO_DAI)!;

    expect(d.hienThi).toBe(1_988);
    expect(d.click).toBe(105);
    expect(d.donSan).toBeNull();
    expect(d.tiLeClickRaDon).toBeNull();
    expect(d.tiLeThemGio).toBeNull();
  });

  it("cộng nhiều ngày; ngày ≤ mốc mà Bronze rỗng ⇒ số của dòng null", async () => {
    await landFixture("tiktok/analytics_products", "shop-products.json", "2026-08-19");
    await landFixture("tiktok/analytics_products", "shop-products.json", "2026-08-20");

    const du = await sanPhamNguonTiktok(KY("2026-08-19", "2026-08-20"), "total");
    expect(du.dong[0].hienThi).toBe(10_312);
    expect(du.dong[0].gmvSan).toBe(660_000);
    expect(du.soNgayThieu).toBe(0);

    await landFixture("tiktok/analytics_products", "shop-products.json", "2026-08-22");
    const hut = await sanPhamNguonTiktok(KY("2026-08-19", "2026-08-22"), "total");
    expect(hut.soNgayThieu).toBe(1); // 21/08
    expect(hut.mocSanSang).toBe("2026-08-22");
    expect(hut.dong[0].gmvSan).toBeNull();
    expect(hut.dong[0].ctr).toBeNull();
  });
});
