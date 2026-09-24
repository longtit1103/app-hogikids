/**
 * Client n8n Public API (v1) — CHỈ các endpoint core mà provisioning cần. Tự viết REST thay vì
 * đi qua MCP: bản MCP từng dính bug activate (415) và PUT làm mất `settings` (cron sai giờ,
 * 2026-08-01) — REST trực tiếp thì mình kiểm soát đúng body gửi đi và đọc lại được sau ghi.
 *
 * Giới hạn API đã xác minh 21/08 (docs.n8n.io/api): create workflow LUÔN ra inactive (activate là
 * lệnh riêng); KHÔNG có GET /credentials (không liệt kê/tra credential được — vì thế id credential
 * phải lưu ở bảng `Setting`); GET /workflows không lọc theo tên và phân trang bằng cursor.
 *
 * Bất biến: message lỗi ném ra KHÔNG chứa API key hay body response thô (có thể theo err hiện lên
 * UI qua ActionResult).
 */

import { laChuyenHuong, lyDoTuChoiDichN8n } from "@/lib/n8n/kiem-dich-den-n8n";

export type N8nClient = { base: string; apiKey: string };

const TIMEOUT_MS = 15_000;

export function taoN8nClient(baseUrl: string, apiKey: string): N8nClient {
  // Chốt chặn cuối trước khi địa chỉ này thành đích fetch kèm secret. Action đã validate lúc lưu,
  // nhưng kho khoá còn sửa được bằng tay/qua bản phục hồi nên đường code phải tự gác lần nữa.
  const lyDo = lyDoTuChoiDichN8n(baseUrl);
  if (lyDo) throw new Error(`n8n URL ${lyDo}.`);
  const url = new URL(baseUrl);
  return { base: `${url.origin}${url.pathname.replace(/\/+$/, "")}`, apiKey };
}

async function goi<T>(client: N8nClient, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${client.base}/api/v1${path}`, {
      method,
      headers: {
        "X-N8N-API-KEY": client.apiKey,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      // KHÔNG đi theo chuyển hướng: n8n Public API không bao giờ 3xx, nên một lượt 3xx hoặc là cấu
      // hình sai, hoặc là đích đang lái request (kèm API key ở header) sang nơi khác. Kiểm địa chỉ
      // lúc gọi không bảo vệ được chặng SAU redirect — đây mới là chỗ bịt.
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Error(`Không kết nối được n8n (${method} ${path}) — kiểm tra n8n URL và n8n có đang chạy không.`);
  }
  if (laChuyenHuong(res.status)) {
    throw new Error(
      `n8n URL trả chuyển hướng (HTTP ${res.status}) cho ${method} ${path} — đã DỪNG, không đi theo. ` +
        "Kiểm tra lại địa chỉ n8n: API của n8n không bao giờ chuyển hướng.",
    );
  }
  if (res.status === 401) throw new Error("n8n từ chối API key (401) — kiểm tra lại key ở n8n Settings → n8n API.");
  if (res.status === 404) throw new KhongTimThay(`n8n không có tài nguyên ${path} (404).`);
  if (!res.ok) {
    // KHÔNG nhét body thô vào message (dài + có thể chứa dữ liệu nhạy) — mã trạng thái là đủ để lần.
    throw new Error(`n8n trả lỗi HTTP ${res.status} cho ${method} ${path}.`);
  }
  return (await res.json()) as T;
}

/** 404 tách riêng: provisioning phân biệt "workflow id đã lưu nhưng bị xoá bên n8n" với lỗi khác. */
export class KhongTimThay extends Error {}

export type WorkflowTomTat = { id: string; name: string; active: boolean };

/** Liệt kê TOÀN BỘ workflow — phân trang cursor cho tới hết (mặc định n8n trả 100/trang). */
export async function listWorkflows(client: N8nClient): Promise<WorkflowTomTat[]> {
  const tatCa: WorkflowTomTat[] = [];
  let cursor: string | undefined;
  const daThayCursor = new Set<string>();
  // Trần 50 trang (5.000 workflow) + chặn cursor lặp: server trả cursor hỏng không được kéo
  // client vào vòng lặp vô hạn trong một server action.
  for (let trang = 0; trang < 50; trang++) {
    const q = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : "?limit=100";
    const kq = await goi<{ data: WorkflowTomTat[]; nextCursor?: string | null }>(client, "GET", `/workflows${q}`);
    tatCa.push(...kq.data);
    cursor = kq.nextCursor ?? undefined;
    if (!cursor || daThayCursor.has(cursor)) return tatCa;
    daThayCursor.add(cursor);
  }
  return tatCa;
}

export type WorkflowDayDu = {
  id: string;
  name: string;
  active: boolean;
  nodes: unknown[];
  connections: Record<string, unknown>;
  settings?: Record<string, unknown>;
};

export async function getWorkflow(client: N8nClient, id: string): Promise<WorkflowDayDu | null> {
  try {
    return await goi<WorkflowDayDu>(client, "GET", `/workflows/${encodeURIComponent(id)}`);
  } catch (e) {
    if (e instanceof KhongTimThay) return null;
    throw e;
  }
}

export type BodyWorkflow = {
  name: string;
  nodes: unknown[];
  connections: Record<string, unknown>;
  settings: Record<string, unknown>;
};

export function createWorkflow(client: N8nClient, body: BodyWorkflow): Promise<WorkflowDayDu> {
  return goi<WorkflowDayDu>(client, "POST", "/workflows", body);
}

export function updateWorkflow(client: N8nClient, id: string, body: BodyWorkflow): Promise<WorkflowDayDu> {
  return goi<WorkflowDayDu>(client, "PUT", `/workflows/${encodeURIComponent(id)}`, body);
}

export function activateWorkflow(client: N8nClient, id: string): Promise<unknown> {
  return goi(client, "POST", `/workflows/${encodeURIComponent(id)}/activate`);
}

export function deactivateWorkflow(client: N8nClient, id: string): Promise<unknown> {
  return goi(client, "POST", `/workflows/${encodeURIComponent(id)}/deactivate`);
}

export function createCredential(
  client: N8nClient,
  cred: { name: string; type: string; data: Record<string, unknown> }
): Promise<{ id: string }> {
  return goi<{ id: string }>(client, "POST", "/credentials", cred);
}

export function deleteCredential(client: N8nClient, id: string): Promise<unknown> {
  return goi(client, "DELETE", `/credentials/${encodeURIComponent(id)}`);
}
