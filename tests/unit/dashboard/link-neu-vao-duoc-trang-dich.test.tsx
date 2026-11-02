import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChuaSyncEmptyState } from "@/components/dashboard/chua-sync-empty-state";
import { coTheVaoHref, hrefDuocPhep } from "@/components/shell/nav-config";
import { BanChay } from "@/components/trang-chu/ban-chay";
import { LaiNhieuNenDay } from "@/components/trang-chu/lai-nhieu-nen-day";
import { SapHetHang } from "@/components/trang-chu/sap-het-hang";
import { TheoKenh } from "@/components/trang-chu/theo-kenh";
import { TinhTrangDon } from "@/components/trang-chu/tinh-trang-don";
import type { Quyen } from "@/lib/quyen/danh-muc-quyen";
import type { TheoKenh as DuTheoKenh, TinhTrangDon as DuTinhTrangDon } from "@/lib/trang-chu/kieu-du-lieu-trang-chu";

/**
 * Link trên trang chủ chỉ dựng khi người xem vào được trang đích (tập `hrefDuocPhep` do server tính).
 * Thiếu tập ⇒ mặc định KHÔNG link — không bao giờ "mở khi quên truyền".
 */

const ownerVaStaff = {
  xemDon: { role: "STAFF" as const, quyen: new Set<Quyen>(["tong-quan:xem", "don-hang:xem"]) },
  chiTongQuan: { role: "STAFF" as const, quyen: new Set<Quyen>(["tong-quan:xem"]) },
};

describe("coTheVaoHref", () => {
  it("so theo phần đường dẫn, bỏ ?query và #hash", () => {
    expect(coTheVaoHref(["/don-hang"], "/don-hang?trang_thai=huy_bom")).toBe(true);
    expect(coTheVaoHref(["/tai-chinh"], "/tai-chinh?tab=dong-tien#khoan-vay")).toBe(true);
    expect(coTheVaoHref(["/don-hang"], "/don-hang-khac")).toBe(false);
    expect(coTheVaoHref([], "/don-hang")).toBe(false);
  });
});

describe("TinhTrangDon — link sang /don-hang theo quyền", () => {
  const du: DuTinhTrangDon = {
    tong: 10,
    theoTrangThai: { COMPLETED: 6, SHIPPING: 2, PENDING: 1, RETURNED: 1, CANCELLED: 0 },
  };
  const ky = { tu: "2026-10-25", den: "2026-10-31" };

  it("thiếu don-hang:xem ⇒ không link /don-hang; có ⇒ link lọc theo trạng thái + kỳ", () => {
    const an = renderToStaticMarkup(<TinhTrangDon du={du} ky={ky} hrefDuocPhep={hrefDuocPhep(ownerVaStaff.chiTongQuan)} />);
    expect(an).toContain("Thành công");
    expect(an).not.toContain('href="/don-hang');
    expect(renderToStaticMarkup(<TinhTrangDon du={du} ky={ky} hrefDuocPhep={[]} />)).not.toContain('href="/don-hang');

    const hien = renderToStaticMarkup(<TinhTrangDon du={du} ky={ky} hrefDuocPhep={hrefDuocPhep(ownerVaStaff.xemDon)} />);
    expect(hien).toContain('href="/don-hang?trang_thai=hoan_thanh&amp;ngay_tu=2026-10-25&amp;ngay_den=2026-10-31"');
  });
});

describe("TheoKenh — link sang /kenh/<id> theo quyền", () => {
  const du: DuTheoKenh = {
    coQuyenGiaVon: false,
    rows: [{ channelId: "shopee", ten: "Shopee", doanhSo: 1_000_000, donHang: 3 }],
  };

  it("thiếu kenh:xem ⇒ dòng tĩnh; có ⇒ link", () => {
    const an = renderToStaticMarkup(<TheoKenh du={du} hrefDuocPhep={["/", "/don-hang"]} />);
    expect(an).toContain("Shopee");
    expect(an).not.toContain('href="/kenh');
    expect(renderToStaticMarkup(<TheoKenh du={du} hrefDuocPhep={["/kenh"]} />)).toContain('href="/kenh/shopee"');
  });
});

describe("ChuaSyncEmptyState — link Cài đặt", () => {
  it("thiếu cai-dat:xem ⇒ không link; chủ shop ⇒ có link", () => {
    const hrefsStaff = hrefDuocPhep(ownerVaStaff.xemDon);
    const hrefsChu = hrefDuocPhep({ role: "OWNER", quyen: new Set<Quyen>() });

    expect(renderToStaticMarkup(<ChuaSyncEmptyState hrefDuocPhep={hrefsStaff} />)).not.toContain('href="/cai-dat"');
    expect(renderToStaticMarkup(<ChuaSyncEmptyState hrefDuocPhep={hrefsChu} />)).toContain('href="/cai-dat"');
  });
});

describe("SapHetHang / BanChay / LaiNhieuNenDay — link sang trang cần quyền riêng", () => {
  const rows = [{ variantId: "v1", sku: "SKU-1", productName: "Áo", label: "M", stock: 2 }];
  const ban = [{ productId: "p1", ten: "Áo", soLuong: 1, doanhSo: 10_000 }];
  const lai = {
    top: [{ productId: "p1", ten: "Áo", loiNhuan: 5_000, soLuong: 1, laiMoiCai: 5_000, bienLai: 50, tonKho: 9, tonThap: false }],
    soThieuGiaVon: 0,
  };

  it("sắp hết hàng: thiếu ton-kho:xem ⇒ không link; có ⇒ link", () => {
    const an = renderToStaticMarkup(<SapHetHang rows={rows} total={1} hrefDuocPhep={["/", "/don-hang"]} />);
    expect(an).toContain("Áo · M");
    expect(an).not.toContain("href=");
    expect(renderToStaticMarkup(<SapHetHang rows={rows} total={1} hrefDuocPhep={["/ton-kho"]} />)).toContain(
      'href="/ton-kho?loc=sap_het"',
    );
  });

  it("bán chạy: thiếu bao-cao:xem ⇒ không link; có ⇒ link dòng sản phẩm", () => {
    const an = renderToStaticMarkup(<BanChay rows={ban} hrefDuocPhep={["/"]} />);
    expect(an).not.toContain("href=");
    expect(renderToStaticMarkup(<BanChay rows={ban} hrefDuocPhep={["/bao-cao"]} />)).toContain("sp=p1");
  });

  it("lãi nhiều – nên đẩy: thiếu bao-cao:xem ⇒ không link, không 'Xem tất cả'; có ⇒ cả hai", () => {
    const an = renderToStaticMarkup(<LaiNhieuNenDay du={lai} hrefDuocPhep={["/"]} />);
    expect(an).not.toContain("href=");
    expect(an).not.toContain("Xem tất cả");
    const hien = renderToStaticMarkup(<LaiNhieuNenDay du={lai} hrefDuocPhep={["/bao-cao"]} />);
    expect(hien).toContain("sp=p1");
    expect(hien).toContain("Xem tất cả");
  });
});
