import { z } from "zod";

import { routeQuaCua } from "@/lib/backup/cong-ghi-toan-cuc";
import { requireTokenVaultSecret } from "@/lib/ingest/token-vault-auth";
import { prisma } from "@/lib/prisma";

/**
 * Kho TOKEN TikTok Shop (Setting) — nguồn sự thật duy nhất cho `tiktokshop-nightly`.
 *
 * VÌ SAO app phải giữ token này (ngoại lệ có chủ đích của quy ước "token nằm trong n8n credentials"):
 * TikTok XOAY VÒNG refresh_token — refresh thành công là refresh_token cũ CHẾT NGAY. n8n chỉ ghi
 * `getWorkflowStaticData` KHI EXECUTION KẾT THÚC, và ở lần chạy TAY thì KHÔNG ghi gì cả. Chỉ cần một
 * request dữ liệu sau bước refresh throw (rate-limit khi backfill 60 ngày là chuyện thường) là token
 * mới bốc hơi trong khi token cũ đã chết ⇒ ĐỨT CHUỖI VĨNH VIỄN, phải cấp quyền lại bằng tay.
 * Vì chỉ được DUY NHẤT 1 hệ refresh, mất là không tự phục hồi được.
 *
 * ⇒ n8n POST token mới về đây NGAY sau khi refresh, TRƯỚC khi bắn bất kỳ request dữ liệu nào;
 *    GET để nạp token đang dùng ở đầu mỗi lần chạy (kể cả chạy tay).
 *
 * Cả GET lẫn POST đều yêu cầu bearer `TOKEN_VAULT_SECRET` (tách khỏi `INGEST_SECRET` 21/09/2026,
 * mục M-02) — token KHÔNG BAO GIỜ lộ ra UI.
 */

/** Ép mọi response của route này KHÔNG bị cache (browser/CDN/proxy) — body mang token OAuth thật. */
function noStore(res: Response): Response {
  res.headers.set("Cache-Control", "no-store");
  return res;
}

const KEY_ACCESS_TOKEN = "tiktokShopAccessToken";
const KEY_REFRESH_TOKEN = "tiktokShopRefreshToken";
const KEY_EXPIRE_AT = "tiktokShopAccessTokenExpireAt"; // epoch GIÂY
const KEY_SAVED_AT = "tiktokShopTokenSavedAt"; // epoch GIÂY — biết token đã nằm im bao lâu
/**
 * Hạn của REFRESH token (epoch GIÂY) — TikTok trả `refresh_token_expire_in`, sống ~365 ngày.
 * Access token tự gia hạn được nên không cần lo; refresh token thì KHÔNG: hết hạn là đứt chuỗi,
 * phải cấp quyền lại bằng tay. Không lưu mốc này thì chỉ phát hiện lúc đã hỏng — quá muộn.
 */
const KEY_REFRESH_EXPIRE_AT = "tiktokShopRefreshTokenExpireAt";

/** Khoá tư vấn tuần tự hoá các lượt ghi kho token TikTok Shop (đọc hạn đang lưu → so → ghi). */
const KHOA_GHI_TOKEN = "kho-token-tiktok-shop";

const tokenBodySchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  /**
   * `access_token_expire_in` của TikTok = epoch GIÂY (không phải "còn bao nhiêu giây").
   * BẮT BUỘC là mốc TƯƠNG LAI: nếu TikTok đổi sang trả "còn N giây" (vd 86400) thì `positive()`
   * vẫn qua, nhưng 86400 là mốc epoch năm 1970 ⇒ workflow tưởng token đã chết ⇒ refresh vòng lặp
   * ⇒ đốt refresh_token (TikTok xoay vòng refresh mỗi lần dùng). Chặn ngay tại biên.
   */
  accessTokenExpireAt: z
    .number()
    .int()
    .positive()
    .refine((v) => v > Date.now() / 1000, "accessTokenExpireAt phải là epoch giây trong tương lai"),
  /**
   * TUỲ CHỌN vì token cũ lưu trước 2026-07-25 chưa có mốc này — thiếu thì giữ nguyên giá trị đang
   * lưu, KHÔNG xoá (xoá đi là mất luôn khả năng cảnh báo sớm). Cùng ràng buộc "epoch giây tương lai"
   * như access token: nếu TikTok đổi sang trả "còn N giây" thì chặn ngay tại biên thay vì lưu một
   * mốc năm 1970 rồi tưởng refresh token đã chết.
   */
  refreshTokenExpireAt: z
    .number()
    .int()
    .positive()
    .refine((v) => v > Date.now() / 1000, "refreshTokenExpireAt phải là epoch giây trong tương lai")
    .optional(),
});

export async function POST(req: Request): Promise<Response> {
  const unauthorized = requireTokenVaultSecret(req);
  if (unauthorized) return noStore(unauthorized);

  // 503 KHÔNG cứu được token nếu chặn ở ĐÂY: workflow đã refresh xong trước khi POST, và TikTok xoay
  // vòng refresh_token nên cái cũ đã chết. Mục đích là để n8n THROW ồn ào (`persistToken` in nguyên
  // cặp token ra log lỗi để chép lại bằng tay) thay vì nhận 200 rồi bị lượt phục hồi lùi bảng
  // `Setting` — mất lặng, chỉ phát hiện vài tuần sau khi dữ liệu đã hụt.
  // `noStore` bọc cả 503 của cửa (hàm idempotent — thân bên trong đã tự bọc).
  return noStore(await routeQuaCua(() => xuLyPost(req)));
}

