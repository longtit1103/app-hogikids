import { beforeEach, describe, expect, it, vi } from "vitest";

import { nguoiDungGia } from "../../helpers/nguoi-dung-gia";
import type { NguoiDung } from "@/lib/quyen/nguoi-dung-phien";
import type { Quyen } from "@/lib/quyen/danh-muc-quyen";

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

const chiChu = vi.hoisted(() => ({
  docTrangThaiSaoLuu: vi.fn(),
  coDuLieuGiaoDich: vi.fn(),
  demDonMoCoi: vi.fn(),
  demChiPhiKhongDungLai: vi.fn(),
  demAdsMoCoi: vi.fn(),
  docQuyenDocN8n: vi.fn(),
  docTrangThaiKhoaKetNoi: vi.fn(),
  docTrangThaiWebhookPancake: vi.fn(),
  docTrangThaiKetNoiN8n: vi.fn(),
}));

vi.mock("@/lib/backup/doc-trang-thai-sao-luu", () => ({ docTrangThaiSaoLuu: chiChu.docTrangThaiSaoLuu }));
vi.mock("@/lib/actions/data-admin", () => ({
  coDuLieuGiaoDich: chiChu.coDuLieuGiaoDich,
  demDonMoCoi: chiChu.demDonMoCoi,
  demChiPhiKhongDungLai: chiChu.demChiPhiKhongDungLai,
  demAdsMoCoi: chiChu.demAdsMoCoi,
}));
vi.mock("@/lib/n8n/quyen-doc-kho-khoa", () => ({ docQuyenDocN8n: chiChu.docQuyenDocN8n }));
vi.mock("@/lib/ket-noi/doc-trang-thai-khoa-ket-noi", () => ({
  docTrangThaiKhoaKetNoi: chiChu.docTrangThaiKhoaKetNoi,
}));
vi.mock("@/lib/ket-noi/webhook-pancake-info", () => ({
  docTrangThaiWebhookPancake: chiChu.docTrangThaiWebhookPancake,
}));
vi.mock("@/lib/n8n/provision/kiem-tra-va-trang-thai-n8n", () => ({
  docTrangThaiKetNoiN8n: chiChu.docTrangThaiKetNoiN8n,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    channel: { findMany: async () => [] },
    expenseCategory: { findMany: async () => [] },
    setting: { findMany: async () => [] },
    syncLog: { findMany: async () => [] },
    rawPancakeWebhookEvent: { groupBy: async () => [], findMany: async () => [] },
  },
}));
vi.mock("@/lib/shop-profile/doc-shop-profile", () => ({
  docShopProfile: async () => ({ shopName: "Shop", shopPhone: "", shopLogoPath: null }),
}));
vi.mock("@/lib/ket-noi/cau-hinh-shop", () => ({
  layCauHinhShop: async () => ({}),
  tenShopTheoId: () => ({}),
}));
vi.mock("@/lib/reports/doi-chieu-don-kho", () => ({ doiChieuDonKhoVsSan: async () => null }));
vi.mock("@/lib/bronze/ket-cuc-silver", () => ({
  demCanXem: async () => 0,
  demTonDong: async () => ({ tong: 0, cuNhat: null }),
  dsDonCanXem: async () => [],
}));
vi.mock("@/lib/tokens/token-expiry", () => ({ KEY_HAN_TOKEN: [], tinhHanToken: () => [] }));
vi.mock("@/lib/ingest/stock-resync-status", () => ({
  KEY_MOC_VA_TON_KHO: "k",
  tinhTrangVaTonKho: () => null,
}));
vi.mock("@/lib/gia-von/trang-thai-lech-gia-von", () => ({
  KEY_MOC_KIEM_GIA_VON: "a",
  KEY_SO_LECH_GIA_VON: "b",
  trangThaiLechGiaVon: () => ({ soLech: 0, mocLuc: null, gioTruoc: null, muc: "khop" }),
}));

// Section hiển thị: chỉ cần biết "có được dựng không" ⇒ component rỗng mang tên riêng.
vi.mock("@/components/settings/anchor-tabs", () => ({ AnchorTabs: () => null }));
vi.mock("@/components/settings/canh-bao-quyen-n8n", () => ({ CanhBaoQuyenN8n: () => null }));
vi.mock("@/components/settings/channels-section", () => ({ ChannelsSection: () => null }));
vi.mock("@/components/settings/data-section", () => ({ DataSection: () => null }));
vi.mock("@/components/settings/expense-categories-section", () => ({ ExpenseCategoriesSection: () => null }));
vi.mock("@/components/settings/security-section", () => ({ SecuritySection: () => null }));
vi.mock("@/components/settings/shop-info-section", () => ({ ShopInfoSection: () => null }));
vi.mock("@/components/settings/stock-threshold-section", () => ({ StockThresholdSection: () => null }));
vi.mock("@/components/settings/sync-section", () => ({ SyncSection: () => null }));
vi.mock("@/components/settings/khoa-ket-noi/khoa-ket-noi-section", () => ({ KhoaKetNoiSection: () => null }));
vi.mock("@/components/settings/token-expiry-panel", () => ({ TokenExpiryPanel: () => null }));
vi.mock("@/components/settings/doi-chieu-don-kho-section", () => ({ DoiChieuDonKhoSection: () => null }));
vi.mock("@/components/settings/don-ket-bronze-section", () => ({ DonKetBronzeSection: () => null }));
vi.mock("@/components/settings/ket-noi-n8n/ket-noi-n8n-section", () => ({ KetNoiN8nSection: () => null }));
vi.mock("@/components/settings/webhook-events-section", () => ({ WebhookEventsSection: () => null }));
vi.mock("@/components/shell/page-title", () => ({ PageTitle: () => null }));

