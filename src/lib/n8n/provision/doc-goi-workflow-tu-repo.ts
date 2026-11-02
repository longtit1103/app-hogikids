import historyImport from "../../../../n8n/history-import.json";
import metaAdsNightly from "../../../../n8n/meta-ads-nightly.json";
import pancakeNightly from "../../../../n8n/pancake-nightly.json";
import pancakeSyncNow from "../../../../n8n/pancake-sync-now.json";
import pancakeWebhookKho from "../../../../n8n/pancake-webhook-kho.json";
import pancakeWebhookShopee from "../../../../n8n/pancake-webhook-shopee.json";
import pancakeWebhookTiktok from "../../../../n8n/pancake-webhook-tiktok.json";
import tiktokBusinessNightly from "../../../../n8n/tiktok-business-nightly.json";
import tiktokshopAnalyticsNightly from "../../../../n8n/tiktokshop-analytics-nightly.json";
import tiktokshopNightly from "../../../../n8n/tiktokshop-nightly.json";

import {
  TIEN_TO_PLACEHOLDER_DUONG_DAN,
  ThieuDuongDanWebhook,
  laDuongDanWebhookHopLe,
  vaiTheoPlaceholder,
  type DuongDanWebhookPancake,
} from "./duong-dan-webhook-pancake";

/**
 * Đóng gói 10 workflow từ `n8n/*.json` (import TĨNH — bundle vào build, ảnh Docker standalone
 * không chép thư mục `n8n/`) thành body gửi n8n Public API.
 *
 * Vì sao phải "đóng gói" chứ không gửi nguyên văn:
 *  - Public API chỉ nhận `{name, nodes, connections, settings}` — field lạ là 400.
 *  - `settings` phải whitelist theo schema API (`availableInMCP`/`callerPolicy` là field UI,
 *    gửi lên là 400 tuỳ bản n8n) — NHƯNG file repo vẫn giữ chúng cho đường import tay.
 *  - Credential ref trong repo là placeholder của instance cũ — phải gắn id credential THẬT của
 *    instance đích (mỗi n8n một bộ id riêng).
 *  - Path 3 webhook Pancake trong repo là PLACEHOLDER (`__DUONG_DAN_WEBHOOK_<VAI>__`) — path thật là
 *    dữ liệu của từng instance trong `Setting` (`duong-dan-webhook-pancake.ts`), thay vào lúc đóng gói.
 */

type NodeN8n = {
  type: string;
  name?: string;
  parameters?: { path?: string; authentication?: string };
  credentials?: Record<string, { id: string; name: string }>;
};

type WorkflowTho = {
  name: string;
  nodes: NodeN8n[];
  connections: Record<string, unknown>;
  settings?: Record<string, unknown>;
};

/** File có thể là object hoặc mảng-1-phần-tử (export cũ của n8n) — nhận cả hai cho bền. */
function chuanHoa(raw: unknown): WorkflowTho {
  const w = (Array.isArray(raw) ? raw[0] : raw) as WorkflowTho;
  if (!w?.name || !Array.isArray(w.nodes)) throw new Error("File workflow n8n không đúng shape {name, nodes, ...}");
  return w;
}

export type GoiWorkflow = {
  /** Slug = tên file (không .json) — khoá của map `n8nWorkflowIds` trong Setting. */
  slug: string;
  ten: string;
  /** history-import chạy TAY một lần lúc go-live — không activate. */
  tuDongBat: boolean;
};

const THO: Array<[slug: string, raw: unknown, tuDongBat: boolean]> = [
  ["pancake-sync-now", pancakeSyncNow, true], // PHẢI active: nút "Đồng bộ ngay" gọi webhook của nó
  ["pancake-nightly", pancakeNightly, true],
  ["meta-ads-nightly", metaAdsNightly, true],
  ["tiktok-business-nightly", tiktokBusinessNightly, true],
  ["tiktokshop-nightly", tiktokshopNightly, true],
  // 02:30 — CHỈ ĐỌC token (lượt 02:00 ngay trên mới được refresh: TikTok xoay vòng refresh_token).
  ["tiktokshop-analytics-nightly", tiktokshopAnalyticsNightly, true],
  ["pancake-webhook-kho", pancakeWebhookKho, true],
  ["pancake-webhook-shopee", pancakeWebhookShopee, true],
  ["pancake-webhook-tiktok", pancakeWebhookTiktok, true],
  ["history-import", historyImport, false],
];

export const DANH_SACH_WORKFLOW: GoiWorkflow[] = THO.map(([slug, raw, tuDongBat]) => ({
  slug,
  ten: chuanHoa(raw).name,
  tuDongBat,
}));

