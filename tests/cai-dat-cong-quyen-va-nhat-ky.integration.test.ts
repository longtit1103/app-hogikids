import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => {
  const { nguoiDungGia } = await import("./helpers/nguoi-dung-gia");
  return {
    ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
    docNguoiDungPhien: vi.fn(async () => nguoiDungGia()),
  };
});
// `ghiNhatKy` chạy BẢN THẬT; ca "nhật ký hỏng ⇒ không lưu" ép nó ném một lần.
vi.mock("@/lib/nhat-ky/ghi-nhat-ky", async (goc) => {
  const that = await goc<typeof import("@/lib/nhat-ky/ghi-nhat-ky")>();
  return { ...that, ghiNhatKy: vi.fn(that.ghiNhatKy) };
});
// Đích webhook đồng bộ: không cần cấu hình n8n thật — `fetch` bị thay ngay trong từng ca.
vi.mock("@/lib/n8n/giai-url-sync-now", () => ({
  giaiUrlSyncNow: vi.fn(async () => ({ url: "http://n8n-gia.test/webhook/sync-now", nguon: "setting" })),
}));

import { countRecomputableOrders, recomputeFeesInRange, updateChannels } from "@/lib/actions/settings-channels";
import {
  createExpenseCategory,
  deleteExpenseCategory,
  renameExpenseCategory,
  toggleExpenseCategoryHidden,
} from "@/lib/actions/settings-expense-categories";
import { updateDefaultLowStockThreshold } from "@/lib/actions/settings-low-stock";
import { updateShopInfo } from "@/lib/actions/settings-shop-info";
import { getLatestSync, getTienDoDongBoNgay, triggerSyncNow } from "@/lib/actions/sync";
import { ghiNhatKy } from "@/lib/nhat-ky/ghi-nhat-ky";
import { prisma } from "@/lib/prisma";
import type { Quyen } from "@/lib/quyen/danh-muc-quyen";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";
import { nguoiDungGia } from "./helpers/nguoi-dung-gia";
import { seedReference, seedShopProfile } from "./helpers/test-db";

/**
 * Cổng quyền + nhật ký của nhóm Cài đặt (spec phân quyền §1.1 module `cai-dat`, §5), DB test thật:
 * thiếu `cai-dat:sua` ⇒ từ chối + dòng `TU_CHOI_QUYEN`, DB không đổi; có quyền ⇒ ghi + dòng OK đúng
 * mã; nhật ký ném ⇒ lượt ghi rollback. Hàm chỉ đọc (`countRecomputableOrders`, `getLatestSync`) đòi
 * `cai-dat:xem`.
 */
const RANGE = { from: new Date("2026-07-01T00:00:00+07:00"), to: new Date("2026-07-31T00:00:00+07:00") };
const KENH_HOP_LE = (["shopee", "tiktok", "facebook", "website", "direct"] as const).map((id) => ({
  id,
  isActive: true,
  platformFeePct: 1.5,
  paymentFeePct: 0,
  color: "#123456",
}));

const staff = (id: string, quyen: Quyen[]) => nguoiDungGia({ id, role: "STAFF", quyen: new Set(quyen) });
const CHI_XEM = staff("staff-chi-xem", ["cai-dat:xem"]);
const DUOC_SUA = staff("staff-duoc-sua", ["cai-dat:xem", "cai-dat:sua"]);
const KHONG_CAI_DAT = staff("staff-khong-cai-dat", ["don-hang:xem"]);

const nhatKy = (hanhDong: string) => prisma.auditLog.findMany({ where: { hanhDong }, orderBy: { thoiDiem: "asc" } });

function formShop(ten: string): FormData {
  const fd = new FormData();
  fd.set("shopName", ten);
  fd.set("shopPhone", "");
  return fd;
}

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await prisma.auditLog.deleteMany();
  await prisma.expenseCategory.deleteMany({ where: { isSystem: false } });
  await prisma.setting.deleteMany({ where: { key: "defaultLowStockThreshold" } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.expenseCategory.deleteMany({ where: { isSystem: false } });
  await seedShopProfile();
  await prisma.$disconnect();
});

