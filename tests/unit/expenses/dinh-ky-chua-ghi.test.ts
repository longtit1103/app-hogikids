import { endOfDay } from "date-fns";
import { describe, expect, it } from "vitest";

import { DINH_KY_RONG, demDinhKyChuaGhi, khoaDaSinh, type MauDinhKyDem } from "@/lib/expenses/dinh-ky-chua-ghi";

/**
 * Lõi thuần đếm lần đến hạn chi định kỳ chưa ghi — dùng chung cho cảnh báo thẻ Quỹ (biên = hôm nay, M đã bật)
 * và điều kiện bật nợ phải trả (biên = cuối ngày trước M, M đã bật = null). Giờ VN (setup ép TZ).
 */
const vn = (ngay: string) => new Date(`${ngay}T00:00:00+07:00`);
const mau = (ghiDe: Partial<MauDinhKyDem> = {}): MauDinhKyDem => ({
  id: "dien",
  dayOfMonth: 15,
  activeFrom: null,
  categoryId: "fixed",
  ...ghiDe,
});
const dem = (p: Partial<Parameters<typeof demDinhKyChuaGhi>[0]> = {}) =>
  demDinhKyChuaGhi({
    mau: [mau()],
    daSinh: new Set(),
    d0: vn("2026-09-07"),
    bienTren: endOfDay(vn("2026-10-31")),
    mocMDaBat: null,
    ...p,
  });

describe("demDinhKyChuaGhi", () => {
  it("đếm mỗi lần đến hạn trong [D0, biên trên] chưa có dòng, gom tháng + khoảng tháng", () => {
    expect(dem()).toEqual({
      soKhoan: 2,
      thang: ["09/2026", "10/2026"],
      khoang: { from: vn("2026-09-01"), to: endOfDay(vn("2026-10-31")) },
    });
  });

  it("đã sinh (cùng mẫu, cùng tháng) ⇒ không thiếu", () => {
    const r = dem({ daSinh: new Set([khoaDaSinh("dien", vn("2026-09-15"))]) });
    expect(r).toMatchObject({ soKhoan: 1, thang: ["10/2026"] });
  });

  it("lần đến hạn trước D0 hoặc sau biên trên không đếm (đến hạn ĐÚNG biên trên vẫn đếm)", () => {
    expect(dem({ d0: vn("2026-09-16") })).toMatchObject({ soKhoan: 1, thang: ["10/2026"] });
    expect(dem({ bienTren: endOfDay(vn("2026-10-14")) })).toMatchObject({ soKhoan: 1, thang: ["09/2026"] });
    expect(dem({ bienTren: endOfDay(vn("2026-10-15")) })).toMatchObject({ soKhoan: 2 });
  });

  it("tháng trước mốc activeFrom không đếm (cùng cổng với bộ sinh)", () => {
    expect(dem({ mau: [mau({ activeFrom: vn("2026-10-20") })] })).toMatchObject({ soKhoan: 1, thang: ["10/2026"] });
  });

  it("ngày 31 kẹp về cuối tháng thiếu ngày (30/09)", () => {
    expect(dem({ mau: [mau({ dayOfMonth: 31 })], bienTren: endOfDay(vn("2026-09-30")) })).toMatchObject({
      soKhoan: 1,
      thang: ["09/2026"],
    });
  });

  it("M ĐÃ bật: bỏ lần đến hạn trước M (mọi mẫu) và mọi lần của mẫu Nhập hàng — bộ sinh cố ý không sinh", () => {
    const daBat = dem({ mocMDaBat: vn("2026-10-01"), bienTren: endOfDay(vn("2026-11-30")) });
    expect(daBat).toMatchObject({ soKhoan: 2, thang: ["10/2026", "11/2026"] });
    const nhapHang = dem({
      mau: [mau({ categoryId: "purchase" })],
      mocMDaBat: vn("2026-10-01"),
      bienTren: endOfDay(vn("2026-11-30")),
    });
    expect(nhapHang).toEqual(DINH_KY_RONG);
  });

  it("điều kiện bật: M lượt bật CHỈ làm biên trên (cuối ngày M − 1), không làm cổng bỏ qua ⇒ vẫn đếm lần 15/09", () => {
    // M = 01/10: biên trên = cuối 30/09, M đã bật = null.
    expect(dem({ bienTren: endOfDay(vn("2026-09-30")), mocMDaBat: null })).toMatchObject({
      soKhoan: 1,
      thang: ["09/2026"],
    });
    // Nếu (sai) truyền M lượt bật làm mốc đã bật thì điều kiện thành rỗng — chốt lý do tách hai tham số.
    expect(dem({ bienTren: endOfDay(vn("2026-09-30")), mocMDaBat: vn("2026-10-01") })).toEqual(DINH_KY_RONG);
  });

  it("không mẫu nào hoặc biên trên trước D0 ⇒ rỗng", () => {
    expect(dem({ mau: [] })).toEqual(DINH_KY_RONG);
    expect(dem({ bienTren: endOfDay(vn("2026-09-01")) })).toEqual(DINH_KY_RONG);
  });
});
