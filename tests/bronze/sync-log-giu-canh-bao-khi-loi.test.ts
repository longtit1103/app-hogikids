import { describe, expect, it } from "vitest";

import { withSyncLog } from "@/lib/ingest/sync-log";
import { prisma } from "@/lib/prisma";

/**
 * Lượt HỎNG mới đúng là lượt cần chẩn đoán nhất, nên cảnh báo đã thu được PHẢI sống sót qua nhánh
 * lỗi. Trước đây nhánh này chỉ ghi `error`, nên một thông báo kiểu "xem cảnh báo trong cùng lượt
 * này" trỏ tới chỗ không tồn tại — không ai biết đơn nào hỏng hay vì sao.
 */
describe("withSyncLog — nhánh lỗi", () => {
  it("giữ nguyên warnings đã thu được vào SyncLog và thân trả về", async () => {
    const res = await withSyncLog("PANCAKE", async (warnings) => {
      warnings.push("đơn ORD-X: không dựng được vì X");
      warnings.push("đơn ORD-Y: không dựng được vì Y");
      throw new Error("DB sập giữa chừng");
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("DB sập");
    expect(body.stats.warnings).toHaveLength(2);
    expect(body.stats.warnings[0]).toContain("ORD-X");

    const log = await prisma.syncLog.findFirstOrThrow({ orderBy: { startedAt: "desc" } });
    expect(log.status).toBe("ERROR");
    expect((log.stats as { warnings: string[] }).warnings).toHaveLength(2);
    await prisma.syncLog.delete({ where: { id: log.id } });
  });
});
