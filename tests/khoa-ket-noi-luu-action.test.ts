import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireUser: vi.fn(async () => "test-user") }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    setting: { upsert: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(async (arr: unknown[]) => Promise.all(arr)),
  },
}));

import { revalidatePath } from "next/cache";

import { luuKhoaKetNoi } from "@/lib/actions/settings-khoa-ket-noi";
import { LOI_DANG_PHUC_HOI, thuGiuKhoaPhucHoi, traKhoaPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { prisma } from "@/lib/prisma";

/**
 * Hợp đồng ghi khóa kết nối: chỉ key trong danh mục của nguồn, trống = giữ nguyên (không phải
 * xóa), một dòng duy nhất, chặn khi đang phục hồi. Prisma mock — hợp đồng nằm ở validate + cách
 * gọi upsert, không ở DB.
 */
describe("luuKhoaKetNoi", () => {
  beforeEach(() => {
    vi.mocked(prisma.setting.upsert).mockReset().mockResolvedValue({} as never);
    vi.mocked(prisma.$transaction).mockClear();
    vi.mocked(revalidatePath).mockClear();
  });

  it("ghi giá trị đã trim, bỏ qua ô trống (trống = giữ nguyên), báo đúng số khóa đã lưu", async () => {
    const r = await luuKhoaKetNoi("pancake", {
      pancakeApiKeyKho: "  khoa-moi-cua-kho  ",
      pancakeApiKeyShopee: "",
    });
    expect(r).toEqual({ ok: true, data: { daLuu: 1 } });
    expect(prisma.setting.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.setting.upsert).toHaveBeenCalledWith({
      where: { key: "pancakeApiKeyKho" },
      create: { key: "pancakeApiKeyKho", value: "khoa-moi-cua-kho" },
      update: { value: "khoa-moi-cua-kho" },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/cai-dat");
  });

  it("key không thuộc nguồn → chặn thẳng, không ghi gì", async () => {
    const r = await luuKhoaKetNoi("pancake", { tiktokShopAppSecret: "lac-nguon" });
    expect(r).toMatchObject({ ok: false });
    expect(prisma.setting.upsert).not.toHaveBeenCalled();
  });

  it("nguồn bịa → từ chối", async () => {
    const r = await luuKhoaKetNoi("nguon-bia" as never, { x: "y" });
    expect(r).toEqual({ ok: false, error: "Nguồn không hợp lệ" });
  });

  it("không nhập gì → báo rõ, không ghi", async () => {
    const r = await luuKhoaKetNoi("meta", { metaAdsAppId: "   " });
    expect(r).toEqual({ ok: false, error: "Chưa nhập giá trị nào để lưu" });
    expect(prisma.setting.upsert).not.toHaveBeenCalled();
  });

  it("giá trị xuống dòng (dán nhầm cả file) → lỗi theo trường, không ghi", async () => {
    const r = await luuKhoaKetNoi("meta", { metaAdsAppSecret: "abc\ndef" });
    expect(r).toMatchObject({ ok: false, field: "metaAdsAppSecret" });
    expect(prisma.setting.upsert).not.toHaveBeenCalled();
  });

  it("đang phục hồi → chặn (kẻo lưu xong bị lượt phục hồi lùi bảng Setting trong im lặng)", async () => {
    const the = thuGiuKhoaPhucHoi();
    expect(the).not.toBeNull();
    try {
      const r = await luuKhoaKetNoi("pancake", { pancakeApiKeyKho: "khoa" });
      expect(r).toEqual({ ok: false, error: LOI_DANG_PHUC_HOI });
      expect(prisma.setting.upsert).not.toHaveBeenCalled();
    } finally {
      traKhoaPhucHoi(the!);
    }
  });

  it("lỗi DB → thông báo chung, KHÔNG nhại giá trị khóa (message Prisma có thể chứa khóa)", async () => {
    vi.mocked(prisma.$transaction).mockRejectedValueOnce(new Error("chua-gia-tri-khoa-abc"));
    const r = await luuKhoaKetNoi("pancake", { pancakeApiKeyKho: "gia-tri-khoa-abc" });
    expect(r).toEqual({ ok: false, error: "Lỗi khi lưu khóa vào kho" });
  });
});
