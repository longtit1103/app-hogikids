import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { DieuHuongDon } from "@/components/orders/drawer-dau-don";
import { DrawerNoiDung } from "@/components/orders/drawer-noi-dung";
import { Sheet } from "@/components/ui/sheet";
import type { ThongTinPhuDon } from "@/lib/orders/don-hang-kieu-du-lieu";
import type { OrderDetail, OrderDetailChe, OrderDetailTheoQuyen } from "@/lib/queries/orders";

/** Đơn COMPLETED itemsTotal 160.000, voucher 0, phí sàn 15.000, 1 dòng SL 2 × 100.000 (giảm 40.000), vốn 40.000. */
const DON_CO_QUYEN: OrderDetail = {
  id: "o1",
  pancakeId: "p1",
  maSan: "SP2611270001",
  code: "DRAWER-01",
  status: "COMPLETED",
  orderedAt: new Date("2026-11-25T02:12:00Z"),
  statusChangedAt: new Date("2026-11-27T03:05:00Z"),
  channelId: "shopee",
  channelName: "Shopee",
  channelColor: "#ee4d2d",
  customerName: null,
  itemsTotal: 160_000,
  discount: 0,
  platformFeeEst: 15_000,
  returnedFee: 0,
  shipFeeCustomer: 0,
  syncedAt: new Date("2026-11-27T04:00:00Z"),
  items: [{ sku: "SKU-1", productName: "Áo thun bé", quantity: 2, unitPrice: 100_000, lineDiscount: 40_000, costPrice: 40_000 }],
  feeComponents: [],
  marketplaceFunded: 0,
  quyetToan: null,
  thongTinPhu: { dongThoiGian: [] },
};

function cheDon(o: OrderDetail): OrderDetailChe {
  const { items, ...phan } = o;
  return { ...phan, items: items.map(({ costPrice: _von, ...con }) => con) };
}

const co = (o: Partial<OrderDetail> = {}): OrderDetailTheoQuyen => ({ coQuyenGiaVon: true, ...DON_CO_QUYEN, ...o });
const che = (o: Partial<OrderDetail> = {}): OrderDetailTheoQuyen => ({
  coQuyenGiaVon: false,
  ...cheDon({ ...DON_CO_QUYEN, ...o }),
});

/** Mốc "bây giờ" của server — drawer phải dùng mốc này (như danh sách), không dùng giờ máy khách. */
const NOW_SERVER = new Date("2026-11-27T05:00:00Z");

const KHONG_MOC: ThongTinPhuDon = { dongThoiGian: [] };
const DIEU_HUONG: DieuHuongDon = { viTri: 2, tong: 7, hrefTruoc: "/don-hang?don=a", hrefSau: "/don-hang?don=b" };

/**
 * Vỏ `OrderDetailDrawer` đưa ruột vào cổng (portal) nên `renderToStaticMarkup` không thấy gì — dựng
 * thẳng ruột trong `Sheet` (cổng không dính vào ruột, tiêu đề vẫn có ngữ cảnh hộp thoại).
 */
function ve(
  order: OrderDetailTheoQuyen,
  thongTinPhu: ThongTinPhuDon | null = KHONG_MOC,
  dieuHuong: DieuHuongDon | null = DIEU_HUONG,
  now: Date = NOW_SERVER,
) {
  const html = renderToStaticMarkup(
    <Sheet open>
      <DrawerNoiDung order={order} thongTinPhu={thongTinPhu} dieuHuong={dieuHuong} now={now} onDong={() => {}} />
    </Sheet>,
  );
  // Chống kiểm "không chứa" đúng giả: ruột phải có mặt thật.
  expect(html).toContain(order.code);
  return html;
}

