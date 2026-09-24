import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Secret phải set TRƯỚC khi gọi handler (cổng bearer đọc `process.env` lúc chạy).
// Từ 21/09/2026 hai route này dùng bearer RIÊNG `TOKEN_VAULT_SECRET`, KHÔNG còn `INGEST_SECRET`
// (mục M-02: khoá ingest nằm trong mọi workflow n8n và lọt `ps aux`, nó chỉ nên cho BƠM dữ liệu
// chứ không cho RÚT token OAuth 4 nền tảng ra nguyên văn). Giữ luôn `INGEST_SECRET` với giá trị
// KHÁC để ca "khoá cũ không còn mở được cửa này" đo được đúng điều nó nói.
const SECRET = "test-token-vault-secret";
const SECRET_INGEST_CU = "test-ingest-secret";
process.env.TOKEN_VAULT_SECRET = SECRET;
process.env.INGEST_SECRET = SECRET_INGEST_CU;
delete process.env.TOKEN_VAULT_FALLBACK_INGEST;

import { GET as metaGet, POST as metaPost } from "@/app/api/ingest/meta-token/route";
import { GET as tiktokGet, POST as tiktokPost } from "@/app/api/ingest/tiktok-token/route";
import { thuGiuKhoaPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { prisma } from "@/lib/prisma";
import { donKhoaPhucHoi } from "../helpers/khoa-bao-tri-reset";

/**
 * Integration test 2 route kho TOKEN (Meta + TikTok Shop) — chạy trên DB test `hogikids_test`.
 *
 * Bọc lưới cho lỗi CLAUDE.md sợ nhất: mất token = ĐỨT chuỗi refresh, phải cấp quyền lại bằng tay.
 * Kiểm 2 điều: (1) không bearer → 401 (token KHÔNG BAO GIỜ lộ), (2) POST lưu → GET đọc lại khứ hồi
 * đúng (nếu POST/GET lệch key thì workflow đọc ra token rỗng ⇒ rơi về hạt giống CONFIG âm thầm).
 */

const TIKTOK_KEYS = [
  "tiktokShopAccessToken",
  "tiktokShopRefreshToken",
  "tiktokShopAccessTokenExpireAt",
  "tiktokShopRefreshTokenExpireAt",
  "tiktokShopTokenSavedAt",
];
const META_KEYS = [
  "metaAdsAccessToken",
  "metaAdsTokenExpireAt",
  "metaAdsDataAccessExpireAt",
  "metaAdsTokenSavedAt",
];

const jsonReq = (url: string, body: unknown, secret: string | null = SECRET) =>
  new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify(body),
  });

const getReq = (url: string, secret: string | null = SECRET) =>
  new Request(url, {
    method: "GET",
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });

async function cleanupTokens() {
  await prisma.setting.deleteMany({ where: { key: { in: [...TIKTOK_KEYS, ...META_KEYS] } } });
}

beforeAll(async () => {
  await cleanupTokens();
}, 60_000);

afterAll(async () => {
  await cleanupTokens();
  await prisma.$disconnect();
});

