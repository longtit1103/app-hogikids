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

const m = vi.hoisted(() => {
  const khong = () => vi.fn().mockResolvedValue(null);
  return {
    calcPnl: khong(),
    sumGmv: khong(),
    computePlatformFeeComponents: khong(),
    computeVoucherBreakdown: khong(),
    computeBackfilledPlatformFee: khong(),
    // Người thiếu Sổ quỹ nhận `flow` đã bỏ lãi tiết kiệm (`dongTienKhongLaiTietKiem`) ⇒ cần đủ 2 vế số.
    computeCashFlow: vi.fn().mockResolvedValue({ balance: 0, thuNhapTaiChinh: 0 }),
    doiSoatTienVe: khong(),
    doiSoatTienVeShopee: khong(),
    listCashMovements: vi.fn().mockResolvedValue([]),
    docViTiktok: khong(),
    tinhSoQuyThang: vi.fn().mockResolvedValue({ d0: null }),
    listKhoanVay: vi.fn().mockResolvedValue([]),
    tongDangGui: vi.fn().mockResolvedValue({ tong: 0, daoHanGanNhat: null, gocDaoHanGanNhat: 0, laiDaoHanGanNhat: 0 }),
    listSoTietKiem: vi.fn().mockResolvedValue([]),
    tongLaiDaNhanTrongKy: vi.fn().mockResolvedValue(0),
    docSoDuChot: khong(),
    ghepDoiChieuSoDuChot: vi.fn().mockReturnValue({}),
    docDuBaoQuy: khong(),
    docSoQuyDongChay: khong(),
  };
});

vi.mock("@/lib/reports/pnl", () => ({ calcPnl: m.calcPnl }));
vi.mock("@/lib/reports/cash-flow", () => ({ computeCashFlow: m.computeCashFlow, sumGmv: m.sumGmv }));
vi.mock("@/lib/reports/platform-fee-breakdown", () => ({
  computePlatformFeeComponents: m.computePlatformFeeComponents,
  computeBackfilledPlatformFee: m.computeBackfilledPlatformFee,
}));
vi.mock("@/lib/reports/voucher-breakdown", () => ({ computeVoucherBreakdown: m.computeVoucherBreakdown }));
vi.mock("@/lib/reports/pnl-line-items", () => ({ isPnlMonthEmpty: () => true }));
vi.mock("@/lib/reports/doi-soat-tien-ve", () => ({ doiSoatTienVe: m.doiSoatTienVe }));
vi.mock("@/lib/reports/doi-soat-tien-ve-shopee", () => ({ doiSoatTienVeShopee: m.doiSoatTienVeShopee }));
vi.mock("@/lib/cash-movements/cash-movement-queries", () => ({ listCashMovements: m.listCashMovements }));
vi.mock("@/lib/vi-san/vi-tiktok-con-lai-toi-thieu-queries", () => ({ docViTiktokConLaiToiThieu: m.docViTiktok }));
vi.mock("@/lib/so-quy/so-quy-queries", () => ({ tinhSoQuyThang: m.tinhSoQuyThang }));
vi.mock("@/lib/so-quy/khoan-vay-queries", () => ({ listKhoanVay: m.listKhoanVay }));
vi.mock("@/lib/tiet-kiem/so-tiet-kiem-queries", () => ({
  tongDangGui: m.tongDangGui,
  listSoTietKiem: m.listSoTietKiem,
  tongLaiDaNhanTrongKy: m.tongLaiDaNhanTrongKy,
}));
vi.mock("@/lib/so-quy/doi-chieu-so-du-chot", () => ({
  docSoDuChot: m.docSoDuChot,
  ghepDoiChieuSoDuChot: m.ghepDoiChieuSoDuChot,
  tinhKhoanCauTruc: () => ({}),
}));
vi.mock("@/lib/so-quy/du-bao-quy-queries", () => ({ docDuBaoQuy: m.docDuBaoQuy }));
vi.mock("@/lib/so-quy/dong-chay-so-quy-queries", () => ({ docSoQuyDongChay: m.docSoQuyDongChay }));
vi.mock("@/lib/expenses/ensure-recurring-expenses", () => ({
  ensureRecurringExpensesForMonths: async () => undefined,
}));
vi.mock("@/lib/date-range-cookie-server", () => ({ docLuaChonDaLuu: async () => null }));
// Thành phần hiển thị không liên quan tới phép đo "nguồn nào được gọi / tab nào được dựng".
vi.mock("@/components/bao-cao/pnl-tab", () => ({ PnlTab: () => null }));
vi.mock("@/components/bao-cao/report-export-buttons", () => ({
  ReportExportButtons: () => null,
  hrefXuatPnl: (ky: string) => `/api/export/bao-cao?tab=pnl&ky=${ky}`,
}));
vi.mock("@/components/finance/cash-flow-tab", () => ({ CashFlowTab: () => null }));
vi.mock("@/components/finance/expense-ledger-tab", () => ({ ExpenseLedgerTab: () => null }));
vi.mock("@/components/finance/so-quy-dong-chay-tab", () => ({ SoQuyDongChayTab: () => null }));
vi.mock("@/components/shell/page-title", () => ({ PageTitle: () => null }));

import TaiChinhPage from "@/app/(app)/tai-chinh/page";

type Node = { type: unknown; props: Record<string, unknown> };

/** Gọi trang rồi lấy props của phần tử `CashFlowTab` trong cây trả về (nếu có). */
async function dungTrang(tab?: string) {
  const el = (await TaiChinhPage({ searchParams: Promise.resolve(tab ? { tab } : {}) })) as Node;
  return el;
}

