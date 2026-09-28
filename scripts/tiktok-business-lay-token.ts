/**
 * TikTok Business (Ads) — đổi auth code → access_token, lấy luôn danh sách advertiser, ghi vào `.env`.
 * App RIÊNG với TikTok Shop (khác portal, khác token, khác luồng OAuth).
 *
 *   npx tsx scripts/tiktok-business-lay-token.ts --link        # in link cấp quyền
 *   npx tsx scripts/tiktok-business-lay-token.ts "<URL có ?auth_code=...>"
 *
 * Token TikTok Business (khác TikTok Shop): access_token dài hạn, KHÔNG xoay vòng, không có refresh
 * token trong đa số trường hợp — nhưng `expires_in` trong response mới là nguồn sự thật, ĐỌC TỪ ĐÓ,
 * không hard-code.
 *
 * KHÔNG in token ra màn hình.
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { ghiEnv } from "./lib/ghi-env";

const ENV_PATH = path.resolve(process.cwd(), ".env");
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

const BASE = "https://business-api.tiktok.com/open_api/v1.3";
const PORTAL_AUTH = "https://business-api.tiktok.com/portal/auth";

const APP_ID = process.env.TIKTOK_BUSINESS_APP_ID;
const SECRET = process.env.TIKTOK_BUSINESS_APP_SECRET;
const REDIRECT = process.env.TIKTOK_BUSINESS_REDIRECT_URI ?? "https://example.com/";

/** Bóc `auth_code` (TikTok Business dùng tên này, KHÁC TikTok Shop dùng `code`). */
function bocAuthCode(input: string): string {
  try {
    const u = new URL(input);
    const c = u.searchParams.get("auth_code") ?? u.searchParams.get("code");
    if (c) return c;
  } catch {
    /* không phải URL → coi như code trần */
  }
  if (/^[\w-]+$/.test(input.trim())) return input.trim();
  throw new Error("Không tìm thấy `auth_code` trong chuỗi truyền vào");
}

async function main(): Promise<void> {
  if (!APP_ID || !SECRET) {
    throw new Error("Thiếu TIKTOK_BUSINESS_APP_ID / TIKTOK_BUSINESS_APP_SECRET trong .env");
  }

  const arg = process.argv[2];
  const link = `${PORTAL_AUTH}?app_id=${APP_ID}&state=hogikids&redirect_uri=${encodeURIComponent(REDIRECT)}`;

  if (!arg || arg === "--link") {
    console.log("Link cấp quyền TikTok Business (bấm → chọn Advertiser → Xác nhận):\n");
    console.log(link);
    console.log("\nSau khi bấm, trình duyệt nhảy về URL có ?auth_code=... → chạy lại script với URL đó.");
    return;
  }

  const authCode = bocAuthCode(arg);

  // ① auth_code → access_token
  const tokRes = (await (
    await fetch(`${BASE}/oauth2/access_token/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: APP_ID, secret: SECRET, auth_code: authCode, grant_type: "auth_code" }),
    })
  ).json()) as {
    code: number;
    message?: string;
    data?: { access_token: string; advertiser_ids?: string[]; scope?: number[] };
  };
  if (tokRes.code !== 0 || !tokRes.data?.access_token) {
    throw new Error(`Đổi token LỖI: code=${tokRes.code} · ${tokRes.message ?? ""}`);
  }
  const accessToken = tokRes.data.access_token;

  // ② Danh sách advertiser đã được cấp quyền
  const advRes = (await (
    await fetch(`${BASE}/oauth2/advertiser/get/?app_id=${APP_ID}&secret=${SECRET}`, {
      headers: { "Access-Token": accessToken },
    })
  ).json()) as {
    code: number;
    message?: string;
    data?: { list?: Array<{ advertiser_id: string; advertiser_name: string }> };
  };
  if (advRes.code !== 0 || !advRes.data?.list?.length) {
    throw new Error(`Lấy advertiser LỖI: code=${advRes.code} · ${advRes.message ?? ""}`);
  }
  const list = advRes.data.list;

  ghiEnv(ENV_PATH, {
    TIKTOK_BUSINESS_ACCESS_TOKEN: accessToken,
    TIKTOK_BUSINESS_ADVERTISER_ID: list[0].advertiser_id,
  });

  console.log("✓ Đã ghi token + advertiser vào .env (không in token)");
  list.forEach((a, i) => console.log(`  ${i === 0 ? "→" : " "} ${a.advertiser_id}  ${a.advertiser_name}`));
  if (list.length > 1) console.log(`  ⚠ Có ${list.length} advertiser — script lấy cái ĐẦU TIÊN. Đổi tay nếu sai.`);
}

void main();
