import { beforeEach, describe, expect, it, vi } from "vitest";

import { nguoiDungGia } from "../../helpers/nguoi-dung-gia";
import type { NguoiDung } from "@/lib/quyen/nguoi-dung-phien";
import type { Quyen } from "@/lib/quyen/danh-muc-quyen";

/**
 * Banner "sau lùi bản phân quyền" ở layout: CHỈ chủ shop mới đọc dấu `Setting('phanQuyenDangLui')`
 * (một dòng theo khoá chính) và thấy banner. STAFF không kích truy vấn nào, prop luôn null.
 */
let nguoiHienTai: NguoiDung | null = null;

vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => ({
  ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
  docNguoiDungPhien: async () => nguoiHienTai,
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

const nguon = vi.hoisted(() => ({
  settingFindUnique: vi.fn(),
  docDauLuiBan: vi.fn(),
}));

vi.mock("@/lib/shop-profile/doc-shop-profile", () => ({ docShopProfile: async () => ({ shopName: "Shop" }) }));
vi.mock("@/lib/queries/variants", () => ({
  countMissingCostVariants: async () => 0,
  hasLowStockVariants: async () => false,
}));
vi.mock("@/lib/queries/sync-health", () => ({ getRecentDataErrorKinds: async () => [] }));
vi.mock("@/lib/bronze/bronze-only", () => ({ hasBronzeBacklog: async () => false }));
vi.mock("@/lib/backup/doc-trang-thai-sao-luu", () => ({ docTrangThaiSaoLuu: async () => ({ muc: "tot" }) }));
vi.mock("@/lib/prisma", () => ({
  prisma: { setting: { findMany: async () => [], findUnique: nguon.settingFindUnique } },
}));
vi.mock("@/lib/so-quy/khoan-vay-queries", () => ({ demKhoanVayCoKyChoDuyet: async () => 0 }));
vi.mock("@/lib/so-quy/du-bao-quy-queries", () => ({ docCanhBaoSapCan: async () => null }));
vi.mock("@/lib/date-range-cookie-server", () => ({ docLuaChonDaLuu: async () => null }));
vi.mock("@/lib/backup/dau-lui-ban", async (goc) => ({
  ...(await goc<typeof import("@/lib/backup/dau-lui-ban")>()),
  docDauLuiBan: nguon.docDauLuiBan,
}));
vi.mock("@/components/shell/shell-chrome", () => ({ ShellChrome: () => null }));
vi.mock("@/components/shell/date-range-provider", () => ({ DateRangeProvider: () => null }));

import AppLayout from "@/app/(app)/layout";

function propsShell(el: unknown): Record<string, unknown> {
  const goc = el as { props: { children: { props: Record<string, unknown> } } };
  return goc.props.children.props;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("layout — banner sau lùi bản", () => {
  it("OWNER + còn dấu ⇒ đọc dấu đúng 1 lần, truyền chuỗi mốc xuống ShellChrome", async () => {
    nguon.docDauLuiBan.mockResolvedValue("10:00 01/10/2026");
    nguoiHienTai = nguoiDungGia({ role: "OWNER" });
    const el = await AppLayout({ children: null });
    expect(nguon.docDauLuiBan).toHaveBeenCalledTimes(1);
    expect(propsShell(el).dangLuiBanTu).toBe("10:00 01/10/2026");
  });

  it("OWNER + không có dấu ⇒ null", async () => {
    nguon.docDauLuiBan.mockResolvedValue(null);
    nguoiHienTai = nguoiDungGia({ role: "OWNER" });
    expect(propsShell(await AppLayout({ children: null })).dangLuiBanTu).toBeNull();
  });

  it("STAFF (kể cả đủ quyền cài đặt) ⇒ KHÔNG đọc dấu, prop null", async () => {
    nguon.docDauLuiBan.mockResolvedValue("10:00 01/10/2026");
    nguoiHienTai = nguoiDungGia({ role: "STAFF", quyen: new Set<Quyen>(["cai-dat:xem", "cai-dat:sua"]) });
    const el = await AppLayout({ children: null });
    expect(nguon.docDauLuiBan).not.toHaveBeenCalled();
    expect(propsShell(el).dangLuiBanTu).toBeNull();
  });
});

describe("docDauLuiBan — một dòng Setting theo khoá chính", () => {
  it("có dòng ⇒ mốc giờ VN; hỏi đúng khoá phanQuyenDangLui", async () => {
    const { docDauLuiBan } = await vi.importActual<typeof import("@/lib/backup/dau-lui-ban")>(
      "@/lib/backup/dau-lui-ban",
    );
    nguon.settingFindUnique.mockResolvedValue({ value: "2026-10-01T03:00:00Z" });
    expect(await docDauLuiBan()).toBe("10:00 01/10/2026");
    expect(nguon.settingFindUnique).toHaveBeenCalledTimes(1);
    expect(nguon.settingFindUnique.mock.calls[0][0]).toMatchObject({ where: { key: "phanQuyenDangLui" } });
  });

  it("không có dòng ⇒ null; giá trị lạ ⇒ hiện nguyên văn", async () => {
    const { docDauLuiBan, dinhDangMocLuiBan } = await vi.importActual<typeof import("@/lib/backup/dau-lui-ban")>(
      "@/lib/backup/dau-lui-ban",
    );
    nguon.settingFindUnique.mockResolvedValue(null);
    expect(await docDauLuiBan()).toBeNull();
    expect(dinhDangMocLuiBan("sua tay")).toBe("sua tay");
  });

  it("tên khoá khớp script SQL lùi/tiến (hợp đồng 3 bên)", async () => {
    const { KEY_DAU_LUI_BAN } = await vi.importActual<typeof import("@/lib/backup/dau-lui-ban")>(
      "@/lib/backup/dau-lui-ban",
    );
    const { readFileSync } = await import("node:fs");
    for (const f of ["deploy/rollback-phan-quyen-m1.sql", "deploy/tien-lai-phan-quyen-m1.sql"]) {
      expect(readFileSync(f, "utf8"), f).toContain(`'${KEY_DAU_LUI_BAN}'`);
    }
  });
});
