import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MAU_KY_TRUOC } from "@/components/trang-chu/mau-trang-chu";
import { TheoKenh } from "@/components/trang-chu/theo-kenh";
import { TienDiDau } from "@/components/trang-chu/tien-di-dau";
import { TinhTrangDon } from "@/components/trang-chu/tinh-trang-don";
import type { ChiaChiPhi } from "@/lib/trang-chu/chia-chi-phi";
import type {
  TheoKenh as DuTheoKenh,
  TinhTrangDon as DuTinhTrangDon,
} from "@/lib/trang-chu/kieu-du-lieu-trang-chu";

const KY = { tu: "2026-10-25", den: "2026-10-31" };

const don = (tong: number, t: [number, number, number, number, number]): DuTinhTrangDon => ({
  tong,
  theoTrangThai: { COMPLETED: t[0], SHIPPING: t[1], PENDING: t[2], RETURNED: t[3], CANCELLED: t[4] },
});

/** Cộng mọi `width:X%` (chỉ phần trăm) trong markup — các đoạn thanh tiền đi đâu. */
const tongRong = (html: string) =>
  [...html.matchAll(/width:([\d.]+)%/g)].reduce((s, m) => s + Number(m[1]), 0);

describe("TinhTrangDon", () => {
  const du = don(52, [21, 20, 8, 2, 1]);

  it("hiện tổng, nhãn riêng trang chủ, % làm tròn và link lọc theo kỳ", () => {
    const html = renderToStaticMarkup(<TinhTrangDon du={du} ky={KY} hrefDuocPhep={["/don-hang"]} />);
    expect(html).toContain(">52<");
    for (const nhan of ["Thành công", "Đang giao", "Chờ xử lý", "Hoàn", "Hủy"]) expect(html).toContain(nhan);
    expect(html).toContain("40%");
    expect(html).toContain("trang_thai=hoan_thanh&amp;ngay_tu=2026-10-25&amp;ngay_den=2026-10-31");
    expect(html).toContain("Gồm cả đơn hoàn / hủy");
  });

  it("số đếm có dấu chấm nghìn (tâm + chú thích)", () => {
    const html = renderToStaticMarkup(
      <TinhTrangDon du={don(1234, [1000, 200, 30, 3, 1])} ky={KY} hrefDuocPhep={[]} />,
    );
    expect(html).toContain(">1.234<");
    expect(html).toContain(">1.000<");
    expect(html).not.toContain(">1234<");
  });

  it("thiếu quyền /don-hang ⇒ dòng tĩnh, không link", () => {
    const html = renderToStaticMarkup(<TinhTrangDon du={du} ky={KY} hrefDuocPhep={[]} />);
    expect(html).not.toContain('href="/don-hang');
    expect(html).toContain("Thành công");
  });

  it("tổng 0 ⇒ vòng xám, '0', không NaN/Infinity", () => {
    const html = renderToStaticMarkup(
      <TinhTrangDon du={don(0, [0, 0, 0, 0, 0])} ky={KY} hrefDuocPhep={["/don-hang"]} />,
    );
    expect(html).not.toMatch(/NaN|Infinity/);
    expect(html).toContain(">0<");
    expect(html).toContain(`stroke="${MAU_KY_TRUOC}"`);
    expect(html).toContain("—");
  });
});

/** Doanh số 100 (không voucher), chi phí 80 = 40+20+10+10, thu nhập tài chính 10 ⇒ lãi 30. */
const LAI: ChiaChiPhi = {
  doanhSo: 100,
  voucher: 0,
  giaVon: 40,
  quangCao: 20,
  phiSan: 10,
  vanHanhKhac: 10,
  chiPhi: 80,
  thuNhapTaiChinh: 10,
  loiNhuan: 30,
  mauSo: 100,
};

const LO: ChiaChiPhi = {
  doanhSo: 100,
  voucher: 0,
  giaVon: 60,
  quangCao: 30,
  phiSan: 10,
  vanHanhKhac: 20,
  chiPhi: 120,
  thuNhapTaiChinh: 0,
  loiNhuan: -20,
  mauSo: 100,
};

