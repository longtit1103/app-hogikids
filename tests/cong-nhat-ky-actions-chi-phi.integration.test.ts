import { format, startOfMonth } from "date-fns";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Quyen } from "@/lib/quyen/danh-muc-quyen";

/**
 * Cổng quyền + nhật ký cho SỔ CHI PHÍ + chi phí nhập hàng (spec phân quyền §1.1, §3.4, §5). Quyền
 * `chi-phi:sua`. Nhật ký ghi kèm tháng của khoản chi (không kèm số tiền — spec §5 cấm giá trị).
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

import { ghiChiPhiNhapHang } from "@/lib/actions/chi-phi-nhap-hang";
import { batLaiDinhKy, createExpense, deleteExpense, stopRecurring, updateExpense } from "@/lib/actions/expenses";
import { ghiNhatKy } from "@/lib/nhat-ky/ghi-nhat-ky";
import { prisma } from "@/lib/prisma";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";
import { nguoiDungGia } from "./helpers/nguoi-dung-gia";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

const khoanChi = { date: "2026-07-10", categoryId: "other", amount: 1_500_000, channelId: null, description: "Thử nhật ký", recurringMonthly: false };
const THANG_NAY = format(startOfMonth(new Date()), "yyyy-MM");

const nhanVien = (...quyen: Quyen[]) => nguoiDungGia({ id: "staff-1", email: "nv@hogikids.test", role: "STAFF", quyen: new Set(quyen) });
const dangNhapLa = (nd: ReturnType<typeof nguoiDungGia>) => vi.mocked(docNguoiDungPhien).mockResolvedValue(nd);
const nhatKy = (hanhDong: string) => prisma.auditLog.findMany({ where: { hanhDong }, orderBy: { thoiDiem: "asc" } });

async function mauDaDung(): Promise<string> {
  const mau = await prisma.recurringExpense.create({
    data: { categoryId: "fixed", amount: 2_000_000, dayOfMonth: 1, description: "Mặt bằng", active: false },
  });
  return mau.id;
}

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.auditLog.deleteMany();
  vi.mocked(ghiNhatKy).mockClear();
  dangNhapLa(nguoiDungGia());
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.auditLog.deleteMany();
  await prisma.$disconnect();
});

describe("sổ chi phí — lượt ghi thật ⇒ nhật ký OK đúng mã", () => {
  it("tạo / sửa / xoá khoản chi kèm tháng", async () => {
    expect((await createExpense(khoanChi)).ok).toBe(true);
    const row = await prisma.expense.findFirstOrThrow();
    expect((await updateExpense(row.id, { ...khoanChi, amount: 1_000_000 })).ok).toBe(true);
    expect((await deleteExpense(row.id, "only")).ok).toBe(true);

    for (const hd of ["CHI_PHI_TAO", "CHI_PHI_SUA", "CHI_PHI_XOA"]) {
      expect(await nhatKy(hd), hd).toMatchObject([
        { ketQua: "OK", doiTuongLoai: "Expense", doiTuongId: row.id, ghiChu: { thang: "2026-07" } },
      ]);
    }
  });

  it("tạo khoản lặp hàng tháng ⇒ một dòng CHI_PHI_TAO trỏ dòng Expense đầu tiên", async () => {
    expect((await createExpense({ ...khoanChi, recurringMonthly: true })).ok).toBe(true);
    const row = await prisma.expense.findFirstOrThrow();
    expect(await nhatKy("CHI_PHI_TAO")).toMatchObject([{ doiTuongId: row.id }]);
  });

  it("bật lại / dừng định kỳ ⇒ đúng mã, đối tượng là mẫu định kỳ", async () => {
    const id = await mauDaDung();
    expect((await batLaiDinhKy(id, { thangBatDau: THANG_NAY })).ok).toBe(true);
    expect((await stopRecurring(id)).ok).toBe(true);

    expect(await nhatKy("CHI_PHI_BAT_DINH_KY")).toMatchObject([
      { ketQua: "OK", doiTuongLoai: "RecurringExpense", doiTuongId: id, ghiChu: { thang: THANG_NAY } },
    ]);
    expect(await nhatKy("CHI_PHI_DUNG_DINH_KY")).toMatchObject([{ ketQua: "OK", doiTuongId: id }]);
  });

  it("bật lại mẫu ĐANG chạy (không đổi gì) ⇒ không có dòng OK", async () => {
    const id = await mauDaDung();
    await batLaiDinhKy(id, { thangBatDau: THANG_NAY });
    await prisma.auditLog.deleteMany();

    expect((await batLaiDinhKy(id, { thangBatDau: THANG_NAY })).ok).toBe(false);
    expect(await nhatKy("CHI_PHI_BAT_DINH_KY")).toHaveLength(0);
  });
});

describe("sổ chi phí — thiếu quyền", () => {
  it("chỉ quyền XEM chi phí (+ sổ quỹ sửa) ⇒ mọi action ghi KHONG_CO_QUYEN, không đổi gì", async () => {
    await createExpense(khoanChi);
    const row = await prisma.expense.findFirstOrThrow();
    const id = await mauDaDung();
    await prisma.auditLog.deleteMany();
    dangNhapLa(nhanVien("chi-phi:xem", "tai-chinh-so-quy:xem", "tai-chinh-so-quy:sua"));

    const ket = [
      await createExpense(khoanChi),
      await updateExpense(row.id, { ...khoanChi, amount: 1 }),
      await deleteExpense(row.id, "only"),
      await batLaiDinhKy(id, { thangBatDau: THANG_NAY }),
      await stopRecurring(id),
      await ghiChiPhiNhapHang({ vanTay: "x", chon: [{ uuid: "u", soTien: 1 }] }),
    ];

    for (const r of ket) expect(r).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    expect(await prisma.expense.count()).toBe(1);
    expect((await prisma.expense.findFirstOrThrow()).amount).toBe(khoanChi.amount);
    expect((await prisma.recurringExpense.findUniqueOrThrow({ where: { id } })).active).toBe(false);
    const tuChoi = await nhatKy("TU_CHOI_QUYEN");
    expect(tuChoi).toHaveLength(6);
    for (const d of tuChoi) expect(d).toMatchObject({ actorId: "staff-1", ghiChu: { quyenThieu: "chi-phi:sua" } });
  });

  it("nhân sự có `chi-phi:sua` ⇒ ghi được, actor là chính người đó", async () => {
    dangNhapLa(nhanVien("chi-phi:xem", "chi-phi:sua"));

    expect((await createExpense(khoanChi)).ok).toBe(true);
    expect(await nhatKy("CHI_PHI_TAO")).toMatchObject([{ actorId: "staff-1", actorEmail: "nv@hogikids.test" }]);
  });
});

describe("sổ chi phí — nhật ký ném ⇒ không lưu gì", () => {
  it("tạo: không dòng Expense", async () => {
    vi.mocked(ghiNhatKy).mockRejectedValueOnce(new Error("nhật ký hỏng giả lập"));

    expect((await createExpense(khoanChi)).ok).toBe(false);
    expect(await prisma.expense.count()).toBe(0);
  });

  it("sửa: số tiền giữ nguyên", async () => {
    await createExpense(khoanChi);
    const row = await prisma.expense.findFirstOrThrow();
    vi.mocked(ghiNhatKy).mockRejectedValueOnce(new Error("nhật ký hỏng giả lập"));

    expect((await updateExpense(row.id, { ...khoanChi, amount: 1 })).ok).toBe(false);
    expect((await prisma.expense.findUniqueOrThrow({ where: { id: row.id } })).amount).toBe(khoanChi.amount);
  });

  it("xoá: dòng còn nguyên, thùng rác trống, có dòng LOI", async () => {
    await createExpense(khoanChi);
    const row = await prisma.expense.findFirstOrThrow();
    vi.mocked(ghiNhatKy).mockRejectedValueOnce(new Error("nhật ký hỏng giả lập"));

    expect((await deleteExpense(row.id, "only")).ok).toBe(false);
    expect(await prisma.expense.count()).toBe(1);
    expect(await prisma.banGhiDaXoa.count()).toBe(0);
    expect(await nhatKy("CHI_PHI_XOA")).toMatchObject([{ ketQua: "LOI", doiTuongId: row.id, ghiChu: { lyDo: "Error" } }]);
  });

  it("dừng định kỳ: mẫu vẫn chạy, câu báo không đội lốt 'không tìm thấy'", async () => {
    const id = await mauDaDung();
    await batLaiDinhKy(id, { thangBatDau: THANG_NAY });
    vi.mocked(ghiNhatKy).mockRejectedValueOnce(new Error("nhật ký hỏng giả lập"));

    const res = await stopRecurring(id);

    expect(res).toMatchObject({ ok: false, error: "Lỗi khi dừng khoản định kỳ" });
    expect((await prisma.recurringExpense.findUniqueOrThrow({ where: { id } })).active).toBe(true);
  });

  it("dừng định kỳ id lạ ⇒ vẫn 'Không tìm thấy khoản định kỳ'", async () => {
    expect(await stopRecurring("khong-ton-tai")).toMatchObject({ ok: false, error: "Không tìm thấy khoản định kỳ" });
  });
});
