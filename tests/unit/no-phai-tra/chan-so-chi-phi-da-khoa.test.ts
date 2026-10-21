import { describe, expect, it } from "vitest";

import {
  chanSoChiPhiDaKhoa,
  laNgayTruocMocM,
  laNhapHangDaKhoaSo,
  laSuaGiuTien,
  LoiSoChiPhiDaKhoa,
  lyDoSoChiPhiDaKhoa,
  type ThaoTacChiPhi,
} from "@/lib/no-phai-tra/chan-so-chi-phi-da-khoa";

/**
 * Cổng khoá sổ chi phí khi đã bật nợ phải trả — thuần trên `Setting` giả (không DB). Đã bật (M ≠ null) ⇒ Nhập hàng
 * khoá MỌI ngày; MỌI danh mục ngày < M (ngày VN) khoá — ngoại lệ duy nhất: sửa giữ tiền dòng trước M (`laSuaGiuTien`).
 */

const vn = (iso: string) => new Date(`${iso}+07:00`);
const M = vn("2026-09-15T00:00:00");

/** `db` giả chỉ có `setting.findUnique` — đúng phần `docMocM` đọc. */
function dbVoiM(giaTri: string | null) {
  return {
    setting: {
      findUnique: async () => (giaTri === null ? null : { value: giaTri }),
    },
  } as unknown as Parameters<typeof chanSoChiPhiDaKhoa>[0];
}

const dong = (categoryId: string, ngay: string) => ({ categoryId, date: vn(`${ngay}T00:00:00`) });
const dayDu = (categoryId: string, ngay: string, amount = 3_000_000, cardId: string | null = null) => ({
  ...dong(categoryId, ngay),
  amount,
  cardId,
});

