import { describe, expect, it, vi } from "vitest";

import { chayDangXuat } from "@/components/shell/chay-dang-xuat";

/**
 * Đăng xuất chạy qua Server Action: mất mạng ⇒ lời gọi ném. Không được để rejection trôi mất
 * (menu "Đăng xuất" không phản hồi) và cũng không được điều hướng khi phiên chưa xoá được.
 */
describe("chayDangXuat", () => {
  it("thành công ⇒ điều hướng, không báo lỗi", async () => {
    const dieuHuong = vi.fn();
    const baoLoi = vi.fn();
    const kq = await chayDangXuat({ logout: async () => undefined, dieuHuong, baoLoi });
    expect(kq).toBe(true);
    expect(dieuHuong).toHaveBeenCalledTimes(1);
    expect(baoLoi).not.toHaveBeenCalled();
  });

  it("lời gọi ném (mất mạng) ⇒ báo lỗi, KHÔNG điều hướng, KHÔNG ném tiếp", async () => {
    const dieuHuong = vi.fn();
    const baoLoi = vi.fn();
    const kq = await chayDangXuat({
      logout: async () => {
        throw new Error("Failed to fetch");
      },
      dieuHuong,
      baoLoi,
    });
    expect(kq).toBe(false);
    expect(dieuHuong).not.toHaveBeenCalled();
    expect(baoLoi).toHaveBeenCalledTimes(1);
    expect(baoLoi.mock.calls[0][0]).toMatch(/đăng xuất/i);
  });
});
