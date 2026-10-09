import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, replace: () => {}, push: () => {} }),
}));
vi.mock("@/lib/actions/tra-tien-hang", () => ({ traTienHangGop: vi.fn() }));
vi.mock("@/lib/actions/phieu-nhap-no", () => ({ xoaPhieu: vi.fn() }));

import { NhanTrangThaiPhieu } from "@/components/no-phai-tra/nhan-trang-thai-phieu";
import { NoPhieuNhapSection } from "@/components/no-phai-tra/no-phieu-nhap-section";
import { conNoPhieu, nhanTrangThaiPhieu } from "@/lib/no-phai-tra/con-no-phieu";
import type { PhieuConNo } from "@/lib/no-phai-tra/phieu-nhap-no-queries";

/** Dựng phiếu từ chính công thức `conNoPhieu` — không gõ tay trạng thái, tránh fixture nói dối. */
function phieu(ma: string, o: { tong: number; daTraTruoc?: number; daTra?: number; daHoan?: number; daHuy?: boolean }): PhieuConNo {
  const daTraTruoc = o.daTraTruoc ?? 0;
  const daTra = o.daTra ?? 0;
  const daHoan = o.daHoan ?? 0;
  const daHuy = o.daHuy ?? false;
  const conNo = conNoPhieu({ tongTien: o.tong, daTraTruoc, daTra, daHoan, daHuy });
  return {
    id: `id-${ma}`,
    refId: `PANCAKE_PURCHASE:${ma}`,
    shopId: "kho",
    maPhieu: ma,
    ngayPhieu: new Date(2026, 9, 1),
    tongTien: o.tong,
    daTraTruoc,
    daHuy,
    lechDaGiaiThich: false,
    lechDaGiaiThichSo: null,
    note: "",
    daTra,
    daHoan,
    conNo,
    trangThai: nhanTrangThaiPhieu(conNo, daHuy),
    soDongTien: daTra > 0 ? 1 : 0,
  };
}

const CON_NO = phieu("#101", { tong: 10_000_000, daTraTruoc: 2_000_000, daTra: 3_000_000 });
const DA_TRA_DU = phieu("#102", { tong: 5_000_000, daTra: 5_000_000 });
const TRA_THUA = phieu("#103", { tong: 4_000_000, daTra: 4_500_000 });
const CAN_THU_HOI = phieu("#104", { tong: 6_000_000, daTra: 6_000_000, daHuy: true });

describe("NhanTrangThaiPhieu — bốn trạng thái, bốn nhãn khác nhau", () => {
  it("fixture đúng trạng thái", () => {
    expect([CON_NO, DA_TRA_DU, TRA_THUA, CAN_THU_HOI].map((p) => p.trangThai)).toEqual([
      "CON_NO",
      "DA_TRA_DU",
      "TRA_THUA",
      "CAN_THU_HOI",
    ]);
  });

  it("còn nợ in số; đã trả đủ; trả thừa và cần thu hồi in số TUYỆT ĐỐI", () => {
    const html = (p: PhieuConNo) => renderToStaticMarkup(<NhanTrangThaiPhieu trangThai={p.trangThai} conNo={p.conNo} />);
    expect(html(CON_NO)).toContain("5.000.000");
    expect(html(DA_TRA_DU)).toContain("Đã trả đủ");
    expect(html(TRA_THUA)).toContain("Trả thừa 500.000");
    expect(html(CAN_THU_HOI)).toContain("Cần thu hồi 6.000.000");
    expect(html(CAN_THU_HOI)).not.toContain("−");
  });
});

describe("NoPhieuNhapSection", () => {
  const props = { phieu: [CON_NO, DA_TRA_DU, TRA_THUA, CAN_THU_HOI], vanTay: "vt", mocM: "2026-10-01", homNay: new Date(2026, 9, 11) };

  it("hiện phiếu còn nợ / trả thừa / cần thu hồi, gom phiếu đã trả đủ vào một câu", () => {
    const html = renderToStaticMarkup(<NoPhieuNhapSection {...props} choPhepSua />);
    expect(html).toContain("#101");
    expect(html).toContain("Trả thừa 500.000");
    expect(html).toContain("Cần thu hồi 6.000.000");
    expect(html).not.toContain("#102");
    expect(html).toContain("1 phiếu đã trả đủ (ẩn)");
    // đã trả = trước 2tr + trả 3tr; tuổi nợ 10 ngày chỉ cho phiếu còn nợ
    expect(html).toContain("5.000.000");
    expect(html).toContain("10 ngày");
  });

  it("tổng còn nợ chỉ cộng phần dương (trả thừa / thu hồi không trừ ngược)", () => {
    const html = renderToStaticMarkup(<NoPhieuNhapSection {...props} />);
    expect(html).toContain("Tổng còn nợ nhà cung cấp");
    expect(html).toMatch(/Tổng còn nợ nhà cung cấp:[\s\S]*5\.000\.000/);
  });

  it("chưa bật (mocM null) hoặc thiếu quyền sửa ⇒ không có nút Trả tiền hàng", () => {
    expect(renderToStaticMarkup(<NoPhieuNhapSection {...props} mocM={null} choPhepSua />)).not.toContain("Trả tiền hàng");
    expect(renderToStaticMarkup(<NoPhieuNhapSection {...props} choPhepSua={false} />)).not.toContain("Trả tiền hàng");
    expect(renderToStaticMarkup(<NoPhieuNhapSection {...props} choPhepSua />)).toContain("Trả tiền hàng");
  });

  it("nút Xoá phiếu: chỉ phiếu KHÔNG còn dòng tiền + có quyền sửa; phiếu còn dòng trả ⇒ không nút", () => {
    const trang = phieu("#105", { tong: 7_000_000 }); // ghi nhận nhầm, chưa trả/hoàn gì
    const html = renderToStaticMarkup(<NoPhieuNhapSection {...props} phieu={[CON_NO, trang]} choPhepSua />);
    expect(html).toContain('aria-label="Xoá phiếu #105"');
    expect(html).not.toContain('aria-label="Xoá phiếu #101"');
    expect(
      renderToStaticMarkup(<NoPhieuNhapSection {...props} phieu={[CON_NO, trang]} choPhepSua={false} />),
    ).not.toContain("Xoá phiếu");
  });
});
