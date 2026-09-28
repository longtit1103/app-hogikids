import { describe, expect, it } from "vitest";

import {
  chenhLechLaiSuat,
  laiDonToiNay,
  laiDuKien,
  soNgayGiua,
} from "@/lib/tiet-kiem/cong-thuc-lai-tiet-kiem";

/**
 * Số trong file này là LITERAL tính tay, KHÔNG suy lại bằng chính công thức đang kiểm — viết
 * `principal * bp * ngay / 3_650_000` ở vế kỳ vọng là test tự khen mình.
 */

describe("soNgayGiua — đếm ngày lịch giờ VN", () => {
  it("kỳ hạn 6 tháng 01/10/2026 → 01/04/2027 = 182 ngày", () => {
    expect(soNgayGiua(new Date(2026, 9, 1), new Date(2027, 3, 1))).toBe(182);
  });

  it("mốc mang giờ 07:00 vẫn ra đúng số ngày (startOfDay trước khi đếm)", () => {
    expect(soNgayGiua(new Date(2026, 9, 1, 7, 0), new Date(2027, 3, 1, 23, 30))).toBe(182);
  });

  it("năm nhuận 2028: 01/01/2028 → 01/01/2029 = 366 ngày", () => {
    expect(soNgayGiua(new Date(2028, 0, 1), new Date(2029, 0, 1))).toBe(366);
  });

  it("mốc ngược ⇒ số ÂM (chỗ cần kẹp thì tự kẹp, hàm này không giấu)", () => {
    expect(soNgayGiua(new Date(2027, 3, 1), new Date(2026, 9, 1))).toBe(-182);
  });
});

describe("laiDuKien — làm tròn ĐÚNG MỘT LẦN, quy ước 365 ngày", () => {
  it("200tr · 5,2%/năm · 182 ngày = 5.185.753 đ", () => {
    expect(laiDuKien(200_000_000, 520, 182)).toBe(5_185_753);
  });

  it("năm nhuận ăn thêm 1 ngày lãi: 100tr · 6%/năm · 366 ngày = 6.016.438 (365 ngày = 6.000.000)", () => {
    expect(laiDuKien(100_000_000, 600, 366)).toBe(6_016_438);
    expect(laiDuKien(100_000_000, 600, 365)).toBe(6_000_000);
  });

  it("lãi suất 0 ⇒ 0 đ (vay/gửi không lãi là trạng thái hợp lệ)", () => {
    expect(laiDuKien(200_000_000, 0, 182)).toBe(0);
  });

  it("số ngày ≤ 0 hoặc gốc ≤ 0 ⇒ 0 đ, KHÔNG ra số âm", () => {
    expect(laiDuKien(200_000_000, 520, 0)).toBe(0);
    expect(laiDuKien(200_000_000, 520, -5)).toBe(0);
    expect(laiDuKien(0, 520, 182)).toBe(0);
  });
});

describe("laiDuKien — ca biên trần: BigInt là thứ giữ cho số đúng", () => {
  /**
   * Bộ số này là biên TRẦN của app (gốc sát 2 tỷ · lãi suất sát 100%/năm · kỳ hạn sát 600 tháng):
   * tích ≈ 3,62e17, vượt `Number.MAX_SAFE_INTEGER` (9.007.199.254.740.991) hơn 40 lần.
   *
   * Vế `number` thuần viết THẲNG ra để so, không gọi hàm nào: nó ra 99.110.224.171, còn số ĐÚNG
   * (tính bằng số nguyên chính xác) là 99.110.224.170 — lệch 1 đồng. Bỏ `BigInt` khỏi `laiDuKien`
   * là rơi đúng vào nhánh sai đó, và không có test nào khác đỏ.
   *
   * Đừng thay bộ số này bằng ca "thường" (200tr/520bp/182 ngày, tích ≈ 1,9e13): tích đó nằm gọn
   * trong 2^53 nên hai đường tính luôn bằng nhau — ca ấy KHÔNG chứng minh được gì.
   */
  const P = 1_999_999_957;
  const BP = 9_917;
  const NGAY = 18_239;

  it("tích trung gian vượt 2^53 thật (không phải lo xa)", () => {
    expect(P * BP * NGAY).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
  });

  it("kết quả BigInt = 99.110.224.170, KHÁC hẳn phép tính number thuần = 99.110.224.171", () => {
    const bangNumberThuan = Math.round((P * BP * NGAY) / (10_000 * 365));
    expect(bangNumberThuan).toBe(99_110_224_171);
    expect(laiDuKien(P, BP, NGAY)).toBe(99_110_224_170);
    expect(laiDuKien(P, BP, NGAY)).not.toBe(bangNumberThuan);
  });
});

