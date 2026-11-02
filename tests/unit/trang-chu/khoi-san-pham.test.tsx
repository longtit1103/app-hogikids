import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BanChay } from "@/components/trang-chu/ban-chay";
import { LaiNhieuNenDay } from "@/components/trang-chu/lai-nhieu-nen-day";
import { SapHetHang } from "@/components/trang-chu/sap-het-hang";
import type { LowStockPreviewRow } from "@/lib/queries/variants";
import type { DongBanChay } from "@/lib/trang-chu/kieu-du-lieu-trang-chu";
import type { DongLaiSanPham } from "@/lib/trang-chu/xep-hang-lai-san-pham";

const CHU_THICH = "Lãi tính trước phí sàn, voucher, quảng cáo. Tồn đỏ = có size sắp hết.";

const dongLai = (o: Partial<DongLaiSanPham> & Pick<DongLaiSanPham, "productId" | "ten">): DongLaiSanPham => ({
  loiNhuan: 1_000_000,
  soLuong: 10,
  laiMoiCai: 100_000,
  bienLai: 40,
  tonKho: 25,
  tonThap: false,
  ...o,
});

const top: DongLaiSanPham[] = [
  dongLai({ productId: "p1", ten: "Áo thun gấu", loiNhuan: 5_000_000, soLuong: 50, laiMoiCai: 100_000, bienLai: 42.5 }),
  dongLai({ productId: "p2", ten: "Quần short", loiNhuan: 3_000_000, tonThap: true, tonKho: 4 }),
  dongLai({ productId: "p3", ten: "Váy hoa", laiMoiCai: null, bienLai: 30 }),
];

describe("LaiNhieuNenDay", () => {
  it("giữ đúng thứ tự props, đủ cột, chú thích bắt buộc", () => {
    const html = renderToStaticMarkup(<LaiNhieuNenDay du={{ top, soThieuGiaVon: 0 }} hrefDuocPhep={["/bao-cao"]} />);
    expect(html).toContain("Lãi nhiều – nên đẩy");
    expect(html).toContain("xếp theo tổng lãi trong kỳ");
    for (const cot of ["Sản phẩm", "Lãi/cái", "Biên", "Tồn"]) expect(html).toContain(cot);
    expect(html.indexOf("Áo thun gấu")).toBeLessThan(html.indexOf("Quần short"));
    expect(html.indexOf("Quần short")).toBeLessThan(html.indexOf("Váy hoa"));
    expect(html).toContain("lãi 5.000.000 ₫ · 50 cái");
    expect(html).toContain("100.000 ₫");
    expect(html).not.toContain("tr ₫");
    expect(html).toContain("42,5%");
    expect(html).toContain(CHU_THICH);
    expect(html).not.toContain("thiếu giá vốn");
  });

  it("lãi/cái hiện đủ số, không làm tròn triệu: 110.000 khác 140.000, 35.000 không thành 0tr", () => {
    const html = renderToStaticMarkup(
      <LaiNhieuNenDay
        du={{
          top: [
            dongLai({ productId: "a", ten: "A", laiMoiCai: 110_000 }),
            dongLai({ productId: "b", ten: "B", laiMoiCai: 140_000 }),
            dongLai({ productId: "c", ten: "C", laiMoiCai: 35_000 }),
          ],
          soThieuGiaVon: 0,
        }}
        hrefDuocPhep={[]}
      />
    );
    expect(html).toContain("110.000 ₫");
    expect(html).toContain("140.000 ₫");
    expect(html).toContain("35.000 ₫");
    expect(html).not.toContain("0tr");
  });

  it("tên sản phẩm dài được phép xuống 2 dòng (line-clamp-2), không cắt một dòng; số căn phải tabular-nums", () => {
    const html = renderToStaticMarkup(<LaiNhieuNenDay du={{ top: [top[0]], soThieuGiaVon: 0 }} hrefDuocPhep={[]} />);
    expect(html).toContain("line-clamp-2");
    expect(html).not.toMatch(/block truncate text-sm font-semibold/);
    expect(html).toContain("tabular-nums");
  });

  it("soThieuGiaVon đi qua formatSoDem (1.234, không 1234)", () => {
    const html = renderToStaticMarkup(<LaiNhieuNenDay du={{ top, soThieuGiaVon: 1234 }} hrefDuocPhep={["/san-pham"]} />);
    expect(html).toContain("1.234 sản phẩm thiếu giá vốn");
  });

  it("Lãi/cái âm (không còn xảy ra sau lọc nhưng phòng thủ) KHÔNG tô xanh", () => {
    const html = renderToStaticMarkup(
      <LaiNhieuNenDay du={{ top: [dongLai({ productId: "x", ten: "Lỗ", laiMoiCai: -50_000 })], soThieuGiaVon: 0 }} hrefDuocPhep={[]} />
    );
    expect(html).not.toContain("text-tq-loi-nhuan-chu");
    expect(html).toContain("text-tq-xau-chu");
  });

  it("laiMoiCai null ⇒ —", () => {
    const html = renderToStaticMarkup(<LaiNhieuNenDay du={{ top: [top[2]], soThieuGiaVon: 0 }} hrefDuocPhep={[]} />);
    expect(html).toContain("—");
  });

  it("tonThap ⇒ huy hiệu tq-xau + title; không thấp ⇒ không", () => {
    const thap = renderToStaticMarkup(<LaiNhieuNenDay du={{ top: [top[1]], soThieuGiaVon: 0 }} hrefDuocPhep={[]} />);
    expect(thap).toContain("bg-tq-xau-nen");
    expect(thap).toContain("text-tq-xau-chu");
    expect(thap).toContain("Có size sắp hết — nhập thêm trước khi đẩy");
    const on = renderToStaticMarkup(<LaiNhieuNenDay du={{ top: [top[0]], soThieuGiaVon: 0 }} hrefDuocPhep={[]} />);
    expect(on).not.toContain("tq-xau");
  });

  it("soThieuGiaVon>0 ⇒ dòng đếm; có quyền /san-pham ⇒ link bộ lọc; không ⇒ chữ tĩnh", () => {
    const co = renderToStaticMarkup(<LaiNhieuNenDay du={{ top, soThieuGiaVon: 3 }} hrefDuocPhep={["/san-pham"]} />);
    expect(co).toContain("3 sản phẩm thiếu giá vốn chưa xếp hạng");
    expect(co).toContain('href="/san-pham?loc=da_ban_thieu_gia_von"');
    const khong = renderToStaticMarkup(<LaiNhieuNenDay du={{ top, soThieuGiaVon: 3 }} hrefDuocPhep={["/bao-cao"]} />);
    expect(khong).toContain("3 sản phẩm thiếu giá vốn chưa xếp hạng");
    expect(khong).not.toContain('href="/san-pham');
  });

  it("link 'Xem tất cả' và dòng chỉ khi có quyền /bao-cao", () => {
    const co = renderToStaticMarkup(<LaiNhieuNenDay du={{ top, soThieuGiaVon: 0 }} hrefDuocPhep={["/bao-cao"]} />);
    expect(co).toContain("Xem tất cả");
    expect(co).toContain('href="/bao-cao?tab=san-pham"');
    expect(co).toContain('href="/bao-cao?tab=san-pham&amp;sp=p1"');
    const khong = renderToStaticMarkup(<LaiNhieuNenDay du={{ top, soThieuGiaVon: 0 }} hrefDuocPhep={[]} />);
    expect(khong).not.toContain("href=");
    expect(khong).not.toContain("Xem tất cả");
    expect(khong).toContain("Áo thun gấu");
  });

  it("rỗng ⇒ thông báo, vẫn hiện dòng thiếu giá vốn + chú thích", () => {
    const html = renderToStaticMarkup(<LaiNhieuNenDay du={{ top: [], soThieuGiaVon: 2 }} hrefDuocPhep={[]} />);
    expect(html).toContain("Chưa có sản phẩm đủ giá vốn để xếp hạng.");
    expect(html).toContain("2 sản phẩm thiếu giá vốn");
  });
});

