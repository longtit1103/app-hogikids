import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, replace: () => {}, push: () => {} }) }));
vi.mock("@/lib/actions/the-tin-dung", () => ({
  taoThe: vi.fn(),
  suaThe: vi.fn(),
  dongThe: vi.fn(),
  xoaThe: vi.fn(),
  ganNenTang: vi.fn(),
  xoaGanNenTang: vi.fn(),
}));
vi.mock("@/lib/actions/chot-sao-ke", () => ({ chotSaoKe: vi.fn() }));
vi.mock("@/lib/actions/uoc-tinh-sao-ke", () => ({ docUocTinhSaoKe: vi.fn() }));

import { TheTinDungSection } from "@/components/no-phai-tra/the-tin-dung-section";
import type { MocGanThe, TheKemTrangThai } from "@/lib/no-phai-tra/the-tin-dung-queries";

const homNay = new Date();
const ngay = (lui: number) => new Date(homNay.getFullYear(), homNay.getMonth(), homNay.getDate() - lui);

function the(o: Partial<TheKemTrangThai>): TheKemTrangThai {
  return {
    id: "t1",
    ten: "Visa Techcombank",
    nganHang: "Techcombank",
    ngayChotSaoKe: 25,
    ngayHanTra: 12,
    closedAt: null,
    note: "",
    duNo: 8_000_000,
    phaiTra: null,
    kyGanNhat: null,
    gan: [],
    nenTangDangGan: [],
    chuaChotKyGanNhat: false,
    lyDoKhongXoa: null,
    lyDoKhongDong: null,
    ...o,
  };
}

const render = (t: TheKemTrangThai, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(<TheTinDungSection the={[t]} mocM="2026-10-01" goiYChot={{}} choPhepSua {...extra} />);

describe("TheTinDungSection", () => {
  it("dư nợ mang nhãn 'ước tính'; chưa có neo ⇒ nói 'chưa có neo' chứ không in 0", () => {
    expect(render(the({}))).toContain("ước tính");
    const html = render(the({ duNo: null }));
    expect(html).toContain("chưa có neo");
  });

  it("kỳ quá hạn: số phải trả + 'quá hạn từ dd/MM' (đỏ); đến hạn hôm nay có nhãn riêng", () => {
    const quaHan = render(
      the({
        phaiTra: {
          nghiaVuKy: 5_000_000,
          phanTruoc: { soTien: 2_000_000, hanTra: ngay(3), quaHan: true, denHanHomNay: false },
          phanMoi: { soTien: 3_000_000, hanTra: ngay(0), quaHan: false, denHanHomNay: true },
        },
      }),
    );
    expect(quaHan).toContain("5.000.000");
    expect(quaHan).toMatch(/quá hạn từ \d{2}\/\d{2}/);
    expect(quaHan).toContain("text-error");
    expect(quaHan).toContain("đến hạn hôm nay");
  });

  it("kỳ đã trả đủ / chưa có kỳ", () => {
    expect(render(the({ phaiTra: { nghiaVuKy: 0, phanTruoc: null, phanMoi: null } }))).toContain("Đã trả đủ kỳ gần nhất");
    expect(render(the({}))).toContain("Chưa có kỳ sao kê");
  });

  it("nhắc chưa chốt sao kê chỉ khi cờ bật", () => {
    expect(render(the({ chuaChotKyGanNhat: true }))).toContain("Chưa chốt sao kê kỳ gần nhất");
    expect(render(the({}))).not.toContain("Chưa chốt sao kê kỳ gần nhất");
  });

  // Mốc của MỘT thẻ ở dạng server trả: `denNgay` = ngày cuối còn gánh (null = mốc cuối).
  const moc = (id: string, nenTang: string, tuNgay: Date, o: Partial<MocGanThe> = {}): MocGanThe => ({
    id,
    nenTang,
    tuNgay,
    xoaDuoc: false,
    denNgay: null,
    theKeTiep: null,
    ...o,
  });
  const ngayTuongDoi = (d: number) => new Date(Date.now() + d * 86_400_000);
  const ganMau = () => [
    moc("g1", "META", ngayTuongDoi(-40), { denNgay: ngayTuongDoi(-6) }),
    moc("g2", "META", ngayTuongDoi(-5)),
    moc("g3", "TIKTOK_ADS", ngayTuongDoi(365), { xoaDuoc: true }),
  ];

  it("mốc gắn nền tảng ĐÃ bật: chỉ mốc đang gánh + sắp áp dụng, bỏ mốc đã bị thay", () => {
    const html = render(the({ gan: ganMau() }));
    expect(html.match(/Meta từ/g)).toHaveLength(1);
    expect(html).toContain("TikTok Ads từ");
    expect(html).toContain("sắp áp dụng");
    expect(html).not.toContain("đến");
  });

  it("mốc gắn nền tảng CHƯA bật (mocM null): đủ lịch sử, mỗi dòng có khoảng hiệu lực trung tính, không nhãn 'đã thay'", () => {
    const html = render(
      the({ gan: ganMau().map((g) => ({ ...g, xoaDuoc: true })) }),
      { mocM: null }
    );
    expect(html.match(/Meta từ/g)).toHaveLength(2);
    expect(html.match(/data-testid="moc-gan-dong"/g)).toHaveLength(3);
    expect(html.match(/ đến /g)).toHaveLength(1); // chỉ mốc g1 có mốc kế
    expect(html).toContain("(sắp áp dụng)");
    expect(html).not.toContain("đã thay");
    expect(html).not.toContain("line-through");
    expect(html.match(/>xoá</g)).toHaveLength(3);
  });

  it("mốc gắn nền tảng ĐÃ bật: nút xoá chỉ ở mốc xoaDuoc", () => {
    const html = render(the({ gan: ganMau() }));
    expect(html.match(/>xoá</g)).toHaveLength(1);
  });

  it("thiếu quyền sửa ⇒ không nút Thêm thẻ, không cột Thao tác", () => {
    const html = render(the({}), { choPhepSua: false });
    expect(html).not.toContain("Thêm thẻ");
    expect(html).not.toContain("Thao tác");
  });

  it("thẻ đã đóng có nhãn", () => {
    expect(render(the({ closedAt: ngay(2) }))).toContain("Đã đóng");
  });
});
