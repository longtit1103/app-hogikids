import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  MAU_CHI_SO,
  MAU_CHU_DAM,
  MAU_CHU_PHU,
  MAU_KY_TRUOC,
  MAU_NEN_THE,
  MAU_TRANG_THAI,
} from "@/components/trang-chu/mau-trang-chu";

/**
 * HEX trong `mau-trang-chu.ts` (dùng cho thuộc tính SVG/Recharts) phải bằng token `--tq-*` ở `:root` của
 * `globals.css` — đổi một bên mà quên bên kia là màu biểu đồ lệch màu chữ/nhãn xung quanh.
 */
const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

function tokenRoot(ten: string): string {
  const m = css.match(new RegExp(`^\\s*${ten}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`, "m"));
  if (!m) throw new Error(`không thấy token ${ten} (HEX) trong globals.css`);
  return m[1]!.toLowerCase();
}

const BANG: Array<[string, string]> = [
  ["--tq-doanh-so", MAU_CHI_SO.doanhSo],
  ["--tq-chi-phi", MAU_CHI_SO.chiPhi],
  ["--tq-loi-nhuan", MAU_CHI_SO.loiNhuan],
  ["--tq-don", MAU_CHI_SO.donHang],
  ["--tq-thanh-cong", MAU_TRANG_THAI.COMPLETED],
  ["--tq-dang-giao", MAU_TRANG_THAI.SHIPPING],
  ["--tq-cho-xu-ly", MAU_TRANG_THAI.PENDING],
  ["--tq-hoan", MAU_TRANG_THAI.RETURNED],
  ["--tq-huy", MAU_TRANG_THAI.CANCELLED],
  ["--tq-ky-truoc", MAU_KY_TRUOC],
  ["--tq-chu-dam", MAU_CHU_DAM],
  ["--tq-chu-phu", MAU_CHU_PHU],
  ["--tq-the", MAU_NEN_THE],
];

describe("mau-trang-chu ↔ token --tq-* trong globals.css", () => {
  it.each(BANG)("%s khớp HEX", (token, hex) => {
    expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(hex.toLowerCase()).toBe(tokenRoot(token));
  });

  it("không còn chuỗi var(--tq-…) trong thuộc tính SVG của component trang chủ", () => {
    
    const dir = join(process.cwd(), "src/components/trang-chu");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".tsx") || x.endsWith(".ts"))) {
      const src = readFileSync(join(dir, f), "utf8");
      // Cho phép var() trong CSS `style` (background gradient) — chỉ cấm dạng thuộc tính stroke/fill.
      expect(src, f).not.toMatch(/(stroke|fill)(=|:\s*)["{]?\s*["']?var\(--tq/);
    }
  });
});
