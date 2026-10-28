import { describe, expect, it } from "vitest";

import { boKyTuDaiDienIlike, mauTimKiemIlike } from "@/lib/escape-ilike";

/**
 * ILIKE coi `%` và `_` là ký tự đại diện: ô tìm SKU kiểu `AO_THUN_01` khớp luôn `AO-THUN-01`, gõ
 * `%` ra cả danh sách. Escape bằng `\` (ký tự thoát mặc định của PostgreSQL LIKE/ILIKE).
 */
describe("boKyTuDaiDienIlike", () => {
  it("thoát %, _ và chính dấu \\", () => {
    expect(boKyTuDaiDienIlike("AO_THUN_01")).toBe("AO\\_THUN\\_01");
    expect(boKyTuDaiDienIlike("50%")).toBe("50\\%");
    expect(boKyTuDaiDienIlike("a\\b")).toBe("a\\\\b");
  });

  it("chuỗi thường giữ nguyên", () => {
    expect(boKyTuDaiDienIlike("áo thun 01")).toBe("áo thun 01");
  });
});

describe("mauTimKiemIlike", () => {
  it("cắt khoảng trắng, escape rồi bọc %...%", () => {
    expect(mauTimKiemIlike("  AO_THUN  ")).toBe("%AO\\_THUN%");
    expect(mauTimKiemIlike("%")).toBe("%\\%%");
  });
});
