import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Component client dùng hook điều hướng của Next; test render tĩnh chỉ cần chúng tồn tại.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/don-hang",
  useSearchParams: () => new URLSearchParams(),
}));

import { BangDonHang } from "@/components/don-hang/bang-don-hang";
import { KhungDanhSachDonHang } from "@/components/don-hang/khung-danh-sach-don-hang";
import { TheDonHangDienThoai } from "@/components/don-hang/the-don-hang-dien-thoai";
import { TheSoDonHang } from "@/components/don-hang/the-so-don-hang";
import type {
  BoLocDonHang,
  DemTrangThaiDonHang,
  DongDonHang,
  DongDonHangChe,
  TongDonHang,
  TongDonHangChe,
  TrangDonHang,
} from "@/lib/orders/don-hang-kieu-du-lieu";
import type { KhopBangLaiLo } from "@/lib/orders/khop-bang-lai-lo";

const NOW = new Date(2026, 10, 27);

const BO_LOC: BoLocDonHang = {
  ky: { loai: "tat_ca" },
  statuses: [],
  channels: [],
  q: "",
  loc: [],
  sx: "moi",
  trang: 1,
  don: null,
};
const KENH = [{ id: "shopee", name: "Shopee", color: "#cc785c" }];
const DEM: DemTrangThaiDonHang = { PENDING: 0, SHIPPING: 0, COMPLETED: 2, RETURNED: 1, CANCELLED: 0 };

function dong(o: Partial<DongDonHang> = {}): DongDonHang {
  return {
    id: "o1",
    code: "HK-1",
    maSan: "251125P3VX7N1R",
    orderedAt: new Date(2026, 10, 25, 9, 0),
    statusChangedAt: new Date(2026, 10, 26, 9, 0),
    channelId: "shopee",
    channelName: "Shopee",
    channelColor: "#cc785c",
    tenKhach: null,
    sanPhamDau: { ten: "Váy hoa nhí", soLuong: 1 },
    soDongHang: 1,
    tongSoLuong: 1,
    itemsTotal: 200_000,
    discount: 0,
    platformFeeEst: 42_800,
    returnedFee: 0,
    status: "COMPLETED",
    phiTamTinh: false,
    laiDon: 30_000,
    thieuGiaVon: false,
    ...o,
  };
}

/** Bỏ trường lãi như truy vấn nhánh che thật sự làm (không chỉ ẩn ở giao diện). */
function che(d: DongDonHang): DongDonHangChe {
  const { laiDon: _laiDon, thieuGiaVon: _thieuGiaVon, ...con } = d;
  return con;
}

const TONG_DAY: TongDonHang = {
  soDon: 3,
  soHopLe: 2,
  soHoanHuy: 1,
  tienHang: 400_000,
  voucher: 20_000,
  phiSan: 80_000,
  thucNhan: 300_000,
  phiSanGiuHoanHuy: 12_000,
  laiHopLe: 40_000,
  lai: 28_000,
  soDonThieuGiaVon: 0,
};

const KHOP_TRON: KhopBangLaiLo = { kieu: "khop_tron", thang: "11/2026" };
const KHOP_MAC_DINH: KhopBangLaiLo = { kieu: "khop_tru_phi_hoan_huy", thang: "11/2026" };
const KHOP_HOAN_HUY: KhopBangLaiLo = { kieu: "khop_phi_hoan_huy", thang: "11/2026" };
const KHONG_KHOP: KhopBangLaiLo = { kieu: "khong_khop" };

function trangDay(rows: DongDonHang[], tong: Partial<TongDonHang> = {}): TrangDonHang {
  return { coQuyenGiaVon: true, rows, tong: { ...TONG_DAY, ...tong }, demTheoTrangThai: DEM, kyTruoc: null };
}

