import { describe, expect, it } from "vitest";

import {
  demKyDaToiHan,
  deXuatKy,
  duNoTai,
  kyChoDuyet,
  laiTheoNgay,
  ngayTraKy,
  type KhoanVayLich,
} from "@/lib/so-quy/lich-tra-no";
import { deXuatTatToan } from "@/lib/so-quy/lai-thau-chi";

const L: KhoanVayLich = {
  kind: "TERM",
  startDate: new Date(2026, 8, 5),
  firstDueDate: new Date(2026, 9, 10),
  termMonths: 12,
  annualRateBp: 1050,
  duNoMoSo: 0,
  giaiNgan: 200_000_000,
  giaiNganNgay: new Date(2026, 8, 5), // dòng LOAN_IN về đúng ngày giải ngân (ca thường)
  laiCoDinhMoiKy: null, // TERM tính lãi từ %/năm như cũ
  tienGuiBatBuocMoiKy: 0,
};

describe("lich-tra-no", () => {
  it("kỳ 1: 05/09 → 10/10 = 35 ngày, lãi 2.013.699, gốc 16.666.667", () => {
    const k1 = deXuatKy(L, [], 1, null);
    expect(k1.soNgay).toBe(35);
    expect(k1.duNoDauKy).toBe(200_000_000);
    expect(k1.lai).toBe(2_013_699);
    expect(k1.goc).toBe(16_666_667);
  });

  it("kỳ 2 sau khi trả gốc kỳ 1 đúng ngày 10/10: dư nợ 183.333.333, 31 ngày ⇒ 1.634.932", () => {
    const k2 = deXuatKy(L, [{ ngay: new Date(2026, 9, 10), soTien: 16_666_667 }], 2, null);
    expect(k2.duNoDauKy).toBe(183_333_333);
    expect(k2.soNgay).toBe(31);
    expect(k2.lai).toBe(1_634_932);
  });

  it("kỳ 12 gốc = dư nợ còn lại (về 0)", () => {
    const tra = Array.from({ length: 11 }, (_, i) => ({
      ngay: new Date(2026, 9 + i, 10),
      soTien: 16_666_667,
    }));
    expect(deXuatKy(L, tra, 12, null).goc).toBe(200_000_000 - 11 * 16_666_667);
  });

  it("firstDueDate 31/01 ⇒ kỳ 2 = 28/02, kỳ 3 = 31/03", () => {
    const l = { ...L, startDate: new Date(2026, 0, 1), firstDueDate: new Date(2026, 0, 31) };
    expect(ngayTraKy(l, 2)).toEqual(new Date(2026, 1, 28));
    expect(ngayTraKy(l, 3)).toEqual(new Date(2026, 2, 31));
  });

  it("startDate mang giờ 07:00 vẫn 35 ngày", () =>
    expect(deXuatKy({ ...L, startDate: new Date(2026, 8, 5, 7, 0) }, [], 1, null).soNgay).toBe(35));

  it("khoản mang sang: startDate 01/10, firstDueDate 10/10 ⇒ 9 ngày, duNo = duNoMoSo", () => {
    const l = {
      ...L,
      startDate: new Date(2026, 9, 1),
      firstDueDate: new Date(2026, 9, 10),
      duNoMoSo: 200_000_000,
      giaiNgan: 0,
      giaiNganNgay: null, // khoản mang sang: KHÔNG có dòng LOAN_IN
    };
    expect(deXuatKy(l, [], 1, null).soNgay).toBe(9);
    expect(duNoTai(l, [], new Date(2026, 9, 1))).toBe(200_000_000);
  });

  it("dư nợ đếm theo NGÀY DÒNG LOAN_IN, không theo startDate", () => {
    // startDate 05/09 (due_0, chủ shop sửa được) nhưng tiền vay chỉ thật sự về 10/09.
    const l = { ...L, duNoMoSo: 30_000_000, giaiNganNgay: new Date(2026, 8, 10) };
    expect(duNoTai(l, [], new Date(2026, 8, 7))).toBe(30_000_000); // chưa cộng khoản giải ngân
    expect(duNoTai(l, [], new Date(2026, 8, 10))).toBe(30_000_000 + 200_000_000);
  });

  /**
   * Ca sửa `firstDueDate` SAU khi đã duyệt kỳ 1: kỳ 1 MỚI (15/10) vẫn chờ duyệt theo luật con dấu
   * "<" (15/10 > 10/10), nhưng mốc đầu kỳ phải KẸP theo con dấu — nếu lấy `due_0` = startDate 05/09
   * thì dòng trả gốc ngày 10/10 nằm SAU mốc, bị bỏ qua, và app đề xuất lại NGUYÊN 200tr + lãi 40
   * ngày, tức đòi trả hai lần cùng một kỳ.
   */
  it("sửa firstDueDate sau khi duyệt kỳ 1: mốc đầu kỳ kẹp theo con dấu, KHÔNG đề xuất lại nguyên gốc", () => {
    const traKy1 = [{ ngay: new Date(2026, 9, 10), soTien: 16_666_667 }];
    const lichMoi = { ...L, firstDueDate: new Date(2026, 9, 15) };
    const conDau = new Date(2026, 9, 10);

    const ky = kyChoDuyet(lichMoi, traKy1, conDau, new Date(2026, 10, 1));
    expect(ky?.ky).toBe(1);
    expect(ky?.tuNgay).toEqual(new Date(2026, 9, 10)); // con dấu, KHÔNG phải startDate 05/09
    expect(ky?.soNgay).toBe(5); // 10/10 → 15/10
    expect(ky?.duNoDauKy).toBe(183_333_333); // đã trừ gốc kỳ 1, không phải 200.000.000
    expect(ky?.lai).toBe(263_699); // round(183.333.333 × 1050/10000 × 5/365)
    expect(ky?.goc).toBe(16_666_667);
  });

  it("gọi thẳng deXuatKy cho kỳ đã nằm sau con dấu ⇒ soNgay kẹp 0, lãi 0 (không âm)", () => {
    const ky = deXuatKy(L, [], 1, new Date(2026, 10, 30));
    expect(ky.soNgay).toBe(0);
    expect(ky.lai).toBe(0);
  });

  it("không lịch ⇒ kyChoDuyet null", () =>
    expect(
      kyChoDuyet({ ...L, firstDueDate: null, termMonths: null }, [], null, new Date(2027, 0, 1))
    ).toBeNull());

  it("kỳ chờ duyệt = kỳ sớm nhất chưa xử lý, so '<' với lastDueHandled", () => {
    expect(kyChoDuyet(L, [], null, new Date(2026, 9, 9))).toBeNull();
    expect(kyChoDuyet(L, [], null, new Date(2026, 10, 20))?.ky).toBe(1);
    expect(kyChoDuyet(L, [], new Date(2026, 9, 10), new Date(2026, 10, 20))?.ky).toBe(2);
    expect(kyChoDuyet(L, [], new Date(2026, 9, 15), new Date(2026, 10, 20))?.ky).toBe(2); // con dấu lệch lịch vẫn không kẹt
  });

  it("demKyDaToiHan: đếm kỳ đã tới hạn theo lịch, dừng ở kỳ đầu tiên vượt hạn", () => {
    expect(demKyDaToiHan(L, new Date(2026, 9, 9))).toBe(0); // trước kỳ 1 (10/10)
    expect(demKyDaToiHan(L, new Date(2026, 9, 10))).toBe(1); // đúng ngày kỳ 1
    expect(demKyDaToiHan(L, new Date(2026, 11, 20))).toBe(3); // 10/10 · 10/11 · 10/12
    expect(demKyDaToiHan(L, new Date(2030, 0, 1))).toBe(12); // không vượt termMonths
    expect(demKyDaToiHan({ ...L, firstDueDate: null, termMonths: null }, new Date(2030, 0, 1))).toBe(0);
  });
});

