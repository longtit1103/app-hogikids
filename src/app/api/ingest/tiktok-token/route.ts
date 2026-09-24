import { z } from "zod";

import { chanRouteKhiDangPhucHoi } from "@/lib/backup/khoa-bao-tri";
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
  if (unauthorized) return unauthorized;

  // 503 KHÔNG cứu được token nếu chặn ở ĐÂY: workflow đã refresh xong trước khi POST, và TikTok xoay
  // vòng refresh_token nên cái cũ đã chết. Mục đích là để n8n THROW ồn ào (`persistToken` in nguyên
  // cặp token ra log lỗi để chép lại bằng tay) thay vì nhận 200 rồi bị lượt phục hồi lùi bảng
  // `Setting` — mất lặng, chỉ phát hiện vài tuần sau khi dữ liệu đã hụt.
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
  try {
    await prisma.$transaction(
      canGhi.map(([key, value]) =>
        prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
      )
    );
  } catch {
    // KHÔNG đưa err.message vào body: lỗi Prisma có thể chứa giá trị token/refresh_token.
    return Response.json({ ok: false, error: "Lỗi khi lưu token vào kho" }, { status: 500 });
  }

  return Response.json({ ok: true, savedAt, accessTokenExpireAt, refreshTokenExpireAt: refreshTokenExpireAt ?? null });
}

export async function GET(req: Request): Promise<Response> {
  const unauthorized = requireTokenVaultSecret(req);
  if (unauthorized) return unauthorized;

  // GET là ĐỌC, nhưng nó là bước ĐẦU của một chuỗi ghi không thể làm nguyên tử: đọc token → refresh
  // (đốt refresh_token cũ) → ghi token mới. Chặn ở bước cuối chỉ kịp báo động; chặn ở đây thì
  // `loadToken()` của workflow throw TRƯỚC khi refresh ("dừng TRƯỚC khi refresh để không đốt
  // refresh_token khi chưa có chỗ lưu") ⇒ refresh_token còn nguyên, đêm sau chạy lại là xong.
  const dangPhucHoi = chanRouteKhiDangPhucHoi();
  if (dangPhucHoi) return dangPhucHoi;

  const rows = await prisma.setting.findMany({
    where: { key: { in: [KEY_ACCESS_TOKEN, KEY_REFRESH_TOKEN, KEY_EXPIRE_AT, KEY_SAVED_AT, KEY_REFRESH_EXPIRE_AT] } },
  });
  const map = new Map(rows.map((r) => [r.key, r.value]));

  // Chưa có gì trong kho ⇒ trả rỗng (KHÔNG lỗi). Workflow không còn giữ token hạt giống (bỏ 2026-07-25)
  // nên phía n8n sẽ THROW để báo phải cấp quyền lại bằng `scripts/tiktok-shop-lay-token.ts` — cố ý ồn ào,
  // vì kho rỗng nghĩa là chuỗi refresh đã đứt và không tự phục hồi được.
  return Response.json({
    ok: true,
    accessToken: map.get(KEY_ACCESS_TOKEN) ?? null,
    refreshToken: map.get(KEY_REFRESH_TOKEN) ?? null,
    accessTokenExpireAt: Number(map.get(KEY_EXPIRE_AT) ?? 0),
    // 0 = chưa biết (token lưu trước 2026-07-25). Workflow chỉ cảnh báo khi > 0 — không có mốc thì
    // im lặng còn hơn báo "hết hạn" sai rồi làm người đọc mất tin vào cảnh báo.
    refreshTokenExpireAt: Number(map.get(KEY_REFRESH_EXPIRE_AT) ?? 0),
    savedAt: Number(map.get(KEY_SAVED_AT) ?? 0),
  });
}
