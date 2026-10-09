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
import type { TheKemTrangThai } from "@/lib/no-phai-tra/the-tin-dung-queries";

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

  it("mốc gắn nền tảng: chỉ mốc đang hiệu lực + sắp áp dụng, bỏ mốc cũ đã bị thay", () => {
    const html = render(
      the({
        gan: [
          { id: "g1", nenTang: "META", tuNgay: ngay(40), xoaDuoc: false },
          { id: "g2", nenTang: "META", tuNgay: ngay(5), xoaDuoc: false },
          { id: "g3", nenTang: "TIKTOK_ADS", tuNgay: new Date(homNay.getFullYear() + 1, 0, 1), xoaDuoc: true },
        ],
      }),
    );
    expect(html).toContain("Meta từ");
    expect(html.match(/Meta từ/g)).toHaveLength(1);
    expect(html).toContain("TikTok Ads từ");
    expect(html).toContain("sắp áp dụng");
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
