import { describe, expect, it } from "vitest";

import {
  docThamSoDonHang,
  hrefDonHang,
  hrefMoDonHang,
  nhanKyDonHang,
  queryXuatDonHang,
} from "@/lib/orders/doc-tham-so-don-hang";

/**
 * Bộ đọc URL trang Đơn hàng là LỚP 1 của che giá vốn: tham số lọc/sắp theo lãi mà người không có
 * quyền giá vốn tự gõ phải bị bỏ ngay tại đây (lớp 2 là hàm truy vấn). Mốc giờ theo VN (setup ép TZ).
 */
const now = new Date(2026, 10, 27, 16, 40);
const DAY = { coQuyenGiaVon: true };
const CHE = { coQuyenGiaVon: false };

describe("docThamSoDonHang — kỳ", () => {
  it("URL rỗng ⇒ trọn tháng này (mặc định), sắp Mới nhất, trang 1, không lọc", () => {
    const b = docThamSoDonHang({}, DAY, now);
    expect(b.ky).toEqual({
      loai: "khoang",
      from: new Date(2026, 10, 1, 0, 0, 0, 0),
      to: new Date(2026, 10, 30, 23, 59, 59, 999),
      nguon: "mac_dinh",
    });
    expect(b).toMatchObject({ statuses: [], channels: [], q: "", loc: [], sx: "moi", trang: 1, don: null });
  });

  it("ky=tat_ca ⇒ tất cả thời gian", () => {
    expect(docThamSoDonHang({ ky: "tat_ca" }, DAY, now).ky).toEqual({ loai: "tat_ca" });
  });

  it("ngày hợp lệ thắng ky=tat_ca", () => {
    const b = docThamSoDonHang({ ky: "tat_ca", ngay_tu: "2026-10-01", ngay_den: "2026-10-31" }, DAY, now);
    expect(b.ky).toEqual({
      loai: "khoang",
      from: new Date(2026, 9, 1, 0, 0, 0, 0),
      to: new Date(2026, 9, 31, 23, 59, 59, 999),
      nguon: "url",
    });
  });

  it("thiếu một vế ngày ⇒ mặc định Tháng này", () => {
    const b = docThamSoDonHang({ ngay_tu: "2026-10-01" }, DAY, now);
    expect(b.ky).toMatchObject({ loai: "khoang", nguon: "mac_dinh", from: new Date(2026, 10, 1) });
  });

  it("ngày sai khuôn ⇒ mặc định Tháng này", () => {
    const b = docThamSoDonHang({ ngay_tu: "26-10-01", ngay_den: "2026-10-31" }, DAY, now);
    expect(b.ky).toMatchObject({ loai: "khoang", nguon: "mac_dinh", from: new Date(2026, 10, 1) });
  });

  it("ngày đảo ngược ⇒ mặc định Tháng này", () => {
    const b = docThamSoDonHang({ ngay_tu: "2026-10-31", ngay_den: "2026-10-01" }, DAY, now);
    expect(b.ky).toMatchObject({ loai: "khoang", nguon: "mac_dinh" });
  });

  it("ky lạ (khác tat_ca) bị bỏ qua ⇒ mặc định", () => {
    expect(docThamSoDonHang({ ky: "abc" }, DAY, now).ky).toMatchObject({ loai: "khoang", nguon: "mac_dinh" });
  });
});

describe("docThamSoDonHang — trạng thái, kênh, tìm, trang, đơn", () => {
  it("slug trạng thái: bỏ slug lạ và trùng, giữ thứ tự xuất hiện", () => {
    expect(docThamSoDonHang({ trang_thai: "hoan_hang,huy_bom,xyz,hoan_hang" }, DAY, now).statuses).toEqual([
      "RETURNED",
      "CANCELLED",
    ]);
  });

  it("kênh: bỏ rỗng, bỏ trùng, trim", () => {
    expect(docThamSoDonHang({ kenh: "tiktok,,tiktok,shopee" }, DAY, now).channels).toEqual(["tiktok", "shopee"]);
    expect(docThamSoDonHang({ kenh: " tiktok , shopee " }, DAY, now).channels).toEqual(["tiktok", "shopee"]);
  });

  it("kênh: tối đa 10 id", () => {
    const kenh = Array.from({ length: 15 }, (_, i) => `k${i}`).join(",");
    expect(docThamSoDonHang({ kenh }, DAY, now).channels).toHaveLength(10);
  });

  it("q: trim hai đầu, cắt 100 ký tự", () => {
    expect(docThamSoDonHang({ q: "  ab  " }, DAY, now).q).toBe("ab");
    expect(docThamSoDonHang({ q: "a".repeat(150) }, DAY, now).q).toHaveLength(100);
  });

  it("q: cắt theo ký tự thật, không tách đôi emoji", () => {
    const q = docThamSoDonHang({ q: "😀".repeat(150) }, DAY, now).q;
    expect(Array.from(q)).toHaveLength(100);
    expect(q).toBe("😀".repeat(100));
  });

  it("trang rác ⇒ 1; trang hợp lệ giữ", () => {
    expect(docThamSoDonHang({ trang: "abc" }, DAY, now).trang).toBe(1);
    expect(docThamSoDonHang({ trang: "0" }, DAY, now).trang).toBe(1);
    expect(docThamSoDonHang({ trang: "4" }, DAY, now).trang).toBe(4);
  });

  it("don: trim, rỗng ⇒ null", () => {
    expect(docThamSoDonHang({ don: "  abc  " }, DAY, now).don).toBe("abc");
    expect(docThamSoDonHang({ don: "   " }, DAY, now).don).toBeNull();
  });
});

