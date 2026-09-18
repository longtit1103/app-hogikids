import { z } from "zod";

import { chanRouteKhiDangPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { requireIngestSecret } from "@/lib/ingest/ingest-auth";
import { prisma } from "@/lib/prisma";
import {
  KEY_META_ACCESS_TOKEN,
  KEY_META_DATA_EXPIRE_AT,
  KEY_META_EXPIRE_AT,
  KEY_META_SAVED_AT,
  luuTokenMetaVaoKho,
} from "@/lib/tokens/luu-token-meta";

/**
 * Kho TOKEN Meta Ads (Setting) — nguồn sự thật duy nhất cho `meta-ads-nightly`.
 *
 * KHÁC TikTok Shop ở chỗ: Meta KHÔNG có refresh_token riêng, và ĐO THẬT (2026-07-14) `fb_exchange_token`
 * KHÔNG tự gia hạn được (trả lại hạn y hệt). Token/quyền hết hạn thì chủ shop phải lấy TAY ở Graph
 * API Explorer rồi chạy `scripts/meta-ads-lay-token.ts` để POST token mới vào kho này. Workflow
 * `meta-ads-nightly` chỉ ĐỌC (GET) kho token — KHÔNG gia hạn, KHÔNG POST token về app.
 *
 * ⚠️ META CÓ **HAI** HẠN, và cái ngắn hơn mới là cái giết ta:
 *   - `expires_at`             — token hết hạn (60 ngày với token cá nhân dài hạn)
 *   - `data_access_expires_at` — quyền TRUY CẬP DỮ LIỆU hết hạn (90 ngày kể từ lần user bấm "Cho phép")
 * Chỉ nhìn `expires_at` thì đúng ngày data-access hết hạn, API từ chối trong khi ta vẫn tưởng token
 * còn sống cả tháng. Reset đồng hồ data access = user vào Graph API Explorer cấp quyền LẠI.
 * (Đo thật 2026-07-14: token còn 60 ngày nhưng data access chỉ còn 9 ngày.)
 *
 * Cả GET lẫn POST đều yêu cầu bearer `INGEST_SECRET` — token KHÔNG BAO GIỜ lộ ra UI.
 */

const tokenBodySchema = z.object({
  accessToken: z.string().min(1),
  /** epoch GIÂY. 0 = không hết hạn (System User token của Business Manager). */
  expireAt: z.number().int().nonnegative(),
  dataAccessExpireAt: z.number().int().nonnegative(),
});

export async function POST(req: Request): Promise<Response> {
  const unauthorized = requireIngestSecret(req);
  if (unauthorized) return unauthorized;

  // POST này KHÔNG phải n8n mà là `scripts/meta-ads-lay-token.ts` chạy tay. Nhận 200 rồi bị lượt
  // phục hồi lùi lại = chủ shop tin token mới đã nằm trong kho, còn `meta-ads-nightly` vẫn lặng lẽ
  // dùng token cũ trong bản backup tới lúc nó hết hạn. 503 buộc chạy lại script sau khi phục hồi.
  // GET KHÔNG chặn (bất đối xứng có chủ đích): Meta không có refresh_token xoay vòng để bị đốt nên
  // chặn đọc chỉ làm mất một đêm dữ liệu ads mà không cứu được gì.
  const dangPhucHoi = chanRouteKhiDangPhucHoi();
  if (dangPhucHoi) return dangPhucHoi;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const parsed = tokenBodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ ok: false, error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  // Transaction 4 key nằm trong `luuTokenMetaVaoKho` — dùng chung với action "Đổi & lưu token
  // Meta" của trang Cài đặt, hai đường nhập một cách ghi.
  let savedAt: number;
  try {
    savedAt = await luuTokenMetaVaoKho(parsed.data);
  } catch {
    // KHÔNG đưa err.message vào body: lỗi Prisma có thể chứa giá trị token.
    return Response.json({ ok: false, error: "Lỗi khi lưu token vào kho" }, { status: 500 });
  }

  return Response.json({ ok: true, savedAt });
}

export async function GET(req: Request): Promise<Response> {
  const unauthorized = requireIngestSecret(req);
  if (unauthorized) return unauthorized;

  const rows = await prisma.setting.findMany({
    where: { key: { in: [KEY_META_ACCESS_TOKEN, KEY_META_EXPIRE_AT, KEY_META_DATA_EXPIRE_AT, KEY_META_SAVED_AT] } },
  });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  // Kho rỗng ⇒ trả accessToken rỗng: workflow rơi về token HẠT GIỐNG trong CONFIG (lần chạy đầu).
  return Response.json({
    ok: true,
    accessToken: map[KEY_META_ACCESS_TOKEN] ?? "",
    expireAt: Number(map[KEY_META_EXPIRE_AT] ?? 0),
    dataAccessExpireAt: Number(map[KEY_META_DATA_EXPIRE_AT] ?? 0),
    savedAt: Number(map[KEY_META_SAVED_AT] ?? 0),
  });
}