describe("laiDonToiNay — thông tin, KHÔNG vào P&L; kẹp trong [0, laiDuKien]", () => {
  const SO = {
    principal: 200_000_000,
    annualRateBp: 520,
    startDate: new Date(2026, 9, 1), // 01/10/2026
    maturityDate: new Date(2027, 3, 1), // 01/04/2027 — 182 ngày
  };

  it("giữa kỳ 31/12/2026 (91 ngày) = 2.592.877 đ", () => {
    expect(laiDonToiNay({ ...SO, homNay: new Date(2026, 11, 31) })).toBe(2_592_877);
  });

  it("kẹp ĐẦU DƯỚI: hôm nay trước ngày gửi ⇒ 0 đ, không âm", () => {
    expect(laiDonToiNay({ ...SO, homNay: new Date(2026, 8, 15) })).toBe(0);
  });

  it("kẹp ĐẦU TRÊN: quá đáo hạn ⇒ đúng bằng laiDuKien, không chạy tiếp", () => {
    const tran = laiDuKien(SO.principal, SO.annualRateBp, 182);
    expect(tran).toBe(5_185_753);
    expect(laiDonToiNay({ ...SO, homNay: new Date(2027, 5, 1) })).toBe(tran);
    expect(laiDonToiNay({ ...SO, homNay: new Date(2030, 0, 1) })).toBe(tran);
  });

  it("đúng ngày gửi ⇒ 0 đ", () => {
    expect(laiDonToiNay({ ...SO, homNay: new Date(2026, 9, 1) })).toBe(0);
  });
});

describe("chenhLechLaiSuat — ước tính vay-để-gửi (spec §6.3)", () => {
  const SO = { principal: 200_000_000, annualRateBp: 520 };

  it("không gắn khoản vay ⇒ null (ẩn hẳn dòng chênh lệch)", () => {
    expect(chenhLechLaiSuat(SO, null)).toBeNull();
  });

  it("vay kỳ hạn khai %/năm: dùng thẳng annualRateBp, quyDoi = false", () => {
    const r = chenhLechLaiSuat(SO, {
      kind: "TERM",
      annualRateBp: 1050,
      laiCoDinhMoiKy: null,
      duNoGoc: 200_000_000,
    });
    expect(r).toEqual({ chenhBp: 520 - 1050, chenhMoiNam: -10_600_000, quyDoi: false });
  });

  it("vay trả gốc cuối kỳ khai lãi CỐ ĐỊNH 1.121.096 đ/kỳ trên 200tr ⇒ quy đổi 673bp (6,73%/năm)", () => {
    // 1.121.096 × 12 × 10.000 / 200.000.000 = 672,6576 → 673 bp.
    const r = chenhLechLaiSuat(SO, {
      kind: "BULLET",
      annualRateBp: 0, // khoản thật KHÔNG khai %/năm — lấy 0 là hiện "gửi lời 5,2%/năm", sai trắng trợn
      laiCoDinhMoiKy: 1_121_096,
      duNoGoc: 200_000_000,
    });
    expect(r).toEqual({ chenhBp: -153, chenhMoiNam: -3_060_000, quyDoi: true });
  });

  it("gửi lãi cao hơn vay ⇒ chênh DƯƠNG", () => {
    const r = chenhLechLaiSuat(
      { principal: 100_000_000, annualRateBp: 700 },
      { kind: "TERM", annualRateBp: 500, laiCoDinhMoiKy: null, duNoGoc: 100_000_000 }
    );
    expect(r).toEqual({ chenhBp: 200, chenhMoiNam: 2_000_000, quyDoi: false });
  });

  it("lãi cố định nhưng KHÔNG phải BULLET ⇒ dùng annualRateBp, KHÔNG quy đổi (dư nợ giảm dần, quy đổi sai)", () => {
    const r = chenhLechLaiSuat(SO, {
      kind: "TERM",
      annualRateBp: 1050,
      laiCoDinhMoiKy: 1_121_096,
      duNoGoc: 200_000_000,
    });
    expect(r?.quyDoi).toBe(false);
    expect(r?.chenhBp).toBe(520 - 1050);
  });

  it("BULLET khai lãi cố định nhưng dư nợ 0 ⇒ null (không đủ dữ liệu, KHÔNG hiện số sai)", () => {
    expect(
      chenhLechLaiSuat(SO, {
        kind: "BULLET",
        annualRateBp: 0,
        laiCoDinhMoiKy: 1_121_096,
        duNoGoc: 0,
      })
    ).toBeNull();
  });

  it("chênh bằng 0 ⇒ trả 0 THẬT, không phải -0 (toBe phân biệt hai giá trị đó)", () => {
    const r = chenhLechLaiSuat(SO, {
      kind: "TERM",
      annualRateBp: 520,
      laiCoDinhMoiKy: null,
      duNoGoc: 200_000_000,
    });
    expect(r?.chenhMoiNam).toBe(0);
    expect(Object.is(r?.chenhMoiNam, -0)).toBe(false);
  });
});