describe("TienDiDau", () => {
  it("lãi có thu nhập tài chính: đoạn phủ đúng 100%, ghi chú thu nhập, % lợi nhuận = 30%", () => {
    const html = renderToStaticMarkup(<TienDiDau du={LAI} choPhepXemLoiLo />);
    expect(tongRong(html)).toBeCloseTo(100, 6);
    expect(html).toContain('data-doan="loiNhuan"');
    expect(html).toContain("Gồm thu nhập tài chính");
    expect(html).toContain("Thu nhập tài chính");
    expect(html).toContain("30%");
    expect(html).toContain("tab=loi-lo");
    expect(html).not.toContain("tq-xau-chu");
  });

  it("lỗ: không đoạn lợi nhuận, có vạch + vùng sọc + nhãn Lỗ, tổng đoạn vẫn 100%", () => {
    const html = renderToStaticMarkup(<TienDiDau du={LO} choPhepXemLoiLo />);
    expect(html).not.toContain('data-doan="loiNhuan"');
    expect(tongRong(html)).toBeCloseTo(100, 6);
    // tongVao 100 / thang 120 = 83,33…%
    expect(html).toMatch(/left:\s?83\.33/);
    expect(html).toContain("Lỗ");
    expect(html).toContain("chi phí vượt tiền vào");
    expect(html).toContain("tq-xau-chu");
    expect(html).not.toContain("Thu nhập tài chính");
  });

  it("không quyền xem Lãi/Lỗ ⇒ không link tab=loi-lo", () => {
    const html = renderToStaticMarkup(<TienDiDau du={LAI} choPhepXemLoiLo={false} />);
    expect(html).not.toContain("tab=loi-lo");
  });

  it("đoạn lợi nhuận rộng 0 (dữ liệu dị) ⇒ bỏ qua, không đoạn rỗng", () => {
    const di: ChiaChiPhi = { ...LAI, thuNhapTaiChinh: 0, giaVon: 100, quangCao: 0, phiSan: 0, vanHanhKhac: 0, loiNhuan: 5 };
    const html = renderToStaticMarkup(<TienDiDau du={di} choPhepXemLoiLo />);
    expect(html).not.toContain('data-doan="loiNhuan"');
    expect(html).not.toContain('data-doan="quangCao"');
    expect(tongRong(html)).toBeCloseTo(100, 6);
  });

  it("voucher ≠ 0 hiện dòng riêng; = 0 thì ẩn", () => {
    const co = renderToStaticMarkup(<TienDiDau du={{ ...LAI, voucher: 7 }} choPhepXemLoiLo />);
    expect(co).toContain("Voucher shop");
    const khong = renderToStaticMarkup(<TienDiDau du={LAI} choPhepXemLoiLo />);
    expect(khong).not.toContain("Voucher shop");
  });

  it("kỳ rỗng (mẫu số 0): ẩn thanh, không NaN/Infinity", () => {
    const rong: ChiaChiPhi = {
      doanhSo: 0, voucher: 0, giaVon: 0, quangCao: 0, phiSan: 0, vanHanhKhac: 0,
      chiPhi: 0, thuNhapTaiChinh: 0, loiNhuan: 0, mauSo: 0,
    };
    const html = renderToStaticMarkup(<TienDiDau du={rong} choPhepXemLoiLo />);
    expect(html).not.toMatch(/NaN|Infinity/);
    expect(html).not.toContain("data-doan");
    expect(html).toContain("—");
  });

  it("mẫu số 0 nhưng có chi phí: % là '—', thanh vẫn vẽ", () => {
    const html = renderToStaticMarkup(
      <TienDiDau du={{ ...LO, doanhSo: 0, mauSo: 0, loiNhuan: -120 }} choPhepXemLoiLo />,
    );
    expect(html).not.toMatch(/NaN|Infinity/);
    expect(html).toContain("—");
  });
});

describe("TheoKenh", () => {
  const day: DuTheoKenh = {
    coQuyenGiaVon: true,
    rows: [
      { channelId: "shopee", ten: "Shopee", doanhSo: 6_800_000, donHang: 27, loiNhuan: 2_100_000 },
      { channelId: "tiktok", ten: "TikTok", doanhSo: 4_900_000, donHang: 19, loiNhuan: -300_000 },
    ],
  };

  it("nhánh đủ: tên, doanh số, đơn, lãi (âm ⇒ xấu), link kênh, chú thích", () => {
    const html = renderToStaticMarkup(<TheoKenh du={day} hrefDuocPhep={["/kenh"]} />);
    expect(html).toContain("doanh số · số đơn · lợi nhuận");
    expect(html).toContain('href="/kenh/shopee"');
    expect(html).toContain("27 đơn");
    expect(html).toContain("2.100.000");
    expect(html).toContain("tq-xau-chu");
    expect(html).toContain("Lãi kênh chưa trừ chi phí cố định và lãi vay.");
  });

  it("thiếu quyền /kenh ⇒ không link", () => {
    const html = renderToStaticMarkup(<TheoKenh du={day} hrefDuocPhep={[]} />);
    expect(html).not.toContain('href="/kenh');
  });

  it("nhánh che: không chữ 'lợi nhuận', không số lãi, không chú thích lãi kênh", () => {
    const che: DuTheoKenh = {
      coQuyenGiaVon: false,
      rows: [{ channelId: "shopee", ten: "Shopee", doanhSo: 6_800_000, donHang: 27 }],
    };
    const html = renderToStaticMarkup(<TheoKenh du={che} hrefDuocPhep={["/kenh"]} />);
    expect(html).toContain("doanh số · số đơn");
    expect(html.toLowerCase()).not.toContain("lợi nhuận");
    expect(html).not.toContain("Lãi kênh");
    expect(html).toContain("6.800.000");
  });

  it("nhánh che: doanh số hiện được trên điện thoại (phần tử không bị 'hidden' dưới sm)", () => {
    const che: DuTheoKenh = {
      coQuyenGiaVon: false,
      rows: [{ channelId: "shopee", ten: "Shopee", doanhSo: 6_800_000, donHang: 27 }],
    };
    const html = renderToStaticMarkup(<TheoKenh du={che} hrefDuocPhep={[]} />);
    const m = html.match(/<span class="([^"]*)">6,8tr/);
    expect(m).not.toBeNull();
    expect(m![1].split(/\s+/)).not.toContain("hidden");
  });

  it("rỗng ⇒ 'Chưa có đơn trong kỳ.'; doanh số tổng 0 không NaN", () => {
    const rong = renderToStaticMarkup(<TheoKenh du={{ coQuyenGiaVon: true, rows: [] }} hrefDuocPhep={[]} />);
    expect(rong).toContain("Chưa có đơn trong kỳ.");
    const khong = renderToStaticMarkup(
      <TheoKenh
        du={{ coQuyenGiaVon: true, rows: [{ channelId: "a", ten: "A", doanhSo: 0, donHang: 0, loiNhuan: 0 }] }}
        hrefDuocPhep={[]}
      />,
    );
    expect(khong).not.toMatch(/NaN|Infinity/);
  });
});
