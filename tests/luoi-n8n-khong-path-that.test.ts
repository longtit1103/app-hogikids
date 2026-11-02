import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PLACEHOLDER_DUONG_DAN_WEBHOOK, VAI_WEBHOOK_PANCAKE } from "@/lib/n8n/provision/duong-dan-webhook-pancake";

/**
 * Lưới: path THẬT của webhook Pancake không được quay lại cây `n8n/`.
 *
 * 3 webhook Pancake không có xác thực — path là thứ duy nhất làm URL khó đoán, và sự kiện `orders`
 * bơm vào đó đi thẳng tới doanh thu/P&L. Path thật là dữ liệu của instance (`Setting`
 * `n8nWebhookPath.<vai>`); file JSON chỉ mang placeholder. Ai export workflow từ n8n rồi chép đè
 * file repo (đường quen tay nhất) là path thật quay lại — lưới này đỏ đúng lúc đó.
 */

const THU_MUC_N8N = path.resolve(__dirname, "..", "n8n");
const PATH_DANG_THAT = /^[0-9a-f]{32}$/;

/** Mọi giá trị của khoá `path` ở BẤT KỲ độ sâu nào (node webhook có thể dời chỗ giữa các bản n8n). */
function moiGiaTriPath(x: unknown, ra: string[] = []): string[] {
  if (Array.isArray(x)) {
    for (const p of x) moiGiaTriPath(p, ra);
  } else if (x && typeof x === "object") {
    for (const [k, v] of Object.entries(x)) {
      if (k === "path" && typeof v === "string") ra.push(v);
      moiGiaTriPath(v, ra);
    }
  }
  return ra;
}

const fileJson = readdirSync(THU_MUC_N8N).filter((f) => f.endsWith(".json"));

describe("lưới n8n/: không path webhook thật trong repo", () => {
  it("tìm thấy file workflow để soi (lưới không được xanh vì đọc nhầm thư mục rỗng)", () => {
    expect(fileJson).toEqual(expect.arrayContaining(VAI_WEBHOOK_PANCAKE.map((v) => `pancake-webhook-${v}.json`)));
  });

  it.each(fileJson)('%s: không giá trị "path" nào có dạng 32 hex', (f) => {
    const ds = moiGiaTriPath(JSON.parse(readFileSync(path.join(THU_MUC_N8N, f), "utf8")));
    const that = ds.filter((p) => PATH_DANG_THAT.test(p));
    // KHÔNG in giá trị khớp ra thông điệp lỗi: log CI là nơi công khai.
    expect(that.length, `${f} mang ${that.length} path dạng 32 hex — thay bằng placeholder __DUONG_DAN_WEBHOOK_<VAI>__`).toBe(0);
  });

  it.each(VAI_WEBHOOK_PANCAKE)("pancake-webhook-%s.json: node webhook mang ĐÚNG placeholder của shop đó", (vai) => {
    const raw = JSON.parse(readFileSync(path.join(THU_MUC_N8N, `pancake-webhook-${vai}.json`), "utf8")) as unknown;
    const wf = (Array.isArray(raw) ? raw[0] : raw) as { nodes: Array<{ type: string; parameters?: { path?: string } }> };
    const webhook = wf.nodes.filter((n) => n.type === "n8n-nodes-base.webhook");
    expect(webhook).toHaveLength(1);
    expect(webhook[0].parameters?.path).toBe(PLACEHOLDER_DUONG_DAN_WEBHOOK[vai]);
  });

  it("không file nào trong n8n/ (JSON lẫn hướng dẫn) chứa URL `/webhook/<32 hex>`", () => {
    const loi: string[] = [];
    for (const f of readdirSync(THU_MUC_N8N)) {
      if (!/\.(json|md)$/.test(f)) continue;
      const txt = readFileSync(path.join(THU_MUC_N8N, f), "utf8");
      if (/\/webhook\/[0-9a-f]{32}(?![0-9a-f])/.test(txt)) loi.push(f);
    }
    expect(loi).toEqual([]);
  });
});
