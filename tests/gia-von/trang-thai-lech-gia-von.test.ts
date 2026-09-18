import { describe, expect, it } from "vitest";

import { GIO_COI_LA_TRE, trangThaiLechGiaVon } from "@/lib/gia-von/trang-thai-lech-gia-von";

/**
 * Tín hiệu duy nhất kéo chủ shop tới việc duyệt giá vốn. Sai ở đây thì hoặc app im lặng trong khi
 * lãi đang tính bằng giá cũ, hoặc kêu oan mỗi ngày tới mức bị lướt qua.
 */

const BAY_GIO = new Date("2026-09-07T10:00:00.000Z");
const gioTruoc = (n: number) => new Date(BAY_GIO.getTime() - n * 3_600_000).toISOString();

describe("trangThaiLechGiaVon", () => {
  it("đếm xong, 0 dòng lệch, mốc tươi ⇒ khớp (không làm phiền)", () => {
    const t = trangThaiLechGiaVon("0", gioTruoc(3), BAY_GIO);
    expect(t.muc).toBe("khop");
    expect(t.soLech).toBe(0);
  });

  it("có dòng lệch + mốc tươi ⇒ co-lech, giữ đúng số", () => {
    const t = trangThaiLechGiaVon("8", gioTruoc(3), BAY_GIO);
    expect(t.muc).toBe("co-lech");
    expect(t.soLech).toBe(8);
  });

  it("MỐC QUÁ HẠN thì 'tre' THẮNG 'khop' — số 0 cũ không được đọc là 'đang ổn'", () => {
    // Ca dễ sót nhất: lượt đêm chết từ hôm kia, ô Setting vẫn giữ số 0 của lần cuối chạy được.
    // Nếu ưu tiên `soLech === 0` thì màn hình xanh mượt trong khi thực tế không ai còn đối chiếu.
    const t = trangThaiLechGiaVon("0", gioTruoc(GIO_COI_LA_TRE + 1), BAY_GIO);
    expect(t.muc).toBe("tre");
  });

  it("mốc quá hạn + có lệch ⇒ vẫn là 'tre' (con số đang cầm đã cũ)", () => {
    const t = trangThaiLechGiaVon("12", gioTruoc(GIO_COI_LA_TRE + 5), BAY_GIO);
    expect(t.muc).toBe("tre");
    expect(t.soLech).toBe(12);
  });

  it("đúng ngưỡng 26 giờ vẫn là bình thường, chỉ QUÁ mới kêu", () => {
    expect(trangThaiLechGiaVon("0", gioTruoc(GIO_COI_LA_TRE), BAY_GIO).muc).toBe("khop");
    expect(trangThaiLechGiaVon("0", gioTruoc(GIO_COI_LA_TRE + 0.1), BAY_GIO).muc).toBe("tre");
  });

  it.each([
    ["thiếu cả hai", undefined, undefined],
    ["thiếu mốc", "5", undefined],
    ["thiếu số", undefined, gioTruoc(1)],
    ["số rác", "abc", gioTruoc(1)],
    ["số âm", "-3", gioTruoc(1)],
    ["số thập phân", "2.5", gioTruoc(1)],
    ["mốc rác", "5", "không-phải-ngày"],
    ["chuỗi rỗng", "", ""],
  ])("giá trị không đọc được (%s) ⇒ chua-kiem, KHÔNG đoán là ổn", (_ten, soLech, moc) => {
    expect(trangThaiLechGiaVon(soLech, moc, BAY_GIO).muc).toBe("chua-kiem");
  });

  it("không ném lỗi với đầu vào lạ", () => {
    expect(() => trangThaiLechGiaVon(null, null, BAY_GIO)).not.toThrow();
  });
});
