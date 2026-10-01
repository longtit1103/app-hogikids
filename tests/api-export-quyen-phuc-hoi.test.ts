import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `ghiNhatKyXuat` cùng luật với `ghiNhatKyLoi`: đang phục hồi DB thì KHÔNG ghi (schema đích đang bị xoá +
 * nạp lại — ghi lúc này lỗi/treo/bị bản backup lùi mất, và ném sẽ biến lượt xuất thành 500).
 * Ngoài cửa sổ phục hồi, vẫn ghi đúng một dòng XUAT_FILE như cũ.
 */
const dangPhucHoi = vi.hoisted(() => vi.fn(() => false));
vi.mock("@/lib/backup/khoa-bao-tri", () => ({ dangPhucHoi }));
vi.mock("@/lib/nhat-ky/ghi-nhat-ky", () => ({ ghiNhatKy: vi.fn(async () => {}), ghiNhatKyLoi: vi.fn(async () => {}) }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { ghiNhatKy } from "@/lib/nhat-ky/ghi-nhat-ky";
import type { NguoiDung } from "@/lib/quyen/nguoi-dung-phien";
import { ghiNhatKyXuat } from "@/lib/reports/xuat-xlsx-server";

const nd = { id: "u1", email: "u1@hogikids.test" } as NguoiDung;

beforeEach(() => {
  dangPhucHoi.mockReset().mockReturnValue(false);
  vi.mocked(ghiNhatKy).mockClear();
});

describe("ghiNhatKyXuat khi đang phục hồi DB", () => {
  it("đang phục hồi ⇒ không ghi, không ném", async () => {
    dangPhucHoi.mockReturnValue(true);
    await expect(ghiNhatKyXuat(nd, "ton-kho", { soDong: 3 })).resolves.toBeUndefined();
    expect(ghiNhatKy).not.toHaveBeenCalled();
  });

  it("bình thường ⇒ ghi đúng một dòng XUAT_FILE", async () => {
    await ghiNhatKyXuat(nd, "ton-kho", { ky: "2026-09", soDong: 3 });
    expect(ghiNhatKy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ghiNhatKy).mock.calls[0][1]).toMatchObject({
      actor: { id: "u1", email: "u1@hogikids.test" },
      hanhDong: "XUAT_FILE",
      ghiChu: { loaiBanGhi: "ton-kho", ky: "2026-09", soDong: 3 },
    });
  });
});
