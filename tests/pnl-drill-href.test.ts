import { describe, expect, it } from "vitest";

import { ORDER_STATUS_META, slugToStatus } from "@/lib/orders/order-status-meta";
import {
  EXCLUDED_ORDER_STATUS_SLUGS,
  VALID_ORDER_STATUS_SLUGS,
  resolvePnlDrillHref,
} from "@/lib/reports/pnl-drill-href";

/**
 * Href drill-down bảng P&L. Bất biến quan trọng nhất: mọi đích drill phải neo
 * ĐÚNG tháng đang hiển thị trên bảng — hàm KHÔNG nhận range toàn cục để không
 * thể lệch kỳ với con số vừa bấm. Riêng /don-hang còn phải mang bộ lọc trạng
 * thái, vì trang đó mặc định hiện cả đơn hoàn/hủy mà P&L không tính.
 */

const MONTH = new Date(2026, 5, 1); // Tháng 6/2026 (30 ngày)

/** Đọc query của href thành object phẳng cho dễ so sánh. */
function queryOf(href: string): Record<string, string> {
  const qs = href.split("?")[1] ?? "";
  return Object.fromEntries(new URLSearchParams(qs));
}

describe("resolvePnlDrillHref — link sổ chi phí /tai-chinh", () => {
  const ADS_HREF = "/tai-chinh?tab=so-chi-phi&danh_muc=ads";

  it("gắn tu/den = đầu/cuối tháng đang hiển thị khi URL không có param nào", () => {
    const out = resolvePnlDrillHref(ADS_HREF, MONTH);
    expect(out.split("?")[0]).toBe("/tai-chinh");
    expect(queryOf(out)).toEqual({
      tab: "so-chi-phi",
      danh_muc: "ads",
      tu: "2026-06-01",
      den: "2026-06-30",
    });
  });

  it("ghi đè tu/den có sẵn trong href bằng tháng đang hiển thị (không để kỳ lạ lọt qua)", () => {
    const out = resolvePnlDrillHref("/tai-chinh?tab=so-chi-phi&tu=2026-01-05&den=2026-01-09", MONTH);
    expect(queryOf(out)).toMatchObject({ tu: "2026-06-01", den: "2026-06-30" });
  });

  it("không tự thêm param `range` — tu/den là nguồn kỳ duy nhất của href drill", () => {
    expect(queryOf(resolvePnlDrillHref(ADS_HREF, MONTH)).range).toBeUndefined();
  });

  it("tính đúng ngày cuối cho tháng 28 và 31 ngày", () => {
    const feb = resolvePnlDrillHref(ADS_HREF, new Date(2026, 1, 1));
    expect(queryOf(feb)).toMatchObject({ tu: "2026-02-01", den: "2026-02-28" });

    const jul = resolvePnlDrillHref(ADS_HREF, new Date(2026, 6, 1));
    expect(queryOf(jul)).toMatchObject({ tu: "2026-07-01", den: "2026-07-31" });
  });

  it("neo theo tháng chứa `month` kể cả khi truyền ngày giữa tháng", () => {
    const out = resolvePnlDrillHref(ADS_HREF, new Date(2026, 5, 18, 23, 30));
    expect(queryOf(out)).toMatchObject({ tu: "2026-06-01", den: "2026-06-30" });
  });

  it("giữ nguyên danh_muc của cả 7 dòng chi phí", () => {
    for (const cat of ["ads", "shipping", "packaging", "return_bom", "fixed", "interest", "other"]) {
      const out = resolvePnlDrillHref(`/tai-chinh?tab=so-chi-phi&danh_muc=${cat}`, MONTH);
      expect(queryOf(out)).toMatchObject({ tab: "so-chi-phi", danh_muc: cat, tu: "2026-06-01", den: "2026-06-30" });
    }
  });

  it("không nhầm path khác chỉ trùng tiền tố chuỗi", () => {
    expect(resolvePnlDrillHref("/tai-chinh-abc?x=1", MONTH)).toBe("/tai-chinh-abc?x=1");
  });
});

