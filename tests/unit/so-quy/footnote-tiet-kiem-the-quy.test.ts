import { describe, expect, it } from "vitest";

import { dongTietKiemDangGui } from "@/components/finance/so-quy-card";

/**
 * Footnote thẻ "Quỹ còn lại" cho sổ tiết kiệm SINH LÃI. Gửi 200tr xong quỹ tụt đúng 200tr mà không
 * một chữ giải thích thì chủ shop đọc thành khoản lỗ. Câu này phải KHÁC HẲN câu tiền gửi BẮT BUỘC
 * theo khoản vay (`DEPOSIT_*`) — hai loại nằm cùng một thẻ, đọc nhầm là sai cả nghĩa lẫn ngày nhận lại.
 */
const SO = {
  tong: 200_000_000,
  daoHanGanNhat: new Date(2027, 2, 15),
  gocDaoHan: 200_000_000,
  laiDuKienDaoHan: 5_200_000,
};

describe("dongTietKiemDangGui", () => {
  it("không có sổ nào đang gửi ⇒ null (không in dòng rỗng)", () => {
    expect(dongTietKiemDangGui(null)).toBeNull();
    expect(dongTietKiemDangGui({ ...SO, tong: 0 })).toBeNull();
  });

  it("có sổ ⇒ đủ Σ đang gửi · đáo hạn dd/MM · gốc nhận lại · lãi dự kiến", () => {
    expect(dongTietKiemDangGui(SO)).toBe(
      "đang gửi tiết kiệm sinh lãi 200.000.000 ₫ (đã trừ vào quỹ, không mất) — đáo hạn gần nhất 15/03 nhận lại 200.000.000 ₫ + lãi ≈ 5.200.000 ₫"
    );
  });

  it("chữ khác hẳn footnote tiền gửi BẮT BUỘC: có 'sinh lãi', không nhắc 'khoản vay'", () => {
    const s = dongTietKiemDangGui(SO) ?? "";
    expect(s).toContain("sinh lãi");
    expect(s).not.toContain("khoản vay");
    expect(s).not.toContain("tiết kiệm ngân hàng"); // đúng chữ mở đầu của câu DEPOSIT_*
  });

  it("không đọc được ngày đáo hạn ⇒ chỉ in vế Σ đang gửi, KHÔNG bịa ngày", () => {
    expect(dongTietKiemDangGui({ ...SO, daoHanGanNhat: null })).toBe(
      "đang gửi tiết kiệm sinh lãi 200.000.000 ₫ (đã trừ vào quỹ, không mất)"
    );
  });
});
