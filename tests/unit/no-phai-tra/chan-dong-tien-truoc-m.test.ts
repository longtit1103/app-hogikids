import { describe, expect, it } from "vitest";

import {
  cauDongTienTruocM,
  chanDongTienTruocM,
  laSuaChiMoTa,
  LoiDongTienTruocM,
  lyDoDongTienTruocM,
  type PhanTienDongTien,
  type ThaoTacDongTien,
} from "@/lib/no-phai-tra/chan-dong-tien-truoc-m";

/**
 * Cổng dòng tiền ghi tay trước M — thuần trên `Setting` giả (không DB). Đã bật (M ≠ null) ⇒ dòng ngày < M (ngày VN)
 * không thêm / xoá / khôi phục / đổi tiền-ngày-loại-khoá cha; ngoại lệ duy nhất: sửa chỉ đổi mô tả.
 */

const vn = (iso: string) => new Date(`${iso}+07:00`);
const M = vn("2026-10-01T00:00:00");

/** `db` giả chỉ có `setting.findUnique` — đúng phần `docMocM` đọc. */
function dbVoiM(giaTri: string | null) {
  return {
    setting: {
      findUnique: async () => (giaTri === null ? null : { value: giaTri }),
    },
  } as unknown as Parameters<typeof chanDongTienTruocM>[0];
}

const dong = (ngay: string, sua: Partial<PhanTienDongTien> = {}): PhanTienDongTien => ({
  date: vn(ngay),
  amount: 50_000_000,
  kind: "LOAN_REPAY",
  loanId: "vay-1",
  savingsId: null,
  cardId: null,
  phieuNhapId: null,
  viAdsId: null,
  ...sua,
});

const sua = (cu: PhanTienDongTien, moi: PhanTienDongTien): ThaoTacDongTien => ({ loai: "SUA", cu, moi });

describe("lyDoDongTienTruocM — lõi thuần", () => {
  it("chưa bật (M null) ⇒ mọi thao tác cho qua", () => {
    const truoc = dong("2026-09-15T00:00:00");
    const ca: ThaoTacDongTien[] = [
      { loai: "TAO", ngay: [truoc.date] },
      { loai: "XOA", ngay: [truoc.date] },
      sua(truoc, { ...truoc, amount: 1 }),
      sua(truoc, dong("2026-10-05T00:00:00")),
    ];
    for (const t of ca) expect(lyDoDongTienTruocM(t, null)).toBeNull();
  });

  it("tạo / xoá: ngày M−1 23:59:59 VN ⇒ chặn; đúng M 00:00 VN ⇒ qua", () => {
    for (const loai of ["TAO", "XOA"] as const) {
      expect(lyDoDongTienTruocM({ loai, ngay: [vn("2026-09-30T23:59:59")] }, M), loai).toBe("TRUOC_M");
      expect(lyDoDongTienTruocM({ loai, ngay: [vn("2026-10-01T00:00:00")] }, M), loai).toBeNull();
      expect(lyDoDongTienTruocM({ loai, ngay: [vn("2026-10-20T15:00:00")] }, M), loai).toBeNull();
    }
  });

  it("tạo / xoá nhiều dòng: một dòng < M trong mảng là chặn cả lượt; mảng rỗng ⇒ qua", () => {
    const ngay = [vn("2026-10-02T00:00:00"), vn("2026-09-28T00:00:00")];
    expect(lyDoDongTienTruocM({ loai: "TAO", ngay }, M)).toBe("TRUOC_M");
    expect(lyDoDongTienTruocM({ loai: "XOA", ngay }, M)).toBe("TRUOC_M");
    expect(lyDoDongTienTruocM({ loai: "TAO", ngay: [vn("2026-10-02T00:00:00"), M] }, M)).toBeNull();
    expect(lyDoDongTienTruocM({ loai: "XOA", ngay: [] }, M)).toBeNull();
  });

  it("biên múi giờ: so theo NGÀY VN chứ không theo ngày UTC", () => {
    // 2026-09-30T17:00Z = 01/10 00:00 VN — ngày UTC là 30/09 nhưng ngày VN là M ⇒ không trước M.
    expect(lyDoDongTienTruocM({ loai: "TAO", ngay: [new Date("2026-09-30T17:00:00Z")] }, M)).toBeNull();
    // 2026-09-30T16:59:59Z = 30/09 23:59:59 VN ⇒ trước M.
    expect(lyDoDongTienTruocM({ loai: "TAO", ngay: [new Date("2026-09-30T16:59:59Z")] }, M)).toBe("TRUOC_M");
    // 2026-09-30T00:30Z = 30/09 07:30 VN — cùng ngày UTC lẫn VN, trước M.
    expect(lyDoDongTienTruocM({ loai: "XOA", ngay: [new Date("2026-09-30T00:30:00Z")] }, M)).toBe("TRUOC_M");
  });

  it("sửa dòng < M chỉ đổi mô tả (cùng ngày VN, khác giờ) ⇒ qua", () => {
    const cu = dong("2026-09-15T00:00:00");
    expect(lyDoDongTienTruocM(sua(cu, { ...cu }), M)).toBeNull();
    expect(lyDoDongTienTruocM(sua(cu, { ...cu, date: vn("2026-09-15T10:30:00") }), M)).toBeNull();
  });

  it("sửa dòng < M đổi bất kỳ phần chạm tiền nào ⇒ chặn", () => {
    const cu = dong("2026-09-15T00:00:00");
    const doi: Array<[string, Partial<PhanTienDongTien>]> = [
      ["amount", { amount: 49_000_000 }],
      ["kind", { kind: "LOAN_IN" }],
      ["loanId", { loanId: "vay-2" }],
      ["loanId → null", { loanId: null }],
      ["savingsId", { savingsId: "so-1" }],
      ["cardId", { cardId: "the-1" }],
      ["phieuNhapId", { phieuNhapId: "phieu-1" }],
      ["viAdsId", { viAdsId: "vi-1" }],
      ["date trong < M", { date: vn("2026-09-16T00:00:00") }],
    ];
    for (const [ten, phan] of doi) expect(lyDoDongTienTruocM(sua(cu, { ...cu, ...phan }), M), ten).toBe("TRUOC_M");
  });

  it("dời qua mốc theo cả hai chiều ⇒ chặn; ≥ M → ≥ M ⇒ qua (luật cũ)", () => {
    const sau = dong("2026-10-05T00:00:00");
    const truoc = dong("2026-09-30T23:59:59");
    expect(lyDoDongTienTruocM(sua(sau, { ...sau, date: truoc.date }), M)).toBe("TRUOC_M");
    expect(lyDoDongTienTruocM(sua(truoc, { ...truoc, date: sau.date }), M)).toBe("TRUOC_M");
    expect(lyDoDongTienTruocM(sua(sau, { ...sau, date: vn("2026-10-09T00:00:00"), amount: 1, kind: "LOAN_IN" }), M)).toBeNull();
    expect(lyDoDongTienTruocM(sua(dong("2026-10-01T00:00:00"), dong("2026-10-01T00:00:00", { amount: 7 })), M)).toBeNull();
  });
});

