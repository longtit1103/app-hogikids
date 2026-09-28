import { beforeEach, describe, expect, it, vi } from "vitest";

/** Phiên giả trong bộ nhớ — thay cho cookie đã ký của iron-session. */
let phienGia: Record<string, unknown> = {};
const settingFindUnique = vi.fn();

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("iron-session", () => ({ getIronSession: async () => phienGia }));
vi.mock("@/lib/prisma", () => ({
  prisma: { setting: { findUnique: (...a: unknown[]) => settingFindUnique(...a) } },
}));

import { getAuthenticatedUserId } from "@/lib/session";

/**
 * MỐC PHIÊN — điểm thu hồi cho cookie iron-session (cookie KÝ, không có bản ghi phiên phía máy chủ).
 * Không có nó thì đổi mật khẩu xong, cookie "ghi nhớ đăng nhập" 30 ngày trên các thiết bị khác vẫn
 * vào được, tức là vô hiệu hoá đúng lý do người ta đổi mật khẩu.
 */
describe("getAuthenticatedUserId — mốc phiên", () => {
  beforeEach(() => {
    settingFindUnique.mockReset();
    phienGia = {};
  });

  it("không có phiên → null (và không cần hỏi DB)", async () => {
    expect(await getAuthenticatedUserId()).toBeNull();
    expect(settingFindUnique).not.toHaveBeenCalled();
  });

  it("mốc cookie KHỚP mốc hiện hành → nhận", async () => {
    settingFindUnique.mockResolvedValue({ value: "1753800000000" });
    phienGia = { userId: "u1", mocPhien: "1753800000000" };

    expect(await getAuthenticatedUserId()).toBe("u1");
  });

  it("mốc cookie CŨ hơn (đã đổi mật khẩu ở nơi khác) → từ chối", async () => {
    settingFindUnique.mockResolvedValue({ value: "1753900000000" });
    phienGia = { userId: "u1", mocPhien: "1753800000000" };

    expect(await getAuthenticatedUserId()).toBeNull();
  });

  it("cookie ĐỜI CŨ (chưa có trường mốc) vẫn dùng được khi chưa từng thu hồi — nâng cấp bản này KHÔNG đá ai ra", async () => {
    settingFindUnique.mockResolvedValue(null); // chưa có dòng Setting ⇒ mốc mặc định "0"
    phienGia = { userId: "u1" };

    expect(await getAuthenticatedUserId()).toBe("u1");
  });

  it("cookie ĐỜI CŨ bị từ chối NGAY khi đã có một lần thu hồi", async () => {
    settingFindUnique.mockResolvedValue({ value: "1753900000000" });
    phienGia = { userId: "u1" };

    expect(await getAuthenticatedUserId()).toBeNull();
  });
});