describe("docThamSoDonHang — chip lọc và sắp xếp theo quyền giá vốn", () => {
  it("loc có quyền ⇒ đủ 3 chip hợp lệ, khoá lạ bỏ", () => {
    expect(docThamSoDonHang({ loc: "lo,thieu_gv,phi_tam,abc" }, DAY, now).loc).toEqual(["lo", "thieu_gv", "phi_tam"]);
  });

  it("loc KHÔNG quyền ⇒ bỏ chip suy ra từ giá vốn (lo, thieu_gv)", () => {
    expect(docThamSoDonHang({ loc: "lo,thieu_gv,phi_tam,abc" }, CHE, now).loc).toEqual(["phi_tam"]);
    expect(docThamSoDonHang({ loc: "lo" }, CHE, now).loc).toEqual([]);
    expect(docThamSoDonHang({ loc: "thieu_gv" }, CHE, now).loc).toEqual([]);
  });

  it("loc bỏ trùng", () => {
    expect(docThamSoDonHang({ loc: "phi_tam,phi_tam" }, DAY, now).loc).toEqual(["phi_tam"]);
  });

  it("sx theo lãi KHÔNG quyền ⇒ ép Mới nhất", () => {
    expect(docThamSoDonHang({ sx: "lai_thap" }, CHE, now).sx).toBe("moi");
    expect(docThamSoDonHang({ sx: "lai_cao" }, CHE, now).sx).toBe("moi");
  });

  it("sx theo lãi có quyền ⇒ giữ", () => {
    expect(docThamSoDonHang({ sx: "lai_thap" }, DAY, now).sx).toBe("lai_thap");
    expect(docThamSoDonHang({ sx: "lai_cao" }, DAY, now).sx).toBe("lai_cao");
  });

  it("sx không cần quyền giữ cho cả người không quyền", () => {
    expect(docThamSoDonHang({ sx: "tien_cao" }, CHE, now).sx).toBe("tien_cao");
    expect(docThamSoDonHang({ sx: "cu" }, CHE, now).sx).toBe("cu");
  });

  it("sx lạ ⇒ Mới nhất", () => {
    expect(docThamSoDonHang({ sx: "zzz" }, DAY, now).sx).toBe("moi");
  });

  it("URL dò của người không quyền (loc=thieu_gv&sx=lai_thap) ⇒ không còn dấu vết lãi", () => {
    const b = docThamSoDonHang({ loc: "thieu_gv", sx: "lai_thap" }, CHE, now);
    expect(b.loc).toEqual([]);
    expect(b.sx).toBe("moi");
  });
});

