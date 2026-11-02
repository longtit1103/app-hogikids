// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAU_CHI_SO, MAU_KY_TRUOC } from "@/components/trang-chu/mau-trang-chu";

// jsdom không đo được kích thước ⇒ ResponsiveContainer mặc định vẽ 0×0. Giữ nguyên mọi thứ khác của recharts,
// chỉ cho khung chứa một kích thước cố định để đường/trục thật sự được dựng.
vi.mock("recharts", async (importOriginal) => {
  const goc = await importOriginal<typeof import("recharts")>();
  const React = await import("react");
  return {
    ...goc,
    ResponsiveContainer: ({ children }: { children: React.ReactElement<{ width?: number; height?: number }> }) => (
      <div style={{ width: 600, height: 220 }}>{React.cloneElement(children, { width: 600, height: 220 })}</div>
    ),
  };
});

import { noiDungTooltip, TooltipBieuDo } from "@/components/trang-chu/bieu-do-theo-ngay";
import {
  ChiSoProvider,
  HangTheSo,
  KhoiBieuDoTheoNgay,
  useChiSoDangChon,
} from "@/components/trang-chu/chi-so-dang-chon";
import type {
  ChiSoBieuDo,
  DiemBieuDo,
  DuLieuTheVaBieuDo,
  GiaTriNgayChe,
  GiaTriNgayDayDu,
  SoSanh,
} from "@/lib/trang-chu/kieu-du-lieu-trang-chu";

afterEach(cleanup);

const ss = (hienTai: number, kyTruoc: number, phanTram: number | null): SoSanh => ({ hienTai, kyTruoc, phanTram });

const DIEM: DiemBieuDo<GiaTriNgayDayDu>[] = [
  { ngay: "2026-10-01", laNgayDangXem: false, hienTai: { doanhSo: 1_000_000, chiPhi: 600_000, loiNhuan: 400_000, donHang: 2 }, kyTruoc: { doanhSo: 800_000, chiPhi: 500_000, loiNhuan: 300_000, donHang: 1 } },
  { ngay: "2026-10-02", laNgayDangXem: true, hienTai: { doanhSo: 2_000_000, chiPhi: 900_000, loiNhuan: 1_100_000, donHang: 3 }, kyTruoc: null },
];

const duDayDu: DuLieuTheVaBieuDo = {
  coQuyenGiaVon: true,
  nhanKySoSanh: "so với tháng trước",
  motNgay: false,
  the: {
    doanhSo: ss(3_000_000, 2_000_000, 50),
    chiPhi: ss(1_500_000, 1_000_000, 50),
    loiNhuan: ss(1_500_000, 1_000_000, 50),
    donHang: ss(5, 3, 66.7),
    tbMoiDon: 600_000,
    quangCao: 300_000,
    bienLai: 50,
    tyLeHoanHuy: 0,
  },
  bieuDo: DIEM,
};

const duChe: DuLieuTheVaBieuDo = {
  coQuyenGiaVon: false,
  nhanKySoSanh: "so với tháng trước",
  motNgay: false,
  the: { doanhSo: ss(3_000_000, 2_000_000, 50), donHang: ss(5, 3, 66.7), tbMoiDon: 600_000, tyLeHoanHuy: 0 },
  bieuDo: DIEM.map((d): DiemBieuDo<GiaTriNgayChe> => ({
    ...d,
    hienTai: { doanhSo: d.hienTai.doanhSo, donHang: d.hienTai.donHang },
    kyTruoc: d.kyTruoc && { doanhSo: d.kyTruoc.doanhSo, donHang: d.kyTruoc.donHang },
  })),
};

/** Thử gọi thẳng `setChiSo` — mô phỏng mọi đường code khác ngoài thẻ số cố đổi sang chỉ số bị cấm. */
function NutThuGoiThang(props: { khoa: ChiSoBieuDo }) {
  const { chiSo, setChiSo } = useChiSoDangChon();
  return (
    <>
      <button type="button" data-testid="goi-thang" onClick={() => setChiSo(props.khoa)} />
      <span data-testid="chi-so-hien-tai">{chiSo}</span>
    </>
  );
}

const dung = (du: DuLieuTheVaBieuDo, them?: React.ReactNode) =>
  render(
    <ChiSoProvider coQuyenGiaVon={du.coQuyenGiaVon}>
      <HangTheSo du={du} />
      <KhoiBieuDoTheoNgay du={du} />
      {them}
    </ChiSoProvider>,
  );

const tieuDe = () => screen.getByTestId("tieu-de-bieu-do").textContent;
const theDangChon = () => screen.getAllByRole("button", { pressed: true });

