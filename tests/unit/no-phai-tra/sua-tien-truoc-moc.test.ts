import { describe, expect, it } from "vitest";

import {
  cauKhongSuaTien,
  keHoachBuSuaTien,
  lyDoKhongSuaTienTruocMoc,
  moTaDongBu,
  moTaNhatKySuaTien,
  type DongChiXetSuaTien,
  type LyDoKhongSuaTien,
  TRAN_MO_TA_DONG_TIEN,
} from "@/lib/no-phai-tra/sua-tien-truoc-moc";

/**
 * Lõi thuần của lối "Sửa số tiền trước mốc": tư cách của dòng chi (mỗi lý do một mã), chiều + số bù theo ngày mở sổ
 * D0, mô tả dòng bù luôn ≤ 200 ký tự và nêu đúng dòng được sửa. M = 01/10/2026, D0 = 07/09/2026 (giờ VN).
 */
const vn = (ngay: string, gio = "00:00:00") => new Date(`${ngay}T${gio}+07:00`);
const M = vn("2026-10-01");
const D0 = vn("2026-09-07");

const dong = (p: Partial<DongChiXetSuaTien> = {}): DongChiXetSuaTien => ({
  date: vn("2026-09-15"),
  categoryId: "fixed",
  refId: null,
  source: "MANUAL",
  cardId: null,
  ...p,
});

describe("lyDoKhongSuaTienTruocMoc", () => {
  it("dòng ghi tay / import trước M, không thẻ ⇒ sửa được", () => {
    expect(lyDoKhongSuaTienTruocMoc(dong(), M)).toBeNull();
    expect(lyDoKhongSuaTienTruocMoc(dong({ source: "IMPORT", categoryId: "ads", refId: "IMPORT:x" }), M)).toBeNull();
    // Cuối ngày 30/09 giờ VN vẫn là trước M (so theo NGÀY VN, không theo UTC).
    expect(lyDoKhongSuaTienTruocMoc(dong({ date: vn("2026-09-30", "23:59:00") }), M)).toBeNull();
    // Dòng bộ sinh định kỳ: bộ sinh chống trùng theo (mẫu, tháng), không theo số tiền ⇒ sửa được.
    expect(lyDoKhongSuaTienTruocMoc(dong({ source: "RECURRING" }), M)).toBeNull();
    // Lãi vay ghi tay thường (không sinh từ kỳ trả nợ) vẫn là dòng ghi tay.
    expect(lyDoKhongSuaTienTruocMoc(dong({ categoryId: "interest" }), M)).toBeNull();
  });

  it.each<[string, Partial<DongChiXetSuaTien>, Date | null, LyDoKhongSuaTien]>([
    ["chưa bật", {}, null, "CHUA_BAT"],
    ["đúng ngày M", { date: vn("2026-10-01", "08:00:00") }, M, "TU_NGAY_BAT"],
    ["sau M", { date: vn("2026-10-05") }, M, "TU_NGAY_BAT"],
    ["danh mục Nhập hàng", { categoryId: "purchase" }, M, "NHAP_HANG"],
    ["refId phiếu nhập đã đổi sang danh mục khác", { refId: "PANCAKE_PURCHASE:abc" }, M, "NHAP_HANG"],
    ["chi ads cửa máy", { source: "ADS_API", categoryId: "ads" }, M, "CHI_PHI_MAY"],
    ["lãi vay sinh cùng kỳ trả nợ", { categoryId: "interest", refId: "LOAN:l1:2026-09-10" }, M, "LAI_VAY"],
    ["có thẻ", { cardId: "card1" }, M, "CO_THE"],
  ])("%s ⇒ %s", (_ten, p, moc, ma) => {
    expect(lyDoKhongSuaTienTruocMoc(dong(p), moc)).toBe(ma);
    expect(cauKhongSuaTien(ma, moc).length).toBeGreaterThan(10);
  });

  it("câu 'từ ngày bật' nêu đúng ngày M", () => {
    expect(cauKhongSuaTien("TU_NGAY_BAT", M)).toContain("01/10/2026");
  });
});

