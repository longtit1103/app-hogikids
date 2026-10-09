import { describe, expect, it } from "vitest";

import { lyDoKhongXoaPhieu } from "@/lib/no-phai-tra/ly-do-khong-xoa-phieu";

describe("lyDoKhongXoaPhieu", () => {
  it("không còn dòng tiền ⇒ xoá được (null)", () => {
    expect(lyDoKhongXoaPhieu({ soDongTien: 0 })).toBeNull();
  });

  it("còn dòng tiền (kể cả trả rồi hoàn Σ = 0) ⇒ chặn, câu nêu số dòng + đường gỡ", () => {
    const lyDo = lyDoKhongXoaPhieu({ soDongTien: 2 });
    expect(lyDo).toContain("2 dòng");
    expect(lyDo).toContain("Khoản tiền khác");
  });
});
