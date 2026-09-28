import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { VAT_MAC_DINH, VAT_META } from "@/lib/ingest/ads-report-mapping";

/**
 * Thuế suất ads được khai ở HAI nơi và phải luôn bằng nhau:
 *   - n8n (`CONFIG.vatRate` Meta, `VAT_MAC_DINH` TikTok) — dùng cho lượt ghi mỗi đêm.
 *   - app (`VAT_META`, `VAT_MAC_DINH`) — dùng cho lượt dựng lại từ kho thô.
 *
 * Trôi khỏi nhau = hỏng ÂM THẦM: lượt đêm ghi theo thuế mới, lượt dựng lại ghi đè bằng
 * thuế cũ, `Expense.amount` đổi số mà không ai được báo. Kiểm này là chốt chặn: đổi thuế
 * ở n8n mà quên đổi ở app (hoặc ngược lại) thì test đỏ ngay, buộc sửa cả hai.
 *
 * Đọc file JSON dạng văn bản vì thuế nằm trong chuỗi `jsCode` của node Code — parse JS ra
 * để lấy giá trị sẽ giòn hơn nhiều so với tìm đúng chuỗi khai báo.
 */
function docWorkflow(ten: string): string {
  return readFileSync(path.join(process.cwd(), "n8n", ten), "utf8");
}

describe("thuế suất ads — app phải khớp n8n", () => {
  it("Meta: CONFIG.vatRate trong workflow bằng VAT_META của app", () => {
    const workflow = docWorkflow("meta-ads-nightly.json");
    // Trong JSON, jsCode escape dấu nháy kép ⇒ chuỗi thật là: vatRate: \"0.10\"
    const khai = workflow.match(/vatRate:\s*\\"([\d.]+)\\"/);
    expect(khai, "không tìm thấy khai báo CONFIG.vatRate trong meta-ads-nightly.json").not.toBeNull();
    expect(Number(khai![1])).toBe(VAT_META);
  });

  it("TikTok: VAT_MAC_DINH trong workflow bằng VAT_MAC_DINH của app", () => {
    const workflow = docWorkflow("tiktok-business-nightly.json");
    const khai = workflow.match(/VAT_MAC_DINH\s*=\s*([\d.]+)/);
    expect(khai, "không tìm thấy khai báo VAT_MAC_DINH trong tiktok-business-nightly.json").not.toBeNull();
    expect(Number(khai![1])).toBe(VAT_MAC_DINH);
  });
});
