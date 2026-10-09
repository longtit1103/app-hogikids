import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Quyen } from "@/lib/quyen/danh-muc-quyen";

/**
 * Thùng rác — quyền theo LOẠI BẢN GHI thực tế (spec phân quyền §1.4).
 *
 * `bang` đọc từ DB TRONG transaction của helper, không tin client; quyền kiểm TRƯỚC con dấu CAS; dòng
 * nhật ký là câu cuối của CÙNG transaction — nhật ký ném ⇒ cụm dựng lại + con dấu rollback trọn.
 */
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => ({
  ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
  docNguoiDungPhien: vi.fn(),
}));
vi.mock("@/lib/nhat-ky/ghi-nhat-ky", async (goc) => {
  const that = await goc<typeof import("@/lib/nhat-ky/ghi-nhat-ky")>();
  return { ...that, ghiNhatKy: vi.fn(that.ghiNhatKy) };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { deleteExpense } from "@/lib/actions/expenses";
import { taoKhoanVay, xoaKhoanVay } from "@/lib/actions/khoan-vay";
import { khoiPhucBanGhi, xoaVinhVienBanGhi } from "@/lib/actions/thung-rac";
import { ghiNhatKy } from "@/lib/nhat-ky/ghi-nhat-ky";
import { prisma } from "@/lib/prisma";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";
import { BANG_THUNG_RAC } from "@/lib/thung-rac/chup-anh-ban-ghi";
import { bangDuocPhep, listThungRac, QUYEN_THEO_BANG, QUYEN_VAO_THUNG_RAC } from "@/lib/thung-rac/thung-rac-queries";
import { nguoiDungGia } from "./helpers/nguoi-dung-gia";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

const HOM_NAY = new Date(2026, 10, 1, 9, 0, 0);
const KHOAN_VAY = {
  name: "Vay thử thùng rác",
  lender: "VPBank",
  annualRateBp: 1050,
  coLich: true,
  termMonths: 12,
  firstDueDate: "2026-10-10",
  cheDo: "moi",
  soTienGiaiNgan: 200_000_000,
  ngayGiaiNgan: "2026-09-05",
  note: "",
};

const chuShop = () => nguoiDungGia();
const nhanVien = (...quyen: Quyen[]) => nguoiDungGia({ id: "staff-1", email: "nv@hogikids.test", role: "STAFF", quyen: new Set(quyen) });
const KE_TOAN_CHI_PHI = nhanVien("chi-phi:xem", "chi-phi:sua");
const KE_TOAN_SO_QUY = nhanVien("tai-chinh-so-quy:xem", "tai-chinh-so-quy:sua");
const dangNhapLa = (nd: ReturnType<typeof nguoiDungGia>) => vi.mocked(docNguoiDungPhien).mockResolvedValue(nd);
const nhatKy = (hanhDong: string) => prisma.auditLog.findMany({ where: { hanhDong }, orderBy: { thoiDiem: "asc" } });

/** Khoản vay vào thùng rác (chủ shop tạo rồi xoá) ⇒ id dòng `BanGhiDaXoa`. */
async function khoanVayTrongThungRac(): Promise<{ dongId: string; loanId: string }> {
  dangNhapLa(chuShop());
  const tao = await taoKhoanVay(KHOAN_VAY);
  if (!tao.ok) throw new Error(tao.error);
  const xoa = await xoaKhoanVay(tao.data.id);
  if (!xoa.ok) throw new Error(xoa.error);
  const dong = await prisma.banGhiDaXoa.findFirstOrThrow({ where: { bang: "Loan" } });
  return { dongId: dong.id, loanId: tao.data.id };
}

/** Khoản chi vào thùng rác. */
async function khoanChiTrongThungRac(): Promise<string> {
  dangNhapLa(chuShop());
  const chi = await prisma.expense.create({
    data: { date: new Date(2026, 6, 10), categoryId: "shipping", description: "Cước", amount: 100_000, source: "MANUAL" },
  });
  const xoa = await deleteExpense(chi.id, "only");
  if (!xoa.ok) throw new Error(xoa.error);
  return (await prisma.banGhiDaXoa.findFirstOrThrow({ where: { bang: "Expense" } })).id;
}

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.auditLog.deleteMany();
  vi.mocked(ghiNhatKy).mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(HOM_NAY);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.auditLog.deleteMany();
  await prisma.$disconnect();
});

