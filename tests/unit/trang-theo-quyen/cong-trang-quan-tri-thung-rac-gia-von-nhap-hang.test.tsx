import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PhieuNhapDeXuat } from "@/lib/nhap-hang/doi-chieu-phieu-nhap";
import type { Quyen } from "@/lib/quyen/danh-muc-quyen";
import type { NguoiDung } from "@/lib/quyen/nguoi-dung-phien";
import { nguoiDungGia } from "../../helpers/nguoi-dung-gia";
import { choChuaSoCanh } from "./quet-cay-phan-tu";

/**
 * Cổng TRANG và cổng KHỐI chỉ nằm ở Server Component — test gọi thẳng trang với nguồn dữ liệu mock:
 *  - `/quan-tri`, `/quan-tri/nhat-ky`: chỉ chủ shop, kể cả nhân sự tick đủ mọi quyền — và nguồn
 *    tài khoản/nhật ký KHÔNG được đọc trước khi từ chối;
 *  - `/tai-chinh/thung-rac`: danh sách lọc theo loại người xem được thao tác (`bangDuocPhep`);
 *  - `/san-pham/dong-bo-gia-von`: `san-pham:sua` mà thiếu giá vốn ⇒ từ chối, không đọc đề xuất;
 *  - `/tai-chinh/chi-phi-nhap-hang`: số quỹ chỉ khi có Sổ quỹ; số lượng phiếu chỉ khi có giá vốn.
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
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

const SL_CANH = 7_654_321;
const QUY_CANH = 912_345_678;

const m = vi.hoisted(() => ({
  listTaiKhoan: vi.fn(),
  listNhatKy: vi.fn(),
  listHanhDongDaCo: vi.fn(),
  listThungRac: vi.fn(),
  docDeXuatGiaVon: vi.fn(),
  tinhAnhHuongCogs: vi.fn(),
  docDeXuatPhieuNhap: vi.fn(),
  docTongNguon: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
// Màn nhập hàng đọc mốc bật nợ phải trả (sau bật là màn khác) — ở đây canh màn CHƯA bật.
vi.mock("@/lib/no-phai-tra/cong-bat-no-phai-tra", async (goc) => ({
  ...(await goc<typeof import("@/lib/no-phai-tra/cong-bat-no-phai-tra")>()),
  docMocM: async () => null,
}));
vi.mock("@/lib/quan-tri/tai-khoan-queries", () => ({ listTaiKhoan: m.listTaiKhoan }));
vi.mock("@/lib/quan-tri/nhat-ky-queries", () => ({ listNhatKy: m.listNhatKy, listHanhDongDaCo: m.listHanhDongDaCo }));
vi.mock("@/components/quan-tri/bang-tai-khoan", () => ({ BangTaiKhoan: () => null }));
vi.mock("@/components/quan-tri/phan-trang-nhat-ky", () => ({ PhanTrangNhatKy: () => null }));
vi.mock("@/components/quan-tri/gio-vn", () => ({ formatGioVn: () => "" }));
vi.mock("@/components/quan-tri/nhan-hanh-dong", () => ({ nhanHanhDong: (x: string) => x, nhanKhoaGhiChu: (x: string) => x }));
vi.mock("@/components/shell/page-title", () => ({ PageTitle: () => null }));
vi.mock("@/lib/thung-rac/thung-rac-queries", async (goc) => ({
  ...(await goc<typeof import("@/lib/thung-rac/thung-rac-queries")>()),
  listThungRac: m.listThungRac,
}));
vi.mock("@/components/thung-rac/thung-rac-table", () => ({ ThungRacTable: () => null }));
vi.mock("@/lib/gia-von/doc-de-xuat-gia-von", () => ({ docDeXuatGiaVon: m.docDeXuatGiaVon }));
vi.mock("@/lib/gia-von/anh-huong-cogs", () => ({ tinhAnhHuongCogs: m.tinhAnhHuongCogs }));
vi.mock("@/components/products/ap-gia-von-button", () => ({ ApGiaVonButton: () => null }));
vi.mock("@/lib/nhap-hang/doc-phieu-nhap-bronze", () => ({ docDeXuatPhieuNhap: m.docDeXuatPhieuNhap }));
vi.mock("@/lib/so-quy/so-quy-queries", () => ({ docTongNguon: m.docTongNguon }));
vi.mock("@/lib/so-quy/cong-thuc-so-quy", () => ({ tinhQuyTuTong: () => QUY_CANH }));
vi.mock("@/components/nhap-hang/duyet-chi-phi-nhap-hang", () => ({
  DuyetChiPhiNhapHang: function DuyetChiPhiNhapHang() {
    return null;
  },
}));

import ChiPhiNhapHangPage from "@/app/(app)/tai-chinh/chi-phi-nhap-hang/page";
import ThungRacPage from "@/app/(app)/tai-chinh/thung-rac/page";
import NhatKyPage from "@/app/(app)/quan-tri/nhat-ky/page";
import QuanTriPage from "@/app/(app)/quan-tri/page";
import DongBoGiaVonPage from "@/app/(app)/san-pham/dong-bo-gia-von/page";
import { BANG_THUNG_RAC } from "@/lib/thung-rac/chup-anh-ban-ghi";
import { DANH_MUC_QUYEN } from "@/lib/quyen/danh-muc-quyen";

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

const PHIEU: PhieuNhapDeXuat = {
  uuid: "u-1",
  displayId: 7,
  ngay: new Date(2026, 8, 5),
  soTien: 45_000_000,
  soLuong: SL_CANH,
  soDongHang: 1,
  nhaCungCap: "NCC",
  ghiChu: null,
  refId: "PANCAKE_PURCHASE:u-1",
  lechLuoiKiem: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  m.listTaiKhoan.mockResolvedValue([]);
  m.listNhatKy.mockResolvedValue({ rows: [], tong: 0 });
  m.listHanhDongDaCo.mockResolvedValue([]);
  m.listThungRac.mockResolvedValue({ rows: [], total: 0 });
  m.docDeXuatGiaVon.mockResolvedValue({ deXuat: [], conPhaiNhapTay: 0 });
  m.tinhAnhHuongCogs.mockResolvedValue({ tongDonHopLe: 0, soBienTheChuaBan: 0, theoThang: [] });
  m.docDeXuatPhieuNhap.mockResolvedValue({
    deXuat: [PHIEU],
    daGhi: [],
    boQuaTruocD0: { soPhieu: 0, tongTien: 0 },
    soViecHauKiem: 0,
    canhBao: [],
    d0: new Date(2026, 6, 1),
    soPhieuNhapThat: 1,
  });
  m.docTongNguon.mockResolvedValue({});
});

describe("/quan-tri + /quan-tri/nhat-ky — chỉ chủ shop", () => {
  const MOI_QUYEN = [...DANH_MUC_QUYEN];

  it("nhân sự tick ĐỦ mọi quyền ⇒ /khong-co-quyen, không đọc danh sách tài khoản", async () => {
    dat("STAFF", ...MOI_QUYEN);
    await expect(QuanTriPage()).rejects.toThrow(`REDIRECT:/khong-co-quyen?tu=${encodeURIComponent("/quan-tri")}`);
    expect(m.listTaiKhoan).not.toHaveBeenCalled();
  });

  it("nhân sự tick ĐỦ mọi quyền ⇒ nhật ký cũng từ chối, không đọc nhật ký", async () => {
    dat("STAFF", ...MOI_QUYEN);
    await expect(NhatKyPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      `REDIRECT:/khong-co-quyen?tu=${encodeURIComponent("/quan-tri/nhat-ky")}`,
    );
    expect(m.listNhatKy).not.toHaveBeenCalled();
    expect(m.listTaiKhoan).not.toHaveBeenCalled();
  });

  it("chủ shop ⇒ vào được cả hai", async () => {
    dat("OWNER");
    await QuanTriPage();
    await NhatKyPage({ searchParams: Promise.resolve({}) });
    expect(m.listTaiKhoan).toHaveBeenCalled();
    expect(m.listNhatKy).toHaveBeenCalledTimes(1);
  });
});

describe("/tai-chinh/thung-rac — danh sách lọc theo loại được phép", () => {
  const bangDaHoi = () => (m.listThungRac.mock.calls[0]?.[0] as { bang: string[] }).bang;
  const xemDongGanSoQuy = () =>
    (m.listThungRac.mock.calls[0]?.[0] as { xemDongTienGanSoQuy: boolean }).xemDongTienGanSoQuy;

  it("chỉ chi-phi:sua ⇒ chỉ hỏi Expense", async () => {
    dat("STAFF", "chi-phi:xem", "chi-phi:sua");
    await ThungRacPage({ searchParams: Promise.resolve({}) });
    expect(bangDaHoi()).toEqual(["Expense"]);
  });

  it("chỉ dòng tiền (sửa) ⇒ chỉ CashMovement; chỉ sổ quỹ (sửa) ⇒ Loan/SoTietKiem/ThuNhap + 3 hồ sơ nợ phải trả", async () => {
    dat("STAFF", "tai-chinh-dong-tien:xem", "tai-chinh-dong-tien:sua");
    await ThungRacPage({ searchParams: Promise.resolve({}) });
    expect(bangDaHoi()).toEqual(["CashMovement"]);
    // Thiếu so-quy:sua ⇒ hỏi danh sách KHÔNG kèm dòng tiền gắn khoản vay / sổ tiết kiệm.
    expect(xemDongGanSoQuy()).toBe(false);

    vi.clearAllMocks();
    m.listThungRac.mockResolvedValue({ rows: [], total: 0 });
    dat("STAFF", "tai-chinh-so-quy:xem", "tai-chinh-so-quy:sua");
    await ThungRacPage({ searchParams: Promise.resolve({}) });
    expect([...bangDaHoi()].sort()).toEqual(["Loan", "PhieuNhapNo", "SoTietKiem", "TheTinDung", "ThuNhap", "ViAdsTraTruoc"]);
  });

  it("chủ shop ⇒ mọi loại", async () => {
    dat("OWNER");
    await ThungRacPage({ searchParams: Promise.resolve({}) });
    expect([...bangDaHoi()].sort()).toEqual([...BANG_THUNG_RAC].sort());
    expect(xemDongGanSoQuy()).toBe(true);
  });
});

describe("/san-pham/dong-bo-gia-von — cần sửa sản phẩm VÀ xem giá vốn", () => {
  it("san-pham:sua thiếu giá vốn ⇒ /khong-co-quyen, không đọc đề xuất giá vốn", async () => {
    dat("STAFF", "san-pham:xem", "san-pham:sua");
    await expect(DongBoGiaVonPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      `REDIRECT:/khong-co-quyen?tu=${encodeURIComponent("/san-pham/dong-bo-gia-von")}`,
    );
    expect(m.docDeXuatGiaVon).not.toHaveBeenCalled();
  });

  it("đủ hai quyền ⇒ đọc đề xuất", async () => {
    dat("STAFF", "san-pham:xem", "san-pham:sua", "gia-von-loi-nhuan:xem");
    await DongBoGiaVonPage({ searchParams: Promise.resolve({}) });
    expect(m.docDeXuatGiaVon).toHaveBeenCalledTimes(1);
  });
});

describe("/tai-chinh/chi-phi-nhap-hang — khối quỹ + số lượng phiếu theo quyền", () => {
  const propsDuyet = (el: unknown) => tim(el, "DuyetChiPhiNhapHang")?.props as { deXuat: object[]; quyHomNay: number | null };

  it("chỉ chi-phi:xem ⇒ không đọc quỹ, không số lượng; tổng phiếu vẫn còn", async () => {
    dat("STAFF", "chi-phi:xem");
    const el = await ChiPhiNhapHangPage();

    expect(m.docTongNguon).not.toHaveBeenCalled();
    expect(choChuaSoCanh(el, QUY_CANH)).toEqual([]);
    expect(choChuaSoCanh(el, SL_CANH)).toEqual([]);
    const p = propsDuyet(el);
    expect(p.quyHomNay).toBeNull();
    expect(p.deXuat[0]).not.toHaveProperty("soLuong");
    expect(p.deXuat[0]).toMatchObject({ soTien: 45_000_000, soDongHang: 1 });
  });

  it("có Sổ quỹ (xem) ⇒ có số quỹ; có giá vốn ⇒ có số lượng", async () => {
    dat("STAFF", "chi-phi:xem", "tai-chinh-so-quy:xem");
    let el = await ChiPhiNhapHangPage();
    expect(m.docTongNguon).toHaveBeenCalledTimes(1);
    expect(propsDuyet(el).quyHomNay).toBe(QUY_CANH);
    expect(choChuaSoCanh(el, SL_CANH)).toEqual([]);

    dat("STAFF", "chi-phi:xem", "gia-von-loi-nhuan:xem");
    el = await ChiPhiNhapHangPage();
    expect(propsDuyet(el).deXuat[0]).toMatchObject({ soLuong: SL_CANH });
  });

  it("component: bản che không có cột SL lẫn số lượng; bản đủ có", async () => {
    const { DuyetChiPhiNhapHang } = await vi.importActual<
      typeof import("@/components/nhap-hang/duyet-chi-phi-nhap-hang")
    >("@/components/nhap-hang/duyet-chi-phi-nhap-hang");
    const { chePhieuNhapDeXuat } = await import("@/lib/nhap-hang/doi-chieu-phieu-nhap");

    const che = renderToStaticMarkup(<DuyetChiPhiNhapHang deXuat={chePhieuNhapDeXuat([PHIEU])} vanTay="v" quyHomNay={null} />);
    expect(che).not.toContain(">SL<");
    expect(che).not.toContain(SL_CANH.toLocaleString("vi-VN"));
    expect(che).toContain("45.000.000");

    const du = renderToStaticMarkup(<DuyetChiPhiNhapHang deXuat={[PHIEU]} vanTay="v" quyHomNay={null} />);
    expect(du).toContain(">SL<");
    expect(du).toContain(SL_CANH.toLocaleString("vi-VN"));
  });
});