function trangChe(rows: DongDonHang[], tong: Partial<TongDonHangChe> = {}): TrangDonHang {
  const { laiHopLe: _a, lai: _c, soDonThieuGiaVon: _d, ...tongChe } = TONG_DAY;
  return { coQuyenGiaVon: false, rows: rows.map(che), tong: { ...tongChe, ...tong }, demTheoTrangThai: DEM, kyTruoc: null };
}

const HAI_DONG = [dong({ id: "a", code: "HK-A" }), dong({ id: "b", code: "HK-B", laiDon: 10_000 })];

const CAM_O_NHANH_CHE = ["Lãi đơn", "Đơn lỗ", "Thiếu giá vốn", "Lãi thấp nhất", "Lãi cao nhất", "the-so-lai"];

describe("TheSoDonHang", () => {
  it("không quyền giá vốn ⇒ không thẻ Lãi", () => {
    const html = renderToStaticMarkup(<TheSoDonHang trang={trangChe(HAI_DONG)} dangTim={false} khop={KHOP_TRON} hrefThieuGiaVon={null} />);
    expect(html).not.toContain("Lãi đơn");
    expect(html).not.toContain("the-so-lai");
    for (const id of ["the-so-don", "the-so-tien-hang", "the-so-thuc-nhan"]) expect(html).toContain(id);
  });

  it("có quyền ⇒ thẻ Lãi, số âm có dấu −", () => {
    const duong = renderToStaticMarkup(<TheSoDonHang trang={trangDay(HAI_DONG)} dangTim={false} khop={KHOP_TRON} hrefThieuGiaVon={null} />);
    expect(duong).toContain("the-so-lai");
    expect(duong).toContain("28.000 ₫");

    const am = renderToStaticMarkup(<TheSoDonHang trang={trangDay(HAI_DONG, { lai: -5_000 })} dangTim={false} khop={KHOP_TRON} hrefThieuGiaVon={null} />);
    expect(am).toContain("−5.000 ₫");
    expect(am).toContain("text-tq-xau-chu");
  });

  it("phí sàn / voucher mang số tiền ở title", () => {
    const html = renderToStaticMarkup(<TheSoDonHang trang={trangDay(HAI_DONG)} dangTim={false} khop={KHOP_TRON} hrefThieuGiaVon={null} />);
    expect(html).toMatch(/data-testid="phi-san-tong" title="Phí sàn −80\.000 ₫"/);
    expect(html).toMatch(/data-testid="voucher-tong" title="Voucher −20\.000 ₫"/);
  });

  it("chú thích khớp / lệch bảng Lãi/Lỗ", () => {
    const lech = renderToStaticMarkup(<TheSoDonHang trang={trangDay(HAI_DONG)} dangTim={false} khop={KHONG_KHOP} hrefThieuGiaVon={null} />);
    expect(lech).toContain("<b>không</b> khớp bảng Lãi/Lỗ");
    expect(lech).toContain("3 đơn");
    const khop = renderToStaticMarkup(<TheSoDonHang trang={trangDay(HAI_DONG)} dangTim={false} khop={KHOP_TRON} hrefThieuGiaVon={null} />);
    expect(khop).toContain("khớp bảng Lãi/Lỗ");
    expect(khop).toContain("Lãi đơn = “LN gộp”.");
    expect(khop).not.toContain("<b>không</b>");
  });

  it("màn mặc định mọi trạng thái: chú thích nêu Lãi đơn = LN gộp − phí sàn đơn hoàn/hủy bằng số", () => {
    const html = renderToStaticMarkup(<TheSoDonHang trang={trangDay(HAI_DONG)} dangTim={false} khop={KHOP_MAC_DINH} hrefThieuGiaVon={null} />);
    expect(html).toContain("Lãi đơn = “LN gộp” − “Phí sàn đơn hoàn/hủy” (12.000 ₫).");
    expect(html).not.toContain("Đang lọc");
  });

  it("thẻ số thứ ba mang nhãn mới, không còn nhãn 'Thực nhận từ sàn' (số tính từ đơn, chưa phải tiền đã về)", () => {
    const html = renderToStaticMarkup(<TheSoDonHang trang={trangDay(HAI_DONG)} dangTim={false} khop={KHOP_MAC_DINH} hrefThieuGiaVon={null} />);
    expect(html).toMatch(/data-testid="the-so-thuc-nhan"[\s\S]*?Tiền sau voucher và phí sàn/);
    expect(html).not.toMatch(/>Thực nhận từ sàn</);
  });

  it("phí sàn đơn hoàn/hủy > 0 ⇒ số nhìn thấy trên thẻ Tiền sau voucher và phí sàn cho CẢ người không quyền giá vốn", () => {
    for (const trang of [trangDay(HAI_DONG), trangChe(HAI_DONG)]) {
      const html = renderToStaticMarkup(<TheSoDonHang trang={trang} dangTim={false} khop={KHOP_MAC_DINH} hrefThieuGiaVon={null} />);
      expect(html).toMatch(/data-testid="phi-san-hoan-huy-tong"[^>]*>phí sàn đơn hoàn\/hủy −12\.000 ₫</);
    }
    const khongCo = renderToStaticMarkup(
      <TheSoDonHang trang={trangChe(HAI_DONG, { phiSanGiuHoanHuy: 0 })} dangTim={false} khop={KHOP_TRON} hrefThieuGiaVon={null} />,
    );
    expect(khongCo).not.toContain("phi-san-hoan-huy-tong");
  });

  it("tập chỉ gồm đơn hoàn/hủy: thấy ngay số phí sàn đơn hoàn/hủy thay vì chỉ '—'", () => {
    const chiHoanHuy = { soDon: 2, soHopLe: 0, soHoanHuy: 2, tienHang: 0, voucher: 0, phiSan: 0, thucNhan: 0, phiSanGiuHoanHuy: 26_000 };
    const html = renderToStaticMarkup(
      <TheSoDonHang trang={trangChe([], chiHoanHuy)} dangTim={false} khop={KHOP_HOAN_HUY} hrefThieuGiaVon={null} />,
    );
    expect(html).toContain("phí sàn đơn hoàn/hủy −26.000 ₫");
    expect(html).toContain("(26.000 ₫) khớp dòng “Phí sàn đơn hoàn/hủy”");
  });

  it("biên âm trên thẻ dùng dấu trừ U+2212, không gạch nối ASCII", () => {
    const html = renderToStaticMarkup(
      <TheSoDonHang trang={trangDay(HAI_DONG, { lai: -50_000 })} dangTim={false} khop={KHOP_TRON} hrefThieuGiaVon={null} />,
    );
    expect(html).toContain("biên −12,5%");
    expect(html).not.toMatch(/biên -/);
  });

  it("thẻ Lãi: có đơn thiếu giá vốn ⇒ cảnh báo kèm link bật chip; không có ⇒ không cảnh báo", () => {
    const co = renderToStaticMarkup(
      <TheSoDonHang
        trang={trangDay(HAI_DONG, { soDonThieuGiaVon: 3 })}
        dangTim={false}
        khop={KHOP_TRON}
        hrefThieuGiaVon="/don-hang?loc=thieu_gv"
      />,
    );
    expect(co).toContain("⚠ 3 đơn thiếu giá vốn — lãi đang cao hơn thực tế");
    expect(co).toMatch(/href="\/don-hang\?loc=thieu_gv"[^>]*data-testid="canh-bao-thieu-gia-von"|data-testid="canh-bao-thieu-gia-von"[^>]*href="\/don-hang\?loc=thieu_gv"/);
    const khong = renderToStaticMarkup(
      <TheSoDonHang trang={trangDay(HAI_DONG)} dangTim={false} khop={KHOP_TRON} hrefThieuGiaVon="/don-hang?loc=thieu_gv" />,
    );
    expect(khong).not.toContain("thiếu giá vốn");
  });

  it("đang tìm ⇒ ghi 'không so kỳ khi đang tìm', không huy hiệu", () => {
    const html = renderToStaticMarkup(<TheSoDonHang trang={trangDay(HAI_DONG)} dangTim khop={KHONG_KHOP} hrefThieuGiaVon={null} />);
    expect(html).toContain("không so kỳ khi đang tìm");
  });

  it("có kỳ trước ⇒ huy hiệu % trên các thẻ; tiền hàng 0 không NaN", () => {
    const trang = trangDay(HAI_DONG, { tienHang: 0, phiSan: 0, voucher: 0 });
    const co = renderToStaticMarkup(
      <TheSoDonHang
        trang={{ ...trang, kyTruoc: { nhan: "tháng trước", tong: { ...TONG_DAY, soDon: 2 } } } as TrangDonHang}
        dangTim={false}
        khop={KHOP_TRON}
        hrefThieuGiaVon={null}
      />,
    );
    expect(co).toContain("↗");
    expect(co).not.toMatch(/NaN|Infinity/);
  });
});

