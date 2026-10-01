import { beforeEach, describe, expect, it, vi } from "vitest";

/** Phiên giả trong bộ nhớ — thay cho cookie đã ký của iron-session. */
let phienGia: Record<string, unknown> = {};
const userFindUnique = vi.fn();

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("iron-session", () => ({ getIronSession: async () => phienGia }));
vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findUnique: (...a: unknown[]) => userFindUnique(...a) } },
}));

import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";
import { createSession } from "@/lib/session";

/** `id` người dùng của phiên đang hiệu lực (qua đúng đường đọc của ba cổng), hoặc null. */
const idPhien = async (): Promise<string | null> => (await docNguoiDungPhien())?.id ?? null;

/** Dòng `User` tối thiểu mà `kiemPhien` đọc. */
function dongUser(sessionEpoch: string, ghiDe: Record<string, unknown> = {}) {
  return {
    id: "u1",
    email: "u1@hogikids.test",
    tenHienThi: "",
    role: "STAFF",
    quyen: [],
    isActive: true,
    mustChangePassword: false,
    sessionEpoch,
    ...ghiDe,
  };
}

/**
 * EPOCH PHIÊN TỪNG NGƯỜI — điểm thu hồi cho cookie iron-session (cookie KÝ, không có bản ghi phiên
 * phía máy chủ). Cookie mang epoch lệch `User.sessionEpoch` của ĐÚNG người đó ⇒ coi như chưa đăng
 * nhập. Đọc qua `docNguoiDungPhien()` — đường đọc chung của ba cổng.
 */
describe("docNguoiDungPhien — epoch phiên theo từng người", () => {
  beforeEach(() => {
    userFindUnique.mockReset();
    phienGia = {};
  });

  it("không có phiên → null (và không cần hỏi DB)", async () => {
    expect(await idPhien()).toBeNull();
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it("epoch cookie KHỚP epoch của người đó → nhận", async () => {
    userFindUnique.mockResolvedValue(dongUser("a".repeat(32)));
    phienGia = { userId: "u1", mocPhien: "a".repeat(32) };

    expect(await idPhien()).toBe("u1");
    expect(userFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "u1" } }));
  });

  it("epoch cookie CŨ (đã đổi mật khẩu/bị thu hồi ở nơi khác) → từ chối", async () => {
    userFindUnique.mockResolvedValue(dongUser("b".repeat(32)));
    phienGia = { userId: "u1", mocPhien: "a".repeat(32) };

    expect(await idPhien()).toBeNull();
  });

  it("tài khoản bị khoá → từ chối dù epoch khớp", async () => {
    userFindUnique.mockResolvedValue(dongUser("0", { isActive: false }));
    phienGia = { userId: "u1", mocPhien: "0" };

    expect(await idPhien()).toBeNull();
  });

  it("cookie ĐỜI CŨ (chưa có trường mốc) vẫn dùng được khi người đó chưa từng bị thu hồi", async () => {
    userFindUnique.mockResolvedValue(dongUser("0"));
    phienGia = { userId: "u1" };

    expect(await idPhien()).toBe("u1");
  });

  it("cookie ĐỜI CŨ bị từ chối NGAY khi người đó đã có một lần thu hồi", async () => {
    userFindUnique.mockResolvedValue(dongUser("c".repeat(32)));
    phienGia = { userId: "u1" };

    expect(await idPhien()).toBeNull();
  });
});

describe("createSession — cookie mang epoch của LƯỢT XÁC THỰC, không đọc DB", () => {
  it("ghi đúng epoch truyền vào, không hỏi DB", async () => {
    userFindUnique.mockReset();
    const save = vi.fn(async () => {});
    phienGia = { save };

    await createSession("u1", true, "d".repeat(32));

    expect(phienGia).toMatchObject({ userId: "u1", mocPhien: "d".repeat(32), ghiNho: true });
    expect(save).toHaveBeenCalledTimes(1);
    expect(userFindUnique).not.toHaveBeenCalled();
  });
});
