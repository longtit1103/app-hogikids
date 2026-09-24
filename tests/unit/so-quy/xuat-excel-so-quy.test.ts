import { describe, expect, it } from "vitest";

import type { DongSoQuy, SoQuyDongChay } from "@/lib/so-quy/dong-chay-so-quy-types";
import type { SoQuyThangDayDu } from "@/lib/so-quy/so-quy-queries";
import { buildSoQuySheetRows } from "@/lib/so-quy/xuat-excel-so-quy";

/**
 * Builder THUẦN sheet Excel Sổ quỹ (dòng chạy). Không chạm DB — chỉ kiểm hình dạng hàng ra: thứ tự
 * cột, tiền là NUMBER (không chuỗi `formatVnd`), dòng Đầu/Cuối kỳ neo đúng số thẻ (không tự cộng),
 * dòng Tổng, luật hiện giờ VN, nhãn "Cuối kỳ" KHỚP màn hình (`nhanCuoiKySoQuy`), và dòng cảnh báo khi
 * `lechDoiChieu`.
 */

const vn = (iso: string) => new Date(`${iso}+07:00`);

function dong(p: Partial<DongSoQuy> & Pick<DongSoQuy, "key" | "ngay" | "nguon" | "thu" | "chi" | "soDu">): DongSoQuy {
  return { dienGiai: "", ...p };
}

/** `the` không được builder đọc — chỉ điền đủ hình dạng cho tsc, giá trị không ảnh hưởng test. */
const THE_RONG: SoQuyThangDayDu = {
  d0: vn("2026-09-01T00:00:00"),
  dauKy: 0,
  thu: 0,
  chi: 0,
  cuoiKy: 0,
  quyHomNay: 0,
  truocMoSo: false,
  adsTiktok: { soChiPhi: 0, sanTruVi: 0 },
  canhBao: {
    tiktokPaidThieuNgay: 0,
    shopeeViTuNgay: null,
    shopeeViToiNgay: null,
    shopeeThieuTruocD0: false,
    shopeeChuaPhanLoai: 0,
    coDinhKyActive: false,
    adsViVuotSo: false,
  },
};

function coSo(p: Partial<Extract<SoQuyDongChay, { trangThai: "CO_SO" }>>): Extract<SoQuyDongChay, { trangThai: "CO_SO" }> {
  return {
    trangThai: "CO_SO",
    d0: vn("2026-09-01T00:00:00"),
    tu: vn("2026-09-01T00:00:00"),
    den: vn("2026-09-30T23:59:59"),
    dauKy: 1_000_000,
    cuoiKy: 1_500_000,
    tongThu: 800_000,
    tongChi: 300_000,
    dong: [],
    lechDoiChieu: null,
    the: THE_RONG,
    ...p,
  };
}

describe("buildSoQuySheetRows — thứ tự cột + kiểu tiền", () => {
  it("cột đúng thứ tự Ngày · Nguồn · Diễn giải · Thu · Chi · Số dư", () => {
    const d = coSo({
      dong: [
        dong({
          key: "GHI_TAY:1",
          ngay: vn("2026-09-05T00:00:00"),
          nguon: "GHI_TAY",
          dienGiai: "Góp vốn",
          thu: 800_000,
          chi: 0,
          soDu: 1_800_000,
        }),
      ],
    });
    const rows = buildSoQuySheetRows(d, false);
    expect(Object.keys(rows[1])).toEqual(["Ngày", "Nguồn", "Diễn giải", "Thu", "Chi", "Số dư"]);
  });

  it("Thu/Chi/Số dư của dòng phát sinh là NUMBER, không phải chuỗi formatVnd", () => {
    const d = coSo({
      dong: [
        dong({
          key: "CHI_PHI:1",
          ngay: vn("2026-09-10T00:00:00"),
          nguon: "CHI_PHI",
          dienGiai: "Đóng gói",
          thu: 0,
          chi: 300_000,
          soDu: 700_000,
        }),
      ],
    });
    const row = buildSoQuySheetRows(d, false)[1];
    expect(row.Thu).toBe(0);
    expect(row.Chi).toBe(300_000);
    expect(row["Số dư"]).toBe(700_000);
    expect(typeof row.Chi).toBe("number");
  });

  it("Nguồn dùng đúng nhãn tiếng Việt dùng chung với bảng trên màn", () => {
    const d = coSo({
      dong: [
        dong({
          key: "BAN_TRUC_TIEP:1",
          ngay: vn("2026-09-12T00:00:00"),
          nguon: "BAN_TRUC_TIEP",
          thu: 200_000,
          chi: 0,
          soDu: 1_200_000,
        }),
      ],
    });
    expect(buildSoQuySheetRows(d, false)[1].Nguồn).toBe("Bán trực tiếp");
  });

  it("ghim thêm nhãn 'Ghi tay' — đổi Record NGUON_LABEL phải làm rớt test này chứ không lặng lẽ xanh", () => {
    const d2 = coSo({
      dong: [dong({ key: "GHI_TAY:2", ngay: vn("2026-09-06T00:00:00"), nguon: "GHI_TAY", thu: 1, chi: 0, soDu: 1 })],
    });
    expect(buildSoQuySheetRows(d2, false)[1].Nguồn).toBe("Ghi tay");
  });
});