describe("danh sách nhánh che giá vốn", () => {
  const bang = (trang: TrangDonHang) => (
    <BangDonHang trang={trang} boLoc={BO_LOC} now={NOW} hrefDon={(id) => `/don-hang?don=${id}`} onMoDon={() => {}} onSapXep={() => {}} />
  );

  it("bảng: không cột Lãi đơn", () => {
    const html = renderToStaticMarkup(bang(trangChe(HAI_DONG)));
    expect(html).not.toContain("Lãi đơn");
    expect(html).not.toContain("sap-xep-cot-lai");
    expect(html).toContain("Tiền hàng");
  });

  it("thẻ điện thoại: 2 ô số, không ô Lãi", () => {
    const html = renderToStaticMarkup(
      <TheDonHangDienThoai trang={trangChe(HAI_DONG)} donDangMo={null} now={NOW} hrefDon={(id) => `/don-hang?don=${id}`} />,
    );
    expect(html).not.toContain("Lãi đơn");
    expect(html).toContain("grid-cols-2");
  });

  it("khung: không chip Đơn lỗ/Thiếu giá vốn, không mục sắp theo lãi, không thẻ Lãi", () => {
    const html = renderToStaticMarkup(
      <KhungDanhSachDonHang trang={trangChe(HAI_DONG)} boLoc={BO_LOC} sp={{}} kenh={KENH} coLoc={false} now={NOW} />,
    );
    for (const cam of CAM_O_NHANH_CHE) expect(html).not.toContain(cam);
    // Chip lọc vẫn còn những lựa chọn không lộ giá vốn.
    expect(html).toContain("Phí tạm tính");
    expect(html).toContain("Tiền hàng cao nhất");
  });

  it("khung có quyền: đủ chip, sắp theo lãi, cột Lãi", () => {
    const html = renderToStaticMarkup(
      <KhungDanhSachDonHang trang={trangDay(HAI_DONG)} boLoc={BO_LOC} sp={{}} kenh={KENH} coLoc={false} now={NOW} />,
    );
    for (const co of ["Đơn lỗ", "Thiếu giá vốn", "Lãi thấp nhất", "Lãi cao nhất", "Lãi đơn"]) expect(html).toContain(co);
  });
});

