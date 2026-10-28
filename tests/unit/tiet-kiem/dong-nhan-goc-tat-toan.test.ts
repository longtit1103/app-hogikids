import { describe, expect, it } from "vitest";

import {
  chonDongNhanGocDiSan,
  laMoTaMauNhanGocTatToan,
  moTaNhanGocTatToan,
  type DongTienSo,
} from "@/lib/tiet-kiem/dong-nhan-goc-tat-toan";

/**
 * Nhận diện dòng nhận gốc do lượt tất toán CŨ sinh (sổ đóng trước khi có cột trỏ dòng). Ba dấu phải
 * khớp ĐỒNG THỜI và ứng viên phải DUY NHẤT — đoán sai là gán dấu cho dòng tiền thật ghi tay, lượt mở
 * lại sau đó sẽ xoá nó.
 *
 * Ngày dựng bằng `+07:00` nên test không phụ thuộc TZ máy chạy.
 */
const vn = (ngay: string) => new Date(`${ngay}T00:00:00+07:00`);

const SO = { name: "Sổ 6 tháng VCB", closedAt: vn("2027-03-05") };
const MO_TA = "Nhận lại gốc tiết kiệm Sổ 6 tháng VCB — tất toán 05/03/2027";

function dong(p: Partial<DongTienSo> & Pick<DongTienSo, "id" | "kind" | "amount">): DongTienSo {
  return { date: vn("2027-03-05"), description: MO_TA, ...p };
}

const GUI = dong({ id: "gui", kind: "SAVINGS_OUT", amount: 100_000_000, date: vn("2026-09-05"), description: "Gửi" });

describe("moTaNhanGocTatToan", () => {
  it("đúng khuôn tất toán ghi, ngày theo giờ VN (23:30 UTC hôm trước vẫn là ngày VN hôm sau)", () => {
    expect(moTaNhanGocTatToan("Sổ 6 tháng VCB", vn("2027-03-05"))).toBe(MO_TA);
    expect(moTaNhanGocTatToan("A", new Date("2027-03-04T17:30:00Z"))).toBe(
      "Nhận lại gốc tiết kiệm A — tất toán 05/03/2027"
    );
  });

  it("mẫu nhận diện khớp mô tả app sinh với mọi tên sổ, không khớp mô tả ghi tay", () => {
    expect(laMoTaMauNhanGocTatToan(MO_TA)).toBe(true);
    expect(laMoTaMauNhanGocTatToan("Nhận lại gốc tiết kiệm Sổ — có — gạch — tất toán 01/12/2026")).toBe(true);
    expect(laMoTaMauNhanGocTatToan("Ngân hàng trả gốc, ghi tay")).toBe(false);
    expect(laMoTaMauNhanGocTatToan(`${MO_TA} (sửa)`)).toBe(false);
    expect(laMoTaMauNhanGocTatToan("Nhận lại gốc tiết kiệm  — tất toán 05/03/2027")).toBe(true);
  });
});

describe("chonDongNhanGocDiSan", () => {
  it("một dòng khớp đủ ba dấu → chọn đúng dòng đó", () => {
    const kq = chonDongNhanGocDiSan(SO, [GUI, dong({ id: "nhan", kind: "SAVINGS_IN", amount: 100_000_000 })]);
    expect(kq).toEqual({ ok: true, id: "nhan" });
  });

  it("dòng tay 40tr + dòng app 60tr → chọn dòng 60tr (60 = 100 gửi − 40 nhận khác)", () => {
    const kq = chonDongNhanGocDiSan(SO, [
      GUI,
      dong({ id: "tay", kind: "SAVINGS_IN", amount: 40_000_000, date: vn("2027-01-10"), description: "Ghi tay" }),
      dong({ id: "app", kind: "SAVINGS_IN", amount: 60_000_000 }),
    ]);
    expect(kq).toEqual({ ok: true, id: "app" });
  });

  it("hai dòng cùng khớp đủ ba dấu (50 + 50) → KHÔNG chọn", () => {
    const kq = chonDongNhanGocDiSan(SO, [
      GUI,
      dong({ id: "a", kind: "SAVINGS_IN", amount: 50_000_000 }),
      dong({ id: "b", kind: "SAVINGS_IN", amount: 50_000_000 }),
    ]);
    expect(kq.ok).toBe(false);
    if (!kq.ok) expect(kq.lyDo).toContain("2 dòng");
  });

  it.each([
    ["mô tả khác tên sổ", { description: "Nhận lại gốc tiết kiệm Sổ khác — tất toán 05/03/2027" }],
    ["mô tả khác ngày", { description: "Nhận lại gốc tiết kiệm Sổ 6 tháng VCB — tất toán 06/03/2027" }],
    ["ngày dòng khác ngày tất toán", { date: vn("2027-03-06") }],
    ["số tiền lệch Σ gửi − Σ nhận khác", { amount: 99_000_000 }],
  ])("lệch một dấu (%s) → KHÔNG chọn", (_ten, lech) => {
    const kq = chonDongNhanGocDiSan(SO, [GUI, dong({ id: "nhan", kind: "SAVINGS_IN", amount: 100_000_000, ...lech })]);
    expect(kq.ok).toBe(false);
  });

  it("dòng gửi ghi tay thêm được cộng vào Σ gửi (dấu số tiền theo công thức số đang gửi)", () => {
    const kq = chonDongNhanGocDiSan(SO, [
      GUI,
      dong({ id: "gui2", kind: "SAVINGS_OUT", amount: 20_000_000, date: vn("2026-10-01"), description: "Gửi thêm" }),
      dong({ id: "nhan", kind: "SAVINGS_IN", amount: 120_000_000 }),
    ]);
    expect(kq).toEqual({ ok: true, id: "nhan" });
  });
});
