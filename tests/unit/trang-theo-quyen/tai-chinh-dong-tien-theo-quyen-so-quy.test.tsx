import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Quyen } from "@/lib/quyen/danh-muc-quyen";
import type { NguoiDung } from "@/lib/quyen/nguoi-dung-phien";
import type { CashFlow } from "@/lib/reports/cash-flow";
import { nguoiDungGia } from "../../helpers/nguoi-dung-gia";
import { choChuaSoCanh, quetGiaTri } from "./quet-cay-phan-tu";

/**
 * `/tai-chinh?tab=dong-tien` theo quyền Sổ quỹ:
 *  - lãi tiết kiệm trong kỳ thuộc Sổ quỹ ⇒ người chỉ có Dòng tiền không nhận số đó ở đâu cả (kể cả
 *    gián tiếp trong số chênh lệch — trừ ngược ra được);
 *  - bảng ghi tay nhận bản KHÔNG liên kết khoản vay/sổ;
 *  - thanh tab hiện "Dòng tiền" cho người chỉ có Sổ quỹ (khối Khoản vay/Tiết kiệm chỉ nằm ở đó).
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
  useRouter: () => ({ refresh: () => {}, replace: () => {}, push: () => {} }),
  usePathname: () => "/tai-chinh",
  useSearchParams: () => new URLSearchParams(),
}));

const LAI_CANH = 7_771_234;
const FLOW: CashFlow = {
  expectedIn: 50_000_000,
  pendingIn: 0,
  pendingCount: 0,
  cashOut: 20_000_000,
  otherIn: 3_000_000,
  otherOut: 1_000_000,
  otherByKind: [],
  thuNhapTaiChinh: LAI_CANH,
  balance: 50_000_000 + 3_000_000 + LAI_CANH - 20_000_000 - 1_000_000,
  outBreakdown: [],
  actualIn: { tiktok: null, shopee: null },
};

const m = vi.hoisted(() => {
  const khong = () => vi.fn().mockResolvedValue(null);
  return {
    computeCashFlow: vi.fn(),
    listCashMovements: vi.fn().mockResolvedValue([]),
    tinhSoQuyThang: vi.fn().mockResolvedValue({ d0: null }),
    listKhoanVay: vi.fn().mockResolvedValue([]),
    tongDangGui: vi.fn(),
    listSoTietKiem: vi.fn().mockResolvedValue([]),
    tongLaiDaNhanTrongKy: vi.fn().mockResolvedValue(0),
    khong,
  };
});

vi.mock("@/lib/reports/pnl", () => ({ calcPnl: vi.fn() }));
vi.mock("@/lib/reports/cash-flow", () => ({ computeCashFlow: m.computeCashFlow, sumGmv: vi.fn() }));
vi.mock("@/lib/reports/platform-fee-breakdown", () => ({
  computePlatformFeeComponents: vi.fn(),
  computeBackfilledPlatformFee: vi.fn(),
}));
vi.mock("@/lib/reports/voucher-breakdown", () => ({ computeVoucherBreakdown: vi.fn() }));
vi.mock("@/lib/reports/pnl-line-items", () => ({ isPnlMonthEmpty: () => true }));
vi.mock("@/lib/reports/doi-soat-tien-ve", () => ({ doiSoatTienVe: async () => undefined }));
vi.mock("@/lib/reports/doi-soat-tien-ve-shopee", () => ({ doiSoatTienVeShopee: async () => undefined }));
vi.mock("@/lib/cash-movements/cash-movement-queries", () => ({ listCashMovements: m.listCashMovements }));
vi.mock("@/lib/vi-san/vi-tiktok-con-lai-toi-thieu-queries", () => ({ docViTiktokConLaiToiThieu: async () => null }));
vi.mock("@/lib/so-quy/so-quy-queries", () => ({ tinhSoQuyThang: m.tinhSoQuyThang }));
vi.mock("@/lib/so-quy/khoan-vay-queries", () => ({ listKhoanVay: m.listKhoanVay }));
vi.mock("@/lib/tiet-kiem/so-tiet-kiem-queries", () => ({
  tongDangGui: m.tongDangGui,
  listSoTietKiem: m.listSoTietKiem,
  tongLaiDaNhanTrongKy: m.tongLaiDaNhanTrongKy,
}));
vi.mock("@/lib/so-quy/doi-chieu-so-du-chot", () => ({
  docSoDuChot: async () => null,
  ghepDoiChieuSoDuChot: () => ({}),
  tinhKhoanCauTruc: () => ({}),
}));
vi.mock("@/lib/so-quy/du-bao-quy-queries", () => ({ docDuBaoQuy: async () => null }));
vi.mock("@/lib/so-quy/dong-chay-so-quy-queries", () => ({ docSoQuyDongChay: async () => ({}) }));
vi.mock("@/lib/expenses/ensure-recurring-expenses", () => ({
  ensureRecurringExpensesForMonths: async () => undefined,
}));
vi.mock("@/lib/date-range-cookie-server", () => ({ docLuaChonDaLuu: async () => null }));
vi.mock("@/components/bao-cao/pnl-tab", () => ({ PnlTab: () => null }));
vi.mock("@/components/bao-cao/report-export-buttons", () => ({
  ReportExportButtons: () => null,
  hrefXuatPnl: () => "",
}));
vi.mock("@/components/finance/cash-flow-tab", () => ({ CashFlowTab: function CashFlowTab() { return null; } }));
vi.mock("@/components/finance/expense-ledger-tab", () => ({ ExpenseLedgerTab: () => null }));
vi.mock("@/components/finance/so-quy-dong-chay-tab", () => ({ SoQuyDongChayTab: () => null }));
vi.mock("@/components/shell/page-title", () => ({ PageTitle: () => null }));

import TaiChinhPage from "@/app/(app)/tai-chinh/page";
import { dongTienKhongLaiTietKiem } from "@/lib/reports/cash-flow-theo-quyen";

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

async function dungTrang(tab?: string) {
  return TaiChinhPage({ searchParams: Promise.resolve(tab ? { tab } : {}) });
}

/** Href các link trên thanh tab. */
function hrefThanhTab(el: unknown): string[] {
  return quetGiaTri(el)
    .filter(({ duong, giaTri }) => /<nav>.*\.href$/.test(duong) && typeof giaTri === "string")
    .map(({ giaTri }) => giaTri as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  m.computeCashFlow.mockResolvedValue(FLOW);
  m.listCashMovements.mockResolvedValue([]);
  m.tinhSoQuyThang.mockResolvedValue({ d0: null });
  m.listKhoanVay.mockResolvedValue([]);
  m.tongDangGui.mockResolvedValue({ tong: 0, daoHanGanNhat: null, gocDaoHanGanNhat: 0, laiDaoHanGanNhat: 0 });
  m.listSoTietKiem.mockResolvedValue([]);
  m.tongLaiDaNhanTrongKy.mockResolvedValue(0);
});

