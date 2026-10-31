import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { BC_ID_TIKTOK_HOP_LE } from "@/lib/bronze/khuon-bc-id-tiktok";

/**
 * MỘT khuôn bc_id cho kho thô, route dấu lượt, action đánh dấu và CHECK của bảng bền `TiktokBcHoaDon`. Lệch nhau thì BC
 * lọt kho thô (cổng nhớ "từng đọc được") mà không bao giờ đánh dấu "không dùng thẻ" được ⇒ chặn vĩnh viễn.
 */
const MIGRATION = path.resolve(
  __dirname,
  "../../../prisma/migrations/20261031090000_trang_thai_bc_tiktok_hoa_don/migration.sql",
);

describe("khuôn bc_id TikTok dùng chung", () => {
  it("CHECK của bảng bền cùng nghĩa với hằng (6–32 chữ số)", () => {
    expect(BC_ID_TIKTOK_HOP_LE.source).toBe("^\\d{6,32}$");
    expect(readFileSync(MIGRATION, "utf8")).toContain(`CHECK ("bcId" ~ '^[0-9]{6,32}$')`);
  });

  it.each([
    ["19 chữ số thật", "7129545797879726081", true],
    ["6 chữ số", "123456", true],
    ["32 chữ số", "1".repeat(32), true],
    ["5 chữ số", "12345", false],
    ["33 chữ số", "1".repeat(33), false],
    ["có chữ", "71295457978797260a1", false],
  ])("%s", (_ten, id, hopLe) => {
    expect(BC_ID_TIKTOK_HOP_LE.test(id)).toBe(hopLe);
  });

  it("kho thô (land-raw) dùng đúng hằng cho stream hoá đơn + chi phí BC, không tự viết khuôn riêng", () => {
    const src = readFileSync(path.resolve(__dirname, "../../../src/lib/bronze/land-raw.ts"), "utf8");
    expect(src).toMatch(/"tiktokbusiness\/invoice": \{ re: BC_ID_TIKTOK_HOP_LE,/);
    expect(src).toMatch(/"tiktokbusiness\/cost": \{ re: BC_ID_TIKTOK_HOP_LE,/);
  });
});