describe("thiếu cai-dat:sua (chỉ xem) ⇒ KHONG_CO_QUYEN + TU_CHOI_QUYEN, không ghi gì", () => {
  it.each([
    ["updateChannels", () => updateChannels(KENH_HOP_LE)],
    ["recomputeFeesInRange", () => recomputeFeesInRange(RANGE)],
    ["createExpenseCategory", () => createExpenseCategory("Danh mục lạ")],
    ["renameExpenseCategory", () => renameExpenseCategory("other", "Tên mới")],
    ["toggleExpenseCategoryHidden", () => toggleExpenseCategoryHidden("fixed", true)],
    ["deleteExpenseCategory", () => deleteExpenseCategory("fixed")],
    ["updateDefaultLowStockThreshold", () => updateDefaultLowStockThreshold(9)],
    ["updateShopInfo", () => updateShopInfo(formShop("Shop Bị Đổi"))],
    ["triggerSyncNow", () => triggerSyncNow()],
  ] as const)("%s", async (_ten, goi) => {
    const fetchGia = vi.fn();
    vi.stubGlobal("fetch", fetchGia);
    const kenhTruoc = await prisma.channel.findMany({ orderBy: { id: "asc" } });
    const danhMucTruoc = await prisma.expenseCategory.findMany({ orderBy: { id: "asc" } });
    vi.mocked(docNguoiDungPhien).mockResolvedValueOnce(CHI_XEM);

    const r = await goi();

    expect(r).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    expect(fetchGia).not.toHaveBeenCalled();
    expect(await prisma.channel.findMany({ orderBy: { id: "asc" } })).toEqual(kenhTruoc);
    expect(await prisma.expenseCategory.findMany({ orderBy: { id: "asc" } })).toEqual(danhMucTruoc);
    expect(await prisma.setting.findUnique({ where: { key: "defaultLowStockThreshold" } })).toBeNull();
    expect((await prisma.shopProfile.findUnique({ where: { id: 1 } }))?.shopName).toBe("HogiKids");
    expect(await nhatKy("TU_CHOI_QUYEN")).toEqual([
      expect.objectContaining({ ketQua: "LOI", actorId: CHI_XEM.id, ghiChu: { quyenThieu: "cai-dat:sua" } }),
    ]);
  });
});

describe("hàm chỉ đọc đòi cai-dat:xem", () => {
  it("không có cai-dat:xem ⇒ countRecomputableOrders / getLatestSync bị từ chối", async () => {
    vi.mocked(docNguoiDungPhien).mockResolvedValueOnce(KHONG_CAI_DAT).mockResolvedValueOnce(KHONG_CAI_DAT);

    expect(await countRecomputableOrders(RANGE)).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    expect(await getLatestSync("PANCAKE")).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    expect(await nhatKy("TU_CHOI_QUYEN")).toHaveLength(2);
  });

  it("không có cai-dat:xem ⇒ getTienDoDongBoNgay bị từ chối (trả kèm error thô của SyncLog)", async () => {
    vi.mocked(docNguoiDungPhien).mockResolvedValueOnce(KHONG_CAI_DAT);

    expect(await getTienDoDongBoNgay(new Date().toISOString())).toMatchObject({
      ok: false,
      code: "KHONG_CO_QUYEN",
    });
  });

  it("có cai-dat:xem ⇒ getLatestSync trả mốc gần nhất (hoặc null khi chưa có lượt nào)", async () => {
    await prisma.syncLog.deleteMany({ where: { kind: "PANCAKE" } });
    vi.mocked(docNguoiDungPhien).mockResolvedValueOnce(CHI_XEM).mockResolvedValueOnce(CHI_XEM);

    expect(await getLatestSync("PANCAKE")).toEqual({ ok: true, data: null });
    await prisma.syncLog.create({ data: { kind: "PANCAKE", status: "OK" } });
    const r = await getLatestSync("PANCAKE");
    expect(r.ok && r.data?.status).toBe("OK");
    await prisma.syncLog.deleteMany({ where: { kind: "PANCAKE" } });
  });
});