const rowsBan: DongBanChay[] = [
  { productId: "a", ten: "Áo A", soLuong: 1234, doanhSo: 9_000_000 },
  { productId: "b", ten: "Quần B", soLuong: 5, doanhSo: 1_000_000 },
];

describe("BanChay", () => {
  it("giữ link /bao-cao?tab=san-pham&sp=<id> như TopProductsCard, chỉ khi có quyền", () => {
    const co = renderToStaticMarkup(<BanChay rows={rowsBan} hrefDuocPhep={["/bao-cao"]} />);
    expect(co).toContain("Bán chạy");
    expect(co).toContain("theo số lượng bán");
    expect(co).toContain('href="/bao-cao?tab=san-pham&amp;sp=a"');
    expect(co).toContain("1.234");
    expect(co.indexOf("Áo A")).toBeLessThan(co.indexOf("Quần B"));
    const khong = renderToStaticMarkup(<BanChay rows={rowsBan} hrefDuocPhep={[]} />);
    expect(khong).not.toContain("href=");
    expect(khong).toContain("Áo A");
  });

  it("rỗng ⇒ thông báo", () => {
    expect(renderToStaticMarkup(<BanChay rows={[]} hrefDuocPhep={[]} />)).toContain(
      "Chưa bán được sản phẩm nào trong kỳ."
    );
  });
});

const rowsTon: LowStockPreviewRow[] = [
  { variantId: "v1", sku: "S1", productName: "Áo A", label: "M", stock: 0 },
  { variantId: "v2", sku: "S2", productName: "Quần B", label: "L", stock: 3 },
];

describe("SapHetHang", () => {
  it("tổng mã qua formatSoDem (1.234 mã)", () => {
    const html = renderToStaticMarkup(<SapHetHang rows={rowsTon} total={1234} hrefDuocPhep={[]} />);
    expect(html).toContain("1.234 mã");
  });

  it("giữ link /ton-kho?loc=sap_het chỉ khi có quyền; hiển thị tổng mã + tồn", () => {
    const co = renderToStaticMarkup(<SapHetHang rows={rowsTon} total={7} hrefDuocPhep={["/ton-kho"]} />);
    expect(co).toContain("Sắp hết hàng");
    expect(co).toContain("7 mã");
    expect(co).toContain('href="/ton-kho?loc=sap_het"');
    expect(co).toContain("Áo A · M");
    expect(co).toContain("text-tq-xau-chu");
    const khong = renderToStaticMarkup(<SapHetHang rows={rowsTon} total={7} hrefDuocPhep={[]} />);
    expect(khong).not.toContain("href=");
    expect(khong).toContain("Quần B · L");
  });

  it("rỗng ⇒ thông báo", () => {
    expect(renderToStaticMarkup(<SapHetHang rows={[]} total={0} hrefDuocPhep={[]} />)).toContain(
      "Không có mã nào dưới ngưỡng."
    );
  });
});