import CaiDatPage from "@/app/(app)/cai-dat/page";

type Node = { type: unknown; props: Record<string, unknown> };

/** Gom tên mọi component hàm có trong cây phần tử (không render) — để hỏi "khối X có mặt không". */
function tenComponent(node: unknown, ra = new Set<string>()): Set<string> {
  if (!node || typeof node !== "object") return ra;
  const n = node as Node;
  if (typeof n.type === "function") ra.add((n.type as { name: string }).name);
  const con = (n.props as { children?: unknown } | undefined)?.children;
  for (const c of Array.isArray(con) ? con : [con]) tenComponent(c, ra);
  return ra;
}

/** `choPhepSua` của từng phần tử `KhoiSua` (khối bọc form sửa) trong cây. */
function choPhepSuaCuaKhoiSua(node: unknown, ra: unknown[] = []): unknown[] {
  if (!node || typeof node !== "object") return ra;
  const n = node as Node;
  if (typeof n.type === "function" && (n.type as { name: string }).name === "KhoiSua") ra.push(n.props.choPhepSua);
  const con = (n.props as { children?: unknown } | undefined)?.children;
  for (const c of Array.isArray(con) ? con : [con]) choPhepSuaCuaKhoiSua(c, ra);
  return ra;
}

function dat(role: "OWNER" | "STAFF", ...q: Quyen[]) {
  nguoiHienTai = nguoiDungGia({ role, quyen: new Set(q) });
}

beforeEach(() => {
  vi.clearAllMocks();
  chiChu.docTrangThaiSaoLuu.mockResolvedValue({ muc: "tot" });
  chiChu.coDuLieuGiaoDich.mockResolvedValue(true);
  chiChu.demDonMoCoi.mockResolvedValue({ tong: 0 });
  chiChu.demChiPhiKhongDungLai.mockResolvedValue({ tong: 0 });
  chiChu.demAdsMoCoi.mockResolvedValue({ tong: 0 });
  chiChu.docQuyenDocN8n.mockResolvedValue({ ok: true });
  chiChu.docTrangThaiKhoaKetNoi.mockResolvedValue({});
  chiChu.docTrangThaiWebhookPancake.mockResolvedValue({});
  chiChu.docTrangThaiKetNoiN8n.mockResolvedValue({});
});

describe("/cai-dat: khối chỉ chủ shop", () => {
  it("STAFF có cai-dat:xem: không query, không render khoá kết nối/n8n/dữ liệu; vẫn có đổi mật khẩu", async () => {
    dat("STAFF", "cai-dat:xem");
    const ten = tenComponent(await CaiDatPage());

    for (const fn of Object.values(chiChu)) expect(fn).not.toHaveBeenCalled();
    expect(ten.has("KhoaKetNoiSection")).toBe(false);
    expect(ten.has("KetNoiN8nSection")).toBe(false);
    expect(ten.has("DataSection")).toBe(false);
    expect(ten.has("CanhBaoQuyenN8n")).toBe(false);
    expect(ten.has("SecuritySection")).toBe(true);
    expect(ten.has("ChannelsSection")).toBe(true);
  });

  it("STAFF có cai-dat:xem: 4 hàm đếm vùng dữ liệu (ném với STAFF như bản thật) KHÔNG được gọi, trang không ném", async () => {
    // Bản thật của 4 hàm này mở bằng cổng chủ shop và NÉM khi người gọi không phải chủ — dựng lại đúng
    // hành vi đó: trang gọi nhầm cho STAFF là cả `/cai-dat` sập.
    const dem4 = [chiChu.coDuLieuGiaoDich, chiChu.demChiPhiKhongDungLai, chiChu.demDonMoCoi, chiChu.demAdsMoCoi];
    for (const fn of dem4) fn.mockRejectedValue(new Error("Chỉ chủ shop xem được số liệu vùng dữ liệu."));
    dat("STAFF", "cai-dat:xem", "cai-dat:sua");

    await expect(CaiDatPage()).resolves.toBeTruthy();
    for (const fn of dem4) expect(fn).not.toHaveBeenCalled();
  });

  it("chủ shop: query và render đủ", async () => {
    dat("OWNER");
    const ten = tenComponent(await CaiDatPage());

    for (const fn of Object.values(chiChu)) expect(fn).toHaveBeenCalledTimes(1);
    expect(ten.has("KhoaKetNoiSection")).toBe(true);
    expect(ten.has("KetNoiN8nSection")).toBe(true);
    expect(ten.has("DataSection")).toBe(true);
  });

  it("các khối sửa nhận choPhepSua = false khi chỉ có cai-dat:xem, true khi có cai-dat:sua", async () => {
    dat("STAFF", "cai-dat:xem");
    const xem = choPhepSuaCuaKhoiSua(await CaiDatPage());
    expect(xem).toHaveLength(4);
    expect(xem.every((v) => v === false)).toBe(true);

    dat("STAFF", "cai-dat:xem", "cai-dat:sua");
    const sua = choPhepSuaCuaKhoiSua(await CaiDatPage());
    expect(sua.every((v) => v === true)).toBe(true);
  });

  it("không có cai-dat:xem ⇒ /khong-co-quyen", async () => {
    dat("STAFF", "don-hang:xem");
    await expect(CaiDatPage()).rejects.toThrow(/REDIRECT:\/khong-co-quyen/);
  });
});
