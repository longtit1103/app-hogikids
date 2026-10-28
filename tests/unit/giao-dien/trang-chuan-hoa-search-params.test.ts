import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * `?kenh=a&kenh=b` làm `searchParams.kenh` thành MẢNG lúc chạy. Mọi trang đọc `searchParams` phải
 * chuẩn hoá ngay sau `await` (mảng → phần tử đầu) để tham số lặp không chạm Prisma/`.split`/`.trim`.
 */
const TRANG_CAN_CHUAN_HOA = [
  "page.tsx",
  "bao-cao/page.tsx",
  "marketing/page.tsx",
  "kenh/page.tsx",
  "tai-chinh/page.tsx",
  "tai-chinh/thung-rac/page.tsx",
  "tai-chinh/no-phai-tra/page.tsx",
];

describe("trang đọc searchParams chuẩn hoá tham số lặp", () => {
  const goc = join(__dirname, "..", "..", "..", "src", "app", "(app)");

  it.each(TRANG_CAN_CHUAN_HOA)("%s dùng chuanHoaSearchParams(await searchParams)", (tep) => {
    const nguon = readFileSync(join(goc, tep), "utf8");
    expect(nguon).toMatch(/chuanHoaSearchParams\(await searchParams\)/);
    expect(nguon).not.toMatch(/const sp = await searchParams;/);
  });
});
