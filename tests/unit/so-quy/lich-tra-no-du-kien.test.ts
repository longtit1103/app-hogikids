import { describe, expect, it } from "vitest";

import { deXuatKy, duKienNKy, type KhoanVayLich, type TraGoc } from "@/lib/so-quy/lich-tra-no";
import { tongChuyenNganHang } from "@/lib/so-quy/tien-ky-tra-no";

/**
 * Bảng DỰ KIẾN N kỳ tới. Ba thứ đáng khoá nhất — cả ba đều có tiền lệ hỏng trong repo:
 *  1. mô phỏng dây chuyền (dư nợ phải giảm theo chuỗi, không đứng yên);
 *  2. gốc kẹp về dư nợ THẬT (lượt trả tay giữa kỳ);
 *  3. tiền thật chuyển ngân hàng đi qua `tongChuyenNganHang` (kỳ cuối bị cấn sổ tiết kiệm).
 */
const HOM_NAY = new Date(2026, 8, 23); // 23/09/2026

const TERM: KhoanVayLich = {
  kind: "TERM",
  startDate: new Date(2026, 8, 5),
  firstDueDate: new Date(2026, 9, 10),
  termMonths: 12,
  annualRateBp: 1050,
  duNoMoSo: 0,
  giaiNgan: 200_000_000,
  giaiNganNgay: new Date(2026, 8, 5),
  laiCoDinhMoiKy: null,
  tienGuiBatBuocMoiKy: 0,
};

/** Đối số mặc định: khoản còn hiệu lực, dư nợ thật = trọn giải ngân, không có tiền gửi. */
const goi = (ghiDe: Partial<Parameters<typeof duKienNKy>[0]> = {}) =>
  duKienNKy({
    lich: TERM,
    traGoc: [],
    lastDueHandled: null,
    homNay: HOM_NAY,
    soKy: 6,
    duNoHienTai: 200_000_000,
    tienGuiDangGiu: 0,
    closedAt: null,
    ...ghiDe,
  });

describe("duKienNKy — TERM: dư nợ giảm dần theo mô phỏng", () => {
  it("6 kỳ đầu: dư nợ đầu kỳ giảm dần, kỳ 1 và 2 khớp số literal của deXuatKy", () => {
    const ds = goi();
    expect(ds).toHaveLength(6);
    expect(ds.map((d) => d.ky)).toEqual([1, 2, 3, 4, 5, 6]);

    expect(ds[0]).toMatchObject({ duNoDauKy: 200_000_000, soNgay: 35, lai: 2_013_699, gocThuc: 16_666_667 });
    // Kỳ 2 CHỈ đúng khi khoản trả kỳ 1 đã được nạp vào — số literal của test gốc `lich-tra-no`.
    expect(ds[1]).toMatchObject({ duNoDauKy: 183_333_333, soNgay: 31, lai: 1_634_932 });

    for (let i = 1; i < ds.length; i++) {
      expect(ds[i].duNoDauKy).toBeLessThan(ds[i - 1].duNoDauKy);
      expect(ds[i - 1].duNoSauKy).toBe(200_000_000 - 16_666_667 * i);
    }
  });

  it("🔴 HÀNG RÀO dây chuyền: khác hẳn lặp ngây thơ — từ kỳ 2 trở đi", () => {
    const ds = goi();
    const ngayTho = [1, 2, 3, 4, 5, 6].map((k) => deXuatKy(TERM, [], k, null));

    expect(ds[0].duNoDauKy).toBe(ngayTho[0].duNoDauKy); // kỳ 1 trùng — chưa có gì để mô phỏng
    for (let i = 1; i < 6; i++) {
      expect(ds[i].duNoDauKy).not.toBe(ngayTho[i].duNoDauKy);
      expect(ds[i].lai).not.toBe(ngayTho[i].lai);
    }
    expect(ngayTho[5].duNoDauKy).toBe(200_000_000);
    expect(ds[5].duNoDauKy).toBeLessThan(200_000_000);
  });

  it("KHÔNG đụng mảng traGoc của caller", () => {
    const tra: TraGoc[] = [{ ngay: new Date(2026, 9, 10), soTien: 16_666_667 }];
    goi({ traGoc: tra });
    expect(tra).toHaveLength(1);
  });

  it("kỳ cuối đưa dư nợ về 0, và dừng đúng số kỳ còn lại khi soKy lớn hơn", () => {
    const ds = goi({ soKy: 99 });
    expect(ds).toHaveLength(12);
    expect(ds[11].ky).toBe(12);
    expect(ds[11].duNoSauKy).toBe(0);
  });
});

