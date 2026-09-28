import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DANH_SACH_WORKFLOW } from "@/lib/n8n/provision/doc-goi-workflow-tu-repo";
import { provisionN8n } from "@/lib/n8n/provision/provision-n8n";
import { prisma } from "@/lib/prisma";

/**
 * ĐƯỜNG GHI của lượt "Cài / cập nhật workflows" — các cổng sống còn theo plan:
 * happy-path tạo mới end-to-end (kèm probe), đọc-lại-timezone-lệch ⇒ loi, trùng tên ⇒ dừng dòng,
 * id map trỏ tên khác ⇒ dừng dòng, backup-fail ⇒ KHÔNG PUT, và secret không lọt vào message lỗi.
 * n8n giả bằng mock fetch có "kho" workflow trong bộ nhớ; DB là DB test thật.
 */

const KEYS = [
  "n8nBaseUrl", "n8nApiKey", "n8nAppUrl", "n8nIngestSecret", "n8nCredentialId",
  "n8nHeaderCredentialId", "n8nWorkflowIds", "n8nCredPgHash", "n8nSyncNowSecret",
  "n8nDbHost", "n8nDbPort", "n8nDbName", "n8nDbUser", "n8nDbSsl", "n8nDbRoPassword",
];

async function ghi(key: string, value: string) {
  await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

async function seedCauHinhDu() {
  await ghi("n8nBaseUrl", "http://n8n-test:5678");
  await ghi("n8nApiKey", "key-test");
  await ghi("n8nDbHost", "db-test");
  await ghi("n8nDbName", "postgres");
  await ghi("n8nDbRoPassword", "mat-khau-ro");
}

type WorkflowLuu = { id: string; name: string; active: boolean; nodes: unknown[]; connections: unknown; settings: Record<string, unknown> };

/**
 * n8n giả: đủ hành vi mà orchestrator dựa vào (create trả bản ghi, đọc lại trả settings đã lưu,
 * activate lật cờ). `bienDang` cho từng test bẻ một hành vi (vd nuốt timezone).
 */
function dungN8nGia(opts: { coSan?: WorkflowLuu[]; bienDang?: (w: WorkflowLuu) => void; onWebhook?: () => Promise<void> } = {}) {
  const kho = new Map<string, WorkflowLuu>((opts.coSan ?? []).map((w) => [w.id, w]));
  let dem = 0;
  const daGoi: string[] = [];
  const fetchGia = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    daGoi.push(`${method} ${u.replace("http://n8n-test:5678", "")}`);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

    if (u.includes("/webhook/")) {
      await opts.onWebhook?.();
      return json({ ok: true });
    }
    if (u.includes("/api/v1/credentials")) return json({ id: `cred-${++dem}` });
    if (u.includes("/api/v1/workflows")) {
      const mId = u.match(/\/api\/v1\/workflows\/([^/?]+)(\/(de)?activate)?$/);
      if (!mId && method === "GET") return json({ data: [...kho.values()].map(({ id, name, active }) => ({ id, name, active })), nextCursor: null });
      if (!mId && method === "POST") {
        const body = JSON.parse(String(init?.body)) as Omit<WorkflowLuu, "id" | "active">;
        const w: WorkflowLuu = { id: `wf-${++dem}`, active: false, ...body };
        opts.bienDang?.(w);
        kho.set(w.id, w);
        return json(w);
      }
      if (mId) {
        const id = decodeURIComponent(mId[1]);
        const w = kho.get(id);
        if (!w) return json({}, 404);
        if (mId[2] === "/activate") { w.active = true; return json(w); }
        if (mId[2] === "/deactivate") { w.active = false; return json(w); }
        if (method === "PUT") {
          const body = JSON.parse(String(init?.body)) as Omit<WorkflowLuu, "id" | "active">;
          Object.assign(w, body);
          opts.bienDang?.(w);
          return json(w);
        }
        return json(w);
      }
    }
    return json({}, 500);
  });
  vi.stubGlobal("fetch", fetchGia);
  return { kho, daGoi };
}

beforeEach(async () => {
  await prisma.setting.deleteMany({ where: { key: { in: KEYS } } });
  await prisma.n8nWorkflowBackup.deleteMany();
  await prisma.syncLog.deleteMany({ where: { kind: "PANCAKE" } });
  process.env.APP_INTERNAL_URL = "http://app-test:3000";
  process.env.INGEST_SECRET = "ingest-secret-test";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.APP_INTERNAL_URL;
});

