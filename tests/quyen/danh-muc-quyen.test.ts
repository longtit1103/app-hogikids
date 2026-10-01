import { describe, expect, it } from "vitest";

import { chuanHoaQuyen, DANH_MUC_QUYEN, laQuyen, NHAN_QUYEN, xemCuaSua } from "@/lib/quyen/danh-muc-quyen";

describe("chuanHoaQuyen", () => {
  it("bỏ mã lạ, không ném", () => {
    expect(chuanHoaQuyen(["don-hang:xem", "khong-co:xem"])).toEqual({ ok: true, quyen: ["don-hang:xem"] });
  });

  it("sua kéo theo xem cùng module", () => {
    const r = chuanHoaQuyen(["chi-phi:sua"]);
    expect(r).toEqual({ ok: true, quyen: expect.arrayContaining(["chi-phi:sua", "chi-phi:xem"]) });
  });

  it("loi-lo:xem mà thiếu gia-von-loi-nhuan:xem ⇒ lỗi, không tự tick", () => {
    const r = chuanHoaQuyen(["tai-chinh-loi-lo:xem"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/giá vốn/);
  });

  it("loi-lo:xem kèm gia-von-loi-nhuan:xem ⇒ hợp lệ", () => {
    expect(chuanHoaQuyen(["tai-chinh-loi-lo:xem", "gia-von-loi-nhuan:xem"]).ok).toBe(true);
  });

  it("gia-von-loi-nhuan:xem KHÔNG mở module nào", () => {
    expect(chuanHoaQuyen(["gia-von-loi-nhuan:xem"])).toEqual({ ok: true, quyen: ["gia-von-loi-nhuan:xem"] });
  });

  it("khử trùng lặp và trả theo thứ tự danh mục", () => {
    const r = chuanHoaQuyen(["ton-kho:xem", "don-hang:xem", "ton-kho:xem"]);
    expect(r).toEqual({ ok: true, quyen: ["don-hang:xem", "ton-kho:xem"] });
  });

  it("danh mục không chứa owner-only", () => {
    for (const q of DANH_MUC_QUYEN) expect(q).not.toMatch(/backup|phuc-hoi|tai-khoan|khoa-ket-noi|xoa-du-lieu/);
    expect(laQuyen("sao-luu:tai")).toBe(false);
  });

  it("module chỉ-xem không có mã sua", () => {
    expect(laQuyen("don-hang:sua")).toBe(false);
    expect(laQuyen("tong-quan:sua")).toBe(false);
    expect(laQuyen("chi-phi:sua")).toBe(true);
  });
});

describe("xemCuaSua + NHAN_QUYEN", () => {
  it("sua → xem cùng module; xem/quyền đặc biệt → null", () => {
    expect(xemCuaSua("chi-phi:sua")).toBe("chi-phi:xem");
    expect(xemCuaSua("chi-phi:xem")).toBeNull();
    expect(xemCuaSua("xuat-du-lieu")).toBeNull();
  });

  it("mọi mã trong danh mục đều có nhãn tiếng Việt", () => {
    for (const q of DANH_MUC_QUYEN) expect(NHAN_QUYEN[q]?.length ?? 0).toBeGreaterThan(0);
  });
});