describe("keHoachBuSuaTien", () => {
  it("Δ > 0 (chi tăng) ⇒ bù VÀO |Δ|; Δ < 0 ⇒ bù RA |Δ|", () => {
    expect(keHoachBuSuaTien(vn("2026-09-15"), 8_000_000, 9_000_000, D0)).toEqual({ coBu: true, chieu: "IN", soTien: 1_000_000 });
    expect(keHoachBuSuaTien(vn("2026-09-15"), 8_000_000, 6_500_000, D0)).toEqual({ coBu: true, chieu: "OUT", soTien: 1_500_000 });
  });

  it("dòng ĐÚNG ngày mở sổ (kể cả giờ trong ngày) ⇒ có bù", () => {
    expect(keHoachBuSuaTien(vn("2026-09-07", "14:00:00"), 100, 300, D0)).toEqual({ coBu: true, chieu: "IN", soTien: 200 });
  });

  it("dòng trước ngày mở sổ hoặc chưa mở sổ ⇒ không bù (dòng nằm ngoài quỹ)", () => {
    expect(keHoachBuSuaTien(vn("2026-09-06", "23:59:00"), 100, 300, D0)).toEqual({ coBu: false });
    expect(keHoachBuSuaTien(vn("2026-08-05"), 100, 300, null)).toEqual({ coBu: false });
  });
});

describe("mô tả", () => {
  it("dòng bù nêu ngày + mô tả dòng chi + cũ → mới + lý do", () => {
    const s = moTaDongBu({ ngayDong: vn("2026-09-15"), moTaDong: "Tiền nhà tháng 9", cu: 8_000_000, moi: 9_000_000, lyDo: "Ghi thiếu" });
    expect(s).toBe('Bù sửa chi phí 15/09/2026 "Tiền nhà tháng 9": 8.000.000 ₫ → 9.000.000 ₫ — Ghi thiếu');
  });

  it("mô tả + lý do dài ⇒ cắt ≤ 200 ký tự, phần nêu dòng chi giữ nguyên", () => {
    const s = moTaDongBu({
      ngayDong: vn("2026-09-15"),
      moTaDong: "x".repeat(150),
      cu: 1_999_999_999,
      moi: 2_000_000_000,
      lyDo: "y".repeat(120),
    });
    expect(s.length).toBeLessThanOrEqual(TRAN_MO_TA_DONG_TIEN);
    expect(s).toContain(`"${"x".repeat(39)}…": 1.999.999.999 ₫ → 2.000.000.000 ₫`);
    expect(s.endsWith("…")).toBe(true);
  });

  it("dòng chi không mô tả ⇒ mô tả dòng bù vẫn không rỗng", () => {
    expect(moTaDongBu({ ngayDong: vn("2026-09-15"), moTaDong: "  ", cu: 1, moi: 2, lyDo: "z" })).toContain("(không mô tả)");
  });

  it("nhật ký nêu số cũ → mới và có / không bù", () => {
    const chung = { ngayDong: vn("2026-09-15"), moTaDong: "Tiền nhà", cu: 8_000_000, moi: 9_000_000, lyDo: "Ghi thiếu", mocM: M };
    expect(moTaNhatKySuaTien({ ...chung, bu: { coBu: true, chieu: "IN", soTien: 1_000_000 } })).toBe(
      'Sửa số tiền chi phí 15/09/2026 "Tiền nhà": 8.000.000 ₫ → 9.000.000 ₫ · bù điều chỉnh mở sổ vào 1.000.000 ₫ ngày ' +
        "01/10/2026 · lý do: Ghi thiếu"
    );
    expect(moTaNhatKySuaTien({ ...chung, bu: { coBu: false } })).toContain("không bù");
  });
});