describe("resolvePnlDrillHref — link COGS sang /bao-cao cũng neo tháng", () => {
  const COGS_HREF = "/bao-cao?tab=san-pham";

  it("gắn tu/den = trọn tháng đang hiển thị, giữ nguyên tab đích", () => {
    const out = resolvePnlDrillHref(COGS_HREF, MONTH);
    expect(queryOf(out)).toEqual({ tab: "san-pham", tu: "2026-06-01", den: "2026-06-30" });
  });

  it("neo cùng tháng với link sổ chi phí — 2 đích không được lệch kỳ nhau", () => {
    const cogs = queryOf(resolvePnlDrillHref(COGS_HREF, MONTH));
    const ledger = queryOf(resolvePnlDrillHref("/tai-chinh?tab=so-chi-phi&danh_muc=ads", MONTH));
    expect([cogs.tu, cogs.den]).toEqual([ledger.tu, ledger.den]);
  });
});

describe("resolvePnlDrillHref — link đơn hàng /don-hang", () => {
  const ORDERS_HREF = "/don-hang";

  it("neo kỳ bằng ngay_tu/ngay_den (schema query riêng của /don-hang, KHÔNG phải tu/den)", () => {
    const out = resolvePnlDrillHref(ORDERS_HREF, MONTH);
    expect(out.split("?")[0]).toBe("/don-hang");
    expect(queryOf(out)).toMatchObject({ ngay_tu: "2026-06-01", ngay_den: "2026-06-30" });
    expect(queryOf(out).tu).toBeUndefined();
    expect(queryOf(out).den).toBeUndefined();
  });

  it("lọc sẵn đúng 3 slug đơn hợp lệ để tổng bên Đơn hàng khớp dòng P&L vừa bấm", () => {
    expect(queryOf(resolvePnlDrillHref(ORDERS_HREF, MONTH)).trang_thai).toBe(
      "cho_xu_ly,dang_giao,hoan_thanh",
    );
  });

  it("không mang theo hoan_hang/huy_bom — P&L loại 2 trạng thái này khỏi doanh thu", () => {
    const slugs = queryOf(resolvePnlDrillHref(ORDERS_HREF, MONTH)).trang_thai.split(",");
    expect(slugs).not.toContain("hoan_hang");
    expect(slugs).not.toContain("huy_bom");
  });

  it("neo cùng tháng với các đích khác — chỉ khác tên param, không lệch kỳ", () => {
    const orders = queryOf(resolvePnlDrillHref(ORDERS_HREF, MONTH));
    const ledger = queryOf(resolvePnlDrillHref("/tai-chinh?tab=so-chi-phi&danh_muc=ads", MONTH));
    expect([orders.ngay_tu, orders.ngay_den]).toEqual([ledger.tu, ledger.den]);
  });

  it("giữ query có sẵn; trang_thai đã set trong href KHÔNG bị ghi đè (để dòng hoàn/hủy tự set riêng)", () => {
    const out = resolvePnlDrillHref("/don-hang?kenh=shopee&q=abc&trang_thai=huy_bom", MONTH);
    expect(queryOf(out)).toEqual({
      kenh: "shopee",
      q: "abc",
      trang_thai: "huy_bom",
      ngay_tu: "2026-06-01",
      ngay_den: "2026-06-30",
    });
  });

  it("tính đúng ngày cuối cho tháng 28 và 31 ngày", () => {
    expect(queryOf(resolvePnlDrillHref(ORDERS_HREF, new Date(2026, 1, 1)))).toMatchObject({
      ngay_tu: "2026-02-01",
      ngay_den: "2026-02-28",
    });
    expect(queryOf(resolvePnlDrillHref(ORDERS_HREF, new Date(2026, 6, 1)))).toMatchObject({
      ngay_tu: "2026-07-01",
      ngay_den: "2026-07-31",
    });
  });

  it("không nhầm path khác chỉ trùng tiền tố chuỗi", () => {
    expect(resolvePnlDrillHref("/don-hang-abc?x=1", MONTH)).toBe("/don-hang-abc?x=1");
  });
});

