import { createInterface } from "node:readline/promises";

/**
 * Kiểm env + CHỐT CHẶN CẤU TRÚC chống chạy nhầm DB thật.
 *
 * Repo này dev nối chung DB prod qua Tailscale (cảnh báo sống còn trong CLAUDE.md) — `.env` trên
 * máy dev TRỎ THẲNG PROD. Script setup có 4 bước nguy hiểm nếu chạy nhầm (migrate bản dev, seed,
 * đè shop ID, ALTER ROLE) nên KHÔNG tin kỷ luật con người: tên DB không kết thúc `_test`/`_scratch`
 * thì bắt gõ lại đúng tên DB (tương tác) hoặc bắt cờ `--toi-biet-day-la-db-that` (không tương tác).
 */

export type ThamSo = {
  shopKho?: string;
  shopShopee?: string;
  shopTiktok?: string;
  tiktokShopId?: string;
  metaAccountId?: string;
  adminUrl?: string;
  n8nDbHost?: string;
  rotateRoPassword: boolean;
  toiBietDbThat: boolean;
  khongTuongTac: boolean;
};

export function parseThamSo(argv: string[]): ThamSo {
  const layGiaTri = (ten: string): string | undefined => {
    const truoc = argv.find((a) => a.startsWith(`${ten}=`));
    return truoc?.slice(ten.length + 1);
  };
  return {
    shopKho: layGiaTri("--shop-kho"),
    shopShopee: layGiaTri("--shop-shopee"),
    shopTiktok: layGiaTri("--shop-tiktok"),
    tiktokShopId: layGiaTri("--tiktok-shop-id"),
    metaAccountId: layGiaTri("--meta-account-id"),
    adminUrl: layGiaTri("--admin-url"),
    n8nDbHost: layGiaTri("--n8n-db-host"),
    rotateRoPassword: argv.includes("--rotate-ro-password"),
    toiBietDbThat: argv.includes("--toi-biet-day-la-db-that"),
    khongTuongTac: argv.includes("--khong-tuong-tac") || !process.stdin.isTTY,
  };
}

/** Env bắt buộc để app chạy được sau setup. INIT_* chỉ bắt ở lượt đầu (seed tự kiểm). */
export const ENV_BAT_BUOC = ["DATABASE_URL", "SESSION_SECRET", "INGEST_SECRET", "APP_INTERNAL_URL"] as const;

export function kiemEnv(): string[] {
  return ENV_BAT_BUOC.filter((k) => !(process.env[k] ?? "").trim());
}

export function tenDbTu(url: string): { db: string; host: string; port: string } {
  const u = new URL(url);
  return { db: u.pathname.replace(/^\//, "").split("?")[0], host: u.hostname, port: u.port || "5432" };
}

export function laDbAnToan(tenDb: string): boolean {
  return tenDb.endsWith("_test") || tenDb.endsWith("_scratch");
}

/**
 * Trả `true` nếu được phép ghi tiếp. In tên DB + host TRƯỚC khi hỏi — người chạy phải nhìn thấy
 * mình sắp đụng vào đâu.
 */
export async function chanDbThat(databaseUrl: string, thamSo: ThamSo): Promise<boolean> {
  const { db, host } = tenDbTu(databaseUrl);
  console.log(`\nDB đích: "${db}" trên ${host}`);
  if (laDbAnToan(db)) return true;

  if (thamSo.khongTuongTac) {
    if (thamSo.toiBietDbThat) return true;
    console.error(
      `✕ DB "${db}" KHÔNG phải DB test/scratch. Mode không tương tác cần cờ --toi-biet-day-la-db-that ` +
        `để xác nhận đây là chủ đích (và chỉ khi bạn hiểu script sẽ migrate/seed/ghi Setting lên DB này).`
    );
    return false;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const traLoi = await rl.question(
      `DB này KHÔNG phải DB test. Gõ lại ĐÚNG tên database ("${db}") để tiếp tục, hoặc Enter để huỷ: `
    );
    return traLoi.trim() === db;
  } finally {
    rl.close();
  }
}