describe("lyDoSoChiPhiDaKhoa — lõi thuần", () => {
  it("chưa bật ⇒ mọi thao tác cho qua", () => {
    const ca: ThaoTacChiPhi[] = [
      { loai: "TAO", dong: dong("purchase", "2026-09-05") },
      { loai: "XOA", dong: dong("fixed", "2026-09-05") },
      { loai: "SUA", cu: dayDu("fixed", "2026-09-05"), moi: dayDu("fixed", "2026-09-05", 9_000_000) },
      { loai: "BAT_MAU", categoryId: "purchase" },
    ];
    for (const t of ca) expect(lyDoSoChiPhiDaKhoa(t, null)).toBeNull();
  });

  it("tạo / xoá: ngày < M mọi danh mục ⇒ TRUOC_M; Nhập hàng ≥ M ⇒ NHAP_HANG; danh mục khác ≥ M ⇒ qua", () => {
    for (const loai of ["TAO", "XOA"] as const) {
      for (const categoryId of ["fixed", "ads", "interest", "purchase"]) {
        expect(lyDoSoChiPhiDaKhoa({ loai, dong: dong(categoryId, "2026-09-14") }, M), `${loai} ${categoryId}`).toBe("TRUOC_M");
      }
      expect(lyDoSoChiPhiDaKhoa({ loai, dong: dong("purchase", "2026-09-15") }, M)).toBe("NHAP_HANG");
      expect(lyDoSoChiPhiDaKhoa({ loai, dong: dong("fixed", "2026-09-15") }, M)).toBeNull();
    }
  });

  it("biên ngày theo NGÀY VN: 14/09 23:59:59 là trước M, 15/09 00:00 không", () => {
    expect(lyDoSoChiPhiDaKhoa({ loai: "TAO", dong: { categoryId: "fixed", date: vn("2026-09-14T23:59:59") } }, M)).toBe("TRUOC_M");
    expect(lyDoSoChiPhiDaKhoa({ loai: "TAO", dong: { categoryId: "fixed", date: vn("2026-09-15T00:00:00") } }, M)).toBeNull();
  });

  it("sửa: giữ tiền trước M ⇒ qua (kể cả đổi sang/khỏi Nhập hàng); đổi tiền/ngày/thẻ trước M ⇒ TRUOC_M", () => {
    const cu = dayDu("fixed", "2026-09-05");
    expect(lyDoSoChiPhiDaKhoa({ loai: "SUA", cu, moi: { ...cu, categoryId: "purchase" } }, M)).toBeNull();
    expect(lyDoSoChiPhiDaKhoa({ loai: "SUA", cu: { ...cu, categoryId: "purchase" }, moi: cu }, M)).toBeNull();
    expect(lyDoSoChiPhiDaKhoa({ loai: "SUA", cu, moi: { ...cu, amount: 9_000_000 } }, M)).toBe("TRUOC_M");
    expect(lyDoSoChiPhiDaKhoa({ loai: "SUA", cu, moi: { ...cu, date: vn("2026-09-06T00:00:00") } }, M)).toBe("TRUOC_M");
    expect(lyDoSoChiPhiDaKhoa({ loai: "SUA", cu, moi: { ...cu, cardId: "the" } }, M)).toBe("TRUOC_M");
    // Dời dòng < M sang ≥ M cũng đổi quỹ cuối M−1.
    expect(lyDoSoChiPhiDaKhoa({ loai: "SUA", cu, moi: { ...cu, date: vn("2026-09-16T00:00:00") } }, M)).toBe("TRUOC_M");
  });

  it("sửa: dòng ≥ M — dời về < M ⇒ TRUOC_M; chạm Nhập hàng ⇒ NHAP_HANG; danh mục khác sửa tự do", () => {
    const sauM = dayDu("fixed", "2026-09-16");
    expect(lyDoSoChiPhiDaKhoa({ loai: "SUA", cu: sauM, moi: { ...sauM, date: vn("2026-09-14T00:00:00") } }, M)).toBe("TRUOC_M");
    expect(lyDoSoChiPhiDaKhoa({ loai: "SUA", cu: sauM, moi: { ...sauM, categoryId: "purchase" } }, M)).toBe("NHAP_HANG");
    expect(lyDoSoChiPhiDaKhoa({ loai: "SUA", cu: sauM, moi: { ...sauM, amount: 9_000_000, categoryId: "ads" } }, M)).toBeNull();
  });

  it("ca vòng 3 bước (purchase 4tr → fixed 4tr → fixed 9tr → purchase 9tr): bước 2 bị chặn; biến thể xoá bị chặn", () => {
    const b0 = dayDu("purchase", "2026-09-05", 4_000_000);
    const b1 = { ...b0, categoryId: "fixed" };
    expect(lyDoSoChiPhiDaKhoa({ loai: "SUA", cu: b0, moi: b1 }, M)).toBeNull();
    expect(lyDoSoChiPhiDaKhoa({ loai: "SUA", cu: b1, moi: { ...b1, amount: 9_000_000 } }, M)).toBe("TRUOC_M");
    expect(lyDoSoChiPhiDaKhoa({ loai: "XOA", dong: b1 }, M)).toBe("TRUOC_M");
  });

  it("bật lại mẫu: chỉ mẫu Nhập hàng bị chặn", () => {
    expect(lyDoSoChiPhiDaKhoa({ loai: "BAT_MAU", categoryId: "purchase" }, M)).toBe("NHAP_HANG");
    expect(lyDoSoChiPhiDaKhoa({ loai: "BAT_MAU", categoryId: "fixed" }, M)).toBeNull();
  });
});