describe("VALID_ORDER_STATUS_SLUGS — chốt định nghĩa 'đơn hợp lệ'", () => {
  /**
   * Danh sách này DẪN XUẤT từ ORDER_STATUS_META (loại RETURNED/CANCELLED) nên
   * trạng thái mới tự lọt vào. Test dưới là chốt chặn CỐ Ý: thêm/đổi trạng thái
   * là nó đỏ, buộc người sửa xác nhận trạng thái mới có thật sự tính vào doanh
   * thu P&L không, thay vì đổi câm lặng ý nghĩa của link drill.
   */
  it("đúng 3 slug, đúng thứ tự, khớp ORDER_STATUS_META", () => {
    expect(VALID_ORDER_STATUS_SLUGS).toEqual(["cho_xu_ly", "dang_giao", "hoan_thanh"]);
  });

  it("là phần bù của RETURNED + CANCELLED trên toàn bộ ORDER_STATUS_META", () => {
    const excluded = [ORDER_STATUS_META.RETURNED.slug, ORDER_STATUS_META.CANCELLED.slug];
    const expected = Object.values(ORDER_STATUS_META)
      .map((m) => m.slug)
      .filter((slug) => !excluded.includes(slug));
    expect(VALID_ORDER_STATUS_SLUGS).toEqual(expected);
  });

  it("mọi slug đều parse ngược được thành OrderStatus (không có slug chết)", () => {
    expect(slugToStatus(VALID_ORDER_STATUS_SLUGS.join(","))).toEqual([
      "PENDING",
      "SHIPPING",
      "COMPLETED",
    ]);
  });
});

describe("resolvePnlDrillHref — đích khác giữ nguyên", () => {
  it("/san-pham giữ nguyên cả query lọc sẵn có", () => {
    expect(resolvePnlDrillHref("/san-pham?loc=thieu_gia_von", MONTH)).toBe(
      "/san-pham?loc=thieu_gia_von",
    );
  });
});

describe("resolvePnlDrillHref — dòng đơn hoàn/hủy tự set trang_thai riêng", () => {
  it("dòng đơn hoàn/hủy: giữ trang_thai đã set (hoan_hang,huy_bom), không bị ghi đè bằng slug hợp lệ", () => {
    const href = `/don-hang?trang_thai=${EXCLUDED_ORDER_STATUS_SLUGS.join(",")}`;
    const out = resolvePnlDrillHref(href, new Date("2026-05-15T00:00:00+07:00"));
    const params = new URLSearchParams(out.split("?")[1]);
    expect(params.get("trang_thai")).toBe(EXCLUDED_ORDER_STATUS_SLUGS.join(","));
    expect(params.get("ngay_tu")).toBe("2026-05-01");
    expect(params.get("ngay_den")).toBe("2026-05-31");
  });
});

/**
 * Dòng "Thu nhập tài chính" drill về đúng KHỐI Sổ tiết kiệm trong tab Dòng tiền, nên href của nó
 * mang neo `#tiet-kiem`. Hàm này neo kỳ bằng cách dựng lại query — neo phải đi qua nguyên vẹn,
 * nếu không nó bị nuốt vào giá trị param cuối cùng và link mở sai tab.
 */
describe("resolvePnlDrillHref — giữ nguyên neo #… của href drill", () => {
  it("neo #tiet-kiem sống sót, KHÔNG lọt vào giá trị param tab", () => {
    const out = resolvePnlDrillHref("/tai-chinh?tab=dong-tien#tiet-kiem", MONTH);
    expect(out.endsWith("#tiet-kiem")).toBe(true);
    const params = new URLSearchParams(out.split("?")[1].split("#")[0]);
    expect(params.get("tab")).toBe("dong-tien");
    expect(params.get("tu")).toBe("2026-06-01");
    expect(params.get("den")).toBe("2026-06-30");
    expect(out).not.toContain("%23");
  });

  it("đích KHÔNG neo kỳ vẫn giữ nguyên cả neo", () => {
    expect(resolvePnlDrillHref("/san-pham?loc=thieu_gia_von#top", MONTH)).toBe(
      "/san-pham?loc=thieu_gia_von#top",
    );
  });

  it("href không có neo thì không mọc dấu # thừa", () => {
    expect(resolvePnlDrillHref("/tai-chinh?tab=so-chi-phi&danh_muc=ads", MONTH)).not.toContain("#");
  });
});
