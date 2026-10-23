import { describe, expect, it } from "vitest";

import { locTheChoForm } from "@/components/finance/loc-ho-so-no-cho-form";
import type { LuaChonDongTienNo } from "@/lib/no-phai-tra/lua-chon-dong-tien-no";
import type { GiaoDichThe, KyNeo } from "@/lib/no-phai-tra/ky-sao-ke";
import {
  denChoCongTheDaDong,
  locTheDongConNo,
  theChoOChon,
  xetTraVaoTheDaDong,
  type PhiaDongTienThe,
} from "@/lib/no-phai-tra/the-da-dong-con-no";

/**
 * Lõi THUẦN cổng thẻ ĐÃ ĐÓNG còn nợ (ads về muộn gán thẻ đóng): lần trả (`CARD_PAY`) MỚI vào chính thẻ khi còn
 * nợ > 0, ngày sau ngày chốt neo. KHÔNG kẹp số trả — dư nợ là ước tính, trả vượt thành "trả thừa". Lần trả ĐÃ CÓ
 * của thẻ: xoá / sửa giảm / sửa tăng đều được. Loại dòng khác / chuyển lần trả ra khỏi thẻ đều chặn. Số liệu
 * LITERAL, đơn vị đồng.
 */

const vn = (ngay: string) => new Date(`${ngay}T00:00:00+07:00`);
const tr = (trieu: number) => Math.round(trieu * 1_000_000);

const THE = { id: "the-cu", ten: "Thẻ cũ" };
const neo = (ngayChot: string, soDuTrieu: number): KyNeo => ({
  ngayChot: vn(ngayChot),
  soDu: tr(soDuTrieu),
  hanTra: null,
  daTraTruocMoSo: 0,
  laNeoMoSo: true,
});
const chi = (ngay: string, trieu: number): GiaoDichThe => ({ ngay: vn(ngay), soTien: tr(trieu), loai: "CHI" });
const tra = (ngay: string, trieu: number): GiaoDichThe => ({ ngay: vn(ngay), soTien: tr(trieu), loai: "TRA" });
const phia = (kind: string, trieu: number, ngay = "2026-11-26", cardId: string | null = THE.id): PhiaDongTienThe => ({
  kind,
  cardId,
  date: vn(ngay),
  amount: tr(trieu),
});

const DEN = vn("2026-11-26");
/** Neo 31/10 = 0, ads ngày 03/11 (về muộn, gán thẻ này theo mốc gắn) 5tr ⇒ dư nợ 5tr. */
const KYS = [neo("2026-10-31", 0)];
const GD_NO_5 = [chi("2026-11-03", 5)];

const xet = (p: { gd?: GiaoDichThe[]; truoc?: PhiaDongTienThe | null; sau?: PhiaDongTienThe | null; kys?: KyNeo[] }) =>
  xetTraVaoTheDaDong({
    the: THE,
    kys: p.kys ?? KYS,
    gd: p.gd ?? GD_NO_5,
    den: DEN,
    truoc: p.truoc ?? null,
    sau: p.sau ?? null,
  });

