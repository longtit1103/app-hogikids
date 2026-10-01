import { beforeEach, describe, expect, it, vi } from "vitest";

import { nguoiDungGia } from "../../helpers/nguoi-dung-gia";
import type { NguoiDung } from "@/lib/quyen/nguoi-dung-phien";
import type { Quyen } from "@/lib/quyen/danh-muc-quyen";

/**
 * `/cai-dat` khối Webhook: dòng "Giá vốn: N mã đang lệch với Pancake" là tín hiệu thuộc vùng giá vốn
 * (cùng luật banner layout) — người `cai-dat:xem` thiếu `gia-von-loi-nhuan:xem` không đọc hai khoá
 * Setting đó và section nhận `hienGiaVon=false`. Component mặc định ẩn khi không truyền cờ.
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
  settingFindMany: vi.fn(),
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
    setting: { findMany: chiChu.settingFindMany },
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
vi.mock("@/components/settings/webhook-events-section", () => ({
  WebhookEventsSection: function WebhookEventsSection() {
    return null;
  },
}));
vi.mock("@/components/shell/page-title", () => ({ PageTitle: () => null }));

import { renderToStaticMarkup } from "react-dom/server";

import CaiDatPage from "@/app/(app)/cai-dat/page";

type Node = { type: unknown; props: Record<string, unknown> };

function tim(node: unknown, ten: string): Node | null {
  if (!node || typeof node !== "object") return null;
  const n = node as Node;
  if (typeof n.type === "function" && (n.type as { name: string }).name === ten) return n;
  const con = (n.props as { children?: unknown } | undefined)?.children;
  for (const c of Array.isArray(con) ? con : [con]) {
    const r = tim(c, ten);
    if (r) return r;
  }
  return null;
}

function dat(role: "OWNER" | "STAFF", ...q: Quyen[]) {
  nguoiHienTai = nguoiDungGia({ role, quyen: new Set(q) });
}

/** Khoá Setting trang đã hỏi DB. */
function khoaSettingDaDoc(): string[] {
  const arg = chiChu.settingFindMany.mock.calls[0]?.[0] as { where: { key: { in: string[] } } };
  return arg.where.key.in;
}

beforeEach(() => {
  vi.clearAllMocks();
  chiChu.settingFindMany.mockResolvedValue([]);
});

describe("/cai-dat — số mã lệch giá vốn theo quyền giá vốn", () => {
  it("cai-dat:xem thiếu giá vốn ⇒ không đọc khoá lệch giá vốn, section nhận hienGiaVon=false", async () => {
    dat("STAFF", "cai-dat:xem");
    const el = await CaiDatPage();
    // Khoá giả lập của module trạng thái lệch giá vốn: "a" (mốc kiểm) và "b" (số lệch).
    expect(khoaSettingDaDoc()).not.toContain("a");
    expect(khoaSettingDaDoc()).not.toContain("b");
    expect(tim(el, "WebhookEventsSection")?.props.hienGiaVon).toBe(false);
  });

  it("có giá vốn ⇒ đọc khoá + hienGiaVon=true; chủ shop cũng vậy", async () => {
    dat("STAFF", "cai-dat:xem", "gia-von-loi-nhuan:xem");
    let el = await CaiDatPage();
    expect(khoaSettingDaDoc()).toEqual(expect.arrayContaining(["a", "b"]));
    expect(tim(el, "WebhookEventsSection")?.props.hienGiaVon).toBe(true);

    vi.clearAllMocks();
    chiChu.settingFindMany.mockResolvedValue([]);
    dat("OWNER");
    el = await CaiDatPage();
    expect(tim(el, "WebhookEventsSection")?.props.hienGiaVon).toBe(true);
  });
});

describe("WebhookEventsSection — dòng giá vốn", () => {
  it("không truyền cờ / false ⇒ không in số mã lệch; true ⇒ in", async () => {
    const { WebhookEventsSection } = await vi.importActual<typeof import("@/components/settings/webhook-events-section")>(
      "@/components/settings/webhook-events-section",
    );
    const props = {
      demTheoKetCuc: [],
      canXem: [],
      vaTonKho: { muc: "ok" as const, mocLuc: new Date(2026, 9, 1), gioTruoc: 1 },
      lechGiaVon: { muc: "co-lech" as const, soLech: 37, mocLuc: new Date(2026, 9, 1), gioTruoc: 1 },
      tenShop: {},
    };
    const an = renderToStaticMarkup(<WebhookEventsSection {...props} />);
    expect(an).not.toContain("Giá vốn");
    expect(an).not.toContain("37 mã");
    expect(renderToStaticMarkup(<WebhookEventsSection {...props} hienGiaVon={false} />)).not.toContain("Giá vốn");
    expect(renderToStaticMarkup(<WebhookEventsSection {...props} hienGiaVon />)).toContain("37 mã đang lệch");
  });
});