describe("hrefDonHang", () => {
  it("đổi bộ lọc ⇒ bỏ trang", () => {
    expect(hrefDonHang({ trang: "3", kenh: "tiktok" }, { loc: "lo" })).toBe("/don-hang?kenh=tiktok&loc=lo");
  });

  it("chỉ đổi đơn mở drawer ⇒ giữ trang", () => {
    expect(hrefDonHang({ trang: "3" }, { don: "x" })).toBe("/don-hang?trang=3&don=x");
  });

  it("‹ › sang trang khác: đổi cả don lẫn trang", () => {
    expect(hrefDonHang({ trang: "3", don: "a" }, { don: "b", trang: "4" })).toBe("/don-hang?trang=4&don=b");
  });

  it("đổi bộ lọc mà vẫn chỉ định trang ⇒ dùng trang chỉ định", () => {
    expect(hrefDonHang({ trang: "3" }, { kenh: "tiktok", trang: "2" })).toBe("/don-hang?trang=2&kenh=tiktok");
  });

  it("đặt ky ⇒ bỏ hai ngày", () => {
    expect(hrefDonHang({ ngay_tu: "2026-11-01", ngay_den: "2026-11-30" }, { ky: "tat_ca" })).toBe(
      "/don-hang?ky=tat_ca",
    );
  });

  it("đặt ngày ⇒ bỏ ky", () => {
    const href = hrefDonHang({ ky: "tat_ca" }, { ngay_tu: "2026-10-01", ngay_den: "2026-10-31" });
    expect(href).toBe("/don-hang?ngay_tu=2026-10-01&ngay_den=2026-10-31");
    expect(href).not.toContain("ky=");
  });

  it("rỗng ⇒ /don-hang", () => {
    expect(hrefDonHang({}, {})).toBe("/don-hang");
  });

  it("khoá lạ được giữ", () => {
    expect(hrefDonHang({ abc: "1" }, {})).toBe("/don-hang?abc=1");
    expect(hrefDonHang({ abc: "1", trang: "2" }, { q: "ao" })).toBe("/don-hang?abc=1&q=ao");
  });

  it("null hoặc chuỗi rỗng ⇒ xoá tham số", () => {
    expect(hrefDonHang({ kenh: "tiktok", q: "ao" }, { kenh: null, q: "" })).toBe("/don-hang");
  });

  it("trang=1 và sx=moi là mặc định ⇒ không ghi lên URL", () => {
    expect(hrefDonHang({ trang: "3" }, { trang: "1" })).toBe("/don-hang");
    expect(hrefDonHang({ sx: "lai_thap" }, { sx: "moi" })).toBe("/don-hang");
  });

  it("xoá lọc: bỏ q, kenh, loc, trang_thai, trang — giữ kỳ và sắp xếp", () => {
    const href = hrefDonHang(
      { ngay_tu: "2026-11-01", ngay_den: "2026-11-30", sx: "tien_cao", q: "ao", kenh: "tiktok", loc: "phi_tam", trang_thai: "hoan_hang", trang: "2" },
      { q: null, kenh: null, loc: null, trang_thai: null, trang: null },
    );
    expect(href).toBe("/don-hang?ngay_tu=2026-11-01&ngay_den=2026-11-30&sx=tien_cao");
  });

  it("giữ dấu phẩy dễ đọc trong giá trị nhiều phần tử", () => {
    expect(hrefDonHang({}, { trang_thai: "cho_xu_ly,dang_giao,hoan_thanh" })).toBe(
      "/don-hang?trang_thai=cho_xu_ly,dang_giao,hoan_thanh",
    );
  });

  it("mã hoá ký tự đặc biệt trong ô tìm", () => {
    const href = hrefDonHang({}, { q: "a&b=c" });
    expect(new URLSearchParams(href.split("?")[1]).get("q")).toBe("a&b=c");
  });
});

describe("hrefMoDonHang — link 'mở đơn này' từ màn khác", () => {
  it("kèm ky=tat_ca: đơn tháng trước vẫn nằm trong danh sách phía sau drawer (‹ › không 'ngoài lọc')", () => {
    expect(hrefMoDonHang("abc")).toBe("/don-hang?ky=tat_ca&don=abc");
    const p = new URL(hrefMoDonHang("a b&c"), "http://x").searchParams;
    expect(p.get("don")).toBe("a b&c");
    expect(p.get("ky")).toBe("tat_ca");
  });
});

describe("queryXuatDonHang", () => {
  it("bỏ trang và don, giữ phần còn lại", () => {
    expect(queryXuatDonHang({ trang: "2", don: "x", kenh: "shopee" })).toBe("kenh=shopee");
  });

  it("rỗng ⇒ chuỗi rỗng", () => {
    expect(queryXuatDonHang({})).toBe("");
    expect(queryXuatDonHang({ trang: "2", don: "x" })).toBe("");
  });

  it("giữ kỳ, lọc và sắp xếp", () => {
    expect(queryXuatDonHang({ ky: "tat_ca", loc: "phi_tam", sx: "tien_cao", q: "" })).toBe(
      "ky=tat_ca&loc=phi_tam&sx=tien_cao",
    );
  });
});

describe("nhanKyDonHang", () => {
  it("khoảng ngày ⇒ dd/MM/yyyy – dd/MM/yyyy giờ VN", () => {
    expect(
      nhanKyDonHang({
        loai: "khoang",
        from: new Date(2026, 10, 1, 0, 0, 0, 0),
        to: new Date(2026, 10, 30, 23, 59, 59, 999),
        nguon: "mac_dinh",
      }),
    ).toBe("01/11/2026 – 30/11/2026");
  });

  it("tất cả thời gian", () => {
    expect(nhanKyDonHang({ loai: "tat_ca" })).toBe("Tất cả thời gian");
  });
});
