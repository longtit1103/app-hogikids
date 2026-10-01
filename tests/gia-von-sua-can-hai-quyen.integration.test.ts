import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => {
  const { nguoiDungGia } = await import("./helpers/nguoi-dung-gia");
  return {
    ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
    docNguoiDungPhien: vi.fn(async () => nguoiDungGia()),
  };
});
// `ghiNhatKy` chạy BẢN THẬT; ca "nhật ký hỏng ⇒ không lưu" ép nó ném một lần.
vi.mock("@/lib/nhat-ky/ghi-nhat-ky", async (goc) => {
  const that = await goc<typeof import("@/lib/nhat-ky/ghi-nhat-ky")>();
  return { ...that, ghiNhatKy: vi.fn(that.ghiNhatKy) };
});

import {
  importCostPrices,
  previewCostImport,
  updateProductCost,
  updateProductThreshold,
  updateVariantCost,
  updateVariantThreshold,
} from "@/lib/actions/cost-price";
import { ghiNhatKy } from "@/lib/nhat-ky/ghi-nhat-ky";
import { prisma } from "@/lib/prisma";
import type { Quyen } from "@/lib/quyen/danh-muc-quyen";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";
import { nguoiDungGia } from "./helpers/nguoi-dung-gia";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Sửa giá vốn đòi `san-pham:sua` ∧ `gia-von-loi-nhuan:xem`; sửa NGƯỠNG TỒN chỉ đòi `san-pham:sua`
 * (ngưỡng không phải dữ liệu giá vốn — không được mở rộng hạn chế). Kiểm TRÊN CÙNG MỘT tài khoản để
 * không có chuyện hai ca xanh nhờ hai bộ quyền khác nhau.
 */
const GIA_GOC = 50_000;
const staff = (id: string, quyen: Quyen[]) => nguoiDungGia({ id, role: "STAFF", quyen: new Set(quyen) });
const SUA_KHONG_GIA_VON = staff("staff-sp-khong-gia-von", ["san-pham:xem", "san-pham:sua"]);
const GIA_VON_KHONG_SUA = staff("staff-gia-von-khong-sua", ["san-pham:xem", "gia-von-loi-nhuan:xem"]);
const DU_HAI_QUYEN = staff("staff-du-hai-quyen", ["san-pham:xem", "san-pham:sua", "gia-von-loi-nhuan:xem"]);

let productId = "";
let variantId = "";

const bienThe = () => prisma.variant.findUniqueOrThrow({ where: { id: variantId } });
const nhatKy = (hanhDong: string) => prisma.auditLog.findMany({ where: { hanhDong }, orderBy: { thoiDiem: "asc" } });

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.auditLog.deleteMany();
  const sp = await prisma.product.create({ data: { pancakeId: "p-gv-quyen", name: "Váy thử", syncedAt: new Date() } });
  const bt = await prisma.variant.create({
    data: { pancakeId: "v-gv-quyen", productId: sp.id, sku: "SKU-GV-QUYEN", label: "M", costPrice: GIA_GOC, syncedAt: new Date() },
  });
  productId = sp.id;
  variantId = bt.id;
  vi.mocked(docNguoiDungPhien).mockReset().mockResolvedValue(nguoiDungGia());
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

