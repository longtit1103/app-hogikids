import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { N8N_RO_ROLE, N8N_SETTING_VIEW } from "@/lib/n8n/role-doc-kho-khoa";
import { prisma } from "@/lib/prisma";

import { SHOP_KHO, SHOP_SHOPEE, SHOP_TIKTOK } from "../helpers/shop-ids-fixture";

/**
 * `npm run setup` — hai hợp đồng sống còn:
 *  1. CHỐT CHẶN CẤU TRÚC: DB không-test mà thiếu cờ xác nhận → thoát ≠0 TRƯỚC MỌI lệnh ghi
 *     (repo này .env dev trỏ THẲNG prod qua Tailscale — chạy nhầm là migrate/seed/đè cấu hình prod).
 *  2. IDEMPOTENT + CHỈ-TẠO-MỚI: chạy lại không đòi INIT_*, và KHÔNG đè giá trị người dùng đã sửa
 *     (platformFeePct đi thẳng công thức phí ước tính — DB sạch không bao giờ lộ lỗi ghi-đè này).
 */

const SCRIPT = "scripts/setup-clone.ts";

function chayScript(args: string[], env: Record<string, string | undefined>): { status: number | null; stdout: string; stderr: string } {
  const kq = spawnSync("./node_modules/.bin/tsx", [SCRIPT, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 180_000,
  });
  if (kq.error) throw kq.error;
  return { status: kq.status, stdout: kq.stdout, stderr: kq.stderr };
}

const ENV_DU = {
  SESSION_SECRET: "s".repeat(32),
  INGEST_SECRET: "i".repeat(32),
  APP_INTERNAL_URL: "http://app-test:3000",
};

describe("setup-clone — chốt chặn DB thật", () => {
  it("DB tên không-test, mode không tương tác, KHÔNG cờ → thoát ≠0 trước mọi lệnh ghi", () => {
    const kq = chayScript(["--khong-tuong-tac"], {
      ...ENV_DU,
      // Host không tồn tại: nếu script LỠ nối/ghi thì cũng chết vì mạng — nhưng hợp đồng là nó
      // phải DỪNG ở chốt chặn (in tên cờ) trước khi đụng tới mạng.
      DATABASE_URL: "postgresql://u:p@host-khong-ton-tai:5432/hogikids_prod_gia?schema=app",
    });
    expect(kq.status).not.toBe(0);
    expect(kq.stderr).toContain("--toi-biet-day-la-db-that");
    expect(kq.stdout).not.toContain("migrate"); // chưa tới bước 3
  });

  it("thiếu env bắt buộc → nêu đúng tên biến, thoát ≠0", () => {
    const kq = chayScript(["--khong-tuong-tac"], {
      ...ENV_DU,
      APP_INTERNAL_URL: "",
      DATABASE_URL: "postgresql://u:p@host:5432/x_test?schema=app",
    });
    expect(kq.status).not.toBe(0);
    expect(`${kq.stdout}${kq.stderr}`).toContain("APP_INTERNAL_URL");
  });
});

describe("setup-clone — chạy thật trên DB test (đuôi _test nên qua chốt chặn)", () => {
  it("2 lượt liên tiếp: lượt sau không đòi INIT_*, KHÔNG đè giá trị đã sửa tay; role đọc được VIEW, bị chặn ở BẢNG", { timeout: 300_000 }, async () => {
    const env = {
      ...ENV_DU,
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
      INIT_EMAIL: "setup-test@hogikids.test",
      INIT_PASSWORD: "mat-khau-setup-test",
    };

    // Lượt 1 — kèm shop ID fixture (trùng giá trị đã seed ⇒ lưới chặn-đổi cho qua) + admin DSN
    // trỏ db `postgres` như người vận hành thật hay đưa (KHÔNG phải db đích): các câu GRANT trên
    // schema/view phải tự nối sang db đích — diễn tập 22/08 từng lộ bug grant chạy nhầm db.
    const adminUrlDbPostgres = (process.env.TEST_DATABASE_URL as string).replace("hogikids_test", "postgres");
    const lan1 = chayScript(
      ["--khong-tuong-tac", `--shop-kho=${SHOP_KHO}`, `--shop-shopee=${SHOP_SHOPEE}`, `--shop-tiktok=${SHOP_TIKTOK}`, `--admin-url=${adminUrlDbPostgres}`],
      env
    );
    expect(lan1.stderr).toBe(lan1.stderr); // giữ stderr trong output vitest khi fail
    expect(lan1.status).toBe(0);
    expect(lan1.stdout).toContain("Xong. Bước kế tiếp");

    // Người dùng sửa tay cấu hình — lượt setup sau KHÔNG được đè (seed chỉ-tạo-mới).
    await prisma.channel.update({ where: { id: "shopee" }, data: { platformFeePct: 99 } });
    await prisma.setting.upsert({
      where: { key: "defaultLowStockThreshold" },
      create: { key: "defaultLowStockThreshold", value: "77" },
      update: { value: "77" },
    });

    // Lượt 2 — KHÔNG INIT_*, không cờ shop.
    const lan2 = chayScript(["--khong-tuong-tac"], { ...env, INIT_EMAIL: undefined, INIT_PASSWORD: undefined });
    expect(lan2.status).toBe(0);

    const shopee = await prisma.channel.findUniqueOrThrow({ where: { id: "shopee" } });
    expect(shopee.platformFeePct).toBe(99);
    const nguong = await prisma.setting.findUniqueOrThrow({ where: { key: "defaultLowStockThreshold" } });
    expect(nguong.value).toBe("77");

    // Quyền role: VIEW đọc được, BẢNG bị chặn (view đã loại n8nApiKey/n8nDbRoPassword).
    const [quyen] = await prisma.$queryRaw<{ view: boolean; bang: boolean }[]>`
      SELECT
        has_table_privilege(${N8N_RO_ROLE}, ${'"app"."' + N8N_SETTING_VIEW + '"'}, 'SELECT') AS "view",
        has_table_privilege(${N8N_RO_ROLE}, '"app"."Setting"', 'SELECT') AS "bang"
    `;
    expect(quyen.view).toBe(true);
    expect(quyen.bang).toBe(false);

    // Bộ khoá n8nDb* đã sẵn cho lượt "Cài workflows".
    const dbUser = await prisma.setting.findUniqueOrThrow({ where: { key: "n8nDbUser" } });
    expect(dbUser.value).toBe(N8N_RO_ROLE);
  });
});