/**
 * Thấu chi — số ở đây TÍNH TAY từ công thức `Σ(dư nợ × số ngày) × bp / (10.000 × 365)`, làm tròn
 * nửa lên MỘT lần, KHÔNG suy lại bằng chính hàm đang kiểm. Rút 100tr ngày 05/09/2026, 12%/năm.
 */
const TC: KhoanVayLich = {
  kind: "OVERDRAFT",
  startDate: new Date(2026, 8, 5),
  firstDueDate: new Date(2026, 9, 10), // ngân hàng thu lãi mùng 10
  termMonths: null, // thấu chi KHÔNG có lịch trả gốc
  annualRateBp: 1200,
  duNoMoSo: 0,
  giaiNgan: 100_000_000,
  giaiNganNgay: new Date(2026, 8, 5),
  laiCoDinhMoiKy: null, // thấu chi luôn tính lãi theo ngày, không dùng cột này
  tienGuiBatBuocMoiKy: 0,
};

/** Trả bớt 40tr ngày 20/09 — mốc chia đoạn giữa kỳ, chỗ thấu chi khác hẳn vay kỳ hạn. */
const TRA_BOT = [{ ngay: new Date(2026, 8, 20), soTien: 40_000_000 }];

describe("lich-tra-no — thấu chi (lãi theo ngày)", () => {
  it("kỳ 1 không trả bớt: 35 ngày × 100tr ⇒ lãi 1.150.685, gốc 0", () => {
    const k1 = deXuatKy(TC, [], 1, null);
    expect(k1.soNgay).toBe(35);
    expect(k1.duNoDauKy).toBe(100_000_000);
    expect(k1.lai).toBe(1_150_685); // 4,2e12 / 3,65e6 = 1.150.684,93
    expect(k1.goc).toBe(0); // ngân hàng chỉ thu lãi
  });

  it("kỳ 1 sau khi trả bớt 40tr ngày 20/09: lãi 887.671, KHÁC hẳn lãi trên dư nợ đầu kỳ", () => {
    const k1 = deXuatKy(TC, TRA_BOT, 1, null);
    // 15 ngày × 100tr + 20 ngày × 60tr = 2,7e9 ⇒ 2,7e9 × 1200 / 3,65e6 = 887.671,23
    expect(k1.lai).toBe(887_671);
    expect(k1.lai).not.toBe(1_150_685); // dư nợ ĐẦU kỳ × 35 ngày — cách tính của vay kỳ hạn
    expect(k1.goc).toBe(0);
  });

  it("tất toán 25/10 sau khi duyệt kỳ 1 (con dấu 10/10): lãi 295.890 + gốc 60tr", () => {
    const tt = deXuatTatToan(TC, TRA_BOT, new Date(2026, 9, 10), new Date(2026, 9, 25));
    expect(tt.tuNgay).toEqual(new Date(2026, 9, 10)); // con dấu, không phải ngày rút
    expect(tt.soNgay).toBe(15);
    expect(tt.lai).toBe(295_890); // 9e8 × 1200 / 3,65e6 = 295.890,41
    expect(tt.goc).toBe(60_000_000);
  });

  it("không có lịch thu lãi: kyChoDuyet null, tất toán 25/10 gộp cả 2 đoạn ⇒ lãi 1.183.562", () => {
    const l = { ...TC, firstDueDate: null };
    expect(kyChoDuyet(l, TRA_BOT, null, new Date(2026, 9, 25))).toBeNull();
    const tt = deXuatTatToan(l, TRA_BOT, null, new Date(2026, 9, 25));
    expect(tt.tuNgay).toEqual(new Date(2026, 8, 5)); // chưa duyệt kỳ nào ⇒ từ ngày rút
    // 15 ngày × 100tr + 35 ngày × 60tr = 3,6e9 ⇒ 3,6e9 × 1200 / 3,65e6 = 1.183.561,64
    expect(tt.lai).toBe(1_183_562);
    expect(tt.goc).toBe(60_000_000);
  });

  it("thấu chi mang sang: dư nợ mở sổ 50tr, rút 01/09, kỳ đầu 10/09 ⇒ 9 ngày, lãi 147.945", () => {
    const l: KhoanVayLich = {
      ...TC,
      startDate: new Date(2026, 8, 1),
      firstDueDate: new Date(2026, 8, 10),
      duNoMoSo: 50_000_000,
      giaiNgan: 0,
      giaiNganNgay: null, // khoản mang sang: KHÔNG có dòng LOAN_IN, quỹ không cộng thêm
    };
    const k1 = deXuatKy(l, [], 1, null);
    expect(k1.soNgay).toBe(9);
    expect(k1.duNoDauKy).toBe(50_000_000);
    expect(k1.lai).toBe(147_945); // 4,5e8 × 1200 / 3,65e6 = 147.945,20
  });

  it("dư nợ 2 tỷ × 3.650 ngày × 100%/năm: BigInt, không mất chính xác vì float", () => {
    const l: KhoanVayLich = {
      ...TC,
      annualRateBp: 10_000,
      giaiNgan: 2_000_000_000,
      giaiNganNgay: new Date(2026, 0, 1),
      startDate: new Date(2026, 0, 1),
    };
    // Tích trung gian 2e9 × 3650 × 10.000 = 7,3e16 > 2^53 (9,007e15) ⇒ nhân bằng Number là sai số.
    const lai = laiTheoNgay(l, [], new Date(2026, 0, 1), new Date(2035, 11, 30)); // đúng 3.650 ngày
    const tay =
      (BigInt(2_000_000_000) * BigInt(3_650) * BigInt(10_000)) / BigInt(3_650_000);
    expect(lai).toBe(Number(tay));
    expect(lai).toBe(20_000_000_000); // 2 tỷ vay 10 năm lãi 100%/năm = 20 tỷ tiền lãi
  });

  it("demKyDaToiHan thấu chi: không lịch = 0; có lịch đếm được dù termMonths NULL", () => {
    expect(demKyDaToiHan({ ...TC, firstDueDate: null }, new Date(2030, 0, 1))).toBe(0);
    expect(demKyDaToiHan(TC, new Date(2026, 9, 9))).toBe(0);
    expect(demKyDaToiHan(TC, new Date(2026, 11, 20))).toBe(3); // 10/10 · 10/11 · 10/12
    expect(demKyDaToiHan(TC, new Date(2027, 9, 10))).toBe(13); // không bị termMonths chặn ở 12
  });

  it("kyChoDuyet thấu chi: dư nợ đã về 0 cả kỳ ⇒ null; kẹp mốc theo con dấu", () => {
    // Trả hết 100tr ngày 20/09: kỳ 1 (10/10) VẪN phải duyệt vì 15 ngày đầu còn dư nợ; kỳ 2 thì
    // dư nợ bằng 0 suốt kỳ ⇒ không còn gì để thu.
    const traHet = [{ ngay: new Date(2026, 8, 20), soTien: 100_000_000 }];
    expect(kyChoDuyet(TC, traHet, null, new Date(2026, 10, 20))?.ky).toBe(1);
    expect(kyChoDuyet(TC, traHet, new Date(2026, 9, 10), new Date(2026, 10, 20))).toBeNull();

    // Đã duyệt kỳ 1 (con dấu 10/10) ⇒ kỳ 2 chỉ tính lãi TỪ con dấu, không tính lại từ ngày rút.
    const k2 = kyChoDuyet(TC, TRA_BOT, new Date(2026, 9, 10), new Date(2026, 10, 20));
    expect(k2?.ky).toBe(2);
    expect(k2?.tuNgay).toEqual(new Date(2026, 9, 10));
    expect(k2?.soNgay).toBe(31); // 10/10 → 10/11
    // 31 ngày × 60tr = 1,86e9 ⇒ 1,86e9 × 1200 / 3,65e6 = 611.506,85
    expect(k2?.lai).toBe(611_507);
    expect(k2?.goc).toBe(0);
  });

  it("deXuatTatToan kẹp con dấu: tất toán đúng ngày con dấu ⇒ 0 ngày lãi, vẫn trả hết gốc", () => {
    const tt = deXuatTatToan(TC, TRA_BOT, new Date(2026, 9, 10), new Date(2026, 9, 10));
    expect(tt.soNgay).toBe(0);
    expect(tt.lai).toBe(0);
    expect(tt.goc).toBe(60_000_000);
  });
});