describe("cùng một tài khoản san-pham:sua KHÔNG xem giá vốn", () => {
  beforeEach(() => {
    vi.mocked(docNguoiDungPhien).mockResolvedValue(SUA_KHONG_GIA_VON);
  });

  it("sửa ngưỡng tồn (biến thể + sản phẩm) ⇒ OK + NGUONG_TON_SUA", async () => {
    expect(await updateVariantThreshold(variantId, 4)).toEqual({ ok: true, data: undefined });
    expect(await updateProductThreshold(productId, 6)).toEqual({ ok: true, data: { updated: 1 } });

    expect((await bienThe()).lowStockThreshold).toBe(6);
    expect(await nhatKy("NGUONG_TON_SUA")).toEqual([
      expect.objectContaining({ ketQua: "OK", actorId: SUA_KHONG_GIA_VON.id, doiTuongLoai: "Variant", doiTuongId: variantId }),
      expect.objectContaining({ ketQua: "OK", doiTuongLoai: "Product", doiTuongId: productId, ghiChu: { soDong: 1 } }),
    ]);
  });

  it.each([
    ["updateVariantCost", () => updateVariantCost(variantId, 99_000)],
    ["updateProductCost", () => updateProductCost(productId, 99_000)],
    ["importCostPrices", () => importCostPrices([{ sku: "SKU-GV-QUYEN", costPrice: 99_000, lowStockThreshold: null }])],
    ["previewCostImport", () => previewCostImport([{ sku: "SKU-GV-QUYEN", costPrice: 99_000, lowStockThreshold: null }])],
  ] as const)("%s ⇒ KHONG_CO_QUYEN + TU_CHOI_QUYEN (thiếu xem giá vốn), giá vốn không đổi", async (_ten, goi) => {
    const r = await goi();

    expect(r).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    // Bước xem trước KHÔNG được lộ giá vốn đang có qua bảng so sánh.
    expect(JSON.stringify(r)).not.toContain(String(GIA_GOC));
    expect((await bienThe()).costPrice).toBe(GIA_GOC);
    expect(await nhatKy("TU_CHOI_QUYEN")).toEqual([
      expect.objectContaining({ ketQua: "LOI", actorId: SUA_KHONG_GIA_VON.id, ghiChu: { quyenThieu: "gia-von-loi-nhuan:xem" } }),
    ]);
    expect(await nhatKy("GIA_VON_SUA")).toEqual([]);
  });
});

it("xem được giá vốn mà KHÔNG san-pham:sua ⇒ sửa giá vốn bị từ chối vì thiếu san-pham:sua", async () => {
  vi.mocked(docNguoiDungPhien).mockResolvedValue(GIA_VON_KHONG_SUA);

  expect(await updateVariantCost(variantId, 99_000)).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
  expect(await updateVariantThreshold(variantId, 3)).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });

  expect((await bienThe()).costPrice).toBe(GIA_GOC);
  expect((await nhatKy("TU_CHOI_QUYEN")).map((d) => d.ghiChu)).toEqual([
    { quyenThieu: "san-pham:sua" },
    { quyenThieu: "san-pham:sua" },
  ]);
});

describe("đủ cả hai quyền ⇒ sửa + nhật ký đúng mã", () => {
  beforeEach(() => {
    vi.mocked(docNguoiDungPhien).mockResolvedValue(DU_HAI_QUYEN);
  });

  it("sửa biến thể, áp cả sản phẩm, import file ⇒ GIA_VON_SUA ×2 + GIA_VON_IMPORT", async () => {
    expect((await updateVariantCost(variantId, 61_000)).ok).toBe(true);
    expect((await updateProductCost(productId, 62_000)).ok).toBe(true);
    const imp = await importCostPrices([{ sku: "SKU-GV-QUYEN", costPrice: 63_000, lowStockThreshold: null }]);
    expect(imp.ok && imp.data.updatedVariants).toBe(1);

    expect((await bienThe()).costPrice).toBe(63_000);
    expect(await nhatKy("GIA_VON_SUA")).toEqual([
      expect.objectContaining({ actorId: DU_HAI_QUYEN.id, doiTuongLoai: "Variant", doiTuongId: variantId }),
      expect.objectContaining({ doiTuongLoai: "Product", doiTuongId: productId, ghiChu: { soDong: 1 } }),
    ]);
    expect(await nhatKy("GIA_VON_IMPORT")).toEqual([expect.objectContaining({ ketQua: "OK", ghiChu: { soDong: 1 } })]);
  });

  it("áp cho sản phẩm không còn biến thể ⇒ báo lỗi, KHÔNG có dòng nhật ký 'đã sửa'", async () => {
    expect((await updateProductCost("khong-ton-tai", 1_000)).ok).toBe(false);
    expect(await nhatKy("GIA_VON_SUA")).toEqual([]);
  });

  it("nhật ký ném ⇒ giá vốn không đổi (cùng transaction)", async () => {
    vi.mocked(ghiNhatKy).mockRejectedValueOnce(new Error("nhat-ky-hong")).mockRejectedValueOnce(new Error("nhat-ky-hong"));

    expect((await updateVariantCost(variantId, 70_000)).ok).toBe(false);
    expect((await importCostPrices([{ sku: "SKU-GV-QUYEN", costPrice: 71_000, lowStockThreshold: null }])).ok).toBe(false);

    expect((await bienThe()).costPrice).toBe(GIA_GOC);
  });
});
