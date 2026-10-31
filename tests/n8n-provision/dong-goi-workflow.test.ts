import { describe, expect, it } from "vitest";

import {
  DANH_SACH_WORKFLOW,
  dongGoiWorkflow,
  SYNC_NOW_AUTH_HEADER,
  SYNC_NOW_WEBHOOK_PATH,
  type CredentialGan,
} from "@/lib/n8n/provision/doc-goi-workflow-tu-repo";
import {
  PLACEHOLDER_DUONG_DAN_WEBHOOK,
  ThieuDuongDanWebhook,
  type DuongDanWebhookPancake,
} from "@/lib/n8n/provision/duong-dan-webhook-pancake";

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

/** Path GIẢ (đúng dạng 32 hex) — đứng thay cho giá trị `Setting` của một instance. */
const DUONG_DAN: DuongDanWebhookPancake = {
  kho: "0123456789abcdef0123456789abcdef",
  shopee: "fedcba9876543210fedcba9876543210",
  tiktok: "00112233445566778899aabbccddeeff",
};

type NodeThu = {
  type: string;
  parameters?: { authentication?: string; path?: string };
  credentials?: Record<string, { id: string; name: string }>;
};

describe("dongGoiWorkflow", () => {
  it.each(DANH_SACH_WORKFLOW.map((w) => [w.slug] as const))("%s: body đúng 4 field, settings whitelist, timezone sống sót", (slug) => {
    const body = dongGoiWorkflow(slug, CREDS, DUONG_DAN);

    expect(Object.keys(body).sort()).toEqual(["connections", "name", "nodes", "settings"]);
    // Field UI không được lọt (400 tuỳ bản n8n) — nhưng file repo vẫn giữ chúng cho import tay.
    expect(body.settings).not.toHaveProperty("availableInMCP");
    expect(body.settings).not.toHaveProperty("callerPolicy");
    // Cả 10 file đã có timezone (3 file webhook bổ sung ở lượt chuẩn hoá 21/08; analytics 25/08).
    expect(body.settings.timezone).toBe("Asia/Ho_Chi_Minh");
  });

  it("MỌI node postgres được gắn credential id MỚI (không sót ref instance cũ)", () => {
    for (const w of DANH_SACH_WORKFLOW) {
      const body = dongGoiWorkflow(w.slug, CREDS, DUONG_DAN);
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
    const body = dongGoiWorkflow("pancake-sync-now", CREDS, DUONG_DAN);
    const webhook = (body.nodes as NodeThu[]).find((n) => n.type === "n8n-nodes-base.webhook");
    expect(webhook?.parameters?.authentication).toBe("headerAuth");
    expect(webhook?.credentials?.httpHeaderAuth).toEqual({ id: "hdr-moi-456", name: CREDS.headerAuth.name });
  });

  it("đóng gói KHÔNG làm bẩn module đã import (clone sâu — lượt sau vẫn sạch)", () => {
    const lan1 = dongGoiWorkflow("pancake-nightly", CREDS, DUONG_DAN);
    const lan2 = dongGoiWorkflow("pancake-nightly", { ...CREDS, postgres: { id: "pg-khac", name: "x" } }, DUONG_DAN);
    const pg1 = (lan1.nodes as NodeThu[]).find((n) => n.type === "n8n-nodes-base.postgres");
    const pg2 = (lan2.nodes as NodeThu[]).find((n) => n.type === "n8n-nodes-base.postgres");
    expect(pg1?.credentials?.postgres.id).toBe("pg-moi-123");
    expect(pg2?.credentials?.postgres.id).toBe("pg-khac");
  });

  it("path sync-now vẫn rút từ JSON (không phải secret — có header auth)", () => {
    expect(SYNC_NOW_WEBHOOK_PATH).toBe("hogikids-sync-now");
    expect(SYNC_NOW_AUTH_HEADER.length).toBeGreaterThan(0);
  });

  it("3 webhook Pancake: path = giá trị Setting của ĐÚNG shop, không còn placeholder", () => {
    for (const vai of ["kho", "shopee", "tiktok"] as const) {
      const body = dongGoiWorkflow(`pancake-webhook-${vai}`, CREDS, DUONG_DAN);
      const webhook = (body.nodes as NodeThu[]).find((n) => n.type === "n8n-nodes-base.webhook");
      expect(webhook?.parameters?.path).toBe(DUONG_DAN[vai]);
    }
  });

  it("KHÔNG workflow nào đóng gói ra chuỗi placeholder `__DUONG_DAN_` (n8n sẽ đăng ký nó làm path thật)", () => {
    for (const w of DANH_SACH_WORKFLOW) {
      const body = dongGoiWorkflow(w.slug, CREDS, DUONG_DAN);
      expect(JSON.stringify(body), w.slug).not.toContain("__DUONG_DAN_");
    }
  });

  it("thiếu path của một shop ⇒ NÉM ThieuDuongDanWebhook nêu đúng khoá Setting, không trả body placeholder", () => {
    const thieuShopee = { kho: DUONG_DAN.kho, tiktok: DUONG_DAN.tiktok };
    expect(() => dongGoiWorkflow("pancake-webhook-shopee", CREDS, thieuShopee)).toThrow(ThieuDuongDanWebhook);
    expect(() => dongGoiWorkflow("pancake-webhook-shopee", CREDS, thieuShopee)).toThrow(/n8nWebhookPath\.shopee/);
    // Shop khác không cần path của shopee — vẫn đóng gói được.
    expect(() => dongGoiWorkflow("pancake-webhook-kho", CREDS, thieuShopee)).not.toThrow();
  });

  it("path Setting hỏng (rỗng / có `/` / chính placeholder) ⇒ NÉM, không ghép bừa", () => {
    for (const hong of ["", "a/b-c-d-e-f-g-h-i-j", PLACEHOLDER_DUONG_DAN_WEBHOOK.tiktok]) {
      expect(() => dongGoiWorkflow("pancake-webhook-tiktok", CREDS, { ...DUONG_DAN, tiktok: hong }), JSON.stringify(hong)).toThrow(
        ThieuDuongDanWebhook
      );
    }
  });

  it("đóng gói KHÔNG ghi path vào module đã import — lượt sau với path khác ra path khác", () => {
    const lan1 = dongGoiWorkflow("pancake-webhook-kho", CREDS, DUONG_DAN);
    const lan2 = dongGoiWorkflow("pancake-webhook-kho", CREDS, { ...DUONG_DAN, kho: "abcdefabcdefabcdefabcdefabcdefab" });
    const p1 = (lan1.nodes as NodeThu[]).find((n) => n.type === "n8n-nodes-base.webhook")?.parameters?.path;
    const p2 = (lan2.nodes as NodeThu[]).find((n) => n.type === "n8n-nodes-base.webhook")?.parameters?.path;
    expect(p1).toBe(DUONG_DAN.kho);
    expect(p2).toBe("abcdefabcdefabcdefabcdefabcdefab");
  });

  it("history-import là workflow duy nhất KHÔNG tự bật (chạy tay một lần lúc go-live)", () => {
    const khongBat = DANH_SACH_WORKFLOW.filter((w) => !w.tuDongBat).map((w) => w.slug);
    expect(khongBat).toEqual(["history-import"]);
  });
});
