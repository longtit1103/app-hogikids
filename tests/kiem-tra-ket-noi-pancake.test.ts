import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: { setting: { findMany: vi.fn() } },
}));

import { xoaCacheCauHinhShop } from "@/lib/ket-noi/cau-hinh-shop";
import { kiemTraPancake } from "@/lib/ket-noi/kiem-tra-pancake";
import { prisma } from "@/lib/prisma";

import { SHOP_KHO, SHOP_SHOPEE, SHOP_TIKTOK } from "./helpers/shop-ids-fixture";

/**
 * Probe Pancake của nút "Kiểm tra kết nối": mỗi shop một kết cục rõ ràng, và thông điệp
 * hiện lên UI KHÔNG BAO GIỜ chứa giá trị API key (stringify toàn kết quả rồi soi).
 */

const KEY_KHO = "PAN-KHO-secret-1234";
const KEY_SHOPEE = "PAN-SHOPEE-secret-5678";

/**
 * Mock trả CÙNG danh sách cho mọi lượt findMany — cả lượt đọc API key lẫn lượt đọc shop id của
 * `layCauHinhShop()` (probe nay resolve shop id từ cấu hình, không còn hằng). Mặc định kèm đủ 3
 * shop id fixture; truyền `keCaShopId: false` cho ca "chưa cấu hình shop ID".
 */
function seedSetting(rows: Array<[string, string]>, opts: { keCaShopId?: boolean } = {}) {
  const shopIdRows: Array<[string, string]> =
    opts.keCaShopId === false
      ? []
      : [
          ["pancakeShopIdKho", SHOP_KHO],
          ["pancakeShopIdShopee", SHOP_SHOPEE],
          ["pancakeShopIdTiktok", SHOP_TIKTOK],
        ];
  vi.mocked(prisma.setting.findMany).mockResolvedValue(
    [...rows, ...shopIdRows].map(([key, value]) => ({ key, value, updatedAt: new Date() })) as never,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(prisma.setting.findMany).mockReset();
  // Cache cấu hình shop sống theo module — không xoá thì test sau đọc bản của test trước.
  xoaCacheCauHinhShop();
});

describe("kiemTraPancake", () => {
  it("mỗi shop một kết cục: dùng được / bị từ chối / thiếu khóa — và không lộ khóa", async () => {
    seedSetting([
      ["pancakeApiKeyKho", KEY_KHO],
      ["pancakeApiKeyShopee", KEY_SHOPEE],
      // pancakeApiKeyTiktok cố ý KHÔNG seed → "Chưa lưu API key".
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes(encodeURIComponent(KEY_KHO))) {
          return { ok: true, status: 200, text: async () => '{"success":true,"data":[]}' };
        }
        return { ok: false, status: 401, text: async () => '{"success":false}' };
      }),
    );

    const r = await kiemTraPancake();
    expect(r.ok).toBe(false);
    expect(r.dong).toHaveLength(3);
    expect(r.dong.find((d) => d.nhan === "Shop Kho Tổng")).toMatchObject({ ok: true });
    expect(r.dong.find((d) => d.nhan === "Shop Shopee")?.chiTiet).toContain("từ chối");
    expect(r.dong.find((d) => d.nhan === "Shop TikTok")?.chiTiet).toContain("Chưa lưu");

    const json = JSON.stringify(r);
    expect(json).not.toContain(KEY_KHO);
    expect(json).not.toContain(KEY_SHOPEE);
  });

  it("cả 3 khóa hợp lệ → nguồn xanh", async () => {
    seedSetting([
      ["pancakeApiKeyKho", "a".repeat(20)],
      ["pancakeApiKeyShopee", "b".repeat(20)],
      ["pancakeApiKeyTiktok", "c".repeat(20)],
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, text: async () => '{"success":true}' })),
    );
    const r = await kiemTraPancake();
    expect(r.ok).toBe(true);
  });

  it("Pancake sập (fetch ném) → báo không kết nối được, không ném ra ngoài", async () => {
    seedSetting([["pancakeApiKeyKho", KEY_KHO]]);
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error(`ECONNRESET ${KEY_KHO}`))));
    const r = await kiemTraPancake();
    expect(r.dong.find((d) => d.nhan === "Shop Kho Tổng")?.chiTiet).toContain("Không kết nối được");
    expect(JSON.stringify(r)).not.toContain(KEY_KHO);
  });

  it("chưa cấu hình shop ID → 3 dòng ĐỎ nêu cách điền, KHÔNG văng lỗi", async () => {
    seedSetting([["pancakeApiKeyKho", KEY_KHO]], { keCaShopId: false });
    vi.stubGlobal("fetch", vi.fn()); // không được gọi tới — thiếu shop id thì khỏi probe
    const r = await kiemTraPancake();
    expect(r.ok).toBe(false);
    expect(r.dong).toHaveLength(3);
    for (const d of r.dong) expect(d.chiTiet).toContain("Chưa cấu hình shop ID");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toContain(KEY_KHO);
  });

  it("HTTP 200 nhưng body không xác nhận success → coi là chưa thông (không xanh giả)", async () => {
    seedSetting([
      ["pancakeApiKeyKho", KEY_KHO],
      ["pancakeApiKeyShopee", KEY_SHOPEE],
      ["pancakeApiKeyTiktok", "c".repeat(20)],
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, text: async () => '{"success":false,"message":"invalid api key"}' })),
    );
    const r = await kiemTraPancake();
    expect(r.ok).toBe(false);
  });
});
