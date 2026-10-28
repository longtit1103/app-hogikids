import { readFileSync } from "node:fs";
import path from "node:path";

import type { BillApp } from "@/lib/sao-ke-the/doi-chieu-sao-ke-the";

/** Thư mục fixture sao kê thẻ: text pypdf đã ẩn danh + bill TikTok phía app (PDF thật KHÔNG commit). */
export const THU_MUC_FIXTURE_SAO_KE = path.join(process.cwd(), "tests/fixtures/sao-ke-the");

export function docTextFixture(ten: "techcombank-2026-09-18" | "techcombank-2026-10-20"): string {
  return readFileSync(path.join(THU_MUC_FIXTURE_SAO_KE, `${ten}.txt`), "utf8");
}

/** Bill TikTok app 10/09 → 25/10/2026; `thoiGianVn` "YYYY-MM-DD HH:mm:ss" giờ VN ⇒ ngày = 10 ký tự đầu. */
export function docBillFixture(): BillApp[] {
  const raw = JSON.parse(
    readFileSync(path.join(THU_MUC_FIXTURE_SAO_KE, "app-bills-2026-09-10-den-10-25.json"), "utf8"),
  ) as Array<{ id: string; thoiGianVn: string; soTien: number }>;
  return raw.map((b) => ({ id: b.id, ngay: b.thoiGianVn.slice(0, 10), soTien: b.soTien }));
}
