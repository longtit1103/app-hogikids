import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Server Action lưu lựa chọn khoảng ngày (#254): chỉ ghi cookie đã kiểm bằng CHÍNH luật URL, đúng bộ
 * thuộc tính cookie phiên (httpOnly, SameSite=lax, Path=/, Secure ở production) + hạn 1 năm.
 */
const cookieJar = vi.hoisted(() => ({ set: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => cookieJar) }));
vi.mock("@/lib/session", () => ({ requireUser: vi.fn(async () => "test-user-id") }));

import { luuLuaChonKhoangNgay } from "@/lib/actions/khoang-ngay";
import { requireUser } from "@/lib/session";

const MOT_NAM = 365 * 24 * 60 * 60;

beforeEach(() => {
  cookieJar.set.mockClear();
  vi.mocked(requireUser).mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("luuLuaChonKhoangNgay", () => {
  it("preset hợp lệ ⇒ ghi cookie đúng tên, giá trị và thuộc tính (dev: không Secure)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const kq = await luuLuaChonKhoangNgay("7d");
    expect(kq).toEqual({ ok: true, data: null });
    expect(requireUser).toHaveBeenCalled();
    expect(cookieJar.set).toHaveBeenCalledWith("hogikids_khoang_ngay", "7d", {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: MOT_NAM,
    });
  });

  it("production ⇒ Secure bật", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await luuLuaChonKhoangNgay("last_month");
    expect(cookieJar.set).toHaveBeenCalledWith(
      "hogikids_khoang_ngay",
      "last_month",
      expect.objectContaining({ secure: true, httpOnly: true, sameSite: "lax", path: "/", maxAge: MOT_NAM }),
    );
  });

  it("khoảng tuỳ chọn ⇒ ghi dạng chuẩn yyyy-MM-dd..yyyy-MM-dd", async () => {
    await luuLuaChonKhoangNgay("2026-07-01..2026-07-31");
    expect(cookieJar.set).toHaveBeenCalledWith("hogikids_khoang_ngay", "2026-07-01..2026-07-31", expect.anything());
  });

  it.each([
    ["khoảng đảo ngược", "2026-07-31..2026-07-01"],
    ["ngày không tồn tại", "2026-02-30..2026-03-05"],
    ["preset lạ", "tuan_nay"],
    ["rỗng", ""],
    ["chuỗi độc", "7d; Path=/admin"],
    ["không phải chuỗi (payload bịa)", { preset: "7d" } as unknown as string],
  ])("giá trị sai hình (%s) ⇒ KHÔNG ghi cookie, trả lỗi", async (_mo_ta, giaTri) => {
    const kq = await luuLuaChonKhoangNgay(giaTri);
    expect(kq.ok).toBe(false);
    expect(cookieJar.set).not.toHaveBeenCalled();
  });
});