describe("xetTraVaoTheDaDong", () => {
  it("còn nợ 5tr: trả 3tr, đúng 5tr, hay VƯỢT ước tính (7tr) đều cho — ngân hàng trừ thật bao nhiêu ghi bấy nhiêu", () => {
    expect(xet({ sau: phia("CARD_PAY", 3) })).toBeNull();
    expect(xet({ sau: phia("CARD_PAY", 5) })).toBeNull();
    expect(xet({ sau: phia("CARD_PAY", 7) })).toBeNull();
  });

  it("dư nợ 0 (đã trả hết) hoặc âm (trả thừa) ⇒ chặn ô thẻ", () => {
    expect(xet({ gd: [chi("2026-11-03", 5), tra("2026-11-10", 5)], sau: phia("CARD_PAY", 1) })?.field).toBe("cardId");
    expect(xet({ gd: [chi("2026-11-03", 5), tra("2026-11-10", 6)], sau: phia("CARD_PAY", 1) })?.field).toBe("cardId");
  });

  it("thẻ chưa có neo ⇒ chặn (không có điểm tựa dư nợ)", () => {
    expect(xet({ kys: [], sau: phia("CARD_PAY", 1) })?.field).toBe("cardId");
  });

  it("loại khác CARD_PAY vào thẻ đóng (nạp ví bằng thẻ) ⇒ chặn dù còn nợ", () => {
    expect(xet({ sau: phia("ADS_TOPUP", 1) })?.field).toBe("cardId");
  });

  it("xoá lần trả đã có ⇒ được (dư nợ chỉ quay về số trước lần trả), kể cả khi thẻ đã hết nợ", () => {
    const truoc = phia("CARD_PAY", 2, "2026-11-20");
    expect(xet({ gd: [...GD_NO_5, tra("2026-11-20", 2)], truoc, sau: null })).toBeNull();
    // Đã trả đủ 5tr bằng hai lần: xoá một lần thì nợ hiện lại — vẫn được, đó là sửa nhầm lẫn.
    expect(xet({ gd: [...GD_NO_5, tra("2026-11-20", 2), tra("2026-11-21", 3)], truoc, sau: null })).toBeNull();
  });

  it("chuyển lần trả của thẻ đóng sang thẻ khác hay đổi loại ⇒ chặn", () => {
    const gd = [...GD_NO_5, tra("2026-11-20", 2)];
    const truoc = phia("CARD_PAY", 2, "2026-11-20");
    expect(xet({ gd, truoc, sau: phia("CARD_PAY", 2, "2026-11-20", "the-moi") })?.field).toBe("cardId");
    expect(xet({ gd, truoc, sau: phia("ADS_TOPUP", 2, "2026-11-20") })?.field).toBe("cardId");
    expect(xet({ gd, truoc, sau: phia("SUPPLIER_PAY", 2, "2026-11-20", null) })?.field).toBe("cardId");
  });

  it("sửa / xoá dòng nạp ví bằng thẻ đóng ⇒ chặn (kể cả sửa thành trả thẻ — xoá một khoản chi khỏi thẻ đóng)", () => {
    expect(xet({ truoc: phia("ADS_TOPUP", 1), sau: phia("CARD_PAY", 1) })?.field).toBe("cardId");
    expect(xet({ truoc: phia("ADS_TOPUP", 1), sau: phia("ADS_TOPUP", 2) })?.field).toBe("cardId");
    expect(xet({ truoc: phia("ADS_TOPUP", 1), sau: null })?.field).toBe("cardId");
  });

  it("sửa lần trả đã có: giảm, tăng, đổi ngày / mô tả đều được — không phụ thuộc dư nợ hiện tại", () => {
    const gd = [...GD_NO_5, tra("2026-11-20", 5)];
    const truoc = phia("CARD_PAY", 5, "2026-11-20");
    expect(xet({ gd, truoc, sau: phia("CARD_PAY", 5, "2026-11-20") })).toBeNull();
    expect(xet({ gd, truoc, sau: phia("CARD_PAY", 1, "2026-11-20") })).toBeNull();
    expect(xet({ gd, truoc, sau: phia("CARD_PAY", 4, "2026-11-22") })).toBeNull();
    expect(xet({ gd, truoc, sau: phia("CARD_PAY", 6, "2026-11-20") })).toBeNull();
    // Hai lần trả 5tr (nợ đang −5tr): sửa giảm hay tăng một lần vẫn được.
    const haiLan = [...GD_NO_5, tra("2026-11-20", 5), tra("2026-11-21", 5)];
    expect(xet({ gd: haiLan, truoc, sau: phia("CARD_PAY", 2, "2026-11-20") })).toBeNull();
    expect(xet({ gd: haiLan, truoc, sau: phia("CARD_PAY", 8, "2026-11-20") })).toBeNull();
  });

  it("chuyển lần trả từ thẻ khác SANG thẻ đóng = dòng mới: còn nợ thì được, hết nợ thì chặn", () => {
    const truoc = phia("CARD_PAY", 2, "2026-11-20", "the-moi");
    expect(xet({ truoc, sau: phia("CARD_PAY", 2, "2026-11-20") })).toBeNull();
    expect(
      xet({ gd: [...GD_NO_5, tra("2026-11-10", 5)], truoc, sau: phia("CARD_PAY", 2, "2026-11-20") })?.field,
    ).toBe("cardId");
  });

  it("ngày trả không sau ngày chốt của neo đang dùng ⇒ không trừ được nợ ⇒ chặn ô ngày, nêu ngày chốt", () => {
    // Kỳ sao kê chốt 25/11 dư nợ 5tr: lần trả ngày 25/11 đã nằm trong số sao kê, không kéo nợ về được.
    const kys = [neo("2026-10-31", 0), neo("2026-11-25", 5)];
    const loi = xet({ kys, gd: [], sau: phia("CARD_PAY", 1, "2026-11-25") });
    expect(loi?.field).toBe("date");
    expect(loi?.message).toContain("25/11/2026");
    expect(xet({ kys, gd: [], sau: phia("CARD_PAY", 1, "2026-11-26") })).toBeNull();
  });
});

