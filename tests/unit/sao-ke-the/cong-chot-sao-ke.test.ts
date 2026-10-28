import { describe, expect, it } from "vitest";

import { kiemSoCuoiThe, lyDoHoaDonTiktokChuaVe, ngayHoaDonTiktokDuVe } from "@/lib/sao-ke-the/cong-chot-sao-ke";

describe("lyDoHoaDonTiktokChuaVe — hoá đơn TikTok ngày chốt về app sau 2 đêm", () => {
  it("hôm nay < D+2 ⇒ chặn, nói ngày nhập lại", () => {
    expect(ngayHoaDonTiktokDuVe("2026-10-20")).toBe("2026-10-22");
    expect(lyDoHoaDonTiktokChuaVe("2026-10-20", "2026-10-21", "2026-10-21")).toBe(
      "Hoá đơn TikTok tối ngày chốt về app sau 2 đêm; nhập lại từ 22/10"
    );
    expect(lyDoHoaDonTiktokChuaVe("2026-12-31", "2027-01-01", "2027-01-01")).toContain("nhập lại từ 02/01");
  });

  it("hôm nay đủ muộn nhưng lượt kéo hoá đơn mới nhất trước D+2 (hoặc chưa có) ⇒ vẫn chặn", () => {
    expect(lyDoHoaDonTiktokChuaVe("2026-10-20", "2026-10-26", "2026-10-21")).toContain(
      "Chưa có lượt kéo hoá đơn TikTok sau ngày chốt (lượt mới nhất ngày 21/10)"
    );
    expect(lyDoHoaDonTiktokChuaVe("2026-10-20", "2026-10-26", null)).toContain("chưa có lượt nào");
  });

  it("hôm nay ≥ D+2 và lượt kéo ≥ D+2 ⇒ chốt được", () => {
    expect(lyDoHoaDonTiktokChuaVe("2026-10-20", "2026-10-22", "2026-10-22")).toBeNull();
    expect(lyDoHoaDonTiktokChuaVe("2026-10-20", "2026-10-26", "2026-10-26")).toBeNull();
  });
});

describe("kiemSoCuoiThe — sao kê đúng thẻ", () => {
  it("tên/ghi chú có đúng 4 số cuối ⇒ ổn", () => {
    expect(kiemSoCuoiThe("Techcombank 9999", "", "9999")).toEqual({ chan: null, canhBao: null });
    expect(kiemSoCuoiThe("Thẻ ads", "đuôi 9999", "9999")).toEqual({ chan: null, canhBao: null });
  });

  it("tên mang bộ 4 chữ số KHÁC ⇒ CHẶN", () => {
    const kq = kiemSoCuoiThe("VPBank 1234", "", "9999");
    expect(kq.canhBao).toBeNull();
    expect(kq.chan).toContain('thẻ "VPBank 1234" mang số 1234');
  });

  it("không có bộ 4 chữ số nào ⇒ chỉ cảnh báo; số dài hơn 4 chữ số không tính là bộ 4 số", () => {
    expect(kiemSoCuoiThe("Visa", "", "9999")).toEqual({
      chan: null,
      canhBao: 'Sao kê của thẻ đuôi 9999 — tên thẻ "Visa" không có số này, kiểm đúng thẻ.',
    });
    expect(kiemSoCuoiThe("Thẻ 123456", "", "9999").chan).toBeNull();
  });
});
