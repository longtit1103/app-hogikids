import { describe, expect, it } from "vitest";

import { ghepDeXuat, rutBienTheTuPayload } from "@/lib/gia-von/doi-chieu-gia-von";

/**
 * Logic thuần của script đối chiếu giá vốn (`scripts/doi-chieu-gia-von-pancake.ts`).
 * Việc này chạm `Variant.costPrice` — số APP-OWNED chủ shop sửa tay — nên luật ghép phải có test.
 */

const SP_KHO = {
  id: "P-1",
  name: "Bộ Lụa Áo",
  variations: [
    { id: "V-A", display_id: "SP000463", average_imported_price: 181149, last_imported_price: 180000 },
    { id: "V-B", display_id: "SP000464", average_imported_price: 0, last_imported_price: 95000 },
    { id: "V-C", display_id: "SP000465", average_imported_price: 0, last_imported_price: 0 },
  ],
};

/** App chưa nhập giá vốn dòng nào — bối cảnh của chế độ mặc định. */
const APP = [
  { id: "v1", pancakeId: "V-A", sku: "SP000463", label: "90/Đỏ", costPrice: 0 },
  { id: "v2", pancakeId: "V-B", sku: "SP000464", label: "100/Đỏ", costPrice: 0 },
  { id: "v3", pancakeId: "V-C", sku: "SP000465", label: "110/Đỏ", costPrice: 0 },
];

describe("rutBienTheTuPayload", () => {
  it("rút uuid + SKU + 2 mức giá từ payload sản phẩm kho", () => {
    const ket = rutBienTheTuPayload(SP_KHO);

    expect(ket).toHaveLength(3);
    expect(ket[0]).toMatchObject({ pancakeId: "V-A", sku: "SP000463", giaTrungBinh: 181149 });
  });

  it("payload webhook (KHÔNG có giá vốn) → mọi giá = 0, không ném lỗi", () => {
    const webhook = { id: "P-1", name: "Áo", variations: [{ id: "V-A", display_id: "SP1", retail_price: 241000 }] };

    const ket = rutBienTheTuPayload(webhook);

    expect(ket[0]).toMatchObject({ giaTrungBinh: 0, giaNhapCuoi: 0 });
  });

  it("payload rác / thiếu variations → mảng rỗng", () => {
    expect(rutBienTheTuPayload(null)).toEqual([]);
    expect(rutBienTheTuPayload("chuỗi")).toEqual([]);
    expect(rutBienTheTuPayload({ id: "P", name: "X" })).toEqual([]);
  });

  it("biến thể thiếu `id` bị bỏ (không có khoá thì không ghép được)", () => {
    const ket = rutBienTheTuPayload({ name: "X", variations: [{ display_id: "SKU" }] });
    expect(ket).toEqual([]);
  });
});

describe("ghepDeXuat", () => {
  it("ưu tiên giá trung bình, thiếu thì lấy giá nhập cuối — cùng luật prefill lúc CREATE", () => {
    const ket = ghepDeXuat(APP, rutBienTheTuPayload(SP_KHO));

    expect(ket).toHaveLength(2); // V-C không có giá nào → không đề xuất
    expect(ket[0]).toMatchObject({ sku: "SP000463", giaDeXuat: 181149, nguon: "trung-binh" });
    expect(ket[1]).toMatchObject({ sku: "SP000464", giaDeXuat: 95000, nguon: "nhap-cuoi" });
  });

  it("khớp theo pancakeId chứ KHÔNG theo SKU (Pancake cho phép SKU trùng giữa sản phẩm)", () => {
    const appSkuTrungNhungUuidKhac = [
      { id: "v9", pancakeId: "V-KHAC", sku: "SP000463", label: "90/Đỏ", costPrice: 0 },
    ];

    expect(ghepDeXuat(appSkuTrungNhungUuidKhac, rutBienTheTuPayload(SP_KHO))).toEqual([]);
  });

  it("chênh lệch lớn xếp trước — sửa vài dòng đầu là bịt phần lớn sai lệch COGS", () => {
    const ket = ghepDeXuat(APP, rutBienTheTuPayload(SP_KHO));

    expect(ket.map((d) => d.giaDeXuat)).toEqual([181149, 95000]);
  });

  it("chế độ mặc định KHÔNG đụng dòng app đã có giá — số chủ shop nhập tay được giữ", () => {
    const daNhapTay = [{ id: "v1", pancakeId: "V-A", sku: "SP000463", label: "90/Đỏ", costPrice: 150000 }];

    expect(ghepDeXuat(daNhapTay, rutBienTheTuPayload(SP_KHO))).toEqual([]);
  });

  it("giá âm / không phải số → coi như KHÔNG có giá, không đề xuất bừa", () => {
    const ban = { name: "X", variations: [{ id: "V-A", average_imported_price: -5, last_imported_price: "rác" }] };

    expect(ghepDeXuat(APP, rutBienTheTuPayload(ban))).toEqual([]);
  });
});

describe("ghepDeXuat — chế độ `theo-pancake` (Pancake là chuẩn)", () => {
  const APP_DA_CO_SO = [
    { id: "v1", pancakeId: "V-A", sku: "SP000463", label: "90/Đỏ", costPrice: 150000 }, // lệch: app cao hơn
    { id: "v2", pancakeId: "V-B", sku: "SP000464", label: "100/Đỏ", costPrice: 95000 }, // đã khớp Pancake
    { id: "v3", pancakeId: "V-C", sku: "SP000465", label: "110/Đỏ", costPrice: 70000 }, // Pancake chưa khai giá
  ];

  it("đề xuất cả dòng app đã có số, bỏ dòng đã khớp", () => {
    const ket = ghepDeXuat(APP_DA_CO_SO, rutBienTheTuPayload(SP_KHO), "theo-pancake");

    expect(ket).toHaveLength(1);
    expect(ket[0]).toMatchObject({ sku: "SP000463", giaHienTai: 150000, giaDeXuat: 181149 });
  });

  it("Pancake chưa khai giá (0đ) thì KHÔNG bao giờ đề xuất — ghi vào là xoá trắng số app đang giữ", () => {
    const ket = ghepDeXuat(APP_DA_CO_SO, rutBienTheTuPayload(SP_KHO), "theo-pancake");

    expect(ket.map((d) => d.sku)).not.toContain("SP000465");
  });

  it("app rẻ hơn hay đắt hơn Pancake đều được đề xuất — sửa theo cả hai chiều", () => {
    const haiChieu = [
      { id: "v1", pancakeId: "V-A", sku: "SP000463", label: "90/Đỏ", costPrice: 181000 }, // app thấp hơn 149đ
      { id: "v2", pancakeId: "V-B", sku: "SP000464", label: "100/Đỏ", costPrice: 200000 }, // app cao hơn 105.000đ
    ];

    const ket = ghepDeXuat(haiChieu, rutBienTheTuPayload(SP_KHO), "theo-pancake");

    expect(ket.map((d) => d.sku)).toEqual(["SP000464", "SP000463"]); // chênh lớn xếp trước
    expect(ket[0].giaDeXuat - ket[0].giaHienTai).toBe(-105000);
  });

  it("dòng app còn trống vẫn được điền ở chế độ này (bao trùm chế độ mặc định)", () => {
    const ket = ghepDeXuat(APP, rutBienTheTuPayload(SP_KHO), "theo-pancake");

    expect(ket.map((d) => d.sku)).toEqual(["SP000463", "SP000464"]);
    expect(ket.every((d) => d.giaHienTai === 0)).toBe(true);
  });
});
