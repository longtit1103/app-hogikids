import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Quyen } from "@/lib/quyen/danh-muc-quyen";

/**
 * Cổng quyền + nhật ký cho nhóm action KHOẢN VAY + tất toán thấu chi (spec phân quyền §1.1, §3.4, §5).
 * Quyền là `tai-chinh-so-quy:sua`. Nhật ký OK ghi TRONG transaction đang giữ khoá dòng `Loan` — nhật
 * ký ném là cả cụm (hồ sơ, dòng gốc, lãi, con dấu kỳ) rollback. Lượt ghi tiền bị từ chối (tất toán,
 * ghi kỳ, xoá) để lại dòng LOI kèm mã lỗi ngắn.
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

import { createCashMovement } from "@/lib/actions/cash-movements";
import { ghiKyTraNo, suaKhoanVay, taoKhoanVay, tatToanKhoanVay, xoaKhoanVay } from "@/lib/actions/khoan-vay";
import { tatToanThauChi } from "@/lib/actions/tat-toan-thau-chi";
import { ghiNhatKy } from "@/lib/nhat-ky/ghi-nhat-ky";
import { prisma } from "@/lib/prisma";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";
import { nguoiDungGia } from "./helpers/nguoi-dung-gia";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

const HOM_NAY = new Date(2026, 10, 1, 9, 0, 0);

const KHOAN_MOI = {
  name: "Vay thử nhật ký",
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
const KY1 = { dueDate: "2026-10-10", lai: 2_013_699, goc: 16_666_667 };
const THAU_CHI = { ...KHOAN_MOI, name: "Thấu chi thử", kind: "OVERDRAFT", termMonths: undefined, soTienGiaiNgan: 100_000_000, annualRateBp: 1200 };

const nhanVien = (...quyen: Quyen[]) => nguoiDungGia({ id: "staff-1", email: "nv@hogikids.test", role: "STAFF", quyen: new Set(quyen) });
const dangNhapLa = (nd: ReturnType<typeof nguoiDungGia>) => vi.mocked(docNguoiDungPhien).mockResolvedValue(nd);
const nhatKy = (hanhDong: string) => prisma.auditLog.findMany({ where: { hanhDong }, orderBy: { thoiDiem: "asc" } });

async function taoKhoan(ghiDe: Record<string, unknown> = {}): Promise<string> {
  const res = await taoKhoanVay({ ...KHOAN_MOI, ...ghiDe });
  if (!res.ok) throw new Error(res.error);
  return res.data.id;
}

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.auditLog.deleteMany();
  vi.mocked(ghiNhatKy).mockClear();
  dangNhapLa(nguoiDungGia());
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

describe("khoản vay — lượt ghi thật ⇒ dòng nhật ký OK đúng mã", () => {
  it("tạo / sửa / ghi kỳ / xoá", async () => {
    const id = await taoKhoan();
    expect((await suaKhoanVay(id, { ...KHOAN_MOI, name: "Đổi tên" })).ok).toBe(true);
    expect((await ghiKyTraNo({ loanId: id, ...KY1 })).ok).toBe(true);
    const id2 = await taoKhoan({ name: "Khoản xoá được" });
    expect((await xoaKhoanVay(id2)).ok).toBe(true);

    expect(await nhatKy("VAY_TAO")).toMatchObject([{ ketQua: "OK", doiTuongId: id }, { doiTuongId: id2 }]);
    expect(await nhatKy("VAY_SUA")).toMatchObject([{ ketQua: "OK", doiTuongLoai: "Loan", doiTuongId: id }]);
    expect(await nhatKy("VAY_GHI_KY")).toMatchObject([{ ketQua: "OK", doiTuongId: id, ghiChu: { ky: "2026-10-10" } }]);
    expect(await nhatKy("VAY_XOA")).toMatchObject([{ ketQua: "OK", doiTuongId: id2, actorId: "test-user" }]);
  });

  it("tất toán sau khi trả hết gốc ⇒ VAY_TAT_TOAN", async () => {
    const id = await taoKhoan();
    await createCashMovement({ date: "2026-10-20", kind: "LOAN_REPAY", amount: 200_000_000, loanId: id, description: "Trả hết" });

    expect((await tatToanKhoanVay(id)).ok).toBe(true);
    expect(await nhatKy("VAY_TAT_TOAN")).toMatchObject([{ ketQua: "OK", doiTuongId: id }]);
  });

  it("tất toán thấu chi ⇒ THAU_CHI_TAT_TOAN kèm ngày", async () => {
    const id = await taoKhoan(THAU_CHI);
    const res = await tatToanThauChi({ loanId: id, ngayTatToan: "2026-10-25", lai: 1_643_836, conDauDaThay: null });
    expect(res.ok).toBe(true);
    expect(await nhatKy("THAU_CHI_TAT_TOAN")).toMatchObject([{ ketQua: "OK", doiTuongId: id, ghiChu: { ky: "2026-10-25" } }]);
  });
});

describe("khoản vay — thiếu quyền", () => {
  it("nhân sự chỉ có quyền dòng tiền (sửa) + sổ quỹ (xem) ⇒ mọi action khoản vay KHONG_CO_QUYEN, kể cả trả gốc qua dòng tiền ghi tay", async () => {
    const id = await taoKhoan();
    dangNhapLa(nhanVien("tai-chinh-dong-tien:xem", "tai-chinh-dong-tien:sua", "tai-chinh-so-quy:xem"));

    const ket = [
      await taoKhoanVay({ ...KHOAN_MOI, name: "Lén tạo" }),
      await suaKhoanVay(id, { ...KHOAN_MOI, name: "Lén sửa" }),
      await ghiKyTraNo({ loanId: id, ...KY1 }),
      await tatToanKhoanVay(id),
      await xoaKhoanVay(id),
      await tatToanThauChi({ loanId: id, ngayTatToan: "2026-10-25", lai: 0, conDauDaThay: null }),
      // Cùng tác động với `ghiKyTraNo` (đổi dư nợ) nên cùng quyền — không phải lối vòng qua quyền dòng tiền.
      await createCashMovement({ date: "2026-10-20", kind: "LOAN_REPAY", amount: 50_000_000, loanId: id, description: "Lén trả gốc" }),
    ];

    for (const r of ket) expect(r).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    expect(await prisma.loan.count()).toBe(1);
    expect((await prisma.loan.findUniqueOrThrow({ where: { id } })).name).toBe(KHOAN_MOI.name);
    expect(await prisma.expense.count()).toBe(0);
    expect(await prisma.cashMovement.count({ where: { kind: "LOAN_REPAY" } })).toBe(0);
    const tuChoi = await nhatKy("TU_CHOI_QUYEN");
    expect(tuChoi).toHaveLength(7);
    for (const d of tuChoi) expect(d).toMatchObject({ actorId: "staff-1", ghiChu: { quyenThieu: "tai-chinh-so-quy:sua" } });
  });
});

describe("khoản vay — nhật ký ném ⇒ không lưu gì", () => {
  it("tạo: không Loan, không LOAN_IN", async () => {
    vi.mocked(ghiNhatKy).mockRejectedValueOnce(new Error("nhật ký hỏng giả lập"));

    expect((await taoKhoanVay(KHOAN_MOI)).ok).toBe(false);
    expect(await prisma.loan.count()).toBe(0);
    expect(await prisma.cashMovement.count()).toBe(0);
  });

  it("ghi kỳ: không lãi, không gốc, con dấu kỳ giữ nguyên + dòng LOI", async () => {
    const id = await taoKhoan();
    vi.mocked(ghiNhatKy).mockRejectedValueOnce(new Error("nhật ký hỏng giả lập"));

    expect((await ghiKyTraNo({ loanId: id, ...KY1 })).ok).toBe(false);
    expect(await prisma.expense.count()).toBe(0);
    expect(await prisma.cashMovement.count({ where: { kind: "LOAN_REPAY" } })).toBe(0);
    expect((await prisma.loan.findUniqueOrThrow({ where: { id } })).lastDueHandled).toBeNull();
    expect(await nhatKy("VAY_GHI_KY")).toMatchObject([{ ketQua: "LOI", doiTuongId: id, ghiChu: { lyDo: "Error" } }]);
  });

  it("tất toán thấu chi: khoản vẫn mở, không lãi, không gốc", async () => {
    const id = await taoKhoan(THAU_CHI);
    vi.mocked(ghiNhatKy).mockRejectedValueOnce(new Error("nhật ký hỏng giả lập"));

    const res = await tatToanThauChi({ loanId: id, ngayTatToan: "2026-10-25", lai: 1_643_836, conDauDaThay: null });

    expect(res.ok).toBe(false);
    expect((await prisma.loan.findUniqueOrThrow({ where: { id } })).closedAt).toBeNull();
    expect(await prisma.expense.count()).toBe(0);
    expect(await prisma.cashMovement.count({ where: { kind: "LOAN_REPAY" } })).toBe(0);
  });

  it("xoá: khoản + dòng giải ngân còn nguyên, thùng rác trống", async () => {
    const id = await taoKhoan();
    vi.mocked(ghiNhatKy).mockRejectedValueOnce(new Error("nhật ký hỏng giả lập"));

    expect((await xoaKhoanVay(id)).ok).toBe(false);
    expect(await prisma.loan.count()).toBe(1);
    expect(await prisma.cashMovement.count()).toBe(1);
    expect(await prisma.banGhiDaXoa.count()).toBe(0);
  });
});

describe("khoản vay — lượt ghi tiền bị từ chối nghiệp vụ ⇒ dòng LOI", () => {
  it("tất toán khi còn dư nợ ⇒ LOI kèm mã lỗi hợp đồng, không có dòng OK", async () => {
    const id = await taoKhoan();

    expect((await tatToanKhoanVay(id)).ok).toBe(false);

    expect(await nhatKy("VAY_TAT_TOAN")).toMatchObject([{ ketQua: "LOI", doiTuongId: id, ghiChu: { lyDo: "LoiHopDong" } }]);
  });
});
