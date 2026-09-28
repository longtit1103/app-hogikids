/**
 * Refresh access_token TikTok Shop bằng refresh_token, ghi lại cả 3 giá trị vào `.env`
 * (access, refresh, hạn epoch). Dùng khi cần seed lại workflow n8n hoặc token gần hết hạn.
 *
 *   npx tsx scripts/tiktok-shop-refresh-token.ts
 *
 * BẤT BIẾN: TikTok XOAY VÒNG refresh_token — refresh xong bản cũ CHẾT NGAY. Chỉ được DUY NHẤT một hệ
 * refresh (workflow n8n `tiktokshop-nightly` là hệ đó). Chạy script này khi n8n đang chạy lịch = tự
 * bắn vào chân mình: n8n sẽ cầm refresh_token đã chết.
 *
 * KHÔNG in token ra màn hình — chỉ in hạn dùng.
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { ghiEnv } from "./lib/ghi-env";

const ENV_PATH = path.resolve(process.cwd(), ".env");
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

const AUTH_BASE = "https://auth.tiktok-shops.com/api/v2";

async function main(): Promise<void> {
  const appKey = process.env.TIKTOK_SHOP_APP_KEY;
  const appSecret = process.env.TIKTOK_SHOP_APP_SECRET;
  const refreshToken = process.env.TIKTOK_SHOP_REFRESH_TOKEN;
  if (!appKey || !appSecret || !refreshToken) {
    throw new Error("Thiếu TIKTOK_SHOP_APP_KEY / APP_SECRET / REFRESH_TOKEN trong .env");
  }

  const qs = new URLSearchParams({
    app_key: appKey,
    app_secret: appSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = (await (await fetch(`${AUTH_BASE}/token/refresh?${qs}`)).json()) as {
    code: number;
    message?: string;
    data?: {
      access_token: string;
      refresh_token: string;
      access_token_expire_in: number;
      refresh_token_expire_in: number;
    };
  };
  if (res.code !== 0 || !res.data?.access_token) {
    throw new Error(
      `REFRESH BỊ TỪ CHỐI: code=${res.code} · ${res.message ?? ""} — ` +
        `refresh_token có thể đã bị hệ khác xoay vòng. Cấp quyền lại: scripts/tiktok-shop-lay-token.ts`
    );
  }

  ghiEnv(ENV_PATH, {
    TIKTOK_SHOP_ACCESS_TOKEN: res.data.access_token,
    TIKTOK_SHOP_REFRESH_TOKEN: res.data.refresh_token,
    TIKTOK_SHOP_ACCESS_TOKEN_EXPIRE_AT: String(res.data.access_token_expire_in),
  });

  const hh = (s: number) => new Date(s * 1000).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
  console.log("✓ Refresh xong, đã ghi .env (không in token)");
  console.log(`  access_token hết hạn : ${hh(res.data.access_token_expire_in)} (epoch ${res.data.access_token_expire_in})`);
  console.log(`  refresh_token hết hạn: ${hh(res.data.refresh_token_expire_in)}`);
}

void main();
