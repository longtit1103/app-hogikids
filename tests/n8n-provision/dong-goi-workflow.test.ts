import { describe, expect, it } from "vitest";

import {
  DANH_SACH_WORKFLOW,
  dongGoiWorkflow,
  SYNC_NOW_AUTH_HEADER,
  SYNC_NOW_WEBHOOK_PATH,
  WEBHOOK_PANCAKE_PATH,
  type CredentialGan,
} from "@/lib/n8n/provision/doc-goi-workflow-tu-repo";

/**
 * Đóng gói 10 workflow từ repo → body gửi n8n Public API. Khoá 3 hợp đồng sống còn:
 * body chỉ có 4 field API nhận; `settings` được whitelist (field UI như availableInMCP gửi lên là
 * 400) NHƯNG timezone phải SỐNG SÓT (mất là cron sai giờ — lớp lỗi 01/08); credential ref của
 * instance cũ phải bị thay bằng id của instance đích trên MỌI node cần credential.
 */

const CREDS: CredentialGan = {
  postgres: { id: "pg-moi-123", name: "hogikids-config-ro (bảng Setting)" },
  headerAuth: { id: "hdr-moi-456", name: "hogikids-sync-now (header auth)" },
};

type NodeThu = {
  type: string;
  parameters?: { authentication?: string };
  credentials?: Record<string, { id: string; name: string }>;
};

describe("dongGoiWorkflow", () => {
  it.each(DANH_SACH_WORKFLOW.map((w) => [w.slug] as const))("%s: body đúng 4 field, settings whitelist, timezone sống sót", (slug) => {
    const body = dongGoiWorkflow(slug, CREDS);

    expect(Object.keys(body).sort()).toEqual(["connections", "name", "nodes", "settings"]);
    // Field UI không được lọt (400 tuỳ bản n8n) — nhưng file repo vẫn giữ chúng cho import tay.
    expect(body.settings).not.toHaveProperty("availableInMCP");
    expect(body.settings).not.toHaveProperty("callerPolicy");
    // Cả 10 file đã có timezone (3 file webhook bổ sung ở lượt chuẩn hoá 21/08; analytics 25/08).
    expect(body.settings.timezone).toBe("Asia/Ho_Chi_Minh");
  });

  it("MỌI node postgres được gắn credential id MỚI (không sót ref instance cũ)", () => {
    for (const w of DANH_SACH_WORKFLOW) {
      const body = dongGoiWorkflow(w.slug, CREDS);
      for (const n of body.nodes as NodeThu[]) {
        if (n.type === "n8n-nodes-base.postgres") {
          expect(n.credentials?.postgres, `${w.slug} có node postgres chưa gắn credential`).toEqual({
            id: "pg-moi-123",
            name: CREDS.postgres.name,
          });
        }
      }
    }
  });

  it("webhook Đồng bộ ngay: headerAuth + credential httpHeaderAuth được gắn", () => {
    const body = dongGoiWorkflow("pancake-sync-now", CREDS);
    const webhook = (body.nodes as NodeThu[]).find((n) => n.type === "n8n-nodes-base.webhook");
    expect(webhook?.parameters?.authentication).toBe("headerAuth");
    expect(webhook?.credentials?.httpHeaderAuth).toEqual({ id: "hdr-moi-456", name: CREDS.headerAuth.name });
  });

  it("đóng gói KHÔNG làm bẩn module đã import (clone sâu — lượt sau vẫn sạch)", () => {
    const lan1 = dongGoiWorkflow("pancake-nightly", CREDS);
    const lan2 = dongGoiWorkflow("pancake-nightly", { ...CREDS, postgres: { id: "pg-khac", name: "x" } });
    const pg1 = (lan1.nodes as NodeThu[]).find((n) => n.type === "n8n-nodes-base.postgres");
    const pg2 = (lan2.nodes as NodeThu[]).find((n) => n.type === "n8n-nodes-base.postgres");
    expect(pg1?.credentials?.postgres.id).toBe("pg-moi-123");
    expect(pg2?.credentials?.postgres.id).toBe("pg-khac");
  });

  it("path webhook đọc từ JSON — có đủ 3 vai + sync-now (URL hiển thị không được bịa tay)", () => {
    expect(WEBHOOK_PANCAKE_PATH.kho).not.toBe("");
    expect(WEBHOOK_PANCAKE_PATH.shopee).not.toBe("");
    expect(WEBHOOK_PANCAKE_PATH.tiktok).not.toBe("");
    expect(SYNC_NOW_WEBHOOK_PATH).toBe("hogikids-sync-now");
    expect(SYNC_NOW_AUTH_HEADER.length).toBeGreaterThan(0);
  });

  it("history-import là workflow duy nhất KHÔNG tự bật (chạy tay một lần lúc go-live)", () => {
    const khongBat = DANH_SACH_WORKFLOW.filter((w) => !w.tuDongBat).map((w) => w.slug);
    expect(khongBat).toEqual(["history-import"]);
  });
});