/** Thân POST sau cửa ghi (đếm suốt request — lượt phục hồi chờ nó xong). */
async function xuLyPost(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return noStore(Response.json({ ok: false, error: "invalid json" }, { status: 400 }));
  }

  const parsed = tokenBodySchema.safeParse(body);
  if (!parsed.success) {
    return noStore(
      Response.json({ ok: false, error: "invalid body", issues: parsed.error.issues }, { status: 400 }),
    );
  }

  const { accessToken, refreshToken, accessTokenExpireAt, refreshTokenExpireAt } = parsed.data;
  const savedAt = Math.floor(Date.now() / 1000);

  const canGhi: Array<[string, string]> = [
    [KEY_ACCESS_TOKEN, accessToken],
    [KEY_REFRESH_TOKEN, refreshToken],
    [KEY_EXPIRE_AT, String(accessTokenExpireAt)],
    [KEY_SAVED_AT, String(savedAt)],
  ];
  if (refreshTokenExpireAt !== undefined) canGhi.push([KEY_REFRESH_EXPIRE_AT, String(refreshTokenExpireAt)]);

  // Một transaction: không để tình trạng access_token mới đứng cạnh refresh_token cũ (đã chết).
  //
  // CHỐNG GHI LÙI: hai lượt n8n refresh chồng nhau (chạy tay đè lịch đêm…) thì lượt POST về SAU có
  // thể mang token hạn CŨ HƠN — refresh_token của nó đã bị lượt kia đốt (TikTok xoay vòng). Ghi đè
  // vô điều kiện là kho giữ refresh_token chết ⇒ đứt chuỗi vĩnh viễn. Nên chỉ ghi khi hạn mới ≥ hạn
  // đang lưu. Đọc-so-ghi nằm sau khoá tư vấn trong CÙNG transaction (ReadCommitted: câu đọc sau khoá
  // thấy bản lượt trước vừa commit) — khoá dòng `FOR UPDATE` không đủ vì lần đầu chưa có dòng nào.
  // Hạn đang lưu hỏng (không phải số) ⇒ ghi đè để tự lành.
  let ghiDe = true;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${KHOA_GHI_TOKEN}, 0))`;
      const dangLuu = await tx.setting.findUnique({ where: { key: KEY_EXPIRE_AT } });
      const hanDangLuu = Number(dangLuu?.value);
      if (Number.isFinite(hanDangLuu) && hanDangLuu > accessTokenExpireAt) {
        ghiDe = false;
        return;
      }
      for (const [key, value] of canGhi) {
        await tx.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
      }
    });
  } catch {
    // KHÔNG đưa err.message vào body: lỗi Prisma có thể chứa giá trị token/refresh_token.
    return noStore(Response.json({ ok: false, error: "Lỗi khi lưu token vào kho" }, { status: 500 }));
  }

  if (!ghiDe) {
    // KHÔNG in token — chỉ mốc hạn, đủ để đọc log biết có lượt refresh chồng nhau.
    console.warn(
      `[tiktok-token] bỏ qua token hạn ${accessTokenExpireAt}: kho đang giữ token hạn mới hơn (lượt refresh chồng nhau)`,
    );
  }
  // 200 cả khi bỏ qua: token đang lưu MỚI hơn và còn sống — không có gì để n8n báo động. Giữ nguyên
  // các trường cũ (mốc của request) + `ghiDe` cho biết có thật sự ghi hay không.
  return noStore(
    Response.json({
      ok: true,
      savedAt,
      accessTokenExpireAt,
      refreshTokenExpireAt: refreshTokenExpireAt ?? null,
      ghiDe,
    }),
  );
}

export async function GET(req: Request): Promise<Response> {
  const unauthorized = requireTokenVaultSecret(req);
  if (unauthorized) return noStore(unauthorized);

  // GET là ĐỌC, nhưng nó là bước ĐẦU của một chuỗi ghi không thể làm nguyên tử: đọc token → refresh
  // (đốt refresh_token cũ) → ghi token mới. Chặn ở bước cuối chỉ kịp báo động; chặn ở đây thì
  // `loadToken()` của workflow throw TRƯỚC khi refresh ("dừng TRƯỚC khi refresh để không đốt
  // refresh_token khi chưa có chỗ lưu") ⇒ refresh_token còn nguyên, đêm sau chạy lại là xong.
  // Đi cùng cửa với route ghi (đếm): lượt đọc này mở đầu chuỗi đọc → refresh → ghi của workflow.
  return noStore(await routeQuaCua(() => xuLyGet()));
}

/** Thân GET sau cửa (chỉ đọc kho token). */
async function xuLyGet(): Promise<Response> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: [KEY_ACCESS_TOKEN, KEY_REFRESH_TOKEN, KEY_EXPIRE_AT, KEY_SAVED_AT, KEY_REFRESH_EXPIRE_AT] } },
  });
  const map = new Map(rows.map((r) => [r.key, r.value]));

  // Chưa có gì trong kho ⇒ trả rỗng (KHÔNG lỗi). Workflow không còn giữ token hạt giống (bỏ 2026-07-25)
  // nên phía n8n sẽ THROW để báo phải cấp quyền lại bằng `scripts/tiktok-shop-lay-token.ts` — cố ý ồn ào,
  // vì kho rỗng nghĩa là chuỗi refresh đã đứt và không tự phục hồi được.
  return noStore(
    Response.json({
      ok: true,
      accessToken: map.get(KEY_ACCESS_TOKEN) ?? null,
      refreshToken: map.get(KEY_REFRESH_TOKEN) ?? null,
      accessTokenExpireAt: Number(map.get(KEY_EXPIRE_AT) ?? 0),
      // 0 = chưa biết (token lưu trước 2026-07-25). Workflow chỉ cảnh báo khi > 0 — không có mốc thì
      // im lặng còn hơn báo "hết hạn" sai rồi làm người đọc mất tin vào cảnh báo.
      refreshTokenExpireAt: Number(map.get(KEY_REFRESH_EXPIRE_AT) ?? 0),
      savedAt: Number(map.get(KEY_SAVED_AT) ?? 0),
    }),
  );
}