describe("laSuaChiMoTa", () => {
  it("cùng ngày VN dù khác giờ ⇒ true; khác ngày VN dù cách vài phút qua nửa đêm ⇒ false", () => {
    const cu = dong("2026-09-15T00:00:00");
    expect(laSuaChiMoTa(cu, { ...cu, date: vn("2026-09-15T23:59:59") })).toBe(true);
    expect(laSuaChiMoTa(cu, { ...cu, date: vn("2026-09-14T23:59:59") })).toBe(false);
  });
});

describe("chanDongTienTruocM — cổng đọc M", () => {
  const taoTruoc: ThaoTacDongTien = { loai: "TAO", ngay: [vn("2026-09-30T23:59:59")] };

  it("Setting vắng / rỗng / toàn khoảng trắng ⇒ qua", async () => {
    for (const gt of [null, "", "   "]) await expect(chanDongTienTruocM(dbVoiM(gt), taoTruoc)).resolves.toBeUndefined();
  });

  it("đã bật + ngày < M ⇒ ném LoiDongTienTruocM mã DA_BAT_NO_PHAI_TRA, field date, câu nêu ngày M", async () => {
    const loi = await chanDongTienTruocM(dbVoiM("2026-10-01"), taoTruoc).catch((e: unknown) => e);
    expect(loi).toBeInstanceOf(LoiDongTienTruocM);
    const l = loi as LoiDongTienTruocM;
    expect(l.code).toBe("DA_BAT_NO_PHAI_TRA");
    expect(l.field).toBe("date");
    expect(l.mocM.getTime()).toBe(M.getTime());
    expect(l.message).toBe(cauDongTienTruocM(M));
    expect(l.message).toContain("01/10/2026");
    expect(l.message).toContain("chỉ sửa được mô tả");
  });

  it("đã bật + ngày ≥ M hoặc sửa chỉ mô tả ⇒ qua", async () => {
    const db = dbVoiM("2026-10-01");
    await expect(chanDongTienTruocM(db, { loai: "XOA", ngay: [M] })).resolves.toBeUndefined();
    const cu = dong("2026-09-15T00:00:00");
    await expect(chanDongTienTruocM(db, sua(cu, { ...cu }))).resolves.toBeUndefined();
  });

  it("Setting có chữ nhưng hỏng ⇒ ném (không hiểu là chưa bật)", async () => {
    await expect(chanDongTienTruocM(dbVoiM("01/10/2026"), taoTruoc)).rejects.toThrow(/noPhaiTraTuNgay hỏng/);
  });
});
