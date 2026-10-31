import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { KHOA_SETTING_DUONG_DAN_WEBHOOK, VAI_WEBHOOK_PANCAKE } from "@/lib/n8n/provision/duong-dan-webhook-pancake";
import { prisma } from "@/lib/prisma";

/**
 * `scripts/nap-duong-dan-webhook-n8n.ts --nguon=ngau-nhien` chỉ dành cho bản clone MỚI. Chạy nhầm trên bản đang
 * chạy = đổi path dưới chân Pancake (Pancake vẫn bắn path cũ ⇒ 404, realtime chết im). Test chạy CHÍNH script
 * (subprocess, DATABASE_URL trỏ DB test): không chứng minh được "Setting chưa có path và n8n không có webhook đang
 * chạy" ⇒ từ chối, KHÔNG ghi gì; chỉ cờ `--xac-nhan-ban-clone-moi` mới vượt. Không gọi mạng: các ca dưới đều thiếu
 * cấu hình n8n trong Setting nên lượt đọc n8n dừng TRƯỚC mọi request.
 */

const SCRIPT = "scripts/nap-duong-dan-webhook-n8n.ts";
const KHOA_PATH = VAI_WEBHOOK_PANCAKE.map((v) => KHOA_SETTING_DUONG_DAN_WEBHOOK[v]);
const KHOA_N8N = ["n8nBaseUrl", "n8nApiKey", "n8nWorkflowIds"];
const A = "0123456789abcdef0123456789abcdef";

const tenDbTest = (): string => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("thiếu TEST_DATABASE_URL");
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
};

function chayScript(thamSo: string[]): { stdout: string; stderr: string; status: number | null } {
  const kq = spawnSync("./node_modules/.bin/tsx", [SCRIPT, ...thamSo], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
    encoding: "utf8",
    timeout: 60_000,
  });
  if (kq.error) throw kq.error;
  return { stdout: kq.stdout, stderr: kq.stderr, status: kq.status };
}

const docPath = async () =>
  new Map((await prisma.setting.findMany({ where: { key: { in: KHOA_PATH } } })).map((r) => [r.key, r.value]));

let truocFile: Array<{ key: string; value: string }> = [];
beforeAll(async () => {
  truocFile = await prisma.setting.findMany({ where: { key: { in: [...KHOA_PATH, ...KHOA_N8N] } }, select: { key: true, value: true } });
});
beforeEach(async () => {
  await prisma.setting.deleteMany({ where: { key: { in: [...KHOA_PATH, ...KHOA_N8N] } } });
});
afterAll(async () => {
  await prisma.setting.deleteMany({ where: { key: { in: [...KHOA_PATH, ...KHOA_N8N] } } });
  for (const r of truocFile) await prisma.setting.create({ data: r });
});

describe("nap-duong-dan-webhook-n8n.ts --nguon=ngau-nhien: chỉ cho bản clone mới", () => {
  it("Setting ĐÃ có path một shop ⇒ TỪ CHỐI (mã 1), không ghi khoá trống nào, path cũ giữ nguyên", { timeout: 90_000 }, async () => {
    await prisma.setting.create({ data: { key: KHOA_SETTING_DUONG_DAN_WEBHOOK.kho, value: A } });
    const kq = chayScript(["--nguon=ngau-nhien", "--apply", `--xac-nhan-db=${tenDbTest()}`]);
    expect(kq.status, kq.stderr).toBe(1);
    expect(kq.stderr).toMatch(/TỪ CHỐI sinh path ngẫu nhiên/);
    expect(kq.stderr).toMatch(/Setting đã có path cho kho/);
    const sau = await docPath();
    expect([...sau.keys()]).toEqual([KHOA_SETTING_DUONG_DAN_WEBHOOK.kho]);
    expect(sau.get(KHOA_SETTING_DUONG_DAN_WEBHOOK.kho)).toBe(A);
  });

  it("KHÔNG đọc được n8n (thiếu n8nBaseUrl/n8nApiKey — cùng lớp với API key hết hạn) ⇒ TỪ CHỐI, không ghi gì", { timeout: 90_000 }, async () => {
    const kq = chayScript(["--nguon=ngau-nhien", "--apply", `--xac-nhan-db=${tenDbTest()}`]);
    expect(kq.status, kq.stderr).toBe(1);
    expect(kq.stderr).toMatch(/Không đọc được workflow trên n8n/);
    expect((await docPath()).size).toBe(0);
  });

  it("có --xac-nhan-ban-clone-moi ⇒ sinh 3 path 32 hex phân biệt cho khoá trống; không in trọn path", { timeout: 90_000 }, async () => {
    const kq = chayScript(["--nguon=ngau-nhien", "--xac-nhan-ban-clone-moi", "--apply", `--xac-nhan-db=${tenDbTest()}`]);
    expect(kq.status, kq.stderr).toBe(0);
    const sau = await docPath();
    expect(sau.size).toBe(3);
    const cac = [...sau.values()];
    for (const p of cac) {
      expect(p).toMatch(/^[0-9a-f]{32}$/);
      expect(kq.stdout + kq.stderr).not.toContain(p);
    }
    expect(new Set(cac).size).toBe(3);
  });

  it("--xac-nhan-ban-clone-moi đi một mình (không --nguon=ngau-nhien) ⇒ lỗi cờ, không ghi gì", { timeout: 90_000 }, async () => {
    const kq = chayScript(["--xac-nhan-ban-clone-moi", "--apply", `--xac-nhan-db=${tenDbTest()}`]);
    expect(kq.status).toBe(1);
    expect(kq.stderr).toMatch(/chỉ đi cùng --nguon=ngau-nhien/);
    expect((await docPath()).size).toBe(0);
  });
});
