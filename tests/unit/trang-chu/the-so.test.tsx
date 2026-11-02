import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChiSoProvider, HangTheSo } from "@/components/trang-chu/chi-so-dang-chon";
import { HuyHieuThayDoi } from "@/components/trang-chu/huy-hieu-thay-doi";
import type {
  DiemBieuDo,
  DuLieuTheVaBieuDo,
  GiaTriNgayChe,
  GiaTriNgayDayDu,
  SoSanh,
} from "@/lib/trang-chu/kieu-du-lieu-trang-chu";

const ss = (hienTai: number, kyTruoc: number, phanTram: number | null): SoSanh => ({ hienTai, kyTruoc, phanTram });

const DIEM_DAY_DU: DiemBieuDo<GiaTriNgayDayDu>[] = [
  { ngay: "2026-10-01", laNgayDangXem: false, hienTai: { doanhSo: 100, chiPhi: 60, loiNhuan: 40, donHang: 2 }, kyTruoc: { doanhSo: 80, chiPhi: 50, loiNhuan: 30, donHang: 1 } },
  { ngay: "2026-10-02", laNgayDangXem: true, hienTai: { doanhSo: 200, chiPhi: 90, loiNhuan: 110, donHang: 3 }, kyTruoc: null },
];

function duDayDu(loiNhuan = 150_000): DuLieuTheVaBieuDo {
  return {
    coQuyenGiaVon: true,
    nhanKySoSanh: "so với tháng trước",
    motNgay: false,
    the: {
      doanhSo: ss(1_000_000, 900_000, 11.1),
      chiPhi: ss(850_000, 780_000, 9),
      loiNhuan: ss(loiNhuan, 120_000, loiNhuan < 0 ? -125 : 25),
      donHang: ss(12, 10, 20),
      tbMoiDon: 83_333,
      quangCao: 200_000,
      bienLai: 15,
      tyLeHoanHuy: 8.3,
    },
    bieuDo: DIEM_DAY_DU,
  };
}

function duChe(): DuLieuTheVaBieuDo {
  return {
    coQuyenGiaVon: false,
    nhanKySoSanh: "so với tháng trước",
    motNgay: false,
    the: { doanhSo: ss(1_000_000, 900_000, 11.1), donHang: ss(12, 10, 20), tbMoiDon: 83_333, tyLeHoanHuy: 8.3 },
    bieuDo: DIEM_DAY_DU.map((d): DiemBieuDo<GiaTriNgayChe> => ({
      ...d,
      hienTai: { doanhSo: d.hienTai.doanhSo, donHang: d.hienTai.donHang },
      kyTruoc: d.kyTruoc && { doanhSo: d.kyTruoc.doanhSo, donHang: d.kyTruoc.donHang },
    })),
  };
}

const hang = (du: DuLieuTheVaBieuDo) =>
  renderToStaticMarkup(
    <ChiSoProvider coQuyenGiaVon={du.coQuyenGiaVon}>
      <HangTheSo du={du} />
    </ChiSoProvider>,
  );

describe("HuyHieuThayDoi", () => {
  it("kỳ trước 0 (null) ⇒ huy hiệu Mới", () => {
    expect(renderToStaticMarkup(<HuyHieuThayDoi phanTram={null} tangLaTot />)).toContain("Mới");
  });
  it("0% ⇒ xám, không mũi tên", () => {
    const html = renderToStaticMarkup(<HuyHieuThayDoi phanTram={0.01} tangLaTot />);
    expect(html).toContain("0%");
    expect(html).not.toMatch(/↗|↘/);
  });
  it("chi phí tăng 9% ⇒ màu xấu", () => {
    const html = renderToStaticMarkup(<HuyHieuThayDoi phanTram={9} tangLaTot={false} />);
    expect(html).toContain("tq-xau");
    expect(html).toContain("↗ 9%");
  });
  it("lợi nhuận giảm ⇒ màu xấu, mũi tên xuống", () => {
    const html = renderToStaticMarkup(<HuyHieuThayDoi phanTram={-12.5} tangLaTot />);
    expect(html).toContain("tq-xau");
    expect(html).toContain("↘ 12,5%");
  });
  it("doanh số tăng ⇒ màu tốt; chi phí giảm ⇒ màu tốt", () => {
    expect(renderToStaticMarkup(<HuyHieuThayDoi phanTram={5} tangLaTot />)).toContain("tq-tot");
    expect(renderToStaticMarkup(<HuyHieuThayDoi phanTram={-5} tangLaTot={false} />)).toContain("tq-tot");
  });
});

describe("HangTheSo", () => {
  it("nhánh che chỉ có Doanh số + Đơn hợp lệ", () => {
    const html = hang(duChe());
    expect(html).toContain("Doanh số");
    expect(html).toContain("Đơn hợp lệ");
    expect(html).not.toContain("Chi phí");
    expect(html).not.toContain("Lợi nhuận");
  });
  it("nhánh đủ đúng thứ tự DOM", () => {
    const html = hang(duDayDu());
    const vt = ["Doanh số", "Chi phí", "Lợi nhuận", "Đơn hợp lệ"].map((n) => html.indexOf(n));
    expect(vt.every((i) => i >= 0)).toBe(true);
    expect([...vt].sort((a, b) => a - b)).toEqual(vt);
  });
  it("dòng phụ + định dạng", () => {
    const html = hang(duDayDu());
    expect(html).toContain("TB 83.333 ₫/đơn");
    expect(html).toContain("Quảng cáo 200.000 ₫");
    expect(html).toContain("Biên lãi 15%");
    expect(html).toContain("12 đơn");
    expect(html).toContain("Hoàn / hủy 8,3%");
  });
  it("kỳ rỗng: tbMoiDon/bienLai null ⇒ dấu —, không vỡ", () => {
    const du = duDayDu();
    if (!du.coQuyenGiaVon) throw new Error("fixture");
    const html = hang({ ...du, the: { ...du.the, tbMoiDon: null, bienLai: null, loiNhuan: ss(0, 0, null) } });
    expect(html).toContain("TB —");
    expect(html).toContain("Biên lãi —");
    expect(html).toContain("Mới");
  });
  it("lợi nhuận âm ⇒ chữ đỏ; dương ⇒ chữ xanh lợi nhuận", () => {
    expect(hang(duDayDu(-50_000))).toContain("text-tq-xau-chu");
    expect(hang(duDayDu(150_000))).toContain("text-tq-loi-nhuan-chu");
  });
  it("mặc định chọn Doanh số (aria-pressed)", () => {
    const html = hang(duDayDu());
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
  });
});