describe("provisionN8n — đường ghi", () => {
  it("n8n sạch: tạo đủ 10 workflow + 2 credential, 9 active, map id ghi vào Setting, probe xanh", { timeout: 30_000 }, async () => {
    await seedCauHinhDu();
    const { kho } = dungN8nGia({
      onWebhook: async () => {
        // Webhook sync-now "chạy": app nhận trang đầu ⇒ có SyncLog PANCAKE mới — probe phải thấy.
        await prisma.syncLog.create({ data: { kind: "PANCAKE", status: "OK", startedAt: new Date(), finishedAt: new Date() } });
      },
    });

    const kq = await provisionN8n();

    expect(kq.rows).toHaveLength(DANH_SACH_WORKFLOW.length);
    expect(kq.rows.filter((r) => r.hanhDong === "tao")).toHaveLength(DANH_SACH_WORKFLOW.length);
    expect(kq.rows.filter((r) => r.active)).toHaveLength(DANH_SACH_WORKFLOW.length - 1); // trừ history-import
    expect(kq.probe.ok).toBe(true);
    expect(kho.size).toBe(DANH_SACH_WORKFLOW.length);

    const map = JSON.parse((await prisma.setting.findUniqueOrThrow({ where: { key: "n8nWorkflowIds" } })).value) as Record<string, string>;
    expect(Object.keys(map).sort()).toEqual(DANH_SACH_WORKFLOW.map((w) => w.slug).sort());
    // Khoá webhook là khoá RIÊNG app sinh — không phải INGEST_SECRET.
    const syncSecret = await prisma.setting.findUniqueOrThrow({ where: { key: "n8nSyncNowSecret" } });
    expect(syncSecret.value).not.toBe("ingest-secret-test");
  });

  it("n8n nuốt settings.timezone sau khi ghi → dòng đó LOI, không báo ✓ (lớp lỗi cron-sai-giờ 01/08)", { timeout: 30_000 }, async () => {
    await seedCauHinhDu();
    dungN8nGia({ bienDang: (w) => { delete w.settings.timezone; } });

    const kq = await provisionN8n();

    // Mọi workflow có timezone trong body (cả 10) đều phải bị đánh LOI.
    expect(kq.rows.every((r) => r.hanhDong === "loi" && /timezone/.test(r.loi ?? ""))).toBe(true);
    expect(kq.probe.ok).toBe(false);
  });

  it("n8n có 2 workflow TRÙNG TÊN với bản của app → dòng đó dừng, không đoán, không PUT", { timeout: 30_000 }, async () => {
    await seedCauHinhDu();
    const ten = DANH_SACH_WORKFLOW[0].ten;
    const { daGoi } = dungN8nGia({
      coSan: [
        { id: "cu-1", name: ten, active: true, nodes: [], connections: {}, settings: {} },
        { id: "cu-2", name: ten, active: false, nodes: [], connections: {}, settings: {} },
      ],
    });

    const kq = await provisionN8n();

    const dong = kq.rows.find((r) => r.ten === ten);
    expect(dong?.hanhDong).toBe("loi");
    expect(dong?.loi).toContain("cùng tên");
    expect(daGoi.some((c) => c.startsWith("PUT") && (c.includes("cu-1") || c.includes("cu-2")))).toBe(false);
  });

  it("id map trỏ workflow TÊN KHÁC → dừng dòng đó, TUYỆT ĐỐI không PUT đè (bản clone/DR mang map lạ)", { timeout: 30_000 }, async () => {
    await seedCauHinhDu();
    const slug0 = DANH_SACH_WORKFLOW[0].slug;
    await ghi("n8nWorkflowIds", JSON.stringify({ [slug0]: "wf-cua-nguoi-khac" }));
    const { daGoi } = dungN8nGia({
      coSan: [{ id: "wf-cua-nguoi-khac", name: "Workflow riêng của chủ n8n", active: true, nodes: [], connections: {}, settings: {} }],
    });

    const kq = await provisionN8n();

    const dong = kq.rows.find((r) => r.slug === slug0);
    expect(dong?.hanhDong).toBe("loi");
    expect(dong?.loi).toContain("đang trỏ workflow tên");
    expect(daGoi.some((c) => c.startsWith("PUT") && c.includes("wf-cua-nguoi-khac"))).toBe(false);
  });

  it("backup ghi THẤT BẠI → bỏ workflow đó, KHÔNG PUT (backup là cổng chặn, không phải best-effort)", { timeout: 30_000 }, async () => {
    await seedCauHinhDu();
    const wf0 = DANH_SACH_WORKFLOW[0];
    await ghi("n8nWorkflowIds", JSON.stringify({ [wf0.slug]: "wf-dang-chay" }));
    const { daGoi } = dungN8nGia({
      coSan: [{ id: "wf-dang-chay", name: wf0.ten, active: true, nodes: [], connections: {}, settings: {} }],
    });
    vi.spyOn(prisma.n8nWorkflowBackup, "create").mockRejectedValue(new Error("DB chập"));

    const kq = await provisionN8n();

    const dong = kq.rows.find((r) => r.slug === wf0.slug);
    expect(dong?.hanhDong).toBe("loi");
    expect(dong?.loi).toContain("backup");
    expect(daGoi.some((c) => c.startsWith("PUT") && c.includes("wf-dang-chay"))).toBe(false);
  });

  it("lỗi Prisma khi ghi kho khoá KHÔNG nhại secret vào message (message Prisma chứa giá trị đang ghi)", { timeout: 30_000 }, async () => {
    await seedCauHinhDu();
    dungN8nGia();
    vi.spyOn(prisma.setting, "upsert").mockRejectedValueOnce(new Error("Invalid value: SECRET-LO-123"));

    const loi = await provisionN8n().then(
      () => null,
      (e: unknown) => (e instanceof Error ? e.message : String(e))
    );
    expect(loi).toMatch(/Lỗi khi ghi kho khoá/);
    expect(loi).not.toContain("SECRET-LO-123");
  });
});