describe("bấm thẻ đổi biểu đồ (nhánh đủ quyền)", () => {
  it("mặc định Doanh số; bấm lần lượt từng thẻ đổi tiêu đề + thẻ đang chọn", () => {
    dung(duDayDu);
    expect(tieuDe()).toBe("Doanh số theo ngày");
    expect(screen.getAllByRole("button")).toHaveLength(4);

    for (const ten of ["Chi phí", "Lợi nhuận", "Đơn hợp lệ", "Doanh số"]) {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${ten}`) }));
      expect(tieuDe()).toBe(`${ten} theo ngày`);
      const dang = theDangChon();
      expect(dang).toHaveLength(1);
      expect(dang[0].textContent).toContain(ten);
    }
  });

  it("biểu đồ thật được dựng (có vùng + đường) và đổi theo chỉ số", () => {
    const { container } = dung(duDayDu);
    expect(screen.getByTestId("bieu-do-theo-ngay")).toBeTruthy();
    expect(container.querySelector("path.recharts-line-curve")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Chi phí/ }));
    expect(container.querySelector(`path.recharts-line-curve[stroke="${MAU_CHI_SO.chiPhi}"]`)).not.toBeNull();
  });
});

describe("nhánh che giá vốn", () => {
  it("chỉ 2 thẻ; không có nút Chi phí/Lợi nhuận; bấm Đơn hợp lệ đổi tiêu đề", () => {
    dung(duChe);
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /Chi phí|Lợi nhuận/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Đơn hợp lệ/ }));
    expect(tieuDe()).toBe("Đơn hợp lệ theo ngày");
    expect(theDangChon()).toHaveLength(1);
  });

  it.each<ChiSoBieuDo>(["chiPhi", "loiNhuan"])("setChiSo(%s) gọi thẳng bị từ chối", (khoa) => {
    dung(duChe, <NutThuGoiThang khoa={khoa} />);
    fireEvent.click(screen.getByTestId("goi-thang"));
    expect(screen.getByTestId("chi-so-hien-tai").textContent).toBe("doanhSo");
    expect(tieuDe()).toBe("Doanh số theo ngày");
  });

  it("nhánh đủ quyền thì setChiSo gọi thẳng được (đối chứng)", () => {
    dung(duDayDu, <NutThuGoiThang khoa="loiNhuan" />);
    fireEvent.click(screen.getByTestId("goi-thang"));
    expect(screen.getByTestId("chi-so-hien-tai").textContent).toBe("loiNhuan");
  });
});

describe("noiDungTooltip", () => {
  const diem = DIEM[0];
  it.each([
    ["doanhSo", "Doanh số", "1.000.000 ₫", "800.000 ₫"],
    ["chiPhi", "Chi phí", "600.000 ₫", "500.000 ₫"],
    ["loiNhuan", "Lợi nhuận", "400.000 ₫", "300.000 ₫"],
    ["donHang", "Đơn hợp lệ", "2 đơn", "1 đơn"],
  ] as const)("%s: nhãn đúng tên + định dạng đúng", (khoa, ten, hien, truoc) => {
    expect(noiDungTooltip(diem, khoa, false)).toEqual({
      tieuDe: "01/10",
      dong: [
        { nhan: `${ten} kỳ này`, giaTri: hien },
        { nhan: `${ten} kỳ trước`, giaTri: truoc },
      ],
    });
  });
  it("kỳ 1 ngày ⇒ chỉ 1 dòng", () => {
    expect(noiDungTooltip(diem, "doanhSo", true).dong).toHaveLength(1);
  });
  it("điểm không có kỳ trước (kỳ trước ngắn hơn) ⇒ chỉ 1 dòng", () => {
    expect(noiDungTooltip(DIEM[1], "donHang", false).dong).toEqual([{ nhan: "Đơn hợp lệ kỳ này", giaTri: "3 đơn" }]);
  });
});

describe("kỳ 1 ngày", () => {
  it("không có đường kỳ trước, chú thích ẩn phần kỳ trước", () => {
    const { container } = dung({ ...duDayDu, motNgay: true });
    expect(container.querySelectorAll(`path.recharts-line-curve[stroke="${MAU_KY_TRUOC}"]`)).toHaveLength(0);
    expect(screen.queryByText(/so với tháng trước/)).toBeNull();
  });
});

describe("bấm thẻ đổi NỘI DUNG tooltip (cùng context với thẻ)", () => {
  const diemVe = { ngay: DIEM[0].ngay, laNgayDangXem: false, hien: 0, truoc: null, goc: DIEM[0] };
  const tooltip = () => screen.getByTestId("tooltip-bieu-do").textContent ?? "";
  const dungTooltip = (du: DuLieuTheVaBieuDo) =>
    render(
      <ChiSoProvider coQuyenGiaVon={du.coQuyenGiaVon}>
        <HangTheSo du={du} />
        <TooltipBieuDo active label="2026-10-01" payload={[{ payload: diemVe }]} motNgay={false} />
      </ChiSoProvider>,
    );

  it("nhánh đủ: mỗi thẻ bấm ⇒ tooltip đúng tên + định dạng chỉ số đó, không còn chỉ số trước", () => {
    dungTooltip(duDayDu);
    expect(tooltip()).toContain("Doanh số kỳ này");
    const cacBuoc = [
      ["Chi phí", "600.000 ₫"],
      ["Lợi nhuận", "400.000 ₫"],
      ["Đơn hợp lệ", "2 đơn"],
      ["Doanh số", "1.000.000 ₫"],
    ] as const;
    let truoc = "Doanh số";
    for (const [ten, giaTri] of cacBuoc) {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${ten}`) }));
      const nd = tooltip();
      expect(nd).toContain(`${ten} kỳ này`);
      expect(nd).toContain(`${ten} kỳ trước`);
      expect(nd).toContain(giaTri);
      expect(nd).not.toContain(`${truoc} kỳ`);
      truoc = ten;
    }
  });

  it("nhánh che: bấm Đơn hợp lệ ⇒ tooltip 'Đơn hợp lệ kỳ này' dạng đơn, không còn Doanh số", () => {
    dungTooltip(duChe);
    expect(tooltip()).toContain("Doanh số kỳ này");
    fireEvent.click(screen.getByRole("button", { name: /^Đơn hợp lệ/ }));
    const nd = tooltip();
    expect(nd).toContain("Đơn hợp lệ kỳ này");
    expect(nd).toContain("2 đơn");
    expect(nd).not.toContain("Doanh số kỳ");
    expect(nd).not.toContain("₫");
  });
});
