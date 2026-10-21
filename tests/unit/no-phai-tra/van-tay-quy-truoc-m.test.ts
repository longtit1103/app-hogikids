import { describe, expect, it } from "vitest";

import { moTaVanTayLech } from "@/lib/no-phai-tra/doc-chenh-lech-tai-m";

/** So vân tay số liệu trước ngày bật (thuần): khớp từng số ⇒ null; lệch ⇒ câu liệt kê từng số đổi cũ → mới. */
const goc = { quyApp: 150_000_000, duNoThauChi: 10_000_000, tongPhieuY: 20_000_000 };

describe("moTaVanTayLech", () => {
  it("khớp cả ba số ⇒ null", () => {
    expect(moTaVanTayLech(goc, { ...goc }, "31/10/2026")).toBeNull();
  });

  it("lệch MỖI số đều bắt (kể cả khi quỹ không đổi)", () => {
    expect(moTaVanTayLech(goc, { ...goc, quyApp: goc.quyApp + 1 }, "31/10/2026")).toContain(
      "quỹ của app cuối 31/10/2026"
    );
    expect(moTaVanTayLech(goc, { ...goc, duNoThauChi: 0 }, "31/10/2026")).toContain("dư nợ thấu chi cuối 31/10/2026");
    expect(moTaVanTayLech(goc, { ...goc, tongPhieuY: 0 }, "31/10/2026")).toContain("phiếu nhập duyệt khác số đã trả");
  });

  it("câu ghi số cũ → mới, chỉ các số đổi", () => {
    const cau = moTaVanTayLech(goc, { ...goc, quyApp: 151_000_000 }, "31/10/2026") ?? "";
    expect(cau).toMatch(/150\.000\.000.*→.*151\.000\.000/);
    expect(cau).not.toContain("thấu chi");
  });
});