describe("có cai-dat:sua ⇒ ghi + dòng nhật ký OK đúng mã, đúng người", () => {
  beforeEach(() => {
    vi.mocked(docNguoiDungPhien).mockResolvedValue(DUOC_SUA);
  });
  afterEach(() => {
    vi.mocked(docNguoiDungPhien).mockReset().mockResolvedValue(nguoiDungGia());
  });

  it("ngưỡng tồn mặc định ⇒ CAI_DAT_NGUONG_TON", async () => {
    expect(await updateDefaultLowStockThreshold(9)).toEqual({ ok: true, data: undefined });
    expect((await prisma.setting.findUnique({ where: { key: "defaultLowStockThreshold" } }))?.value).toBe("9");
    expect(await nhatKy("CAI_DAT_NGUONG_TON")).toEqual([expect.objectContaining({ ketQua: "OK", actorId: DUOC_SUA.id })]);
  });

  it("danh mục: tạo → đổi tên → ẩn → xoá, mỗi bước một dòng", async () => {
    const tao = await createExpenseCategory("Phí gửi hàng");
    expect(tao.ok).toBe(true);
    if (!tao.ok) return;
    expect((await renameExpenseCategory(tao.data.id, "Phí ship")).ok).toBe(true);
    expect((await toggleExpenseCategoryHidden(tao.data.id, true)).ok).toBe(true);
    expect((await deleteExpenseCategory(tao.data.id)).ok).toBe(true);

    for (const ma of ["DANH_MUC_CHI_PHI_TAO", "DANH_MUC_CHI_PHI_SUA", "DANH_MUC_CHI_PHI_AN_HIEN", "DANH_MUC_CHI_PHI_XOA"]) {
      expect(await nhatKy(ma), ma).toEqual([
        expect.objectContaining({ ketQua: "OK", actorId: DUOC_SUA.id, doiTuongLoai: "ExpenseCategory", doiTuongId: tao.data.id }),
      ]);
    }
  });

  it("kênh + tính lại phí + thông tin shop ⇒ CAI_DAT_KENH / CAI_DAT_TINH_LAI_PHI / CAI_DAT_THONG_TIN_SHOP", async () => {
    const kenhTruoc = await prisma.channel.findMany();
    try {
      expect((await updateChannels(KENH_HOP_LE)).ok).toBe(true);
      expect((await recomputeFeesInRange(RANGE)).ok).toBe(true);
      expect((await updateShopInfo(formShop("HogiKids Mới"))).ok).toBe(true);
    } finally {
      for (const k of kenhTruoc) await prisma.channel.update({ where: { id: k.id }, data: k });
      await seedShopProfile();
    }

    expect(await nhatKy("CAI_DAT_KENH")).toHaveLength(1);
    expect(await nhatKy("CAI_DAT_TINH_LAI_PHI")).toEqual([
      expect.objectContaining({ ketQua: "OK", ghiChu: { soDong: expect.any(Number) } }),
    ]);
    expect(await nhatKy("CAI_DAT_THONG_TIN_SHOP")).toHaveLength(1);
  });

  it("đồng bộ ngay: n8n nhận lệnh ⇒ DONG_BO_KICH_HOAT; n8n lỗi ⇒ không có dòng OK", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    const truocKhiBam = Date.now();
    const kq = await triggerSyncNow();
    // `mocBam` = giờ SERVER chụp trước khi gọi n8n — nút dùng để chỉ nhận SyncLog của lượt vừa bấm.
    expect(kq).toEqual({ ok: true, data: { mocBam: expect.any(String) } });
    // Cận dưới: chụp SAU lúc bắt đầu gọi; cận trên: không ở tương lai (mốc lệch tương lai ⇒ dòng
    // SyncLog của chính lượt này rơi khỏi bộ lọc `startedAt >= mocBam` ⇒ nút báo "chưa phản hồi" giả).
    if (kq.ok) {
      expect(Date.parse(kq.data.mocBam)).toBeGreaterThanOrEqual(truocKhiBam);
      expect(Date.parse(kq.data.mocBam)).toBeLessThanOrEqual(Date.now());
    }
    vi.stubGlobal("fetch", vi.fn(async () => new Response("loi", { status: 500 })));
    expect((await triggerSyncNow()).ok).toBe(false);

    expect(await nhatKy("DONG_BO_KICH_HOAT")).toEqual([expect.objectContaining({ ketQua: "OK", actorId: DUOC_SUA.id })]);
  });

  it("nhật ký ném ⇒ lượt ghi rollback (ngưỡng không lưu, danh mục không tạo)", async () => {
    vi.mocked(ghiNhatKy).mockRejectedValueOnce(new Error("nhat-ky-hong")).mockRejectedValueOnce(new Error("nhat-ky-hong"));

    expect((await updateDefaultLowStockThreshold(7)).ok).toBe(false);
    expect((await createExpenseCategory("Không được còn")).ok).toBe(false);

    expect(await prisma.setting.findUnique({ where: { key: "defaultLowStockThreshold" } })).toBeNull();
    expect(await prisma.expenseCategory.count({ where: { name: "Không được còn" } })).toBe(0);
  });
});