describe("duKienNKy — 🔴 gốc KẸP về dư nợ THẬT (lượt trả tay giữa kỳ)", () => {
  it("trả tay 195tr ⇒ kỳ 1 chỉ còn gốc 5tr, dư nợ sau kỳ về 0 — KHÔNG hứa trả 16,6tr", () => {
    // `deXuatKy` tính gốc từ dư nợ ĐẦU kỳ (200tr) nên đề xuất 16.666.667; thực tế chỉ còn nợ 5tr.
    // Không kẹp thì bảng dự kiến hứa một số lớn hơn số thật còn nợ, đá với `KyTraNoCard` và bảng khoản vay.
    const ds = goi({
      traGoc: [{ ngay: new Date(2026, 8, 20), soTien: 195_000_000 }],
      duNoHienTai: 5_000_000,
    });
    expect(ds[0].goc).toBe(16_666_667); // đề xuất thô của deXuatKy — giữ nguyên để đối chiếu
    expect(ds[0].gocThuc).toBe(5_000_000); // số ĐEM HIỂN THỊ
    expect(ds[0].duNoSauKy).toBe(0);
  });

  it("trả tay 50tr giữa kỳ 2 ⇒ cột Gốc và Dư nợ sau kỳ tự khớp nhau ở MỌI dòng", () => {
    const ds = goi({
      traGoc: [{ ngay: new Date(2026, 9, 25), soTien: 50_000_000 }],
      duNoHienTai: 150_000_000,
      soKy: 4,
    });
    let duNo = 150_000_000;
    for (const d of ds) {
      expect(d.duNoSauKy).toBe(duNo - d.gocThuc);
      duNo = d.duNoSauKy;
    }
  });
});

describe("duKienNKy — 🔴 tiền thật chuyển ngân hàng đi qua tongChuyenNganHang", () => {
  const BULLET: KhoanVayLich = {
    ...TERM,
    kind: "BULLET",
    termMonths: 4,
    laiCoDinhMoiKy: 1_121_096,
    tienGuiBatBuocMoiKy: 5_000_000,
  };

  it("kỳ cuối BULLET: ngân hàng CẤN sổ tiết kiệm đang giữ ⇒ tổng chuyển TRỪ phần hoàn", () => {
    const ds = duKienNKy({
      lich: BULLET,
      traGoc: [],
      lastDueHandled: null,
      homNay: HOM_NAY,
      soKy: 4,
      duNoHienTai: 200_000_000,
      tienGuiDangGiu: 0,
      closedAt: null,
    });
    expect(ds).toHaveLength(4);

    // Kỳ 1…3: chưa hoàn gì, tổng chuyển = lãi + tiền gửi (gốc 0).
    for (const d of ds.slice(0, 3)) {
      expect(d.hoanTienGui).toBe(0);
      expect(d.tongChuyen).toBe(1_121_096 + 5_000_000);
    }
    // Kỳ 4 (cuối): đã giữ 3 kỳ × 5tr + kỳ này 5tr = 20tr được cấn lại.
    expect(ds[3].hoanTienGui).toBe(20_000_000);
    expect(ds[3].gocThuc).toBe(200_000_000);
    expect(ds[3].tongChuyen).toBe(1_121_096 + 200_000_000 + 5_000_000 - 20_000_000);
    // Và phải BẰNG chính công thức dùng chung — không có bản "chưa trừ" thứ hai nào.
    expect(ds[3].tongChuyen).toBe(
      tongChuyenNganHang({ lai: 1_121_096, goc: 200_000_000, tienGui: 5_000_000, tienGuiSeNhanLai: 20_000_000 })
    );
    // Tự cộng lãi+gốc+tiền gửi sẽ ra số LỆCH 20tr — chính sự cố `tien-ky-tra-no.ts` sinh ra để diệt.
    expect(ds[3].tongChuyen).not.toBe(ds[3].lai + ds[3].gocThuc + ds[3].tienGui);
  });

  it("đã giữ sẵn tiền gửi từ các kỳ đã duyệt ⇒ cộng dồn đúng vào phần hoàn kỳ cuối", () => {
    const ds = duKienNKy({
      lich: BULLET,
      traGoc: [],
      lastDueHandled: new Date(2026, 9, 10), // đã duyệt kỳ 1
      homNay: HOM_NAY,
      soKy: 4,
      duNoHienTai: 200_000_000,
      tienGuiDangGiu: 5_000_000, // kỳ 1 đã nộp
      closedAt: null,
    });
    expect(ds.map((d) => d.ky)).toEqual([2, 3, 4]);
    expect(ds[2].hoanTienGui).toBe(20_000_000); // 5tr sẵn + 3 kỳ × 5tr
  });

  it("TERM không có tiền gửi ⇒ tổng chuyển = lãi + gốc, hoàn 0", () => {
    const ds = goi({ soKy: 2 });
    expect(ds[0].hoanTienGui).toBe(0);
    expect(ds[0].tongChuyen).toBe(ds[0].lai + ds[0].gocThuc);
  });
});