describe("chanSoChiPhiDaKhoa — cổng đọc M", () => {
  it("chưa bật (M null) ⇒ không ném", async () => {
    await expect(chanSoChiPhiDaKhoa(dbVoiM(null), { loai: "TAO", dong: dong("purchase", "2026-09-05") })).resolves.toBeUndefined();
  });

  it("trước M ⇒ LoiSoChiPhiDaKhoa TRUOC_M, mã DA_BAT_NO_PHAI_TRA, câu nói đúng điều còn được phép", async () => {
    const p = chanSoChiPhiDaKhoa(dbVoiM("2026-09-15"), { loai: "XOA", dong: dong("fixed", "2026-09-05") });
    await expect(p).rejects.toBeInstanceOf(LoiSoChiPhiDaKhoa);
    await expect(p).rejects.toMatchObject({ code: "DA_BAT_NO_PHAI_TRA", lyDo: "TRUOC_M" });
    await expect(p).rejects.toMatchObject({
      message: expect.stringContaining("Chi phí trước ngày bật theo dõi nợ (15/09/2026) đã chốt vào số dư mở sổ"),
    });
    await expect(p).rejects.toMatchObject({ message: expect.stringContaining("chỉ đổi được danh mục, mô tả, kênh") });
    await expect(p).rejects.toMatchObject({ message: expect.stringContaining("không đổi số tiền, ngày hay thẻ") });
    await expect(p).rejects.toMatchObject({ message: expect.stringContaining("không thêm, xoá hay khôi phục") });
  });

  it("Nhập hàng từ M ⇒ NHAP_HANG, câu chỉ đường sổ nợ", async () => {
    const p = chanSoChiPhiDaKhoa(dbVoiM("2026-09-15"), { loai: "TAO", dong: dong("purchase", "2026-09-18") });
    await expect(p).rejects.toMatchObject({ code: "DA_BAT_NO_PHAI_TRA", lyDo: "NHAP_HANG" });
    await expect(p).rejects.toMatchObject({
      message: expect.stringContaining('Từ ngày bật theo dõi nợ (15/09/2026), chi phí "Nhập hàng" đã khoá sổ'),
    });
    await expect(p).rejects.toMatchObject({ message: expect.stringContaining("tiền hàng ghi qua sổ nợ") });
  });

  it("danh mục khác ≥ M ⇒ không ném", async () => {
    for (const categoryId of ["ads", "fixed", "interest"]) {
      await expect(chanSoChiPhiDaKhoa(dbVoiM("2026-09-15"), { loai: "TAO", dong: dong(categoryId, "2026-09-15") })).resolves.toBeUndefined();
    }
  });
});

describe("vị từ thuần cho nơi chỉ đọc", () => {
  it("laNhapHangDaKhoaSo: đúng khi và chỉ khi purchase + đã bật", () => {
    expect(laNhapHangDaKhoaSo({ categoryId: "purchase" }, M)).toBe(true);
    expect(laNhapHangDaKhoaSo({ categoryId: "purchase" }, null)).toBe(false);
    expect(laNhapHangDaKhoaSo({ categoryId: "fixed" }, M)).toBe(false);
  });
  it("laNgayTruocMocM: theo ngày VN; chưa bật ⇒ false", () => {
    expect(laNgayTruocMocM(vn("2026-09-14T23:59:59"), M)).toBe(true);
    expect(laNgayTruocMocM(vn("2026-09-15T00:00:00"), M)).toBe(false);
    expect(laNgayTruocMocM(vn("2026-01-01T00:00:00"), null)).toBe(false);
  });
});

describe("laSuaGiuTien — ngoại lệ sửa dòng trước M chỉ đổi danh mục/mô tả/kênh", () => {
  const cu = { date: vn("2026-09-05T10:30:00"), amount: 3_000_000, cardId: null };
  it("cùng NGÀY VN (khác giờ) + cùng tiền + cùng thẻ + trước M ⇒ được", () => {
    expect(laSuaGiuTien(cu, { ...cu, date: vn("2026-09-05T00:00:00") }, M)).toBe(true);
  });
  it("đổi ngày / số tiền / thẻ, hoặc ngày ≥ M ⇒ không", () => {
    expect(laSuaGiuTien(cu, { ...cu, date: vn("2026-09-04T23:59:59") }, M)).toBe(false);
    expect(laSuaGiuTien(cu, { ...cu, amount: 3_000_001 }, M)).toBe(false);
    expect(laSuaGiuTien(cu, { ...cu, cardId: "the" }, M)).toBe(false);
    const sauM = { ...cu, date: vn("2026-09-15T00:00:00") };
    expect(laSuaGiuTien(sauM, sauM, M)).toBe(false);
    const cuoiTruocM = { ...cu, date: vn("2026-09-14T23:59:59") };
    expect(laSuaGiuTien(cuoiTruocM, cuoiTruocM, M)).toBe(true);
  });
});