/**
 * BULLET (trả gốc cuối kỳ) — ca THẬT chủ shop (khoản vay có tiền gửi tiết kiệm bắt buộc):
 * 200tr giải ngân 12/05/2026, 36 kỳ, kỳ đầu 10/06/2026, lãi CỐ ĐỊNH 1.121.096đ MỌI kỳ (không phụ
 * thuộc số ngày/dư nợ), tiền gửi tiết kiệm bắt buộc 300.000đ MỌI kỳ. Số LITERAL tính tay theo giấy
 * báo ngân hàng — KHÔNG suy lại bằng chính hàm `deXuatKy` đang kiểm.
 *
 * `annualRateBp` CỐ Ý giữ 1050 (≠ 0): chứng minh lãi đọc từ `laiCoDinhMoiKy` chứ không rơi về công
 * thức %/năm khi cả hai cùng có mặt.
 */
const BU: KhoanVayLich = {
  kind: "BULLET",
  startDate: new Date(2026, 4, 12), // 12/05/2026
  firstDueDate: new Date(2026, 5, 10), // 10/06/2026
  termMonths: 36,
  annualRateBp: 1050,
  duNoMoSo: 0,
  giaiNgan: 200_000_000,
  giaiNganNgay: new Date(2026, 4, 12),
  laiCoDinhMoiKy: 1_121_096,
  tienGuiBatBuocMoiKy: 300_000,
};

