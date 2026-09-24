/**
 * Meta Ads — đổi token ngắn hạn (Graph API Explorer, sống 1–2h) sang token DÀI HẠN (60 ngày),
 * ghi vào `.env` kèm hạn epoch RỒI đẩy thẳng vào kho token của app.
 *
 *   npx tsx scripts/meta-ads-lay-token.ts "<token mới>"   # token mới lấy từ Graph API Explorer
 *   npx tsx scripts/meta-ads-lay-token.ts                 # đổi lại token đang có (xem cảnh báo dưới)
 *
 * ⚠️ ĐỔI LẠI TOKEN ĐANG SỐNG **KHÔNG** KÉO DÀI ĐƯỢC HẠN — đã ĐO 2026-07-25: token còn 49 ngày,
 * `fb_exchange_token` trả về token mới hợp lệ nhưng `expires_at` **y hệt** (chênh 0 ngày), và
 * `data_access_expires_at` cũng không nhích. Nên KHÔNG có cách tự động hoá: muốn hạn mới thì bắt buộc
 * lấy token tươi ở Graph API Explorer (người thật bấm) rồi truyền vào tham số. Vì thế workflow
 * `meta-ads-nightly` chỉ KIỂM HẠN + cảnh báo, cố ý không gia hạn — đừng "sửa" nó thành tự gia hạn.
 *
 * BẤT BIẾN: Meta KHÔNG có token vĩnh viễn cho tài khoản cá nhân — chỉ System User token của Business
 * Manager mới vĩnh viễn (chủ shop chưa xin được quyền đó). Token 60 ngày SẼ CHẾT ⇒ phải lấy tay
 * trước hạn. Token chết âm thầm = chi phí quảng cáo ngừng chảy vào P&L = lãi tự nhiên đẹp lên
 * (đúng lỗi đã giết hệ cũ) ⇒ workflow KÊU TO khi còn <14 ngày và DỪNG HẲN khi đã hết hạn.
 *
 * Hai hạn, cái NGẮN HƠN mới là cái giết ta: `expires_at` (token, ~60 ngày) và
 * `data_access_expires_at` (quyền đọc dữ liệu, ~90 ngày — hết là Meta từ chối mọi request).
 *
 * KHÔNG in token ra màn hình.
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { ghiEnv } from "./lib/ghi-env";

const ENV_PATH = path.resolve(process.cwd(), ".env");
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

const V = "v25.0";
const GRAPH = `https://graph.facebook.com/${V}`;

async function main(): Promise<void> {
  const appId = process.env.META_ADS_APP_ID;
  const appSecret = process.env.META_ADS_APP_SECRET;
  const tokenHienTai = process.argv[2] ?? process.env.META_ADS_ACCESS_TOKEN;
  if (!appId || !appSecret) throw new Error("Thiếu META_ADS_APP_ID / META_ADS_APP_SECRET trong .env");
  if (!tokenHienTai) throw new Error("Thiếu token — truyền vào tham số hoặc để sẵn META_ADS_ACCESS_TOKEN");

  // ① Đổi sang token dài hạn (60 ngày). Chỉ SINH LỢI khi `tokenHienTai` là token TƯƠI vừa lấy ở
  //    Graph API Explorer; đổi lại token dài hạn đang chạy thì Meta trả token mới nhưng GIỮ NGUYÊN
  //    hạn cũ (đo 2026-07-25, chênh 0 ngày). Hết hạn hẳn rồi thì không tự khôi phục được.
  const qs = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: tokenHienTai,
  });
  const res = (await (await fetch(`${GRAPH}/oauth/access_token?${qs}`)).json()) as {
    access_token?: string;
    expires_in?: number;
    error?: { message?: string; code?: number };
  };
  if (res.error || !res.access_token) {
    throw new Error(`Đổi token LỖI: ${res.error?.message ?? "không rõ"} (code ${res.error?.code ?? "?"})`);
  }
  const tokenMoi = res.access_token;

  // ② Hỏi Facebook hạn THẬT của token mới — `expires_in` của bước ① không phải lúc nào cũng có.
  const dbg = (await (
    await fetch(
      `${GRAPH}/debug_token?input_token=${tokenMoi}&access_token=${appId}|${appSecret}`
    )
  ).json()) as {
    data?: { expires_at?: number; is_valid?: boolean; scopes?: string[]; data_access_expires_at?: number };
  };
  const d = dbg.data ?? {};
  const hetHan = Number(d.expires_at ?? 0);

  ghiEnv(ENV_PATH, {
    META_ADS_ACCESS_TOKEN: tokenMoi,
    META_ADS_TOKEN_EXPIRE_AT: String(hetHan),
    // Hạn THỨ HAI của Meta — cái NGẮN HƠN mới là cái giết ta. Không gieo nó vào workflow thì đúng
    // ngày data access hết hạn, Meta từ chối mọi request trong khi ta vẫn tưởng token còn cả tháng.
    META_ADS_DATA_ACCESS_EXPIRE_AT: String(Number(d.data_access_expires_at ?? 0)),
  });

  // Đẩy thẳng vào KHO TOKEN của app — workflow n8n đọc từ đó, KHÔNG phải nạp lại workflow mỗi lần
  // đổi token. Không có APP_URL/secret thì bỏ qua (chỉ ghi .env), nhưng nói rõ là phải nạp tay.
  // Bearer là `TOKEN_VAULT_SECRET` từ 21/09/2026 (mục M-02 — kho token có khoá riêng); rơi về
  // `INGEST_SECRET` chỉ để script cũ còn chạy trong lượt chuyển, gỡ cùng lúc với cầu ở app.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_URL;
  const ingestSecret = process.env.TOKEN_VAULT_SECRET ?? process.env.INGEST_SECRET;
  let dayVaoApp = false;
  if (appUrl && ingestSecret) {
    try {
      const r = await fetch(`${appUrl.replace(/\/$/, "")}/api/ingest/meta-token`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ingestSecret}` },
        body: JSON.stringify({
          accessToken: tokenMoi,
          expireAt: hetHan,
          dataAccessExpireAt: Number(d.data_access_expires_at ?? 0),
        }),
      });
      dayVaoApp = r.ok;
      if (!r.ok) console.warn(`  ⚠ App từ chối lưu token: HTTP ${r.status}`);
    } catch (e) {
      console.warn(`  ⚠ Không đẩy được token vào app: ${(e as Error).message}`);
    }
  }

  const hh = (s: number) =>
    s ? new Date(s * 1000).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) : "KHÔNG HẾT HẠN";
  const conLai = hetHan ? Math.round((hetHan * 1000 - Date.now()) / 86400000) : Infinity;

  console.log("✓ Đã ghi token vào .env (không in ra đây)");
  console.log(`  vào kho app    : ${dayVaoApp ? "CÓ — workflow n8n đọc được ngay, không phải nạp lại" : "KHÔNG (phải nạp lại workflow vào n8n bằng tay)"}`);
  console.log(`  còn sống       : ${d.is_valid ? "có" : "KHÔNG"}`);
  console.log(`  quyền          : ${(d.scopes ?? []).join(", ")}`);
  console.log(`  token hết hạn  : ${hh(hetHan)}  (còn ${conLai === Infinity ? "∞" : conLai} ngày)`);
  console.log(`  data access hạn: ${hh(Number(d.data_access_expires_at ?? 0))}`);
  if (conLai !== Infinity && conLai < 55) {
    console.log(
      "  ⚠ Chưa được 60 ngày — token nguồn là token CŨ nên hạn không nhích (đổi lại token đang sống\n" +
        "    KHÔNG kéo dài hạn, đã đo 2026-07-25). Muốn hạn mới: lấy token tươi ở Graph API Explorer\n" +
        "    rồi chạy lại kèm tham số.",
    );
  }
}

void main();
