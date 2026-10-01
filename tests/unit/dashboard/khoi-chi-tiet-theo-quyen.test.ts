import { beforeEach, describe, expect, it, vi } from "vitest";

const { lowStock, productReport, syncFind } = vi.hoisted(() => ({
  lowStock: vi.fn(async () => ({ rows: [], total: 0 })),
  productReport: vi.fn(async () => ({ rows: [] })),
  syncFind: vi.fn(async () => null),
}));
vi.mock("@/lib/queries/variants", () => ({ getLowStockPreview: lowStock }));
vi.mock("@/lib/reports/product-report", () => ({ computeProductReport: productReport }));
vi.mock("@/lib/prisma", () => ({ prisma: { syncLog: { findFirst: syncFind } } }));

import { taiKhoiChiTietDashboard } from "@/lib/dashboard/khoi-chi-tiet-theo-quyen";
import type { Quyen } from "@/lib/quyen/danh-muc-quyen";
import type { NguoiDung } from "@/lib/quyen/nguoi-dung-phien";

const range = { from: new Date("2026-09-01"), to: new Date("2026-09-30") };
const nguoi = (role: "OWNER" | "STAFF", ...q: Quyen[]) => ({ role, quyen: new Set<Quyen>(q) }) as unknown as NguoiDung;

beforeEach(() => vi.clearAllMocks());

describe("taiKhoiChiTietDashboard", () => {
  it("chỉ tong-quan:xem ⇒ không query khối nào, cả ba null", async () => {
    const r = await taiKhoiChiTietDashboard(nguoi("STAFF", "tong-quan:xem"), range, { coQuyenGiaVon: false });
    expect(r).toEqual({ productReport: null, lowStock: null, syncLogs: null });
    expect(lowStock).not.toHaveBeenCalled();
    expect(productReport).not.toHaveBeenCalled();
    expect(syncFind).not.toHaveBeenCalled();
  });

  it("có ton-kho:xem ⇒ chỉ tồn thấp được gọi", async () => {
    const r = await taiKhoiChiTietDashboard(nguoi("STAFF", "tong-quan:xem", "ton-kho:xem"), range, { coQuyenGiaVon: false });
    expect(lowStock).toHaveBeenCalledTimes(1);
    expect(r.lowStock).not.toBeNull();
    expect(r.productReport).toBeNull();
    expect(r.syncLogs).toBeNull();
  });

  it("có bao-cao:xem / cai-dat:xem ⇒ top sản phẩm / đồng bộ được tải", async () => {
    const r = await taiKhoiChiTietDashboard(nguoi("STAFF", "bao-cao:xem", "cai-dat:xem"), range, { coQuyenGiaVon: false });
    expect(productReport).toHaveBeenCalledTimes(1);
    expect(syncFind).toHaveBeenCalledTimes(5);
    expect(r.syncLogs).toHaveLength(5);
    expect(lowStock).not.toHaveBeenCalled();
  });

  it("chủ shop ⇒ tải đủ ba khối", async () => {
    const r = await taiKhoiChiTietDashboard(nguoi("OWNER"), range, { coQuyenGiaVon: true });
    expect(r.productReport && r.lowStock && r.syncLogs).toBeTruthy();
  });
});
