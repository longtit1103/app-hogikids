import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Chốt phiên "không ghi nhớ" (`remember = false`): cookie PHẢI là cookie phiên trình duyệt THẬT
 * (không `Max-Age`/`Expires` — mất khi đóng trình duyệt) NHƯNG seal cũng PHẢI hết hạn phía server
 * sau 24 giờ. Trước bản vá, `cookieOptions.maxAge: undefined` (đường lấy cookie phiên thật) khiến
 * `iron-session` ép `ttl = 0` — seal KHÔNG BAO GIỜ hết hạn phía server, xem
 * `node_modules/iron-session/dist/index.js` (`getSessionConfig`). Xem chi tiết cơ chế ở
 * `src/lib/session.ts` (nhánh `remember === false` của `createSession`).
 */

type MucCookie = { value: string; options?: Record<string, unknown> };

let khoCookie: Map<string, MucCookie>;

// QUAN TRỌNG: trả về store GẮN VỚI `khoCookie` hiện tại, KHÔNG tạo Map mới mỗi lượt gọi — trong
// một request thật, `cookies()` của Next trả về CÙNG MỘT cookie jar cho mọi lệnh gọi trong lượt
// đó (tạo phiên rồi đọc lại phiên vừa tạo phải thấy cùng một cookie).
function taoCookieStoreGia() {
  return {
    get: (name: string) => khoCookie.get(name),
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      khoCookie.set(name, { value, options });
    },
  };
}

vi.mock("next/headers", () => ({
  cookies: async () => taoCookieStoreGia(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    setting: {
      // Mốc phiên mặc định "0" — không đụng DB thật, chỉ cần ổn định giữa lượt tạo và lượt đọc.
      findUnique: vi.fn(async () => null),
    },
  },
}));

import { createSession, getAuthenticatedUserId } from "@/lib/session";

describe("createSession(remember=false) — cookie phiên thật + hết hạn phía server sau 24h", () => {
  beforeEach(() => {
    // `.env` thật đã nạp SESSION_SECRET (>= 32 ký tự) trong tests/setup.ts.
    khoCookie = new Map();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T00:00:00+07:00"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("Set-Cookie KHÔNG mang Max-Age/Expires (cookie phiên trình duyệt thật)", async () => {
    await createSession("chu-shop", false);

    expect(khoCookie.size).toBe(1);
    const [, muc] = [...khoCookie.entries()][0];
    expect(muc.options).toBeDefined();
    expect(muc.options).not.toHaveProperty("maxAge");
    expect(muc.options).not.toHaveProperty("expires");
  });

  it("còn trong 24h → vẫn đăng nhập được", async () => {
    await createSession("chu-shop", false);

    vi.setSystemTime(new Date("2026-09-24T23:59:00+07:00")); // +23h59
    expect(await getAuthenticatedUserId()).toBe("chu-shop");
  });

  it("quá 24h → seal bị server TỪ CHỐI dù cookie không có Max-Age để tự xoá", async () => {
    await createSession("chu-shop", false);

    // `iron-webcrypto` cho phép lệch đồng hồ (`timestampSkewSec`, mặc định 60s) — vượt QUÁ mốc đó
    // mới chắc chắn bị coi là hết hạn, xem `node_modules/iron-webcrypto/dist/index.js` (`unseal`).
    vi.setSystemTime(new Date("2026-09-25T00:02:00+07:00")); // +24h2p, vượt hẳn dung sai 60s
    expect(await getAuthenticatedUserId()).toBeNull();
  });

  it("remember=true (đối chứng): vẫn còn Max-Age (cookie 30 ngày) như trước", async () => {
    await createSession("chu-shop", true);

    const [, muc] = [...khoCookie.entries()][0];
    expect(muc.options).toHaveProperty("maxAge");
    expect(typeof muc.options?.maxAge).toBe("number");
  });
});
