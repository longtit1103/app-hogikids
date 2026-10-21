import { describe, expect, it } from "vitest";

import { parseVnInt } from "@/lib/import/xlsx-shared";

/**
 * `parseVnInt` — ô số tiền VND trong file import tay (ads / ví Shopee / giá vốn).
 *
 * Lỗi cũ: xoá CẢ `.` lẫn `,` rồi `parseInt` ⇒ file TikTok/Meta xuất `Cost = "120000.00"` thành
 * 12.000.000 (×100), `"1,234.5"` thành 12.345 (×10) — chi phí ads phồng mà không cổng nào kêu.
 * Luật mới: đuôi 1–2 chữ số sau `.`/`,` là PHẦN THẬP PHÂN (làm tròn); nhóm đúng 3 chữ số là dấu
 * NGHÌN; còn lại mập mờ ⇒ null (dòng lỗi cho chủ shop sửa file, không tự đoán).
 */
describe("parseVnInt — giữ nguyên hành vi số nguyên", () => {
  it.each([
    ["120000", 120_000],
    ["1.234.567", 1_234_567],
    ["1,234,567", 1_234_567],
    ["120.000", 120_000],
    ["1.234", 1_234],
    ["-1.234.567", -1_234_567],
    ["120.000 ₫", 120_000],
    ["120.000đ", 120_000],
    ["1 234 567", 1_234_567],
    ["0", 0],
  ])("%s → %d", (vao, ra) => {
    expect(parseVnInt(vao)).toBe(ra);
  });

  it("number → Math.round; rỗng/null/NaN → null", () => {
    expect(parseVnInt(1234.6)).toBe(1235);
    expect(parseVnInt(Number.NaN)).toBeNull();
    expect(parseVnInt("")).toBeNull();
    expect(parseVnInt(null)).toBeNull();
    expect(parseVnInt(undefined)).toBeNull();
  });
});

describe("parseVnInt — phần thập phân (KHÔNG còn phồng ×100)", () => {
  it.each([
    ["120000.00", 120_000],
    ["120000,00", 120_000],
    ["120000.5", 120_001],
    ["1,234.5", 1_235],
    ["1,234,567.89", 1_234_568],
    ["1.234.567,89", 1_234_568],
    ["1.234,50", 1_235],
    ["0.4", 0],
    ["-1,234.5", -1_235],
    ["-120000.00", -120_000],
  ])("%s → %d", (vao, ra) => {
    expect(parseVnInt(vao)).toBe(ra);
  });
});

describe("parseVnInt — mập mờ ⇒ null (không tự đoán)", () => {
  it.each([
    ["1.234.56"], // dấu thập phân trùng dấu nghìn
    ["1,234,56"],
    ["120000.000"], // 6 chữ số trước nhóm 3 — không phải nhóm nghìn hợp lệ, cũng không phải thập phân
    ["12,34,567"], // nhóm không đều 3 chữ số
    ["1.234,567"], // trộn dấu không có đuôi thập phân
    ["1234.5678"],
    ["abc"],
    ["1.2.3"],
    ["--5"],
    ["+5"],
  ])("%s → null", (vao) => {
    expect(parseVnInt(vao)).toBeNull();
  });
});
