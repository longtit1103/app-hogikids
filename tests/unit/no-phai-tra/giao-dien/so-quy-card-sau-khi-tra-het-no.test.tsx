import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, replace: () => {}, push: () => {} }),
  usePathname: () => "/tai-chinh",
  useSearchParams: () => new URLSearchParams(),
}));

import { SoQuyCard } from "@/components/finance/so-quy-card";
import { tinhSauKhiTraHetNo } from "@/lib/no-phai-tra/sau-khi-tra-het-no";
import type { SoQuyThangDayDu } from "@/lib/so-quy/so-quy-queries";

const soQuy = {
  d0: new Date(2026, 0, 1),
  truocMoSo: false,
  dauKy: 0,
  thu: 20_000_000,
  chi: 10_000_000,
  cuoiKy: 10_000_000,
  quyHomNay: 10_000_000,
  adsTiktok: { soChiPhi: 5_000_000, sanTruVi: 1_000_000 },
  canhBao: {
    tiktokPaidThieuNgay: 0,
    shopeeViTuNgay: null,
    shopeeViToiNgay: null,
    shopeeThieuTruocD0: false,
    shopeeChuaPhanLoai: 0,
    dinhKyChuaGhi: { soKhoan: 0, thang: [], khoang: null },
    adsViVuotSo: false,
  },
} as unknown as SoQuyThangDayDu;

const base = { soQuy, isCurrentMonth: true, soKhoanVayCoKyCho: 0, loans: [], tietKiem: null };

describe("tinhSauKhiTraHetNo", () => {
  it("quỹ − nợ thẻ (>0) − còn nợ phiếu (>0); số âm (trả thừa / thu hồi / dư nợ âm) không cộng ngược", () => {
    const t = tinhSauKhiTraHetNo(10_000_000, [{ duNo: 3_000_000 }, { duNo: -500_000 }, { duNo: null }], [
      { conNo: 2_000_000 },
      { conNo: -700_000 },
    ]);
    expect(t).toEqual({ quyHomNay: 10_000_000, noThe: 3_000_000, noPhieu: 2_000_000, conLai: 5_000_000 });
  });

  it("nợ nhiều hơn quỹ ⇒ âm (không kẹp về 0)", () => {
    expect(tinhSauKhiTraHetNo(1_000_000, [{ duNo: 4_000_000 }], []).conLai).toBe(-3_000_000);
  });
});

describe("SoQuyCard — dòng 'Sau khi trả hết nợ' + footnote ads TikTok", () => {
  it("CHƯA bật: không có dòng mới, footnote ads TikTok giữ nguyên 'trả thẻ ≈'", () => {
    const html = renderToStaticMarkup(<SoQuyCard {...base} />);
    expect(html).not.toContain("Sau khi trả hết nợ");
    expect(html).toContain("trả");
    expect(html).toContain("thẻ ≈ 4.000.000");
  });

  it("ĐÃ bật: hiện số còn lại + công thức; footnote ads đổi nhãn, bỏ 'trả thẻ ≈'", () => {
    const sau = tinhSauKhiTraHetNo(10_000_000, [{ duNo: 3_000_000 }], [{ conNo: 2_000_000 }]);
    const html = renderToStaticMarkup(<SoQuyCard {...base} sauKhiTraHetNo={sau} />);
    expect(html).toContain("Sau khi trả hết nợ");
    expect(html).toContain("5.000.000");
    expect(html).toContain("nợ thẻ tín dụng (ước tính) 3.000.000");
    expect(html).toContain("nợ tiền hàng");
    expect(html).toContain("Ads TikTok sau mốc theo dõi nợ: trả qua thẻ, xem khối Thẻ tín dụng");
    expect(html).not.toContain("thẻ ≈");
  });

  it("nợ vượt quỹ ⇒ số còn lại tô đỏ", () => {
    const sau = tinhSauKhiTraHetNo(1_000_000, [{ duNo: 4_000_000 }], []);
    expect(renderToStaticMarkup(<SoQuyCard {...base} sauKhiTraHetNo={sau} />)).toContain("text-error");
  });
});
