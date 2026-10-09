import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Đóng đường ghi `Expense` "Nhập hàng" (`purchase`) từ M = 01/11/2026 (spec §5.3) trên DB thật: tạo/sửa tay,
 * mẫu định kỳ, màn duyệt phiếu nhập, bộ sinh định kỳ (bỏ lần phát sinh ≥ M, VẪN sinh tháng < M), khôi phục
 * thùng rác. Ngày < M ⇒ như cũ (sửa lịch sử X ở §5.4 vẫn được). Hôm nay ghim 10/12/2026.
 */
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => ({
  ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
  docNguoiDungPhien: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { ghiChiPhiNhapHang } from "@/lib/actions/chi-phi-nhap-hang";
import { createExpense, deleteExpense, updateExpense } from "@/lib/actions/expenses";
import {
  ensureRecurringExpensesChiTiet,
  ensureRecurringExpensesForMonthsChiTiet,
} from "@/lib/expenses/ensure-recurring-expenses";
import { KEY_NO_PHAI_TRA_TU_NGAY } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { prisma } from "@/lib/prisma";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";
import { khoanDinhKy } from "@/lib/so-quy/du-bao-quy";
import { khoiPhucBanGhiDaXoa } from "@/lib/thung-rac/khoi-phuc-ban-ghi";
import { CAU_NHAP_HANG_SAU_M } from "@/lib/thung-rac/ly-do-khong-khoi-phuc";

import { nguoiDungGia } from "../../helpers/nguoi-dung-gia";
import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

const vn = (ngay: string, gio = "00:00:00") => new Date(`${ngay}T${gio}+07:00`);

async function batM() {
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
  await prisma.setting.create({ data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: "2026-11-01" } });
}

const nhapHang = (p: Record<string, unknown> = {}) => ({
  date: vn("2026-11-05"),
  categoryId: "purchase",
  amount: 5_000_000,
  description: "Nhập lô áo",
  channelId: null,
  ...p,
});

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
  vi.mocked(docNguoiDungPhien).mockResolvedValue(nguoiDungGia());
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(vn("2026-12-10", "10:00:00"));
});