describe("danh sách có quyền: đánh dấu dòng lỗ", () => {
  const render = (rows: DongDonHang[]) =>
    renderToStaticMarkup(
      <BangDonHang
        trang={trangDay(rows)}
        boLoc={BO_LOC}
        now={NOW}
        hrefDon={(id) => `/don-hang?don=${id}`}
        onMoDon={() => {}}
        onSapXep={() => {}}
      />,
    );
  const demLo = (html: string) => (html.match(/data-dong-lo="true"/g) ?? []).length;

  it("đơn hợp lệ lãi âm ⇒ đánh dấu lỗ + số có dấu −", () => {
    const html = render([dong({ id: "lo", laiDon: -20_000 }), dong({ id: "ok" })]);
    expect(demLo(html)).toBe(1);
    expect(html).toContain("−20.000 ₫");
  });

  it("đơn hoàn lãi âm (= −phí sàn giữ) ⇒ KHÔNG đánh dấu lỗ", () => {
    const html = render([dong({ id: "hoan", status: "RETURNED", returnedFee: 12_000, laiDon: -12_000 })]);
    expect(demLo(html)).toBe(0);
    expect(html).toContain("−12.000 ₫");
    expect(html).toContain("phí sàn giữ");
  });

  it("không có ô chọn nhiều dòng (màn chỉ xem)", () => {
    const html = render(HAI_DONG);
    expect(html).not.toContain("<input");
    expect(html).not.toContain('type="checkbox"');
  });

  it("mã đơn là link thật tới ?don=", () => {
    const html = render([dong({ id: "xyz", code: "HK-9" })]);
    expect(html).toContain('href="/don-hang?don=xyz"');
    expect(html).toContain("HK-9");
  });

  it("dòng đang mở drawer được đánh dấu", () => {
    const html = renderToStaticMarkup(
      <BangDonHang
        trang={trangDay(HAI_DONG)}
        boLoc={{ ...BO_LOC, don: "a" }}
        now={NOW}
        hrefDon={(id) => `/don-hang?don=${id}`}
        onMoDon={() => {}}
        onSapXep={() => {}}
      />,
    );
    expect((html.match(/data-dang-mo="true"/g) ?? []).length).toBe(1);
  });
});

