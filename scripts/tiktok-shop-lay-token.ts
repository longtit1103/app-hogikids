/**
 * Đổi auth code (sau khi cấp quyền cho shop) → access_token + refresh_token + shop_cipher,
 * rồi GHI THẲNG vào `.env`. Chạy MỘT LẦN lúc thiết lập, và chạy lại nếu phải cấp quyền lại.
 *
 *   npx tsx scripts/tiktok-shop-lay-token.ts "<URL trình duyệt nhảy về, có ?code=...>"
 *
 * BẤT BIẾN: refresh token XOAY VÒNG — mỗi lần refresh, token cũ chết. Chỉ được để DUY NHẤT một hệ
 * refresh. Mất refresh_token = phải cấp quyền lại bằng tay (không tự khôi phục được).
 *
 * KHÔNG in token ra màn hình (chỉ in hạn dùng + shop). Token nằm trong `.env` (đã gitignore).
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { ghiEnv } from "./lib/ghi-env";

// Script standalone không đi qua Next auto-load .env → nạp bằng loader built-in của Node (≥20.6).
const ENV_PATH = path.resolve(process.cwd(), ".env");
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

const AUTH_BASE = "https://auth.tiktok-shops.com/api/v2";
const API_BASE = "https://open-api.tiktokglobalshop.com";

const APP_KEY = process.env.TIKTOK_SHOP_APP_KEY;
const APP_SECRET = process.env.TIKTOK_SHOP_APP_SECRET;
if (!APP_KEY || !APP_SECRET) throw new Error("Thiếu TIKTOK_SHOP_APP_KEY / TIKTOK_SHOP_APP_SECRET trong .env");

/** Chữ ký TikTok Shop: HMAC-SHA256(app_secret, app_secret + path + Σ(key+value đã sort) + body + app_secret). */
async function ky(pathname: string, params: Record<string, string>, body = ""): Promise<string> {
  const { createHmac } = await import("node:crypto");
  const p = { ...params };
  delete p.sign;
  delete p.access_token;
  const chuoi = Object.keys(p)
    .sort()
    .map((k) => k + p[k])
    .join("");
  return createHmac("sha256", APP_SECRET!)
    .update(APP_SECRET + pathname + chuoi + body + APP_SECRET)
    .digest("hex");
}

/** Bóc `code` từ URL trình duyệt nhảy về (hoặc nhận thẳng chuỗi code). */
function bocCode(input: string): string {
  try {
    const code = new URL(input).searchParams.get("code");
    if (code) return code;
  } catch {
    /* không phải URL → coi như code trần */
  }
  if (/^[\w-]+$/.test(input.trim())) return input.trim();
  throw new Error("Không tìm thấy `code` trong chuỗi truyền vào");
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error(
      "Cách dùng: npx tsx scripts/tiktok-shop-lay-token.ts \"<URL có ?code=...>\"\n" +
        `Link cấp quyền: https://services.tiktokshop.com/open/authorize?service_id=${process.env.TIKTOK_SHOP_SERVICE_ID ?? "<SERVICE_ID>"}`
    );
    process.exit(1);
  }

  const authCode = bocCode(arg);

  // ① Đổi auth code → token
  const qs = new URLSearchParams({
    app_key: APP_KEY!,
    app_secret: APP_SECRET!,
    auth_code: authCode,
    grant_type: "authorized_code",
  });
  const tokenRes = await fetch(`${AUTH_BASE}/token/get?${qs}`);
  const tokenJson = (await tokenRes.json()) as {
    code: number;
    message?: string;
    data?: {
      access_token: string;
      refresh_token: string;
      access_token_expire_in: number;
      refresh_token_expire_in: number;
    };
  };
  if (tokenJson.code !== 0 || !tokenJson.data?.access_token) {
    throw new Error(`Đổi token LỖI: code=${tokenJson.code} · ${tokenJson.message ?? ""}`);
  }
  const { access_token, refresh_token, access_token_expire_in, refresh_token_expire_in } = tokenJson.data;

  // ② Lấy shop_cipher (bắt buộc kèm mọi request Finance/Order). Endpoint này KHÔNG nhận shop_cipher.
  const p = "/authorization/202309/shops";
  const params: Record<string, string> = { app_key: APP_KEY!, timestamp: String(Math.floor(Date.now() / 1000)) };
  params.sign = await ky(p, params);
  const shopRes = await fetch(`${API_BASE}${p}?${new URLSearchParams(params)}`, {
    headers: { "x-tts-access-token": access_token, "content-type": "application/json" },
  });
  const shopJson = (await shopRes.json()) as {
    code: number;
    message?: string;
    data?: { shops?: Array<{ id: string; name: string; cipher: string; region: string; code: string }> };
  };
  if (shopJson.code !== 0 || !shopJson.data?.shops?.length) {
    throw new Error(`Lấy shop_cipher LỖI: code=${shopJson.code} · ${shopJson.message ?? ""}`);
  }
  const shop = shopJson.data.shops[0];

  ghiEnv(ENV_PATH, {
    TIKTOK_SHOP_ACCESS_TOKEN: access_token,
    TIKTOK_SHOP_REFRESH_TOKEN: refresh_token,
    // Hạn epoch access_token — ghi luôn để sau khi cấp quyền lại, .env không giữ hạn CŨ (n8n đọc
    // field này để biết khi nào cần refresh). Bản refresh-token đã ghi; bản cấp-quyền phải khớp.
    TIKTOK_SHOP_ACCESS_TOKEN_EXPIRE_AT: String(access_token_expire_in),
    TIKTOK_SHOP_CIPHER: shop.cipher,
    TIKTOK_SHOP_ID: shop.id,
  });

  const hh = (s: number) => new Date(s * 1000).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
  console.log("✓ Đã ghi token vào .env (không in ra đây)");
  console.log(`  shop: ${shop.name} (id ${shop.id}, ${shop.region})`);
  console.log(`  access_token hết hạn : ${hh(access_token_expire_in)}`);
  console.log(`  refresh_token hết hạn: ${hh(refresh_token_expire_in)}`);
  if (shopJson.data.shops.length > 1) {
    console.log(`  ⚠ Có ${shopJson.data.shops.length} shop được cấp quyền — script lấy shop ĐẦU TIÊN.`);
  }
}

void main();