describe("dongTienKhongLaiTietKiem", () => {
  it("bỏ lãi khỏi cả dòng tách lẫn số chênh lệch, không đổi vế nào khác", () => {
    const ra = dongTienKhongLaiTietKiem(FLOW);
    expect(ra.thuNhapTaiChinh).toBe(0);
    expect(ra.balance).toBe(FLOW.expectedIn + FLOW.otherIn - FLOW.cashOut - FLOW.otherOut);
    expect({ ...ra, thuNhapTaiChinh: FLOW.thuNhapTaiChinh, balance: FLOW.balance }).toEqual(FLOW);
  });
});

describe("tab Dòng tiền — lãi tiết kiệm + liên kết khoản vay theo quyền Sổ quỹ", () => {
  it("chỉ Dòng tiền ⇒ không số lãi nào trong cây, bảng ghi tay đọc bản không liên kết", async () => {
    dat("STAFF", "tai-chinh-dong-tien:xem", "tai-chinh-dong-tien:sua");
    const el = await dungTrang("dong-tien");

    expect(choChuaSoCanh(el, LAI_CANH)).toEqual([]);
    const dongTien = tim(el, "CashFlowTab")?.props.dongTien as { flow: CashFlow; hienLaiTietKiem: boolean; choPhepSuaDongSoQuy: boolean };
    expect(dongTien.flow.thuNhapTaiChinh).toBe(0);
    expect(dongTien.flow.balance).toBe(FLOW.balance - LAI_CANH);
    expect(dongTien.hienLaiTietKiem).toBe(false);
    expect(dongTien.choPhepSuaDongSoQuy).toBe(false);
    expect(m.listCashMovements).toHaveBeenCalledWith(expect.anything(), { coQuyenSoQuy: false });
  });

  it("có Sổ quỹ (xem) ⇒ lãi còn nguyên, bảng ghi tay đọc bản đầy đủ", async () => {
    dat("STAFF", "tai-chinh-dong-tien:xem", "tai-chinh-so-quy:xem");
    const el = await dungTrang("dong-tien");

    const dongTien = tim(el, "CashFlowTab")?.props.dongTien as { flow: CashFlow; hienLaiTietKiem: boolean };
    expect(dongTien.flow).toEqual(FLOW);
    expect(dongTien.hienLaiTietKiem).toBe(true);
    expect(m.listCashMovements).toHaveBeenCalledWith(expect.anything(), { coQuyenSoQuy: true });
  });

  it("chủ shop ⇒ đủ, cờ sửa dòng Sổ quỹ bật", async () => {
    dat("OWNER");
    const el = await dungTrang("dong-tien");
    const dongTien = tim(el, "CashFlowTab")?.props.dongTien as { flow: CashFlow; choPhepSuaDongSoQuy: boolean };
    expect(dongTien.flow.thuNhapTaiChinh).toBe(LAI_CANH);
    expect(dongTien.choPhepSuaDongSoQuy).toBe(true);
  });
});

