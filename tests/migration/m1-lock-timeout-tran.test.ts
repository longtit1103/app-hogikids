import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Trần `lock_timeout` của M1 (migration phân quyền). Test hành vi `(e)` ở `m1-nguyen-tu` chỉ chứng minh
 * M1 dừng TRƯỚC khi khoá giữ 45s tự nhả — nâng hạn lên 44s vẫn xanh, trong khi mỗi giây chờ là một
 * giây MỌI truy vấn "User" xếp hàng sau `ALTER TABLE` (app đứng hình nếu lỡ chưa dừng). Khoá bằng số:
 * hạn ≤ 20s, đặt đúng MỘT lần, bằng `SET LOCAL` sau `BEGIN;` và trước câu đầu tiên đụng "User".
 */
const M1 = path.resolve(
  process.cwd(),
  "prisma/migrations/20260930170000_tai_khoan_phu_phan_quyen/migration.sql",
);
const TRAN_GIAY = 20;

describe("M1 — lock_timeout có trần", () => {
  // Bỏ chú thích `--` (chú thích của M1 có nhắc `ALTER TABLE "User"` — không phải câu lệnh).
  const sql = readFileSync(M1, "utf8").replace(/--[^\n]*/g, "");
  const cau = [...sql.matchAll(/^\s*SET\s+LOCAL\s+lock_timeout\s*=\s*'(\d+)(ms|s)?'\s*;/gim)];

  it(`đặt đúng một lần, ≤ ${TRAN_GIAY}s`, () => {
    expect(cau).toHaveLength(1);
    const [, so, donVi] = cau[0];
    const giay = donVi?.toLowerCase() === "ms" ? Number(so) / 1000 : donVi ? Number(so) : Number(so) / 1000;
    expect(giay).toBeGreaterThan(0);
    expect(giay).toBeLessThanOrEqual(TRAN_GIAY);
  });

  it("nằm sau BEGIN; và trước câu đầu tiên ALTER TABLE \"User\"", () => {
    const viTri = cau[0].index ?? -1;
    const begin = sql.search(/^BEGIN;/m);
    const alterUser = sql.search(/ALTER\s+TABLE\s+"User"/);
    expect(begin).toBeGreaterThan(-1);
    expect(alterUser).toBeGreaterThan(-1);
    expect(viTri).toBeGreaterThan(begin);
    expect(viTri).toBeLessThan(alterUser);
  });
});