describe("route /api/ingest/tiktok-token", () => {
  it("POST thiếu bearer → 401", async () => {
    const res = await tiktokPost(
      jsonReq(
        "http://t/api/ingest/tiktok-token",
        { accessToken: "a", refreshToken: "r", accessTokenExpireAt: Math.floor(Date.now() / 1000) + 3600 },
        null,
      ),
    );
    expect(res.status).toBe(401);
  });

  it("GET thiếu bearer → 401", async () => {
    const res = await tiktokGet(getReq("http://t/api/ingest/tiktok-token", null));
    expect(res.status).toBe(401);
  });

  it("bearer là INGEST_SECRET → 401: khoá ingest KHÔNG còn mở được kho token (M-02)", async () => {
    // Ca này là toàn bộ điểm của việc tách secret. Mất nó thì ai đọc được khoá ingest — nó nằm
    // trong 11 workflow n8n và trong `ps aux` mỗi lượt script chạy tay — vẫn GET ra access token
    // LẪN refresh token của TikTok Shop.
    const res = await tiktokGet(getReq("http://t/api/ingest/tiktok-token", SECRET_INGEST_CU));
    expect(res.status).toBe(401);
    const resPost = await tiktokPost(
      jsonReq(
        "http://t/api/ingest/tiktok-token",
        { accessToken: "a", refreshToken: "r", accessTokenExpireAt: Math.floor(Date.now() / 1000) + 3600 },
        SECRET_INGEST_CU,
      ),
    );
    expect(resPost.status).toBe(401);
  });

  it("bearer INGEST_SECRET qua được KHI VÀ CHỈ KHI cầu tương thích đang mở", async () => {
    process.env.TOKEN_VAULT_FALLBACK_INGEST = "1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await tiktokGet(getReq("http://t/api/ingest/tiktok-token", SECRET_INGEST_CU));
      expect(res.status).toBe(200);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      delete process.env.TOKEN_VAULT_FALLBACK_INGEST;
    }
  });

  it("POST lưu → GET đọc lại khứ hồi đúng", async () => {
    const expireAt = Math.floor(Date.now() / 1000) + 86_400; // 1 ngày tương lai
    const postRes = await tiktokPost(
      jsonReq("http://t/api/ingest/tiktok-token", {
        accessToken: "tt-access-123",
        refreshToken: "tt-refresh-456",
        accessTokenExpireAt: expireAt,
      }),
    );
    expect(postRes.status).toBe(200);

    const getRes = await tiktokGet(getReq("http://t/api/ingest/tiktok-token"));
    expect(getRes.status).toBe(200);
    const json = (await getRes.json()) as {
      ok: boolean;
      accessToken: string | null;
      refreshToken: string | null;
      accessTokenExpireAt: number;
      savedAt: number;
    };
    expect(json.ok).toBe(true);
    expect(json.accessToken).toBe("tt-access-123");
    expect(json.refreshToken).toBe("tt-refresh-456");
    expect(json.accessTokenExpireAt).toBe(expireAt);
    expect(json.savedAt).toBeGreaterThan(0);
  });

  it("POST kèm refreshTokenExpireAt → lưu và đọc lại được (mốc để cảnh báo TRƯỚC khi đứt chuỗi)", async () => {
    const accessExp = Math.floor(Date.now() / 1000) + 604_800; // 7 ngày
    const refreshExp = Math.floor(Date.now() / 1000) + 365 * 86_400; // TikTok cấp refresh 365 ngày
    const postRes = await tiktokPost(
      jsonReq("http://t/api/ingest/tiktok-token", {
        accessToken: "tt-a",
        refreshToken: "tt-r",
        accessTokenExpireAt: accessExp,
        refreshTokenExpireAt: refreshExp,
      }),
    );
    expect(postRes.status).toBe(200);

    const json = (await (await tiktokGet(getReq("http://t/api/ingest/tiktok-token"))).json()) as {
      refreshTokenExpireAt: number;
    };
    expect(json.refreshTokenExpireAt).toBe(refreshExp);
  });

  it("POST KHÔNG kèm refreshTokenExpireAt → giữ nguyên mốc cũ, không xoá mất khả năng cảnh báo", async () => {
    const now = Math.floor(Date.now() / 1000);
    const refreshExp = now + 300 * 86_400;
    await tiktokPost(
      jsonReq("http://t/api/ingest/tiktok-token", {
        accessToken: "tt-a1",
        refreshToken: "tt-r1",
        accessTokenExpireAt: now + 3600,
        refreshTokenExpireAt: refreshExp,
      }),
    );
    // Lần lưu sau (vd bản n8n cũ chưa gửi mốc refresh) không được làm mất mốc đã có
    await tiktokPost(
      jsonReq("http://t/api/ingest/tiktok-token", {
        accessToken: "tt-a2",
        refreshToken: "tt-r2",
        accessTokenExpireAt: now + 7200,
      }),
    );
    const json = (await (await tiktokGet(getReq("http://t/api/ingest/tiktok-token"))).json()) as {
      accessToken: string;
      refreshTokenExpireAt: number;
    };
    expect(json.accessToken).toBe("tt-a2");
    expect(json.refreshTokenExpireAt).toBe(refreshExp);
  });

  it("POST refreshTokenExpireAt là 'còn N giây' (31536000) → 400 (không phải epoch tương lai)", async () => {
    const res = await tiktokPost(
      jsonReq("http://t/api/ingest/tiktok-token", {
        accessToken: "a",
        refreshToken: "r",
        accessTokenExpireAt: Math.floor(Date.now() / 1000) + 3600,
        refreshTokenExpireAt: 31_536_000, // epoch năm 1971, KHÔNG phải mốc tương lai
      }),
    );
    expect(res.status).toBe(400);
  });

  it("POST accessTokenExpireAt là 'còn N giây' (86400) → 400 (không phải epoch tương lai)", async () => {
    const res = await tiktokPost(
      jsonReq("http://t/api/ingest/tiktok-token", {
        accessToken: "a",
        refreshToken: "r",
        accessTokenExpireAt: 86_400, // epoch năm 1970, KHÔNG phải mốc tương lai
      }),
    );
    expect(res.status).toBe(400);
  });

  it("DB lỗi khi lưu → 500 {ok:false} nhất quán, body KHÔNG lộ token", async () => {
    // Mô phỏng DB lỗi: message chứa giá trị token (Prisma error thật có thể in query args).
    const spy = vi
      .spyOn(prisma, "$transaction")
      .mockRejectedValueOnce(new Error("db down — value: tt-secret-access, tt-secret-refresh"));
    try {
      const res = await tiktokPost(
        jsonReq("http://t/api/ingest/tiktok-token", {
          accessToken: "tt-secret-access",
          refreshToken: "tt-secret-refresh",
          accessTokenExpireAt: Math.floor(Date.now() / 1000) + 3600,
        }),
      );
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain("tt-secret-access");
      expect(text).not.toContain("tt-secret-refresh");
      const json = JSON.parse(text) as { ok: boolean; error: string };
      expect(json.ok).toBe(false);
      expect(json.error).toContain("Lỗi khi lưu token");
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * Kho token trong lúc phục hồi. Bất đối xứng CÓ CHỦ ĐÍCH giữa hai sàn:
 *  - TikTok XOAY VÒNG refresh_token nên chặn cả GET — workflow dừng TRƯỚC bước refresh, refresh_token
 *    còn nguyên, đêm sau chạy lại là xong. Chặn ở POST thì token cũ đã bị đốt rồi, chỉ kịp báo động.
 *  - Meta KHÔNG có refresh_token xoay vòng, workflow chỉ ĐỌC kho — chặn GET không cứu được gì mà còn
 *    mất một đêm dữ liệu ads, nên GET Meta vẫn thông.
 */
describe("kho token khi đang phục hồi dữ liệu", () => {
  afterEach(() => {
    donKhoaPhucHoi();
  });

  it("POST tiktok-token → 503 + Retry-After, KHÔNG ghi Setting nào", async () => {
    const truoc = await prisma.setting.count({ where: { key: { in: TIKTOK_KEYS } } });
    expect(thuGiuKhoaPhucHoi()).not.toBeNull();

    const res = await tiktokPost(
      jsonReq("http://t/api/ingest/tiktok-token", {
        accessToken: "tt-khi-phuc-hoi",
        refreshToken: "tt-r-khi-phuc-hoi",
        accessTokenExpireAt: Math.floor(Date.now() / 1000) + 3600,
      }),
    );

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(await prisma.setting.count({ where: { key: { in: TIKTOK_KEYS } } })).toBe(truoc);
  });

  it("GET tiktok-token → 503: n8n dừng TRƯỚC khi refresh ⇒ refresh_token không bị đốt", async () => {
    expect(thuGiuKhoaPhucHoi()).not.toBeNull();

    const res = await tiktokGet(getReq("http://t/api/ingest/tiktok-token"));

    expect(res.status).toBe(503);
  });

  it("POST meta-token → 503 (buộc chạy lại script lấy token sau khi phục hồi xong)", async () => {
    expect(thuGiuKhoaPhucHoi()).not.toBeNull();

    const res = await metaPost(
      jsonReq("http://t/api/ingest/meta-token", {
        accessToken: "meta-khi-phuc-hoi",
        expireAt: 0,
        dataAccessExpireAt: 0,
      }),
    );

    expect(res.status).toBe(503);
  });

  it("GET meta-token → VẪN 200: Meta không có refresh xoay vòng để cứu, chặn chỉ mất dữ liệu ads", async () => {
    expect(thuGiuKhoaPhucHoi()).not.toBeNull();

    const res = await metaGet(getReq("http://t/api/ingest/meta-token"));

    expect(res.status).toBe(200);
  });

  it("POST tiktok-token thiếu bearer → 401 chứ KHÔNG 503 (không tiết lộ trạng thái app cho caller lạ)", async () => {
    expect(thuGiuKhoaPhucHoi()).not.toBeNull();

    const res = await tiktokPost(
      jsonReq(
        "http://t/api/ingest/tiktok-token",
        { accessToken: "a", refreshToken: "r", accessTokenExpireAt: Math.floor(Date.now() / 1000) + 3600 },
        null,
      ),
    );

    expect(res.status).toBe(401);
  });
});

describe("route /api/ingest/meta-token", () => {
  it("POST thiếu bearer → 401", async () => {
    const res = await metaPost(
      jsonReq(
        "http://t/api/ingest/meta-token",
        { accessToken: "a", expireAt: 0, dataAccessExpireAt: 0 },
        null,
      ),
    );
    expect(res.status).toBe(401);
  });

  it("GET thiếu bearer → 401", async () => {
    const res = await metaGet(getReq("http://t/api/ingest/meta-token", null));
    expect(res.status).toBe(401);
  });

  it("POST lưu → GET đọc lại khứ hồi đúng", async () => {
    const expireAt = Math.floor(Date.now() / 1000) + 60 * 86_400; // ~60 ngày
    const dataAccessExpireAt = Math.floor(Date.now() / 1000) + 9 * 86_400; // ~9 ngày (hạn ngắn hơn)
    const postRes = await metaPost(
      jsonReq("http://t/api/ingest/meta-token", {
        accessToken: "meta-access-789",
        expireAt,
        dataAccessExpireAt,
      }),
    );
    expect(postRes.status).toBe(200);

    const getRes = await metaGet(getReq("http://t/api/ingest/meta-token"));
    expect(getRes.status).toBe(200);
    const json = (await getRes.json()) as {
      ok: boolean;
      accessToken: string;
      expireAt: number;
      dataAccessExpireAt: number;
      savedAt: number;
    };
    expect(json.ok).toBe(true);
    expect(json.accessToken).toBe("meta-access-789");
    expect(json.expireAt).toBe(expireAt);
    expect(json.dataAccessExpireAt).toBe(dataAccessExpireAt);
    expect(json.savedAt).toBeGreaterThan(0);
  });

  it("DB lỗi khi lưu → 500 {ok:false} nhất quán, body KHÔNG lộ token", async () => {
    // Mô phỏng DB lỗi: message chứa giá trị token (Prisma error thật có thể in query args).
    const spy = vi
      .spyOn(prisma, "$transaction")
      .mockRejectedValueOnce(new Error("db down — value: meta-secret-token"));
    try {
      const res = await metaPost(
        jsonReq("http://t/api/ingest/meta-token", {
          accessToken: "meta-secret-token",
          expireAt: 0,
          dataAccessExpireAt: 0,
        }),
      );
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain("meta-secret-token");
      const json = JSON.parse(text) as { ok: boolean; error: string };
      expect(json.ok).toBe(false);
      expect(json.error).toContain("Lỗi khi lưu token");
    } finally {
      spy.mockRestore();
    }
  });
});
