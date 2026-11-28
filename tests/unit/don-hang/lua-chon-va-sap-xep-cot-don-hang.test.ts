import { describe, expect, it } from "vitest";

import {
  chipHienThi,
  demLocDangBat,
  dungChipDangAp,
  locSauKhiBatTat,
  luaChonSapXep,
} from "@/components/don-hang/lua-chon-loc-don-hang";
import { ariaSortCot, sapXepKhiBamCot } from "@/components/don-hang/sap-xep-cot-don-hang";
import type { BoLocDonHang } from "@/lib/orders/don-hang-kieu-du-lieu";

const BO_LOC: BoLocDonHang = {
  ky: { loai: "tat_ca" },
  statuses: [],
  channels: [],
  q: "",
  loc: [],
  sx: "moi",
  trang: 1,
  don: null,
};

describe("lựa chọn lọc theo quyền", () => {
  it("không quyền giá vốn ⇒ không chip Đơn lỗ/Thiếu giá vốn, không sắp theo lãi", () => {
    expect(chipHienThi(false).map((c) => c.id)).toEqual(["phi_tam"]);
    expect(luaChonSapXep(false).map((s) => s.id)).toEqual(["moi", "cu", "tien_cao", "tien_thap"]);
  });

  it("có quyền ⇒ đủ", () => {
    expect(chipHienThi(true).map((c) => c.id)).toEqual(["lo", "thieu_gv", "phi_tam"]);
    expect(luaChonSapXep(true).map((s) => s.id)).toContain("lai_thap");
  });
});

describe("chip đang áp + đếm lọc", () => {
  const kenh = [{ id: "shopee", name: "Shopee" }];

  it("không lọc ngoài kỳ ⇒ không chip, đếm 0", () => {
    expect(dungChipDangAp(BO_LOC, kenh)).toEqual([]);
    expect(demLocDangBat(BO_LOC)).toBe(0);
  });

  it("một trạng thái đã có tab ⇒ không chip trạng thái; ≥ 2 ⇒ có", () => {
    expect(dungChipDangAp({ ...BO_LOC, statuses: ["COMPLETED"] }, kenh)).toEqual([]);
    const nhieu = dungChipDangAp({ ...BO_LOC, statuses: ["PENDING", "SHIPPING", "COMPLETED"] }, kenh);
    expect(nhieu.map((c) => c.nhan)).toEqual(["Trạng thái: Chờ xử lý, Đang giao, Thành công"]);
    expect(nhieu[0].doi).toEqual({ trang_thai: null });
  });

  it("kênh, chip, tìm: nhãn + thay đổi bỏ riêng từng cái", () => {
    const chip = dungChipDangAp({ ...BO_LOC, channels: ["shopee", "la"], loc: ["lo", "phi_tam"], q: "váy" }, kenh);
    expect(chip.map((c) => c.nhan)).toEqual(["Kênh: Shopee, la", "Đơn lỗ", "Phí tạm tính", "Tìm: “váy”"]);
    expect(chip[1].doi).toEqual({ loc: "phi_tam" });
    expect(chip[2].doi).toEqual({ loc: "lo" });
  });

  it("đếm: kênh tính 1, mỗi chip 1, sắp xếp khác mặc định 1", () => {
    expect(demLocDangBat({ ...BO_LOC, channels: ["a", "b"], loc: ["lo", "thieu_gv"], sx: "tien_cao" })).toBe(4);
  });

  it("bật/tắt chip trả chuỗi phẩy, rỗng ⇒ null", () => {
    expect(locSauKhiBatTat([], "lo")).toBe("lo");
    expect(locSauKhiBatTat(["lo"], "phi_tam")).toBe("lo,phi_tam");
    expect(locSauKhiBatTat(["lo"], "lo")).toBeNull();
  });
});

describe("sắp xếp bằng tiêu đề cột", () => {
  it("cột chưa sắp ⇒ chiều mặc định", () => {
    expect(sapXepKhiBamCot("ngay", "tien_cao")).toBe("moi");
    expect(sapXepKhiBamCot("tien", "moi")).toBe("tien_cao");
    expect(sapXepKhiBamCot("lai", "moi")).toBe("lai_thap");
  });

  it("cột đang sắp ⇒ đảo chiều", () => {
    expect(sapXepKhiBamCot("ngay", "moi")).toBe("cu");
    expect(sapXepKhiBamCot("ngay", "cu")).toBe("moi");
    expect(sapXepKhiBamCot("tien", "tien_cao")).toBe("tien_thap");
    expect(sapXepKhiBamCot("lai", "lai_thap")).toBe("lai_cao");
  });

  it("aria-sort chỉ có trên cột đang sắp", () => {
    expect(ariaSortCot("ngay", "moi")).toBe("descending");
    expect(ariaSortCot("ngay", "cu")).toBe("ascending");
    expect(ariaSortCot("tien", "tien_thap")).toBe("ascending");
    expect(ariaSortCot("lai", "lai_thap")).toBe("ascending");
    expect(ariaSortCot("lai", "moi")).toBeUndefined();
  });
});
