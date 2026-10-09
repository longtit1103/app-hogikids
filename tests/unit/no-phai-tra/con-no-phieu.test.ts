import { describe, expect, it } from "vitest";

import { conNoPhieu, nhanTrangThaiPhieu } from "@/lib/no-phai-tra/con-no-phieu";

describe("conNoPhieu — còn nợ một phiếu nhập", () => {
  it("trả một phần ⇒ còn dương", () => {
    expect(conNoPhieu({ tongTien: 100, daTraTruoc: 0, daHuy: false, daTra: 10, daHoan: 0 })).toBe(90);
  });

  it("đã trả trước một phần lúc nhập ⇒ trừ vào nợ", () => {
    expect(conNoPhieu({ tongTien: 53.6, daTraTruoc: 33.6, daHuy: false, daTra: 0, daHoan: 0 })).toBeCloseTo(20, 10);
  });

  it("trả quá tổng phiếu ⇒ âm, nhãn TRA_THUA", () => {
    const conNo = conNoPhieu({ tongTien: 20, daTraTruoc: 0, daHuy: false, daTra: 23, daHoan: 0 });
    expect(conNo).toBe(-3);
    expect(nhanTrangThaiPhieu(conNo, false)).toBe("TRA_THUA");
  });

  it("phiếu huỷ đã có tiền trả ⇒ âm, nhãn CAN_THU_HOI", () => {
    const conNo = conNoPhieu({ tongTien: 20, daTraTruoc: 0, daHuy: true, daTra: 5, daHoan: 0 });
    expect(conNo).toBe(-5);
    expect(nhanTrangThaiPhieu(conNo, true)).toBe("CAN_THU_HOI");
  });

  it("nhà cung cấp hoàn phần trả thừa ⇒ về 0, DA_TRA_DU", () => {
    const conNo = conNoPhieu({ tongTien: 20, daTraTruoc: 0, daHuy: false, daTra: 23, daHoan: 3 });
    expect(conNo).toBe(0);
    expect(nhanTrangThaiPhieu(conNo, false)).toBe("DA_TRA_DU");
  });

  it("phiếu huỷ chưa trả đồng nào ⇒ 0, DA_TRA_DU", () => {
    const conNo = conNoPhieu({ tongTien: 20, daTraTruoc: 0, daHuy: true, daTra: 0, daHoan: 0 });
    expect(conNo).toBe(0);
    expect(nhanTrangThaiPhieu(conNo, true)).toBe("DA_TRA_DU");
  });

  it("còn nợ dương ⇒ CON_NO", () => {
    expect(nhanTrangThaiPhieu(90, false)).toBe("CON_NO");
  });
});