function timWebhookPath(raw: unknown): string | null {
  for (const n of chuanHoa(raw).nodes) {
    if (n.type === "n8n-nodes-base.webhook" && n.parameters?.path) return n.parameters.path;
  }
  return null;
}

export const SYNC_NOW_WEBHOOK_PATH = timWebhookPath(pancakeSyncNow) ?? "";

/**
 * Tên header cho khoá webhook "Đồng bộ ngay" (credential httpHeaderAuth do provisioning tạo,
 * giá trị = INGEST_SECRET). `triggerSyncNow()` phải gửi ĐÚNG header này.
 */
export const SYNC_NOW_AUTH_HEADER = "x-hogikids-sync-secret";

/** Key trong `settings` mà Public API chấp nhận — phần còn lại (availableInMCP, callerPolicy…) là field UI. */
const SETTINGS_API_HOP_LE = new Set([
  "executionOrder",
  "timezone",
  "saveManualExecutions",
  "saveExecutionProgress",
  "saveDataErrorExecution",
  "saveDataSuccessExecution",
  "executionTimeout",
  "errorWorkflow",
]);

export type CredentialGan = {
  /** Credential Postgres đọc view SettingN8n — gắn vào MỌI node postgres. */
  postgres: { id: string; name: string };
  /** Credential header auth cho webhook sync-now. */
  headerAuth: { id: string; name: string };
};

export type BodyDaDongGoi = {
  name: string;
  nodes: unknown[];
  connections: Record<string, unknown>;
  settings: Record<string, unknown>;
};

/**
 * `duongDanWebhook` = path thật của instance (đọc từ `Setting` bằng `docDuongDanWebhookBatBuoc`).
 * Placeholder nào không có path hợp lệ tương ứng ⇒ NÉM, tuyệt đối không đóng gói placeholder: n8n sẽ
 * đăng ký đúng chuỗi placeholder làm path, path thật Pancake đang bắn trả 404 (realtime chết câm).
 */
export function dongGoiWorkflow(slug: string, creds: CredentialGan, duongDanWebhook: Partial<DuongDanWebhookPancake>): BodyDaDongGoi {
  const muc = THO.find(([s]) => s === slug);
  if (!muc) throw new Error(`Không có workflow slug "${slug}" trong repo.`);
  const tho = chuanHoa(muc[1]);

  // Clone sâu qua JSON — node sẽ bị sửa credential ref, không được đụng module đã import (cache).
  const nodes = JSON.parse(JSON.stringify(tho.nodes)) as NodeN8n[];
  for (const n of nodes) {
    if (n.type === "n8n-nodes-base.postgres") {
      n.credentials = { postgres: { id: creds.postgres.id, name: creds.postgres.name } };
    }
    // Header auth cho webhook Đồng bộ ngay CHỈ bật ở bản đẩy-qua-API (nơi gắn được credential).
    // File repo cố ý KHÔNG có `authentication` — import TAY (đường dự phòng/prod hiện hành) mà
    // mang headerAuth-không-credential là nút Đồng bộ ngay chết ngay sau import.
    if (n.type === "n8n-nodes-base.webhook" && n.parameters?.path === SYNC_NOW_WEBHOOK_PATH) {
      n.parameters = { ...n.parameters, authentication: "headerAuth" };
      n.credentials = { httpHeaderAuth: { id: creds.headerAuth.id, name: creds.headerAuth.name } };
    }
    if (n.type === "n8n-nodes-base.webhook" && n.parameters?.path) {
      const vai = vaiTheoPlaceholder(n.parameters.path);
      if (vai) {
        const p = duongDanWebhook[vai];
        if (!laDuongDanWebhookHopLe(p)) throw new ThieuDuongDanWebhook([vai]);
        n.parameters = { ...n.parameters, path: p };
      }
    }
  }

  const settings: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(tho.settings ?? {})) {
    if (SETTINGS_API_HOP_LE.has(k)) settings[k] = v;
  }

  const body: BodyDaDongGoi = { name: tho.name, nodes, connections: tho.connections, settings };
  // Lưới cuối: placeholder lọt ở BẤT KỲ đâu trong body (node mới, field khác ngoài `path`) là dừng.
  if (JSON.stringify(body).includes(TIEN_TO_PLACEHOLDER_DUONG_DAN)) {
    throw new Error(`Workflow "${slug}" còn placeholder đường dẫn webhook sau khi đóng gói — không gửi lên n8n.`);
  }
  return body;
}