describe("lich-tra-no — BULLET (trả gốc cuối kỳ, lãi cố định + tiền gửi bắt buộc)", () => {
  it("kỳ 1: 12/05 → 10/06 = 29 ngày, lãi cố định 1.121.096 (KHÔNG theo %/năm), gốc 0, tiền gửi 300.000", () => {
    const k1 = deXuatKy(BU, [], 1, null);
    expect(k1.soNgay).toBe(29);
    expect(k1.duNoDauKy).toBe(200_000_000);
    expect(k1.lai).toBe(1_121_096);
    // round(200tr × 1050bp × 29/365/10000) = 1.668.493 — công thức %/năm, KHÔNG được dùng ở đây.
    expect(k1.lai).not.toBe(1_668_493);
    expect(k1.goc).toBe(0);
    // round(200tr/36) = 5.555.556 — gốc chia đều của TERM. BULLET tuyệt đối không rơi vào nhánh này.
    expect(k1.goc).not.toBe(5_555_556);
    expect(k1.tienGui).toBe(300_000);
  });

  it("kỳ 35: vẫn lãi 1.121.096, gốc 0 — CHƯA tới kỳ trả gốc dù đã gần hết kỳ hạn", () => {
    const k35 = deXuatKy(BU, [], 35, null);
    expect(k35.duNoDauKy).toBe(200_000_000); // chưa trả gốc kỳ nào (traGoc rỗng)
    expect(k35.lai).toBe(1_121_096);
    expect(k35.goc).toBe(0);
    expect(k35.tienGui).toBe(300_000);
  });

  it("kỳ 36 (kỳ cuối): trả TRỌN gốc 200.000.000, lãi vẫn 1.121.096 (không prorate theo số kỳ)", () => {
    const k36 = deXuatKy(BU, [], 36, null);
    expect(k36.duNoDauKy).toBe(200_000_000);
    expect(k36.goc).toBe(200_000_000);
    expect(k36.lai).toBe(1_121_096);
    expect(k36.tienGui).toBe(300_000);
  });

  it("Σ tiền gửi 36 kỳ = 10.800.000 — dòng tiền thuần, không phụ thuộc dư nợ hay số ngày", () => {
    let tong = 0;
    for (let k = 1; k <= 36; k++) tong += deXuatKy(BU, [], k, null).tienGui;
    expect(tong).toBe(10_800_000);
  });
});