afterEach(async () => {
  vi.useRealTimers();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

describe("tạo / sửa tay", () => {
  it("Nhập hàng ngày ≥ M ⇒ DA_BAT_NO_PHAI_TRA ở ô danh mục; ngày < M ⇒ ghi như cũ; chưa bật ⇒ như cũ", async () => {
    expect(await createExpense(nhapHang())).toEqual({ ok: true, data: undefined });
    await batM();
    expect(await createExpense(nhapHang({ date: vn("2026-11-01") }))).toMatchObject({
      ok: false,
      code: "DA_BAT_NO_PHAI_TRA",
      field: "categoryId",
    });
    expect(await createExpense(nhapHang({ date: vn("2026-10-31") }))).toEqual({ ok: true, data: undefined });
    expect(await prisma.expense.count()).toBe(2);
  });

  it("mẫu định kỳ Nhập hàng sau khi bật ⇒ từ chối dù dòng đầu ngày < M; danh mục khác vẫn lặp được", async () => {
    await batM();
    expect(await createExpense(nhapHang({ date: vn("2026-10-20"), recurringMonthly: true }))).toMatchObject({
      ok: false,
      code: "DA_BAT_NO_PHAI_TRA",
    });
    expect(await prisma.recurringExpense.count()).toBe(0);
    expect(
      await createExpense(nhapHang({ categoryId: "fixed", date: vn("2026-12-05"), recurringMonthly: true })),
    ).toEqual({ ok: true, data: undefined });
  });

  it("sửa: đổi sang Nhập hàng ngày ≥ M ⇒ từ chối; dời Nhập hàng < M qua M ⇒ từ chối; sửa số dòng < M ⇒ được", async () => {
    await batM();
    await createExpense(nhapHang({ categoryId: "other", date: vn("2026-11-20") }));
    await createExpense(nhapHang({ date: vn("2026-10-20") }));
    const khac = await prisma.expense.findFirstOrThrow({ where: { categoryId: "other" } });
    const nhap = await prisma.expense.findFirstOrThrow({ where: { categoryId: "purchase" } });
    expect(await updateExpense(khac.id, nhapHang({ date: vn("2026-11-20") }))).toMatchObject({ code: "DA_BAT_NO_PHAI_TRA" });
    expect(await updateExpense(nhap.id, nhapHang({ date: vn("2026-11-02") }))).toMatchObject({ code: "DA_BAT_NO_PHAI_TRA" });
    expect(await updateExpense(nhap.id, nhapHang({ date: vn("2026-10-20"), amount: 3_360_000 }))).toEqual({
      ok: true,
      data: undefined,
    });
    expect((await prisma.expense.findUniqueOrThrow({ where: { id: nhap.id } })).amount).toBe(3_360_000);
  });
});

describe("màn duyệt phiếu nhập", () => {
  it("đã bật ⇒ DA_BAT_NO_PHAI_TRA cho TOÀN action, không đọc phiếu, không ghi dòng nào", async () => {
    await batM();
    const res = await ghiChiPhiNhapHang({ vanTay: "x", chon: [{ uuid: "u", soTien: 1 }] });
    expect(res).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA" });
    expect(await prisma.expense.count()).toBe(0);
  });
});

describe("bộ sinh định kỳ — review focus #4", () => {
  it("mẫu Nhập hàng active, M = 01/11: T10 vẫn sinh (ghi bù), T11 và T12 bỏ qua (boQuaNhapHang = 1 mỗi lượt)", async () => {
    await prisma.recurringExpense.create({
      data: { categoryId: "purchase", amount: 2_000_000, dayOfMonth: 5, description: "Nhập định kỳ", active: true, activeFrom: vn("2026-09-01") },
    });
    await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: 1_000_000, dayOfMonth: 5, description: "Mặt bằng", active: true, activeFrom: vn("2026-09-01") },
    });
    await batM();
    expect(await ensureRecurringExpensesChiTiet(vn("2026-10-15"))).toEqual({ daTao: 2, boQuaNhapHang: 0 });
    expect(await ensureRecurringExpensesChiTiet(vn("2026-11-15"))).toEqual({ daTao: 1, boQuaNhapHang: 1 });
    expect(await ensureRecurringExpensesChiTiet(vn("2026-12-15"))).toEqual({ daTao: 1, boQuaNhapHang: 1 });
    // Lượt sau vẫn báo bỏ qua (mẫu còn active), không chèn gì.
    expect(await ensureRecurringExpensesChiTiet(vn("2026-12-15"))).toEqual({ daTao: 0, boQuaNhapHang: 1 });
    const nhap = await prisma.expense.findMany({ where: { categoryId: "purchase" }, select: { recurringMonth: true } });
    expect(nhap).toEqual([{ recurringMonth: "2026-10" }]);
  });

  it("nhiều tháng (tab Sổ chi phí): cộng dồn boQuaNhapHang qua các tháng, tháng trùng chỉ tính một lần", async () => {
    await prisma.recurringExpense.create({
      data: { categoryId: "purchase", amount: 2_000_000, dayOfMonth: 5, description: "Nhập định kỳ", active: true, activeFrom: vn("2026-09-01") },
    });
    await batM();
    const thang = [vn("2026-10-01"), vn("2026-11-01"), vn("2026-12-01"), vn("2026-12-01")];
    expect(await ensureRecurringExpensesForMonthsChiTiet(thang)).toEqual({ daTao: 1, boQuaNhapHang: 2 });
  });

  it("dự báo quỹ không trừ lần phát sinh Nhập hàng ≥ M (cùng luật bộ sinh)", () => {
    const mau = [
      { id: "a", amount: 2, dayOfMonth: 5, description: "Nhập", activeFrom: null, boQuaTuNgay: "2026-11-01" },
      { id: "b", amount: 1, dayOfMonth: 5, description: "Mặt bằng", activeFrom: null },
    ];
    const khoan = khoanDinhKy(mau, "2026-12-01", "2026-12-31", new Set());
    expect(khoan.map((k) => k.moTa)).toEqual(["Chi phí định kỳ — Mặt bằng"]);
  });
});

describe("khôi phục thùng rác", () => {
  it("Expense Nhập hàng ngày ≥ M xoá TRƯỚC khi bật ⇒ sau bật không khôi phục được; ngày < M ⇒ được", async () => {
    await createExpense(nhapHang());
    await createExpense(nhapHang({ date: vn("2026-10-20") }));
    for (const e of await prisma.expense.findMany()) await deleteExpense(e.id, "only");
    await batM();
    const [sauM, truocM] = await Promise.all(
      ["2026-11-05", "2026-10-20"].map((d) => prisma.banGhiDaXoa.findFirstOrThrow({ where: { ngay: vn(d) } })),
    );
    const actor = nguoiDungGia();
    expect(await khoiPhucBanGhiDaXoa(sauM.id, actor)).toEqual({ ok: false, lyDo: CAU_NHAP_HANG_SAU_M });
    expect(await khoiPhucBanGhiDaXoa(truocM.id, actor)).toEqual({ ok: true, canhBao: null });
    expect(await prisma.expense.count()).toBe(1);
  });
});
