import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Chốt khả năng XOAY `SESSION_SECRET` mà không đá chủ shop ra khỏi phiên đang sống trên prod.
 *
 * Bất biến: cookie đang sống trên prod (seal bằng `SESSION_SECRET` DẠNG CHUỖI ĐƠN — mọi bản trước
 * đợt vá này) PHẢI còn mở được sau deploy khi CHƯA đặt `SESSION_SECRET_PREVIOUS`. Xem chi tiết id
 * khoá ở ghi chú `getSessionPassword` trong `src/lib/session.ts`.
 */

type MucCookie = { value: string; options?: Record<string, unknown> };
let khoCookie: Map<string, MucCookie>;

// QUAN TRỌNG: trả store GẮN VỚI `khoCookie` hiện tại, KHÔNG tạo Map mới mỗi lượt gọi — xem cùng
// ghi chú ở `session-khong-ghi-nho-het-han-server.test.ts`.
function taoCookieStoreGia() {
  return {
    get: (name: string) => khoCookie.get(name),
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      khoCookie.set(name, { value, options });
    },
  };
}

vi.mock("next/headers", () => ({ cookies: async () => taoCookieStoreGia() }));
vi.mock("@/lib/prisma", () => ({
  prisma: { setting: { findUnique: vi.fn(async () => null) } },
}));

import { sealData } from "iron-session";

import { createSession, getAuthenticatedUserId } from "@/lib/session";

const SECRET_A = "a".repeat(32); // secret "đang sống trên prod" trước lượt xoay
const SECRET_B = "b".repeat(32); // secret MỚI sau lượt xoay

let sessionSecretGoc: string | undefined;
let sessionSecretPreviousGoc: string | undefined;

describe("xoay SESSION_SECRET — cookie cũ vẫn mở được, cookie mới ký bằng secret hiện hành", () => {
  beforeEach(() => {
    khoCookie = new Map();
    sessionSecretGoc = process.env.SESSION_SECRET;
    sessionSecretPreviousGoc = process.env.SESSION_SECRET_PREVIOUS;
  });

  afterEach(() => {
    // Trả `.env` thật lại đúng như lượt nạp ban đầu (tests/setup.ts) — các test file khác chạy
    // sau trong CÙNG worker đều dựa vào SESSION_SECRET thật.
    if (sessionSecretGoc === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = sessionSecretGoc;
    if (sessionSecretPreviousGoc === undefined) delete process.env.SESSION_SECRET_PREVIOUS;
    else process.env.SESSION_SECRET_PREVIOUS = sessionSecretPreviousGoc;
  });

  it("(a) seal bằng cấu hình CHUỖI ĐƠN cũ → unseal bằng cấu hình mới (chưa đặt PREVIOUS) vẫn OK", async () => {
    delete process.env.SESSION_SECRET_PREVIOUS;
    process.env.SESSION_SECRET = SECRET_A;

    // Mô phỏng ĐÚNG cookie sống trên prod TRƯỚC bản vá: seal bằng CHUỖI ĐƠN (không phải map
    // nhiều-khoá) — gọi thẳng `sealData` của iron-session, không qua `getSessionPassword()`.
    const sealCu = await sealData(
      { userId: "chu-shop-cu", mocPhien: "0", ghiNho: true },
      { password: SECRET_A, ttl: 60 * 60 * 24 * 30 }
    );
    khoCookie = new Map([["hogikids_session", { value: sealCu }]]);

    // Đọc bằng cấu hình MỚI (map `{"1": SECRET_A}` — chưa xoay, chưa đặt PREVIOUS).
    expect(await getAuthenticatedUserId()).toBe("chu-shop-cu");
  });

  it("(b) có PREVIOUS: seal bằng secret CŨ vẫn mở được; seal MỚI dùng secret HIỆN HÀNH", async () => {
    // Trước lượt xoay: mọi cookie sống được ký bằng SECRET_A (chưa có PREVIOUS).
    delete process.env.SESSION_SECRET_PREVIOUS;
    process.env.SESSION_SECRET = SECRET_A;
    await createSession("chu-shop-truoc-xoay", true);
    const sealTruocXoay = khoCookie.get("hogikids_session")?.value;
    expect(sealTruocXoay).toBeTruthy();

    // Xoay khoá: SESSION_SECRET_PREVIOUS = secret cũ, SESSION_SECRET = secret mới.
    process.env.SESSION_SECRET_PREVIOUS = SECRET_A;
    process.env.SESSION_SECRET = SECRET_B;

    // Cookie ký TRƯỚC lượt xoay vẫn mở được.
    khoCookie = new Map([["hogikids_session", { value: sealTruocXoay! }]]);
    expect(await getAuthenticatedUserId()).toBe("chu-shop-truoc-xoay");

    // Đăng nhập MỚI sau lượt xoay ký bằng secret HIỆN HÀNH (SECRET_B) — đọc lại vẫn ra đúng user.
    await createSession("chu-shop-sau-xoay", true);
    expect(await getAuthenticatedUserId()).toBe("chu-shop-sau-xoay");

    // Xác nhận seal MỚI THẬT SỰ dùng SECRET_B chứ không phải SECRET_A (còn PREVIOUS): thử mở
    // bằng bản đồ CHỈ có SECRET_A (bỏ hẳn SECRET_B) phải THẤT BẠI.
    const sealSauXoay = khoCookie.get("hogikids_session")?.value;
    process.env.SESSION_SECRET = SECRET_A;
    process.env.SESSION_SECRET_PREVIOUS = SECRET_A;
    khoCookie = new Map([["hogikids_session", { value: sealSauXoay! }]]);
    expect(await getAuthenticatedUserId()).toBeNull();
  });
});