describe("denChoCongTheDaDong", () => {
  it("lấy ngày muộn nhất giữa hôm nay và các phía chạm đúng thẻ; phía thẻ khác bỏ qua", () => {
    const homNay = vn("2026-11-26");
    expect(denChoCongTheDaDong(homNay, THE.id, phia("CARD_PAY", 1, "2026-11-20"), null)).toBe(homNay);
    expect(denChoCongTheDaDong(homNay, THE.id, null, phia("CARD_PAY", 1, "2026-11-28")).getTime()).toBe(
      vn("2026-11-28").getTime(),
    );
    expect(denChoCongTheDaDong(homNay, THE.id, phia("CARD_PAY", 1, "2026-11-30", "khac"), null)).toBe(homNay);
  });
});

describe("locTheDongConNo", () => {
  it("chỉ thẻ ĐÃ ĐÓNG có dư nợ ≠ 0 (dương lẫn âm); thẻ mở, nợ 0, chưa có neo ⇒ bỏ", () => {
    const dong = vn("2026-11-25");
    expect(
      locTheDongConNo([
        { id: "a", ten: "A", closedAt: dong, duNo: tr(2) },
        { id: "b", ten: "B", closedAt: dong, duNo: -tr(1) },
        { id: "c", ten: "C", closedAt: dong, duNo: 0 },
        { id: "d", ten: "D", closedAt: dong, duNo: null },
        { id: "e", ten: "E", closedAt: null, duNo: tr(9) },
      ]),
    ).toEqual([
      { id: "a", ten: "A", duNo: tr(2) },
      { id: "b", ten: "B", duNo: -tr(1) },
    ]);
  });
});

describe("theChoOChon", () => {
  const dong = vn("2026-11-25");
  it("thẻ mở ⇒ chọn được, giữ tên", () => {
    expect(theChoOChon({ id: "a", ten: "A", closedAt: null }, tr(3))).toEqual({ id: "a", ten: "A", dong: false });
  });

  it("thẻ đóng còn nợ > 0 ⇒ chọn được (đánh dấu chiTraThe), nhãn nêu số còn nợ + chỉ ghi Trả thẻ", () => {
    const t = theChoOChon({ id: "b", ten: "B", closedAt: dong }, tr(2));
    expect(t.dong).toBe(false);
    expect(t.chiTraThe).toBe(true);
    expect(t.ten).toContain("đã đóng — còn nợ 2.000.000");
    expect(t.ten).toContain("chỉ ghi Trả thẻ");
  });

  it("thẻ đóng hết nợ / trả thừa / chưa có neo ⇒ đóng (form ẩn)", () => {
    for (const duNo of [0, -tr(1), null]) {
      expect(theChoOChon({ id: "c", ten: "C", closedAt: dong }, duNo)).toEqual({ id: "c", ten: "C", dong: true });
    }
  });
});

describe("locTheChoForm — thẻ đóng-còn-nợ chỉ hiện cho Trả thẻ", () => {
  const no: LuaChonDongTienNo = {
    mocM: vn("2026-11-01"),
    the: [
      { id: "mo", ten: "Thẻ mở", dong: false },
      theChoOChon({ id: "con-no", ten: "Thẻ cũ", closedAt: vn("2026-11-25") }, tr(2)),
      { id: "het-no", ten: "Thẻ hết nợ", dong: true },
    ],
    phieu: [],
    vi: [],
  };
  const ids = (kind?: "CARD_PAY" | "ADS_TOPUP" | "", dangSua: { kind: string; cardId: string; phieuNhapId: null } | null = null) =>
    locTheChoForm(no, dangSua, kind).map((o) => o.id);

  it("CARD_PAY ⇒ thẻ mở + thẻ đóng-còn-nợ; thẻ đóng hết nợ ẩn", () => {
    expect(ids("CARD_PAY")).toEqual(["mo", "con-no"]);
  });

  it("ADS_TOPUP (nạp ví bằng thẻ) ⇒ chỉ thẻ mở", () => {
    expect(ids("ADS_TOPUP")).toEqual(["mo"]);
  });

  it("không truyền loại ⇒ không lọc theo loại (server vẫn là cổng cuối)", () => {
    expect(ids()).toEqual(["mo", "con-no"]);
  });

  it("dòng đang sửa luôn giữ thẻ của nó, kể cả thẻ đã đóng hết nợ", () => {
    expect(ids("ADS_TOPUP", { kind: "ADS_TOPUP", cardId: "het-no", phieuNhapId: null })).toEqual(["mo", "het-no"]);
  });
});