describe("buildSoQuySheetRows — dòng Đầu kỳ · Tổng · Cuối kỳ", () => {
  const d = coSo({
    dauKy: 1_000_000,
    cuoiKy: 1_500_000,
    tongThu: 800_000,
    tongChi: 300_000,
    dong: [
      dong({ key: "a", ngay: vn("2026-09-05T00:00:00"), nguon: "GHI_TAY", thu: 800_000, chi: 0, soDu: 1_800_000 }),
      dong({ key: "b", ngay: vn("2026-09-10T00:00:00"), nguon: "CHI_PHI", thu: 0, chi: 300_000, soDu: 1_500_000 }),
    ],
  });
  const rows = buildSoQuySheetRows(d, false);

  it("dòng ĐẦU là Đầu kỳ, Số dư = dauKy của thẻ (không tự cộng)", () => {
    expect(rows[0]["Diễn giải"]).toBe("Đầu kỳ");
    expect(rows[0]["Số dư"]).toBe(1_000_000);
  });

  it("dòng Tổng: Thu = tongThu, Chi = tongChi", () => {
    const dongTong = rows.find((r) => r["Diễn giải"] === "Tổng");
    expect(dongTong).toBeDefined();
    expect(dongTong?.Thu).toBe(800_000);
    expect(dongTong?.Chi).toBe(300_000);
  });

  it("dòng CUỐI (không lệch) là Cuối kỳ, Số dư = cuoiKy của thẻ (không tự cộng)", () => {
    const cuoiCung = rows.at(-1)!;
    expect(cuoiCung["Diễn giải"]).toBe("Cuối kỳ");
    expect(cuoiCung["Số dư"]).toBe(1_500_000);
  });

  it("kỳ rỗng (không phát sinh) vẫn có đủ Đầu kỳ + Tổng + Cuối kỳ", () => {
    const rong = buildSoQuySheetRows(coSo({ dong: [], tongThu: 0, tongChi: 0 }), false);
    expect(rong.map((r) => r["Diễn giải"])).toEqual(["Đầu kỳ", "Tổng", "Cuối kỳ"]);
  });
});

describe("buildSoQuySheetRows — nhãn 'Cuối kỳ' KHỚP màn hình (nhanCuoiKySoQuy)", () => {
  // `the.cuoiKy !== the.quyHomNay` + tháng hiện tại ⇒ vẫn còn khoản ghi ngày sau hôm nay, cùng luật
  // `so-quy-card.tsx`/bảng trên màn — sheet PHẢI đổi nhãn giống hệt, không được in "Cuối kỳ" trơn.
  const theLech: SoQuyThangDayDu = { ...THE_RONG, cuoiKy: 1_500_000, quyHomNay: 1_200_000 };

  it("tháng hiện tại + còn khoản ghi ngày sau hôm nay ⇒ 'Cuối kỳ (dự kiến hết tháng)'", () => {
    const rows = buildSoQuySheetRows(coSo({ the: theLech }), true);
    expect(rows.at(-1)!["Diễn giải"]).toBe("Cuối kỳ (dự kiến hết tháng)");
  });

  it("KHÔNG phải tháng hiện tại (đang xem tháng đã qua) ⇒ vẫn 'Cuối kỳ' trơn dù cuoiKy≠quyHomNay", () => {
    const rows = buildSoQuySheetRows(coSo({ the: theLech }), false);
    expect(rows.at(-1)!["Diễn giải"]).toBe("Cuối kỳ");
  });

  it("tháng hiện tại nhưng cuoiKy = quyHomNay (không còn khoản dự kiến) ⇒ vẫn 'Cuối kỳ' trơn", () => {
    const rows = buildSoQuySheetRows(coSo({ the: THE_RONG }), true);
    expect(rows.at(-1)!["Diễn giải"]).toBe("Cuối kỳ");
  });
});

describe("buildSoQuySheetRows — cột Ngày theo giờ VN", () => {
  it("giờ VN = 00:00 ⇒ chỉ dd/MM/yyyy, không có giờ", () => {
    const d = coSo({
      dong: [dong({ key: "a", ngay: vn("2026-09-05T00:00:00"), nguon: "GHI_TAY", thu: 1, chi: 0, soDu: 1 })],
    });
    expect(buildSoQuySheetRows(d, false)[1].Ngày).toBe("05/09/2026");
  });

  it("giờ VN ≠ 00:00 ⇒ cộng thêm HH:mm", () => {
    const d = coSo({
      dong: [dong({ key: "a", ngay: vn("2026-09-05T14:30:00"), nguon: "GHI_TAY", thu: 1, chi: 0, soDu: 1 })],
    });
    expect(buildSoQuySheetRows(d, false)[1].Ngày).toBe("05/09/2026 14:30");
  });
});

describe("buildSoQuySheetRows — lệch đối chiếu", () => {
  it("lechDoiChieu = null ⇒ không có dòng cảnh báo", () => {
    const rows = buildSoQuySheetRows(coSo({ lechDoiChieu: null }), false);
    expect(rows.some((r) => String(r["Diễn giải"]).includes("CẢNH BÁO"))).toBe(false);
  });

  it("lechDoiChieu có giá trị ⇒ thêm dòng cảnh báo cuối sheet, nêu rõ hai số lệch", () => {
    const rows = buildSoQuySheetRows(
      coSo({ lechDoiChieu: { cuoiKyThe: 1_500_000, cuoiKyTuDong: 1_400_000 } }),
      false
    );
    const canhBao = rows.at(-1)!;
    expect(String(canhBao["Diễn giải"])).toContain("CẢNH BÁO");
    expect(String(canhBao["Diễn giải"])).toContain("1.500.000");
    expect(String(canhBao["Diễn giải"])).toContain("1.400.000");
    // Dòng "Cuối kỳ" vẫn phải đứng NGAY TRƯỚC dòng cảnh báo (cảnh báo là dòng thêm ở cuối, không thay).
    expect(rows.at(-2)!["Diễn giải"]).toBe("Cuối kỳ");
  });
});
