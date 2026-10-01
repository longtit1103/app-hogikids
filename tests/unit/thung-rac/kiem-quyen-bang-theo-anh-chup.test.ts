import { describe, expect, it } from "vitest";

import { QUYEN_CHU_SHOP } from "@/lib/quyen/cong-action";
import { DANH_MUC_QUYEN, type Quyen } from "@/lib/quyen/danh-muc-quyen";
import { kiemQuyenBang, LoiThieuQuyenThungRac } from "@/lib/thung-rac/quyen-thung-rac";
import { nguoiDungGia } from "../../helpers/nguoi-dung-gia";

/**
 * `kiemQuyenBang` — cổng quyền thùng rác theo LOẠI bản ghi + ảnh chụp (hàm thuần, không DB):
 *  - loại lạ (dữ liệu hỏng / bản cũ) ⇒ CHỈ chủ shop, kể cả nhân sự tick đủ mọi quyền;
 *  - dòng tiền gắn khoản vay / sổ tiết kiệm (đọc từ ảnh) ⇒ thêm `tai-chinh-so-quy:sua`;
 *  - ảnh không đọc được ⇒ coi như có gắn (fail-closed).
 */

const nv = (...q: Quyen[]) => nguoiDungGia({ id: "nv", role: "STAFF", quyen: new Set(q) });
const DONG_TIEN = nv("tai-chinh-dong-tien:xem", "tai-chinh-dong-tien:sua");
const DU_HAI = nv("tai-chinh-dong-tien:xem", "tai-chinh-dong-tien:sua", "tai-chinh-so-quy:xem", "tai-chinh-so-quy:sua");
const anh = (chinh: Record<string, unknown>) => ({ ban: 1, chinh, cashMovements: [], thuNhap: [], ghiChu: {} });

function quyenThieu(f: () => void): string | null {
  try {
    f();
    return null;
  } catch (e) {
    if (e instanceof LoiThieuQuyenThungRac) return e.quyenThieu;
    throw e;
  }
}

describe("kiemQuyenBang", () => {
  it("loại bản ghi lạ ⇒ nhân sự tick đủ mọi quyền vẫn bị chặn (chỉ chủ shop)", () => {
    expect(quyenThieu(() => kiemQuyenBang(nv(...DANH_MUC_QUYEN), "BangLa", anh({})))).toBe(QUYEN_CHU_SHOP);
    expect(quyenThieu(() => kiemQuyenBang(nguoiDungGia(), "BangLa", anh({})))).toBeNull();
  });

  it("dòng tiền gắn khoản vay / sổ tiết kiệm ⇒ đòi thêm so-quy:sua", () => {
    expect(quyenThieu(() => kiemQuyenBang(DONG_TIEN, "CashMovement", anh({ loanId: "l1", savingsId: null })))).toBe(
      "tai-chinh-so-quy:sua",
    );
    expect(quyenThieu(() => kiemQuyenBang(DONG_TIEN, "CashMovement", anh({ loanId: null, savingsId: "s1" })))).toBe(
      "tai-chinh-so-quy:sua",
    );
    expect(quyenThieu(() => kiemQuyenBang(DU_HAI, "CashMovement", anh({ loanId: "l1", savingsId: null })))).toBeNull();
  });

  it("dòng tiền trơn ⇒ chỉ cần quyền dòng tiền; thiếu quyền dòng tiền ⇒ nêu đúng quyền đó trước", () => {
    expect(quyenThieu(() => kiemQuyenBang(DONG_TIEN, "CashMovement", anh({ loanId: null, savingsId: null })))).toBeNull();
    expect(
      quyenThieu(() => kiemQuyenBang(nv("tai-chinh-so-quy:sua"), "CashMovement", anh({ loanId: "l1", savingsId: null }))),
    ).toBe("tai-chinh-dong-tien:sua");
  });

  it("ảnh hỏng / thiếu phần chính ⇒ coi như gắn khoản (fail-closed)", () => {
    for (const hong of [null, "x", {}, [], { chinh: null }, { chinh: [] }, { chinh: "x" }]) {
      expect(quyenThieu(() => kiemQuyenBang(DONG_TIEN, "CashMovement", hong))).toBe("tai-chinh-so-quy:sua");
    }
  });

  it("loại khác giữ nguyên luật theo loại", () => {
    expect(quyenThieu(() => kiemQuyenBang(nv("chi-phi:sua"), "Expense", anh({})))).toBeNull();
    expect(quyenThieu(() => kiemQuyenBang(DONG_TIEN, "Expense", anh({})))).toBe("chi-phi:sua");
    expect(quyenThieu(() => kiemQuyenBang(DONG_TIEN, "Loan", anh({})))).toBe("tai-chinh-so-quy:sua");
  });
});