describe("khung rỗng", () => {
  const rong = (coLoc: boolean, boLoc = BO_LOC) =>
    renderToStaticMarkup(
      <KhungDanhSachDonHang
        trang={trangDay([], { soDon: 0, soHopLe: 0, soHoanHuy: 0 })}
        boLoc={boLoc}
        sp={{}}
        kenh={KENH}
        coLoc={coLoc}
        now={NOW}
      />,
    );

  it("có lọc ⇒ 'Không có đơn nào khớp bộ lọc' + Xóa lọc, ẩn bảng và phân trang", () => {
    const html = rong(true);
    expect(html).toContain("Không có đơn nào khớp bộ lọc");
    expect(html).toContain("Xóa lọc");
    expect(html).not.toContain("bang-don-hang");
    expect(html).not.toContain("phan-trang-tom-tat");
  });

  it("không lọc, có kỳ ⇒ 'Chưa có đơn nào trong kỳ này' + link tất cả thời gian", () => {
    const html = rong(false, { ...BO_LOC, ky: { loai: "khoang", from: new Date(2026, 10, 1), to: new Date(2026, 10, 30), nguon: "mac_dinh" } });
    expect(html).toContain("Chưa có đơn nào trong kỳ này");
    expect(html).toContain("ky=tat_ca");
  });
});

describe("tab, phân trang", () => {
  it("tab Tất cả = Σ đếm; chỉ sáng đúng tab khi 1 trạng thái; ≥ 2 trạng thái ⇒ không tab nào sáng", () => {
    const sang = (b: BoLocDonHang) =>
      (renderToStaticMarkup(
        <KhungDanhSachDonHang trang={trangDay(HAI_DONG)} boLoc={b} sp={{}} kenh={KENH} coLoc={false} now={NOW} />,
      ).match(/aria-selected="true"/g) ?? []).length;
    expect(sang(BO_LOC)).toBe(1);
    expect(sang({ ...BO_LOC, statuses: ["COMPLETED"] })).toBe(1);
    expect(sang({ ...BO_LOC, statuses: ["PENDING", "SHIPPING"] })).toBe(0);
  });

  it("tóm tắt '1–20 / 63 đơn' khi 63 đơn", () => {
    const html = renderToStaticMarkup(
      <KhungDanhSachDonHang
        trang={trangDay(HAI_DONG, { soDon: 63 })}
        boLoc={BO_LOC}
        sp={{}}
        kenh={KENH}
        coLoc={false}
        now={NOW}
      />,
    );
    expect(html).toContain("1–20 / 63 đơn");
  });
});