/**
 * SỔ TIẾT KIỆM BẮT BUỘC CHỈ THUỘC BULLET, và `kyChoDuyet` không được nuốt kỳ chỉ vì dư nợ về 0.
 *
 * Hai luật này đi cùng nhau: từ khi `deXuatKy` kẹp `tienGui = 0` cho mọi loại khác BULLET, điều kiện
 * "còn kỳ chờ" mới nới ra được `duNoDauKy > 0 || lai > 0 || tienGui > 0` mà KHÔNG đổi hành vi của
 * TERM/OVERDRAFT.
 */
describe("lich-tra-no — tiền gửi chỉ thuộc BULLET, kỳ chờ không phụ thuộc riêng dư nợ", () => {
  /** Bản ghi TERM còn SÓT số tiền gửi (khai trước khi có luật, hoặc ghi thẳng DB). */
  const TERM_RO_TIEN_GUI: KhoanVayLich = { ...L, tienGuiBatBuocMoiKy: 300_000 };
  const TC_RO_TIEN_GUI: KhoanVayLich = { ...TC, tienGuiBatBuocMoiKy: 300_000 };

  it.each([
    ["TERM", TERM_RO_TIEN_GUI],
    ["OVERDRAFT", TC_RO_TIEN_GUI],
  ])("%s còn sót tienGuiBatBuocMoiKy → đề xuất tienGui = 0, không đẻ dòng DEPOSIT_OUT", (_ten, lich) => {
    expect(deXuatKy(lich, [], 1, null).tienGui).toBe(0);
    expect(deXuatKy(lich, [], 2, null).tienGui).toBe(0);
  });

  /**
   * Ca hỏng thật: BULLET trả trọn gốc SỚM ở kỳ 33 (10/02/2029). Lãi của loại này CỐ ĐỊNH, độc lập
   * dư nợ, nên ngân hàng vẫn thu đủ kỳ 34–36 × 1.121.096 = 3.363.288 + 3 × 300.000 tiền gửi. Điều
   * kiện cũ (`duNoDauKy > 0`) làm ba kỳ đó biến mất khỏi màn hình ⇒ số tiền trên không bao giờ vào
   * Sổ chi phí và Lãi/Lỗ báo lãi khống.
   */
  it("BULLET trả trọn gốc sớm → kỳ SAU vẫn hiện với lãi cố định + tiền gửi (dư nợ đầu kỳ 0)", () => {
    const traTron = [{ ngay: new Date(2029, 1, 10), soTien: 200_000_000 }]; // 10/02/2029 = kỳ 33
    const ky34 = kyChoDuyet(BU, traTron, new Date(2029, 1, 10), new Date(2029, 2, 10));
    expect(ky34).not.toBeNull();
    expect(ky34?.ky).toBe(34);
    expect(ky34?.duNoDauKy).toBe(0);
    expect(ky34?.lai).toBe(1_121_096);
    expect(ky34?.goc).toBe(0);
    expect(ky34?.tienGui).toBe(300_000);
  });

  /**
   * HÀNH VI CŨ KHÔNG ĐỔI: lãi của TERM/OVERDRAFT tỉ lệ dư nợ (dư nợ 0 ⇒ lãi 0) và `tienGui` nay
   * luôn 0 ngoài BULLET, nên trả hết nợ là hết kỳ chờ — đúng như trước khi nới điều kiện.
   */
  it("TERM/OVERDRAFT trả hết gốc → hết kỳ chờ (điều kiện nới KHÔNG làm hiện kỳ rỗng)", () => {
    const traHet = [{ ngay: new Date(2026, 9, 10), soTien: 200_000_000 }];
    expect(kyChoDuyet(L, traHet, new Date(2026, 9, 10), new Date(2026, 10, 10))).toBeNull();

    const traHetTc = [{ ngay: new Date(2026, 9, 10), soTien: 100_000_000 }];
    expect(kyChoDuyet(TC, traHetTc, new Date(2026, 9, 10), new Date(2026, 10, 10))).toBeNull();
  });
});