/** Tìm phần tử theo tên hàm component trong cây phần tử React (không render). */
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

beforeEach(() => {
  vi.clearAllMocks();
  m.listCashMovements.mockResolvedValue([]);
  m.tinhSoQuyThang.mockResolvedValue({ d0: null });
  m.listKhoanVay.mockResolvedValue([]);
  m.tongDangGui.mockResolvedValue({ tong: 0, daoHanGanNhat: null, gocDaoHanGanNhat: 0, laiDaoHanGanNhat: 0 });
  m.listSoTietKiem.mockResolvedValue([]);
  m.tongLaiDaNhanTrongKy.mockResolvedValue(0);
  m.ghepDoiChieuSoDuChot.mockReturnValue({});
});

describe("/tai-chinh theo quyền", () => {
  it("chỉ dòng tiền: tab mặc định Dòng tiền, KHÔNG query khối quỹ/vay/tiết kiệm", async () => {
    dat("STAFF", "tai-chinh-dong-tien:xem");
    const el = await dungTrang();
    expect(m.computeCashFlow).toHaveBeenCalledTimes(1);
    expect(m.listCashMovements).toHaveBeenCalledTimes(1);
    expect(m.tinhSoQuyThang).not.toHaveBeenCalled();
    expect(m.listKhoanVay).not.toHaveBeenCalled();
    expect(m.tongDangGui).not.toHaveBeenCalled();
    expect(m.listSoTietKiem).not.toHaveBeenCalled();
    expect(m.tongLaiDaNhanTrongKy).not.toHaveBeenCalled();
    expect(m.docSoDuChot).not.toHaveBeenCalled();
    expect(m.calcPnl).not.toHaveBeenCalled();
    const tab = tim(el, "CashFlowTab");
    expect(tab?.props.quy).toBeNull();
    expect(tab?.props.dongTien).not.toBeNull();
  });

  it("?tab=loi-lo khi chỉ có dòng tiền ⇒ /khong-co-quyen, không rơi về tab mặc định", async () => {
    dat("STAFF", "tai-chinh-dong-tien:xem");
    await expect(dungTrang("loi-lo")).rejects.toThrow(
      `REDIRECT:/khong-co-quyen?tu=${encodeURIComponent("/tai-chinh?tab=loi-lo")}`,
    );
    expect(m.calcPnl).not.toHaveBeenCalled();
    expect(m.computeCashFlow).not.toHaveBeenCalled();
  });

  it("chỉ sổ quỹ: tab Sổ quỹ là mặc định ở thanh tab; vào ?tab=dong-tien chỉ có khối quỹ", async () => {
    dat("STAFF", "tai-chinh-so-quy:xem");
    const el = await dungTrang("dong-tien");
    expect(m.tinhSoQuyThang).toHaveBeenCalledTimes(1);
    expect(m.listKhoanVay).toHaveBeenCalledTimes(1);
    expect(m.computeCashFlow).not.toHaveBeenCalled();
    expect(m.listCashMovements).not.toHaveBeenCalled();
    expect(m.doiSoatTienVe).not.toHaveBeenCalled();
    expect(m.docSoDuChot).not.toHaveBeenCalled();
    const tab = tim(el, "CashFlowTab");
    expect(tab?.props.dongTien).toBeNull();
    expect(tab?.props.quy).not.toBeNull();
  });

  it("chỉ sổ quỹ, không ?tab ⇒ dựng tab Sổ quỹ (mặc định = tab đầu còn lại)", async () => {
    dat("STAFF", "tai-chinh-so-quy:xem");
    m.docSoQuyDongChay.mockResolvedValue({});
    await dungTrang();
    expect(m.docSoQuyDongChay).toHaveBeenCalledTimes(1);
    expect(m.computeCashFlow).not.toHaveBeenCalled();
  });

  it("chủ shop: Lãi/Lỗ mặc định; dòng tiền tải đủ hai nhóm + bản chốt", async () => {
    dat("OWNER");
    await dungTrang();
    expect(m.calcPnl).toHaveBeenCalled();

    vi.clearAllMocks();
    m.listCashMovements.mockResolvedValue([]);
    m.tinhSoQuyThang.mockResolvedValue({ d0: null });
    m.listKhoanVay.mockResolvedValue([]);
    m.tongDangGui.mockResolvedValue({ tong: 0, daoHanGanNhat: null, gocDaoHanGanNhat: 0, laiDaoHanGanNhat: 0 });
    m.listSoTietKiem.mockResolvedValue([]);
    m.tongLaiDaNhanTrongKy.mockResolvedValue(0);
    await dungTrang("dong-tien");
    expect(m.computeCashFlow).toHaveBeenCalledTimes(1);
    expect(m.tinhSoQuyThang).toHaveBeenCalledTimes(1);
    expect(m.docSoDuChot).toHaveBeenCalledTimes(2);
  });

  it("không quyền tài chính nào ⇒ /khong-co-quyen từ cổng trang", async () => {
    dat("STAFF", "don-hang:xem");
    await expect(dungTrang()).rejects.toThrow(/REDIRECT:\/khong-co-quyen/);
  });

  it("chưa đăng nhập ⇒ /dang-nhap", async () => {
    nguoiHienTai = null;
    await expect(dungTrang()).rejects.toThrow(/REDIRECT:\/dang-nhap/);
  });
});