describe("duKienNKy — con dấu, quá hạn, cổng đóng khoản", () => {
  it("đã duyệt kỳ 1 ⇒ bảng bắt đầu từ kỳ 2", () => {
    const ds = goi({
      traGoc: [{ ngay: new Date(2026, 9, 10), soTien: 16_666_667 }],
      lastDueHandled: new Date(2026, 9, 10),
      duNoHienTai: 183_333_333,
      soKy: 3,
    });
    expect(ds.map((d) => d.ky)).toEqual([2, 3, 4]);
    expect(ds[0].duNoDauKy).toBe(183_333_333);
  });

  it("🟠 nhiều kỳ quá hạn: TẤT CẢ mang quaHan, nhưng CHỈ kỳ đầu là dangChoDuyet", () => {
    // 15/12/2026: kỳ 1 (10/10), 2 (10/11), 3 (10/12) đều quá hạn; kỳ 4 (10/01) thì chưa.
    const ds = goi({ homNay: new Date(2026, 11, 15), soKy: 4 });
    expect(ds.map((d) => d.quaHan)).toEqual([true, true, true, false]);
    expect(ds.map((d) => d.dangChoDuyet)).toEqual([true, false, false, false]);
  });

  it("khoản ĐÃ TẤT TOÁN ⇒ rỗng, cổng nằm trong lib chứ không chỉ ở call-site", () => {
    expect(goi({ closedAt: new Date(2026, 9, 1) })).toEqual([]);
  });

  it("không có lịch ⇒ rỗng; soKy <= 0 ⇒ rỗng", () => {
    expect(goi({ lich: { ...TERM, firstDueDate: null } })).toEqual([]);
    expect(goi({ soKy: 0 })).toEqual([]);
    expect(goi({ soKy: -1 })).toEqual([]);
  });
});

describe("duKienNKy — DỪNG khi hết nghĩa vụ, không đẻ kỳ ma", () => {
  it("TERM trả trọn gốc giữa kỳ 1 ⇒ CÒN đúng kỳ 1 (lãi trên dư nợ ĐẦU kỳ) rồi DỪNG", () => {
    const ds = goi({ traGoc: [{ ngay: new Date(2026, 8, 20), soTien: 200_000_000 }], duNoHienTai: 0 });
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ ky: 1, duNoDauKy: 200_000_000, lai: 2_013_699 });
    expect(ds[0].gocThuc).toBe(0); // không còn nợ ⇒ không hứa trả gốc
    expect(ds[0].duNoSauKy).toBe(0);
  });

  it("BULLET dư nợ VỀ 0 mà vẫn CÒN kỳ — lãi khai + tiền gửi độc lập dư nợ", () => {
    const ds = duKienNKy({
      lich: { ...TERM, kind: "BULLET", termMonths: 4, laiCoDinhMoiKy: 1_121_096, tienGuiBatBuocMoiKy: 5_000_000 },
      traGoc: [{ ngay: new Date(2026, 9, 10), soTien: 200_000_000 }],
      lastDueHandled: new Date(2026, 9, 10),
      homNay: HOM_NAY,
      soKy: 4,
      duNoHienTai: 0,
      tienGuiDangGiu: 0,
      closedAt: null,
    });
    expect(ds.length).toBeGreaterThan(0);
    expect(ds[0]).toMatchObject({ ky: 2, duNoDauKy: 0, lai: 1_121_096, tienGui: 5_000_000 });
  });
});

describe("duKienNKy — OVERDRAFT: chỉ thu lãi, dư nợ phẳng", () => {
  it("mọi kỳ gốc 0, lãi theo ngày > 0, dư nợ không đổi", () => {
    const ds = goi({
      lich: { ...TERM, kind: "OVERDRAFT", termMonths: null, annualRateBp: 1500, laiCoDinhMoiKy: null },
      soKy: 5,
    });
    expect(ds).toHaveLength(5);
    for (const d of ds) {
      expect(d.gocThuc).toBe(0);
      expect(d.lai).toBeGreaterThan(0);
      expect(d.duNoDauKy).toBe(200_000_000);
      expect(d.duNoSauKy).toBe(200_000_000);
      expect(d.hoanTienGui).toBe(0); // termMonths null ⇒ không có "kỳ cuối"
    }
  });
});
