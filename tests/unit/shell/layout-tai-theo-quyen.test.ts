import { beforeEach, describe, expect, it, vi } from "vitest";

import { nguoiDungGia } from "../../helpers/nguoi-dung-gia";
import type { NguoiDung } from "@/lib/quyen/nguoi-dung-phien";
import type { Quyen } from "@/lib/quyen/danh-muc-quyen";

/** Người dùng phiên mà mock trả về — mỗi test đặt lại. */
let nguoiHienTai: NguoiDung | null = null;

vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => ({
  ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
  docNguoiDungPhien: async () => nguoiHienTai,
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

const nguon = vi.hoisted(() => ({
  docShopProfile: vi.fn(),
  countMissingCostVariants: vi.fn(),
  hasLowStockVariants: vi.fn(),
  getRecentDataErrorKinds: vi.fn(),
  hasBronzeBacklog: vi.fn(),
  docTrangThaiSaoLuu: vi.fn(),
  settingFindMany: vi.fn(),
  demKhoanVayCoKyChoDuyet: vi.fn(),
  docCanhBaoSapCan: vi.fn(),
}));

vi.mock("@/lib/shop-profile/doc-shop-profile", () => ({ docShopProfile: nguon.docShopProfile }));
vi.mock("@/lib/queries/variants", () => ({
  countMissingCostVariants: nguon.countMissingCostVariants,
  hasLowStockVariants: nguon.hasLowStockVariants,
}));
vi.mock("@/lib/queries/sync-health", () => ({ getRecentDataErrorKinds: nguon.getRecentDataErrorKinds }));
vi.mock("@/lib/bronze/bronze-only", () => ({ hasBronzeBacklog: nguon.hasBronzeBacklog }));
vi.mock("@/lib/backup/doc-trang-thai-sao-luu", () => ({ docTrangThaiSaoLuu: nguon.docTrangThaiSaoLuu }));
vi.mock("@/lib/prisma", () => ({ prisma: { setting: { findMany: nguon.settingFindMany } } }));
vi.mock("@/lib/so-quy/khoan-vay-queries", () => ({ demKhoanVayCoKyChoDuyet: nguon.demKhoanVayCoKyChoDuyet }));
vi.mock("@/lib/so-quy/du-bao-quy-queries", () => ({ docCanhBaoSapCan: nguon.docCanhBaoSapCan }));
vi.mock("@/lib/date-range-cookie-server", () => ({ docLuaChonDaLuu: async () => null }));
// Dấu lùi bản (chỉ OWNER) có suite riêng: `banner-lui-ban-layout.test.ts`.
vi.mock("@/lib/backup/dau-lui-ban", () => ({ docDauLuiBan: async () => null }));
// Khung client không liên quan tới phép đo "nguồn nào được gọi".
vi.mock("@/components/shell/shell-chrome", () => ({ ShellChrome: () => null }));
vi.mock("@/components/shell/date-range-provider", () => ({ DateRangeProvider: () => null }));

import AppLayout from "@/app/(app)/layout";

/** Đọc props truyền cho ShellChrome từ cây phần tử layout trả về. */
function propsShell(el: unknown): Record<string, unknown> {
  const goc = el as { props: { children: { props: Record<string, unknown> } } };
  return goc.props.children.props;
}

beforeEach(() => {
  vi.clearAllMocks();
  nguon.docShopProfile.mockResolvedValue({ shopName: "Shop thử" });
  nguon.countMissingCostVariants.mockResolvedValue(3);
  nguon.hasLowStockVariants.mockResolvedValue(true);
  nguon.getRecentDataErrorKinds.mockResolvedValue([]);
  nguon.hasBronzeBacklog.mockResolvedValue(false);
  nguon.docTrangThaiSaoLuu.mockResolvedValue({ muc: "tot" });
  nguon.settingFindMany.mockResolvedValue([]);
  nguon.demKhoanVayCoKyChoDuyet.mockResolvedValue(2);
  nguon.docCanhBaoSapCan.mockResolvedValue(null);
});

const MAU_KHO: Quyen[] = ["don-hang:xem", "san-pham:xem", "ton-kho:xem"];

describe("layout (app) tải theo quyền", () => {
  it("mẫu Kho: chỉ tồn thấp và hồ sơ shop được gọi", async () => {
    nguoiHienTai = nguoiDungGia({ role: "STAFF", quyen: new Set(MAU_KHO) });
    const el = await AppLayout({ children: null });

    expect(nguon.docShopProfile).toHaveBeenCalledTimes(1);
    expect(nguon.hasLowStockVariants).toHaveBeenCalledTimes(1);
    expect(nguon.countMissingCostVariants).not.toHaveBeenCalled();
    expect(nguon.getRecentDataErrorKinds).not.toHaveBeenCalled();
    expect(nguon.hasBronzeBacklog).not.toHaveBeenCalled();
    expect(nguon.docTrangThaiSaoLuu).not.toHaveBeenCalled();
    expect(nguon.settingFindMany).not.toHaveBeenCalled();
    expect(nguon.demKhoanVayCoKyChoDuyet).not.toHaveBeenCalled();
    expect(nguon.docCanhBaoSapCan).not.toHaveBeenCalled();

    const p = propsShell(el);
    expect(p.hrefDuocPhep).toEqual(["/don-hang", "/san-pham", "/ton-kho"]);
    // Không tải ⇒ không được suy banner từ dữ liệu rỗng.
    expect(p.lechGiaVon).toMatchObject({ muc: "khop" });
    expect(p.phieuNhapChuaGhi).toMatchObject({ muc: "khop" });
    expect(p.saoLuuCoVanDe).toBe(false);
    expect(p.missingCostCount).toBe(0);
  });

  it("chủ shop: đủ 10 nguồn, menu có Quản trị", async () => {
    nguoiHienTai = nguoiDungGia({ role: "OWNER" });
    const el = await AppLayout({ children: null });

    expect(nguon.docShopProfile).toHaveBeenCalledTimes(1);
    expect(nguon.countMissingCostVariants).toHaveBeenCalledTimes(1);
    expect(nguon.hasLowStockVariants).toHaveBeenCalledTimes(1);
    expect(nguon.getRecentDataErrorKinds).toHaveBeenCalledTimes(1);
    expect(nguon.hasBronzeBacklog).toHaveBeenCalledTimes(1);
    expect(nguon.docTrangThaiSaoLuu).toHaveBeenCalledTimes(1);
    expect(nguon.settingFindMany).toHaveBeenCalledTimes(2);
    expect(nguon.demKhoanVayCoKyChoDuyet).toHaveBeenCalledTimes(1);
    expect(nguon.docCanhBaoSapCan).toHaveBeenCalledTimes(1);
    expect(propsShell(el).hrefDuocPhep).toContain("/quan-tri");
  });

  it("giá vốn cần CẢ san-pham:xem và gia-von-loi-nhuan:xem", async () => {
    nguoiHienTai = nguoiDungGia({ role: "STAFF", quyen: new Set<Quyen>(["san-pham:xem"]) });
    await AppLayout({ children: null });
    expect(nguon.countMissingCostVariants).not.toHaveBeenCalled();

    vi.clearAllMocks();
    nguon.docShopProfile.mockResolvedValue({ shopName: "x" });
    nguon.settingFindMany.mockResolvedValue([]);
    nguoiHienTai = nguoiDungGia({
      role: "STAFF",
      quyen: new Set<Quyen>(["san-pham:xem", "gia-von-loi-nhuan:xem"]),
    });
    await AppLayout({ children: null });
    expect(nguon.countMissingCostVariants).toHaveBeenCalledTimes(1);
  });

  it("chỉ sổ quỹ: nạp khoản vay + dự báo quỹ, không nạp giá vốn/phiếu nhập", async () => {
    nguoiHienTai = nguoiDungGia({ role: "STAFF", quyen: new Set<Quyen>(["tai-chinh-so-quy:xem"]) });
    await AppLayout({ children: null });
    expect(nguon.demKhoanVayCoKyChoDuyet).toHaveBeenCalledTimes(1);
    expect(nguon.docCanhBaoSapCan).toHaveBeenCalledTimes(1);
    expect(nguon.settingFindMany).not.toHaveBeenCalled();
  });

  it("chưa đăng nhập ⇒ chuyển về đăng nhập, không nạp nguồn nào", async () => {
    nguoiHienTai = null;
    await expect(AppLayout({ children: null })).rejects.toThrow(/REDIRECT:\/dang-nhap/);
    expect(nguon.docShopProfile).not.toHaveBeenCalled();
  });
});