describe("drawer chi tiết đơn — che giá vốn + khối hoàn/hủy", () => {
  it("không quyền giá vốn: không Giá vốn, Lãi dòng, line-profit, ô Lãi đơn; vẫn có Tiền sau voucher và phí sàn", () => {
    const html = ve(che());
    expect(html).not.toContain("Giá vốn");
    expect(html).not.toContain("Lãi dòng");
    expect(html).not.toContain("line-profit");
    expect(html).not.toContain("Lãi đơn");
    // Cây dừng ở "Tiền sau voucher và phí sàn": không nhánh Giá vốn, không dòng Lãi đơn, không tên sản phẩm × SL của nhánh vốn.
    expect(html).not.toContain("Áo thun bé × 2");
    expect(html).toContain("Tiền sau voucher và phí sàn");
    expect(html).not.toContain("Thực nhận từ sàn");
  });

  it("có quyền: ô Lãi + cây cùng ra 65.000 ₫, lãi dòng 80.000 ₫", () => {
    const html = ve(co());
    expect(html).toContain("Lãi đơn");
    // 160.000 − 15.000 − 2 × 40.000 = 65.000, ở ô Lãi lẫn dòng "Lãi đơn" của cây.
    expect(html.split("65.000 ₫").length - 1).toBeGreaterThanOrEqual(2);
    expect(html).toMatch(/data-testid="line-profit"[^>]*>80\.000 ₫</);
    expect(html).toContain("biên 40,6%");
  });

  it("đơn hoàn: khối riêng, ô Lãi chỉ là phí sàn giữ, không tô như đơn lỗ", () => {
    const html = ve(co({ status: "RETURNED", returnedFee: 12_000 }));
    expect(html).toContain("Đơn không tính vào Lãi/Lỗ");
    expect(html).toContain("−12.000 ₫");
    expect(html).toContain("phí sàn giữ");
    expect(html).not.toContain("đơn lỗ");
    expect(html).not.toContain("text-tq-xau-chu");
    // Lãi dòng không có nghĩa với đơn hoàn/hủy.
    expect(html).toMatch(/data-testid="line-profit"[^>]*>—</);
  });

  it("đơn hoàn mà sàn không giữ phí: ô Lãi '—'", () => {
    const html = ve(co({ status: "CANCELLED", returnedFee: 0, platformFeeEst: 0 }));
    expect(html).toContain("sàn không giữ phí");
  });

  it("thiếu giá vốn: ô Lãi cảnh báo, không hiện biên", () => {
    const html = ve(co({ items: [{ ...DON_CO_QUYEN.items[0], costPrice: 0 }] }));
    expect(html).toContain("⚠ thiếu giá vốn");
    expect(html).toContain("⚠ chưa có giá vốn");
    expect(html).not.toContain("biên ");
  });

  it("dòng thời gian rỗng thì ẩn khối; không bao giờ có ghi chú đơn", () => {
    const rong = ve(co(), KHONG_MOC);
    expect(rong).not.toContain("Dòng thời gian trạng thái");
    expect(rong).not.toContain("Ghi chú đơn");
    expect(ve(co(), null)).not.toContain("Dòng thời gian trạng thái");

    const coMoc = ve(co(), {
      dongThoiGian: [
        { status: "PENDING", luc: new Date("2026-11-25T02:12:00Z"), hienTai: false },
        { status: "COMPLETED", luc: new Date("2026-11-27T03:05:00Z"), hienTai: true },
      ],
    });
    expect(coMoc).toContain("Dòng thời gian trạng thái");
    expect(coMoc).toContain("25/11 09:12");
    expect(coMoc).toContain("27/11 10:05");
    expect(coMoc).toContain("hiện tại");
    expect(coMoc).not.toContain("Ghi chú đơn");
  });

  it("điều hướng: ngoài lọc khi viTri null, nút tắt khi không có href", () => {
    const html = ve(co(), KHONG_MOC, { viTri: null, tong: 7, hrefTruoc: null, hrefSau: null });
    expect(html).toContain("ngoài lọc");
    expect(html.match(/disabled=""/g)?.length).toBe(2);

    const trongLoc = ve(co());
    expect(trongLoc).toContain("2 / 7");
    expect(trongLoc).toContain('href="/don-hang?don=a"');
    expect(trongLoc).toContain('href="/don-hang?don=b"');
  });

  it("đơn Shopee có mã sàn, đơn bán tại shop ghi 'Bán tại shop'", () => {
    expect(ve(co())).toContain("SP2611270001");
    const tai = ve(co({ channelId: "direct", channelName: "Bán trực tiếp", maSan: null, customerName: "Chị Lan" }));
    expect(tai).toContain("Bán tại shop");
    expect(tai).toContain("khách: Chị Lan");
  });

  it("đơn hủy kênh không phí thật mà sàn giữ phí: khối hoàn/hủy hiện số thực, khớp ô Lãi", () => {
    const html = ve(co({ status: "CANCELLED", channelId: "facebook", maSan: null, returnedFee: 4_000, platformFeeEst: 0 }));
    expect(html).not.toContain("sàn không giữ phí");
    expect(html).toMatch(/Phí sàn đơn hoàn\/hủy \(thực thu\)[\s\S]*4\.000 ₫/);
  });

  it("nhãn 'tạm tính' đơn hoàn/hủy tính theo mốc now của server, không theo giờ máy khách", () => {
    // Đơn TikTok hủy, sàn còn treo phí, đặt 20/10: còn trong cửa sổ 30 ngày nếu now = 15/11, đã quá nếu now = 27/11.
    const don = co({ status: "CANCELLED", channelId: "tiktok", orderedAt: new Date("2026-10-20T03:00:00Z"), returnedFee: 0, platformFeeEst: 30_000 });
    expect(ve(don, KHONG_MOC, DIEU_HUONG, new Date("2026-11-15T03:00:00Z"))).toContain("tạm tính");
    expect(ve(don, KHONG_MOC, DIEU_HUONG, new Date("2026-11-27T03:00:00Z"))).not.toContain("tạm tính");
  });

  it("kênh không phải bán trực tiếp không lộ tên khách", () => {
    expect(ve(co({ customerName: "Chị Lan" }))).not.toContain("Chị Lan");
  });
});
