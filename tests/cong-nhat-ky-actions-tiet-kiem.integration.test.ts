import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Quyen } from "@/lib/quyen/danh-muc-quyen";

/**
 * Cổng quyền + nhật ký cho SỔ TIẾT KIỆM (spec phân quyền §1.1, §3.4, §5). Quyền `tai-chinh-so-quy:sua`.
 *
 * Điểm riêng của tất toán: `closedAt` là câu CUỐI CÙNG của transaction (bất biến CLAUDE.md) ⇒ dòng
 * nhật ký đứng NGAY TRƯỚC câu đóng. Nhật ký ném ⇒ gốc `SAVINGS_IN` + lãi `ThuNhap` rollback, sổ vẫn
 * mở — không bao giờ có lãi trong P&L mà không có dấu vết ai tất toán.
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

import { suaSoTietKiem, taoSoTietKiem, xoaSoTietKiem } from "@/lib/actions/so-tiet-kiem";
import { moLaiSoTietKiem, tatToanSoTietKiem } from "@/lib/actions/tat-toan-so-tiet-kiem";
import { ghiNhatKy } from "@/lib/nhat-ky/ghi-nhat-ky";
import { prisma } from "@/lib/prisma";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";
import { nguoiDungGia } from "./helpers/nguoi-dung-gia";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

const HOM_NAY = new Date(2027, 2, 10, 9, 0, 0);
const SO = {
  name: "Sổ thử nhật ký",
  bank: "Vietcombank",
  principal: 200_000_000,
  startDate: "2026-09-05",
  termMonths: 6,
  maturityDate: "2027-03-05",
  annualRateBp: 520,
  note: "",
};
const TAT_TOAN = { ngayTatToan: "2027-03-05", lai: 5_157_260 };

const nhanVien = (...quyen: Quyen[]) => nguoiDungGia({ id: "staff-1", email: "nv@hogikids.test", role: "STAFF", quyen: new Set(quyen) });
const dangNhapLa = (nd: ReturnType<typeof nguoiDungGia>) => vi.mocked(docNguoiDungPhien).mockResolvedValue(nd);
const nhatKy = (hanhDong: string) => prisma.auditLog.findMany({ where: { hanhDong }, orderBy: { thoiDiem: "asc" } });

async function taoSo(ghiDe: Record<string, unknown> = {}): Promise<string> {
  const res = await taoSoTietKiem({ ...SO, ...ghiDe });
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

describe("sổ tiết kiệm — lượt ghi thật ⇒ nhật ký OK đúng mã", () => {
  it("tạo / sửa / tất toán / mở lại / xoá", async () => {
    const id = await taoSo();
    expect((await suaSoTietKiem({ ...SO, id, name: "Đổi tên" })).ok).toBe(true);
    expect((await tatToanSoTietKiem({ id, ...TAT_TOAN })).ok).toBe(true);
    expect((await moLaiSoTietKiem({ id })).ok).toBe(true);
    expect((await xoaSoTietKiem({ id })).ok).toBe(true);

    for (const hd of ["TIET_KIEM_TAO", "TIET_KIEM_SUA", "TIET_KIEM_MO_LAI", "TIET_KIEM_XOA"]) {
      expect(await nhatKy(hd), hd).toMatchObject([{ ketQua: "OK", doiTuongLoai: "SoTietKiem", doiTuongId: id }]);
    }
    expect(await nhatKy("TIET_KIEM_TAT_TOAN")).toMatchObject([{ ketQua: "OK", doiTuongId: id, ghiChu: { ky: "2027-03-05" } }]);
  });
});

describe("sổ tiết kiệm — thiếu quyền", () => {
  it("quyền chi phí + dòng tiền KHÔNG mở được sổ quỹ ⇒ KHONG_CO_QUYEN cho cả 5 action", async () => {
    const id = await taoSo();
    dangNhapLa(nhanVien("chi-phi:xem", "chi-phi:sua", "tai-chinh-dong-tien:xem", "tai-chinh-dong-tien:sua"));

    const ket = [
      await taoSoTietKiem({ ...SO, name: "Lén" }),
      await suaSoTietKiem({ ...SO, id, name: "Lén sửa" }),
      await tatToanSoTietKiem({ id, ...TAT_TOAN }),
      await moLaiSoTietKiem({ id }),
      await xoaSoTietKiem({ id }),
    ];

    for (const r of ket) expect(r).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    const so = await prisma.soTietKiem.findUniqueOrThrow({ where: { id } });
    expect(so).toMatchObject({ name: SO.name, closedAt: null });
    expect(await prisma.soTietKiem.count()).toBe(1);
    expect(await prisma.thuNhap.count()).toBe(0);
    expect(await nhatKy("TU_CHOI_QUYEN")).toHaveLength(5);
  });
});

describe("sổ tiết kiệm — nhật ký ném ⇒ không lưu gì", () => {
  it("tất toán: sổ vẫn mở, không SAVINGS_IN, không ThuNhap + dòng LOI", async () => {
    const id = await taoSo();
    vi.mocked(ghiNhatKy).mockRejectedValueOnce(new Error("nhật ký hỏng giả lập"));

    expect((await tatToanSoTietKiem({ id, ...TAT_TOAN })).ok).toBe(false);

    expect((await prisma.soTietKiem.findUniqueOrThrow({ where: { id } })).closedAt).toBeNull();
    expect(await prisma.cashMovement.count({ where: { kind: "SAVINGS_IN" } })).toBe(0);
    expect(await prisma.thuNhap.count()).toBe(0);
    expect(await nhatKy("TIET_KIEM_TAT_TOAN")).toMatchObject([{ ketQua: "LOI", doiTuongId: id, ghiChu: { lyDo: "Error" } }]);
  });

  it("tạo: không sổ, không dòng gửi", async () => {
    vi.mocked(ghiNhatKy).mockRejectedValueOnce(new Error("nhật ký hỏng giả lập"));

    expect((await taoSoTietKiem(SO)).ok).toBe(false);
    expect(await prisma.soTietKiem.count()).toBe(0);
    expect(await prisma.cashMovement.count()).toBe(0);
  });

  it("mở lại: sổ vẫn đóng, lãi vẫn còn", async () => {
    const id = await taoSo();
    await tatToanSoTietKiem({ id, ...TAT_TOAN });
    vi.mocked(ghiNhatKy).mockRejectedValueOnce(new Error("nhật ký hỏng giả lập"));

    expect((await moLaiSoTietKiem({ id })).ok).toBe(false);
    expect((await prisma.soTietKiem.findUniqueOrThrow({ where: { id } })).closedAt).not.toBeNull();
    expect(await prisma.thuNhap.count()).toBe(1);
  });
});

describe("sổ tiết kiệm — từ chối nghiệp vụ ⇒ dòng LOI", () => {
  it("tất toán sổ đã tất toán ⇒ LOI mã LoiHopDong, chỉ một dòng OK từ lượt đầu", async () => {
    const id = await taoSo();
    await tatToanSoTietKiem({ id, ...TAT_TOAN });

    expect((await tatToanSoTietKiem({ id, ...TAT_TOAN })).ok).toBe(false);

    expect(await nhatKy("TIET_KIEM_TAT_TOAN")).toMatchObject([
      { ketQua: "OK" },
      { ketQua: "LOI", ghiChu: { lyDo: "LoiHopDong" } },
    ]);
  });
});