describe("thanh tab /tai-chinh", () => {
  it("chỉ Sổ quỹ ⇒ thanh tab CÓ 'Dòng tiền' (đường vào khối Khoản vay/Tiết kiệm), tab mặc định vẫn Sổ quỹ", async () => {
    dat("STAFF", "tai-chinh-so-quy:xem");
    const el = await dungTrang();
    const href = hrefThanhTab(el);
    expect(href).toContain("/tai-chinh?tab=dong-tien");
    // Sổ quỹ là tab mặc định ⇒ link của nó không mang ?tab=.
    expect(href).toContain("/tai-chinh");
    expect(href.some((h) => h.includes("tab=loi-lo") || h.includes("tab=so-chi-phi"))).toBe(false);
  });

  it("không Dòng tiền lẫn Sổ quỹ ⇒ thanh tab không có 'Dòng tiền'", async () => {
    dat("STAFF", "chi-phi:xem");
    const el = await dungTrang();
    expect(hrefThanhTab(el).some((h) => h.includes("tab=dong-tien"))).toBe(false);
  });
});

describe("CashFlowTab — câu công thức theo quyền", () => {
  it("thiếu Sổ quỹ ⇒ công thức không có vế lãi tiết kiệm; có ⇒ có", async () => {
    const { CashFlowTab } = await vi.importActual<typeof import("@/components/finance/cash-flow-tab")>(
      "@/components/finance/cash-flow-tab",
    );
    const khoi = (hien: boolean) => ({
      flow: hien ? FLOW : dongTienKhongLaiTietKiem(FLOW),
      movements: [],
      viTiktok: null,
      choPhepSua: false,
      choPhepSuaDongSoQuy: false,
      hienLaiTietKiem: hien,
    });

    const thieu = renderToStaticMarkup(<CashFlowTab dongTien={khoi(false)} quy={null} isCurrentMonth={false} />);
    expect(thieu).not.toContain("lãi tiết kiệm");
    expect(thieu).not.toContain(LAI_CANH.toLocaleString("vi-VN"));

    const du = renderToStaticMarkup(<CashFlowTab dongTien={khoi(true)} quy={null} isCurrentMonth={false} />);
    expect(du).toContain("+ lãi tiết kiệm");
    expect(du).toContain(LAI_CANH.toLocaleString("vi-VN"));
  });
});
