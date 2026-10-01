import { describe, expect, it } from "vitest";

import { chuanHoaQuyen, DANH_MUC_QUYEN } from "@/lib/quyen/danh-muc-quyen";
import { VAI_TRO_MAU, type MaVaiTroMau } from "@/lib/quyen/vai-tro-mau";

const CAC_MA = Object.keys(VAI_TRO_MAU) as MaVaiTroMau[];

describe("VAI_TRO_MAU", () => {
  it("đủ 4 mẫu", () => {
    expect(CAC_MA.sort()).toEqual(["dong-so-huu", "ke-toan", "kho", "marketing"]);
  });

  it.each(CAC_MA)("mẫu %s ⊆ danh mục và chuẩn hoá hợp lệ (không đổi nội dung)", (ma) => {
    const quyen = VAI_TRO_MAU[ma].quyen;
    for (const q of quyen) expect(DANH_MUC_QUYEN).toContain(q);
    const r = chuanHoaQuyen(quyen);
    expect(r.ok).toBe(true);
    // Mẫu đã tự thoả ràng buộc (sua ⇒ xem) — chuẩn hoá không được thêm bớt gì.
    if (r.ok) expect([...r.quyen].sort()).toEqual([...quyen].sort());
  });

  it("mẫu Kho KHÔNG có tong-quan:xem, xuat-du-lieu, giá vốn", () => {
    const kho = VAI_TRO_MAU.kho.quyen;
    expect([...kho].sort()).toEqual(["don-hang:xem", "san-pham:xem", "ton-kho:xem"]);
    expect(kho).not.toContain("tong-quan:xem");
    expect(kho).not.toContain("xuat-du-lieu");
    expect(kho).not.toContain("gia-von-loi-nhuan:xem");
  });

  it("mẫu Kế toán thoả ràng buộc Lãi/Lỗ ⇒ giá vốn", () => {
    const kt = VAI_TRO_MAU["ke-toan"].quyen;
    expect(kt).toContain("tai-chinh-loi-lo:xem");
    expect(kt).toContain("gia-von-loi-nhuan:xem");
    for (const q of ["tai-chinh-dong-tien:sua", "tai-chinh-so-quy:sua", "chi-phi:sua", "xuat-du-lieu"] as const) {
      expect(kt).toContain(q);
    }
  });

  it("mẫu Đồng sở hữu = mọi :xem + 2 quyền đặc biệt, không :sua", () => {
    const dsh = VAI_TRO_MAU["dong-so-huu"].quyen;
    const moiXem = DANH_MUC_QUYEN.filter((q) => q.endsWith(":xem"));
    expect([...dsh].sort()).toEqual([...moiXem, "xuat-du-lieu"].sort());
    expect(dsh.some((q) => q.endsWith(":sua"))).toBe(false);
  });

  it("mẫu Marketing có marketing:sua + các quyền xem theo spec", () => {
    expect([...VAI_TRO_MAU.marketing.quyen].sort()).toEqual(
      ["bao-cao:xem", "don-hang:xem", "kenh:xem", "marketing:sua", "marketing:xem", "tong-quan:xem"].sort(),
    );
  });
});
