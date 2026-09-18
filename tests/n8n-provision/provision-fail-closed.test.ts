import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CanXacNhanDoiHaTang, provisionN8n } from "@/lib/n8n/provision/provision-n8n";
import { prisma } from "@/lib/prisma";

/**
 * Fail-closed của lượt "Cài / cập nhật workflows" — các cửa DỪNG phải dừng ĐÚNG CHỖ:
 *  - thiếu cấu hình ⇒ chưa gửi gì đi đâu;
 *  - khóa hạ tầng sắp bị đổi ⇒ đòi xác nhận, chưa ghi;
 *  - credential tạo LỖI ⇒ TUYỆT ĐỐI không có PUT/POST workflow nào (đè workflow trỏ credential
 *    không tồn tại = 10 workflow mất quyền đọc kho khoá, chết câm).
 * DB là DB test thật (Setting); n8n được giả bằng mock fetch — đếm từng request bắn ra.
 */

const KEYS = [
  "n8nBaseUrl", "n8nApiKey", "n8nAppUrl", "n8nIngestSecret", "n8nCredentialId",
  "n8nHeaderCredentialId", "n8nWorkflowIds", "n8nDbHost", "n8nDbPort", "n8nDbName",
  "n8nDbUser", "n8nDbSsl", "n8nDbRoPassword",
];

async function ghi(key: string, value: string) {
  await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

beforeEach(async () => {
  await prisma.setting.deleteMany({ where: { key: { in: KEYS } } });
  process.env.APP_INTERNAL_URL = "http://app-test:3000";
  process.env.INGEST_SECRET = "secret-test";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.APP_INTERNAL_URL;
});

describe("provisionN8n — các cửa dừng", () => {
  it("chưa lưu n8n URL/API key → dừng ngay, KHÔNG bắn request nào", async () => {
    const fetchGia = vi.fn();
    vi.stubGlobal("fetch", fetchGia);
    await expect(provisionN8n()).rejects.toThrow(/Chưa lưu n8n URL/);
    expect(fetchGia).not.toHaveBeenCalled();
  });

  it("thiếu env APP_INTERNAL_URL → lỗi nêu đúng tên env (fail-closed, không default mò)", async () => {
    await ghi("n8nBaseUrl", "http://n8n-test:5678");
    await ghi("n8nApiKey", "key-test");
    delete process.env.APP_INTERNAL_URL;
    const fetchGia = vi.fn();
    vi.stubGlobal("fetch", fetchGia);
    await expect(provisionN8n()).rejects.toThrow(/APP_INTERNAL_URL/);
    expect(fetchGia).not.toHaveBeenCalled();
  });

  it("khóa hạ tầng trong kho KHÁC env → đòi xác nhận, CHƯA ghi đè", async () => {
    await ghi("n8nBaseUrl", "http://n8n-test:5678");
    await ghi("n8nApiKey", "key-test");
    await ghi("n8nAppUrl", "http://app-CU:3000"); // giá trị prod đang chạy — khác env hiện tại
    const fetchGia = vi.fn();
    vi.stubGlobal("fetch", fetchGia);

    await expect(provisionN8n()).rejects.toBeInstanceOf(CanXacNhanDoiHaTang);

    const sau = await prisma.setting.findUnique({ where: { key: "n8nAppUrl" } });
    expect(sau?.value).toBe("http://app-CU:3000"); // chưa bị đè
  });

  it("credential Postgres tạo LỖI → 0 request ghi workflow (fail-closed trước mọi PUT)", async () => {
    await ghi("n8nBaseUrl", "http://n8n-test:5678");
    await ghi("n8nApiKey", "key-test");
    await ghi("n8nDbHost", "db-test");
    await ghi("n8nDbName", "postgres");
    await ghi("n8nDbRoPassword", "mat-khau-ro");

    const daGoi: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        daGoi.push(`${init?.method ?? "GET"} ${u}`);
        if (u.includes("/api/v1/workflows") && (init?.method ?? "GET") === "GET") {
          return new Response(JSON.stringify({ data: [], nextCursor: null }), { status: 200 });
        }
        if (u.includes("/api/v1/credentials")) {
          return new Response("{}", { status: 500 }); // n8n từ chối tạo credential
        }
        return new Response("{}", { status: 200 });
      })
    );

    await expect(provisionN8n()).rejects.toThrow(/HTTP 500/);
    // GET danh sách được phép; TUYỆT ĐỐI không có POST/PUT /workflows nào.
    expect(daGoi.some((c) => c.startsWith("POST") && c.includes("/api/v1/workflows"))).toBe(false);
    expect(daGoi.some((c) => c.startsWith("PUT"))).toBe(false);
  });

  it("thiếu bộ khoá n8nDb* (chưa chạy setup) → lỗi hướng dẫn, không ghi workflow", async () => {
    await ghi("n8nBaseUrl", "http://n8n-test:5678");
    await ghi("n8nApiKey", "key-test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [], nextCursor: null }), { status: 200 }))
    );
    await expect(provisionN8n()).rejects.toThrow(/npm run setup/);
  });
});
