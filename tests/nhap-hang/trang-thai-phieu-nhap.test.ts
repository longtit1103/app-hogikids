import { describe, expect, it } from "vitest";

import { cauNhacPhieuNhap, trangThaiPhieuNhapChuaGhi } from "@/lib/nhap-hang/trang-thai-phieu-nhap";

/**
 * Dải nhắc việc phiếu nhập: hai loại việc, hai chiều lệch quỹ NGƯỢC nhau.
 *
 * Ca đã xảy ra thật 2 lần trên prod: duyệt hết phiếu chờ ⇒ số về 0 ⇒ banner TẮT, trong khi phiếu
 * #173/#179 đã ghi sổ bị huỷ bên Pancake vẫn treo tiền khống. Test dưới khoá cả hai: banner phải
 * KÊU khi còn việc hậu kiểm, và câu chữ phải nói ĐÚNG việc.
 */
const MOC = new Date(2026, 8, 17, 3, 0).toISOString();
const BAY_GIO = new Date(2026, 8, 17, 9, 0);

describe("trangThaiPhieuNhapChuaGhi", () => {
  it("hết phiếu chờ nhưng còn việc hậu kiểm ⇒ VẪN kêu", () => {
    const t = trangThaiPhieuNhapChuaGhi("0", "1", MOC, BAY_GIO);

    expect(t).toMatchObject({ muc: "co-lech", soChoDuyet: 0, soViecHauKiem: 1 });
  });

  it("sạch cả hai ⇒ im", () => {
    expect(trangThaiPhieuNhapChuaGhi("0", "0", MOC, BAY_GIO).muc).toBe("khop");
  });

  it("ô hậu kiểm VẮNG (ngay sau deploy) hoặc rác ⇒ chua-kiem, KHÔNG coi là sạch", () => {
    expect(trangThaiPhieuNhapChuaGhi("0", undefined, MOC, BAY_GIO).muc).toBe("chua-kiem");
    expect(trangThaiPhieuNhapChuaGhi("0", "abc", MOC, BAY_GIO).muc).toBe("chua-kiem");
  });

  it("mốc quá 26 giờ ⇒ 'tre' thắng cả hai số (con số đang cầm đã cũ)", () => {
    const mocCu = new Date(2026, 8, 15, 3, 0).toISOString();

    expect(trangThaiPhieuNhapChuaGhi("3", "2", mocCu, BAY_GIO).muc).toBe("tre");
  });
});

describe("cauNhacPhieuNhap", () => {
  it("chỉ phiếu chờ ⇒ nói quỹ đang NHIỀU hơn thực tế", () => {
    const c = cauNhacPhieuNhap({ soChoDuyet: 3, soViecHauKiem: 0 });

    expect(c).toContain("3 phiếu nhập hàng bên Pancake chưa vào Sổ chi phí");
    expect(c).toContain("nhiều hơn thực tế");
  });

  it("chỉ việc hậu kiểm ⇒ KHÔNG được nói 'chưa vào Sổ chi phí' (chủ shop bấm vào không có gì để duyệt)", () => {
    const c = cauNhacPhieuNhap({ soChoDuyet: 0, soViecHauKiem: 1 });

    expect(c).toContain("1 phiếu nhập đã ghi sổ nay không khớp Pancake");
    expect(c).not.toContain("chưa vào Sổ chi phí");
  });

  it("có cả hai ⇒ nêu RIÊNG từng số, không khẳng định quỹ nhiều hay ít", () => {
    const c = cauNhacPhieuNhap({ soChoDuyet: 3, soViecHauKiem: 1 });

    expect(c).toContain("3 phiếu nhập chưa vào Sổ chi phí");
    expect(c).toContain("1 phiếu đã ghi nay không khớp");
    expect(c).toContain("quỹ đang lệch với thực tế");
    expect(c).not.toContain("nhiều hơn thực tế");
  });
});