describe("bảng quyền thùng rác", () => {
  it("mọi loại bản ghi đều có quyền; quyền vào trang = đúng tập quyền theo loại", () => {
    expect(Object.keys(QUYEN_THEO_BANG).sort()).toEqual([...BANG_THUNG_RAC].sort());
    expect([...new Set(Object.values(QUYEN_THEO_BANG))].sort()).toEqual([...QUYEN_VAO_THUNG_RAC].sort());
  });

  it("bangDuocPhep: chủ shop ⇒ tất cả; kế toán chi phí ⇒ chỉ Expense; không quyền sửa ⇒ rỗng", () => {
    expect(bangDuocPhep(chuShop()).sort()).toEqual([...BANG_THUNG_RAC].sort());
    expect(bangDuocPhep(KE_TOAN_CHI_PHI)).toEqual(["Expense"]);
    expect(bangDuocPhep(KE_TOAN_SO_QUY).sort()).toEqual(
      ["Loan", "PhieuNhapNo", "SoTietKiem", "TheTinDung", "ThuNhap", "ViAdsTraTruoc"]
    );
    expect(bangDuocPhep(nhanVien("chi-phi:xem", "tai-chinh-so-quy:xem"))).toEqual([]);
  });
});

describe("khôi phục theo loại bản ghi", () => {
  it("chỉ `chi-phi:sua` khôi phục khoản VAY ⇒ KHONG_CO_QUYEN, mục vẫn trong thùng rác, nhật ký nêu quyền thiếu", async () => {
    const { dongId, loanId } = await khoanVayTrongThungRac();
    await prisma.auditLog.deleteMany();
    dangNhapLa(KE_TOAN_CHI_PHI);

    const res = await khoiPhucBanGhi(dongId);

    expect(res).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    expect((await prisma.banGhiDaXoa.findUniqueOrThrow({ where: { id: dongId } })).khoiPhucLuc).toBeNull();
    expect(await prisma.loan.count({ where: { id: loanId } })).toBe(0);
    expect(await nhatKy("TU_CHOI_QUYEN")).toMatchObject([
      { ketQua: "LOI", actorId: "staff-1", ghiChu: { quyenThieu: "tai-chinh-so-quy:sua" } },
    ]);
    expect(await nhatKy("THUNG_RAC_KHOI_PHUC")).toHaveLength(0);
  });

  it("cùng người đó: danh sách lọc theo bangDuocPhep KHÔNG có dòng khoản vay", async () => {
    await khoanVayTrongThungRac();
    const chiId = await khoanChiTrongThungRac();

    const { rows, total } = await listThungRac({ bang: bangDuocPhep(KE_TOAN_CHI_PHI), xemDongTienGanSoQuy: false });

    expect(rows.map((r) => r.id)).toEqual([chiId]);
    expect(total).toBe(1);
    expect(await listThungRac({ bang: [], xemDongTienGanSoQuy: true })).toEqual({ rows: [], total: 0 });
    expect((await listThungRac({ bang: bangDuocPhep(chuShop()), xemDongTienGanSoQuy: true })).total).toBe(2);
  });

  it("người có `tai-chinh-so-quy:sua` khôi phục OK + nhật ký THUNG_RAC_KHOI_PHUC kèm loại", async () => {
    const { dongId, loanId } = await khoanVayTrongThungRac();
    dangNhapLa(KE_TOAN_SO_QUY);

    expect((await khoiPhucBanGhi(dongId)).ok).toBe(true);

    expect(await prisma.loan.count({ where: { id: loanId } })).toBe(1);
    expect(await nhatKy("THUNG_RAC_KHOI_PHUC")).toMatchObject([
      { ketQua: "OK", actorId: "staff-1", doiTuongLoai: "Loan", doiTuongId: loanId, ghiChu: { loaiBanGhi: "Loan" } },
    ]);
  });

  it("chỉ quyền XEM ⇒ bị chặn ngay ở cổng action (cần ít nhất một quyền sửa)", async () => {
    const chiId = await khoanChiTrongThungRac();
    dangNhapLa(nhanVien("chi-phi:xem", "tai-chinh-dong-tien:xem"));

    expect(await khoiPhucBanGhi(chiId)).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    expect(await xoaVinhVienBanGhi(chiId)).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    expect(await prisma.expense.count()).toBe(0);
    expect(await prisma.banGhiDaXoa.count()).toBe(1);
  });

  it("nhật ký ném ⇒ con dấu CAS vẫn null, không dòng nào được dựng lại, kết quả ok:false", async () => {
    const { dongId, loanId } = await khoanVayTrongThungRac();
    const dongTienTruoc = await prisma.cashMovement.count();
    dangNhapLa(chuShop());
    vi.mocked(ghiNhatKy).mockRejectedValueOnce(new Error("nhật ký hỏng giả lập"));

    const res = await khoiPhucBanGhi(dongId);

    expect(res.ok).toBe(false);
    expect((await prisma.banGhiDaXoa.findUniqueOrThrow({ where: { id: dongId } })).khoiPhucLuc).toBeNull();
    expect(await prisma.loan.count({ where: { id: loanId } })).toBe(0);
    expect(await prisma.cashMovement.count()).toBe(dongTienTruoc);
    // Lần sau (nhật ký lành) vẫn khôi phục được — con dấu không bị đóng oan.
    expect((await khoiPhucBanGhi(dongId)).ok).toBe(true);
  });

  it("hai lượt khôi phục cùng lúc bởi người đủ quyền ⇒ hành vi CAS giữ nguyên: 1 OK, 1 'đã được khôi phục'", async () => {
    const { dongId } = await khoanVayTrongThungRac();
    dangNhapLa(KE_TOAN_SO_QUY);

    const ket = await Promise.all([khoiPhucBanGhi(dongId), khoiPhucBanGhi(dongId)]);

    expect(ket.filter((r) => r.ok)).toHaveLength(1);
    const thua = ket.find((r) => !r.ok);
    expect(thua).toMatchObject({ ok: false, error: "Mục này đã được khôi phục" });
    expect(await nhatKy("THUNG_RAC_KHOI_PHUC")).toHaveLength(1);
  });
});

