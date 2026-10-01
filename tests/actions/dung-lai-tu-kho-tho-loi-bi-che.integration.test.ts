import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * `withSyncLog` gói MỌI lỗi ném ra từ `fn` (nghiệp vụ LẪN hạ tầng — Prisma, mất kết nối…) thành
 * `{ok:false, error: e.message}` — không tách loại (xem `src/lib/ingest/sync-log.ts`). Comment cũ ở
 * `dungLaiTuKhoTho` nói nhánh đó chỉ bắt lỗi NGHIỆP VỤ là SAI: message thô (có thể mang chi tiết hạ
 * tầng) từng bị đẩy thẳng ra client qua `Dựng lại thất bại: ${body.error}`.
 *
 * Mock `dungLaiGiaoDichTuKhoTho` ném lỗi có chuỗi NHẬN DIỆN — không có DB thật nào sinh ra chuỗi
 * này, nên nếu nó lọt ra `ActionResult.error` thì chắc chắn là rò rỉ, không phải trùng hợp.
 */
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => {
  const { nguoiDungGia } = await import("../helpers/nguoi-dung-gia");
  return {
    ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
    docNguoiDungPhien: vi.fn(async () => nguoiDungGia()),
  };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const LOI_HA_TANG_GIA =
  'Prisma: connection to "supabase-db:5432" refused — role "hogikids_app" P1001';

vi.mock("@/lib/bronze/rebuild", () => ({
  dungLaiGiaoDichTuKhoTho: vi.fn(async () => {
    throw new Error(LOI_HA_TANG_GIA);
  }),
}));

import { dungLaiTuKhoTho } from "@/lib/actions/data-admin";
import { prisma } from "@/lib/prisma";

import { seedReference } from "../helpers/test-db";

beforeAll(async () => {
  await seedReference();
}, 60_000);

afterEach(async () => {
  // Dọn khoá + log để test sau không vấp "đang có lượt chạy".
  await prisma.setting.deleteMany({ where: { key: "khoaViecNang" } });
  await prisma.syncLog.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("dungLaiTuKhoTho — lỗi bên trong withSyncLog không lộ chi tiết hạ tầng", () => {
  it("`fn` ném lỗi hạ tầng ⇒ ActionResult.error là câu cố định, KHÔNG chứa message thô", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await dungLaiTuKhoTho();

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).not.toContain(LOI_HA_TANG_GIA);
      expect(res.error).not.toContain("supabase-db");
      expect(res.error).not.toContain("P1001");
      // Vẫn phải trỏ được chủ shop tới nơi có chi tiết thật.
      expect(res.error).toContain("/cai-dat");

      // Chi tiết thật vẫn phải còn đâu đó để chẩn đoán — SyncLog là nơi giữ nó.
      const logRow = await prisma.syncLog.findFirst({ orderBy: { startedAt: "desc" } });
      expect(logRow?.status).toBe("ERROR");
      expect(logRow?.error).toContain(LOI_HA_TANG_GIA);

      // Lượt dựng lại hỏng (có thể đã ghi một phần) để lại dòng nhật ký LOI — chỉ mã lý do, không
      // mang message thô của hạ tầng.
      const nhatKy = await prisma.auditLog.findFirst({
        where: { hanhDong: "DU_LIEU_DUNG_LAI_TU_KHO" },
        orderBy: { thoiDiem: "desc" },
      });
      expect(nhatKy).toMatchObject({ ketQua: "LOI", ghiChu: { lyDo: "that-bai" } });
      expect(JSON.stringify(nhatKy)).not.toContain("supabase-db");
    } finally {
      log.mockRestore();
    }
  });
});