describe("xoá vĩnh viễn theo loại bản ghi", () => {
  it("chỉ `chi-phi:sua` xoá vĩnh viễn khoản VAY ⇒ KHONG_CO_QUYEN, mục còn nguyên", async () => {
    const { dongId } = await khoanVayTrongThungRac();
    await prisma.auditLog.deleteMany();
    dangNhapLa(KE_TOAN_CHI_PHI);

    expect(await xoaVinhVienBanGhi(dongId)).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    expect(await prisma.banGhiDaXoa.count({ where: { id: dongId } })).toBe(1);
    expect(await nhatKy("TU_CHOI_QUYEN")).toMatchObject([{ ghiChu: { quyenThieu: "tai-chinh-so-quy:sua" } }]);
  });

  it("đúng quyền ⇒ xoá + nhật ký THUNG_RAC_XOA_VINH_VIEN kèm loại", async () => {
    const chiId = await khoanChiTrongThungRac();
    const banGhiId = (await prisma.banGhiDaXoa.findUniqueOrThrow({ where: { id: chiId } })).banGhiId;
    dangNhapLa(KE_TOAN_CHI_PHI);

    expect((await xoaVinhVienBanGhi(chiId)).ok).toBe(true);

    expect(await prisma.banGhiDaXoa.count()).toBe(0);
    expect(await nhatKy("THUNG_RAC_XOA_VINH_VIEN")).toMatchObject([
      { ketQua: "OK", doiTuongLoai: "Expense", doiTuongId: banGhiId, ghiChu: { loaiBanGhi: "Expense" } },
    ]);
  });

  it("nhật ký ném ⇒ mục vẫn còn trong thùng rác + dòng LOI", async () => {
    const chiId = await khoanChiTrongThungRac();
    vi.mocked(ghiNhatKy).mockRejectedValueOnce(new Error("nhật ký hỏng giả lập"));

    const res = await xoaVinhVienBanGhi(chiId);

    expect(res).toMatchObject({ ok: false, error: "Lỗi khi xoá vĩnh viễn" });
    expect(await prisma.banGhiDaXoa.count({ where: { id: chiId } })).toBe(1);
    expect(await nhatKy("THUNG_RAC_XOA_VINH_VIEN")).toMatchObject([{ ketQua: "LOI", ghiChu: { lyDo: "Error" } }]);
  });

  it("id lạ ⇒ 'Không tìm thấy mục trong thùng rác' (như cũ)", async () => {
    dangNhapLa(chuShop());
    expect(await xoaVinhVienBanGhi("khong-ton-tai")).toMatchObject({ ok: false, error: "Không tìm thấy mục trong thùng rác" });
  });
});
