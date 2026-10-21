import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Đã bật nợ phải trả (M = 15/09/2026, giữa tháng) ⇒ chi phí "Nhập hàng" (`purchase`) KHOÁ SỔ ở MỌI đường ghi,
 * MỌI ngày, trên DB thật — ngoại lệ duy nhất: SỬA dòng < M giữ nguyên ngày VN + số tiền + thẻ (chỉ đổi danh mục /
 * mô tả / kênh — quỹ và nợ phiếu không đổi, chỉ Lãi/Lỗ đổi): tạo / sửa (số tiền, ngày, đổi TỪ hoặc SANG Nhập hàng) / xoá (cả "Xoá và dừng lặp
 * lại") / khôi phục thùng rác / duyệt phiếu nhập / mẫu định kỳ / bộ sinh định kỳ; cảnh báo + dự báo quỹ hiểu
 * y hệt bộ sinh. Ngày < M cũng chặn: quỹ cuối M−1 đã chốt theo tiền thật bằng điều chỉnh mở sổ — ghi thêm, sửa
 * hay xoá một dòng trước M là quỹ từ M lệch đúng số đó. Luật "trước M" cho danh mục KHÁC (và ca vòng qua danh mục
 * khác) nằm ở `dong-so-chi-phi-truoc-m-moi-danh-muc.integration.test.ts`; file này giữ góc nhìn Nhập hàng. Chưa
 * bật ⇒ mọi thao tác như cũ. Hôm nay ghim 20/09/2026.
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
import { docDuBaoQuy } from "@/lib/so-quy/du-bao-quy-queries";
import { tinhSoQuyThang } from "@/lib/so-quy/so-quy-queries";
import { refIdChoPhieu } from "@/lib/nhap-hang/doi-chieu-phieu-nhap";
import { daTraTruocHopLe } from "@/lib/no-phai-tra/luat-da-tra-truoc-phieu";
import { calcPnl } from "@/lib/reports/pnl";
import { khoiPhucBanGhiDaXoa } from "@/lib/thung-rac/khoi-phuc-ban-ghi";
import { CAU_CHI_PHI_TRUOC_M_DA_KHOA_SO, CAU_NHAP_HANG_DA_KHOA_SO } from "@/lib/thung-rac/ly-do-khong-khoi-phuc";

import { nguoiDungGia } from "../../helpers/nguoi-dung-gia";
import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

const vn = (ngay: string, gio = "00:00:00") => new Date(`${ngay}T${gio}+07:00`);
const M = "2026-09-15";

async function batM() {
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
  await prisma.setting.create({ data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: M } });
}

/** Input form Sổ chi phí: Nhập hàng 10/09 (trước M). */
const nhapHang = (p: Record<string, unknown> = {}) => ({
  date: vn("2026-09-10"),
  categoryId: "purchase",
  amount: 5_000_000,
  description: "Nhập lô áo",
  channelId: null,
  ...p,
});

/** Dòng Expense có sẵn (ghi trước khi bật) — chèn thẳng, không qua action. */
const dongCo = (categoryId: string, ngay = "2026-09-05", p: Record<string, unknown> = {}) =>
  prisma.expense.create({
    data: { date: vn(ngay), categoryId, amount: 3_000_000, description: `Dòng ${categoryId}`, source: "MANUAL", channelId: null, ...p },
  });

/** Ảnh dòng để so "nguyên vẹn" sau lượt bị từ chối. */
const anh = (id: string) =>
  prisma.expense.findUniqueOrThrow({
    where: { id },
    select: { date: true, categoryId: true, amount: true, description: true, recurringId: true },
  });

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
  vi.mocked(docNguoiDungPhien).mockResolvedValue(nguoiDungGia());
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(vn("2026-09-20", "10:00:00"));
});

afterEach(async () => {
  vi.useRealTimers();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

describe("đã bật — tạo", () => {
  it("Nhập hàng ngày < M ⇒ chặn ở ô Ngày (sổ trước M đã chốt); ngày ≥ M ⇒ chặn ở ô danh mục (đi sổ nợ); danh mục khác ≥ M ghi được", async () => {
    await batM();
    expect(await createExpense(nhapHang({ date: vn("2026-09-10") }))).toMatchObject({
      ok: false,
      code: "DA_BAT_NO_PHAI_TRA",
      field: "date",
      error: expect.stringContaining("đã chốt vào số dư mở sổ"),
    });
    for (const ngay of ["2026-09-15", "2026-09-18"]) {
      expect(await createExpense(nhapHang({ date: vn(ngay) }))).toMatchObject({
        ok: false,
        code: "DA_BAT_NO_PHAI_TRA",
        field: "categoryId",
        error: expect.stringContaining("đã khoá sổ"),
      });
    }
    expect(await prisma.expense.count()).toBe(0);
    expect(await createExpense(nhapHang({ categoryId: "fixed", date: vn("2026-09-15") }))).toEqual({ ok: true, data: undefined });
    expect(await prisma.expense.count({ where: { categoryId: "fixed" } })).toBe(1);
  });

  it("mẫu định kỳ Nhập hàng ⇒ từ chối cả dòng đầu ngày < M lẫn ≥ M; danh mục khác lặp được từ M", async () => {
    await batM();
    for (const ngay of ["2026-09-05", "2026-09-16"]) {
      expect(await createExpense(nhapHang({ date: vn(ngay), recurringMonthly: true }))).toMatchObject({
        ok: false,
        code: "DA_BAT_NO_PHAI_TRA",
      });
    }
    expect(await prisma.recurringExpense.count()).toBe(0);
    expect(await createExpense(nhapHang({ categoryId: "fixed", date: vn("2026-09-16"), recurringMonthly: true }))).toEqual({
      ok: true,
      data: undefined,
    });
  });
});

describe("đã bật — sửa", () => {
  /** Ảnh tiền: quỹ cuối 14/09 (= cuối M−1), quỹ kỳ từ M, quỹ hôm nay, và LN ròng tháng 9. */
  const anhTien = async () => {
    const truocM = await tinhSoQuyThang({ from: vn("2026-09-01"), to: vn("2026-09-14", "23:59:59") });
    const tuM = await tinhSoQuyThang({ from: vn("2026-09-15"), to: vn("2026-09-30", "23:59:59") });
    const pnl = await calcPnl({ from: vn("2026-09-01"), to: vn("2026-09-30", "23:59:59") });
    return { quyCuoiTruocM: truocM.cuoiKy, quyDauTuM: tuM.dauKy, quyCuoiTuM: tuM.cuoiKy, quyHomNay: tuM.quyHomNay, lnRong: pnl.netProfit };
  };
  const moSo = () =>
    prisma.cashMovement.create({ data: { date: vn("2026-08-01"), kind: "CAPITAL_IN", amount: 100_000_000, description: "Mở sổ" } });
  const base = (categoryId: string, p: Record<string, unknown> = {}) => ({
    date: vn("2026-09-05"),
    categoryId,
    amount: 3_000_000,
    description: `Dòng ${categoryId}`,
    channelId: null,
    ...p,
  });

  it("dòng Nhập hàng (phiếu) 05/09 10:30 đổi sang `fixed` giữ tiền + ngày ⇒ được: LN ròng T9 giảm đúng 3tr, quỹ + đã trả trước phiếu KHÔNG đổi", async () => {
    await moSo();
    const refId = refIdChoPhieu("phieu-uuid-1");
    // Dòng sinh từ phiếu mang GIỜ; form gửi 00:00 cùng ngày ⇒ so theo ngày VN phải coi là cùng ngày.
    const nhap = await dongCo("purchase", "2026-09-05", { date: vn("2026-09-05", "10:30:00"), refId });
    await batM();
    const truoc = await anhTien();
    const traTruoc = () => daTraTruocHopLe(prisma, { refId, ngayPhieu: vn("2026-09-05") }, undefined, { laChuShop: true, lyDoLech: undefined });
    const traTruocCu = await traTruoc();

    expect(await updateExpense(nhap.id, base("fixed", { description: "Thuê kho (khai nhầm Nhập hàng)" }))).toEqual({ ok: true, data: undefined });

    const sau = await anhTien();
    expect(sau.lnRong).toBe(truoc.lnRong - 3_000_000);
    expect({ ...sau, lnRong: 0 }).toEqual({ ...truoc, lnRong: 0 });
    expect(await traTruoc()).toEqual(traTruocCu);
    expect(traTruocCu.daTraTruoc).toBe(3_000_000);
    expect(await anh(nhap.id)).toMatchObject({ categoryId: "fixed", amount: 3_000_000, description: "Thuê kho (khai nhầm Nhập hàng)" });
  });

  it("dòng `fixed` 05/09 sang Nhập hàng giữ tiền + ngày ⇒ được; đổi mô tả / kênh dòng Nhập hàng < M ⇒ được", async () => {
    const coDinh = await dongCo("fixed");
    const nhap = await dongCo("purchase");
    await batM();
    expect(await updateExpense(coDinh.id, base("purchase"))).toEqual({ ok: true, data: undefined });
    expect(await updateExpense(nhap.id, base("purchase", { description: "Nhập lô áo — sửa mô tả" }))).toEqual({ ok: true, data: undefined });
    const kenh = await prisma.channel.findFirstOrThrow();
    expect(await updateExpense(nhap.id, base("purchase", { channelId: kenh.id }))).toEqual({ ok: true, data: undefined });
    expect(await anh(coDinh.id)).toMatchObject({ categoryId: "purchase", amount: 3_000_000 });
    expect(await prisma.expense.findUniqueOrThrow({ where: { id: nhap.id } })).toMatchObject({ channelId: kenh.id, amount: 3_000_000 });
  });

  it("dòng Nhập hàng 05/09: đổi số tiền / ngày / ngày qua M / danh mục + số tiền cùng lúc ⇒ từ chối (toast, không gắn ô danh mục), dòng nguyên", async () => {
    const nhap = await dongCo("purchase");
    await batM();
    const truoc = await anh(nhap.id);
    for (const doi of [
      { amount: 3_360_000 },
      { date: vn("2026-09-06") },
      { date: vn("2026-09-16") },
      { categoryId: "fixed", amount: 3_360_000 },
      { categoryId: "fixed", date: vn("2026-09-04") },
    ]) {
      const r = await updateExpense(nhap.id, base("purchase", doi));
      expect(r, JSON.stringify(doi)).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA" });
      // Người dùng có thể chỉ sửa ô tiền/ngày — lỗi khoá sổ của DÒNG CŨ không được dán vào ô danh mục.
      expect(r, JSON.stringify(doi)).not.toHaveProperty("field");
    }
    expect(await anh(nhap.id)).toEqual(truoc);
  });

  it("dòng `fixed` 05/09 sang Nhập hàng KÈM đổi số tiền ⇒ từ chối (toast — sổ trước M); dòng `fixed` 16/09 (≥ M) sang Nhập hàng giữ tiền ⇒ từ chối ở ô danh mục", async () => {
    const coDinh = await dongCo("fixed");
    const sauM = await dongCo("fixed", "2026-09-16");
    await batM();
    const r = await updateExpense(coDinh.id, base("purchase", { amount: 3_500_000 }));
    expect(r).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA", error: expect.stringContaining("đã chốt vào số dư mở sổ") });
    expect(r).not.toHaveProperty("field");
    expect(await updateExpense(sauM.id, base("purchase", { date: vn("2026-09-16") }))).toMatchObject({
      ok: false,
      code: "DA_BAT_NO_PHAI_TRA",
      field: "categoryId",
    });
    expect((await anh(coDinh.id)).categoryId).toBe("fixed");
    expect((await anh(sauM.id)).categoryId).toBe("fixed");
    // Danh mục khác ngày ≥ M: sửa số tiền vẫn được.
    expect(await updateExpense(sauM.id, base("fixed", { date: vn("2026-09-16"), amount: 3_500_000 }))).toEqual({ ok: true, data: undefined });
  });

  it("dòng Nhập hàng 05/09 đang mang thẻ: gỡ thẻ (giữ tiền + ngày + danh mục) ⇒ từ chối, thẻ còn nguyên", async () => {
    const the = await prisma.theTinDung.create({ data: { ten: "Thẻ A", ngayChotSaoKe: 25, ngayHanTra: 10 } });
    const nhap = await dongCo("purchase", "2026-09-05", { cardId: the.id });
    await batM();
    expect(await updateExpense(nhap.id, base("purchase", { cardId: null }))).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA" });
    expect((await prisma.expense.findUniqueOrThrow({ where: { id: nhap.id } })).cardId).toBe(the.id);
  });
});

describe("đã bật — xoá", () => {
  it("dòng Nhập hàng 05/09 ⇒ từ chối (toast, không gắn ô), dòng còn, thùng rác trống; dòng `fixed` 16/09 (≥ M) xoá được", async () => {
    const nhap = await dongCo("purchase");
    const coDinh = await dongCo("fixed", "2026-09-16");
    await batM();
    const r = await deleteExpense(nhap.id, "only");
    expect(r).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA" });
    expect(r).not.toHaveProperty("field");
    expect(await prisma.expense.findUnique({ where: { id: nhap.id } })).not.toBeNull();
    expect(await prisma.banGhiDaXoa.count()).toBe(0);
    expect(await deleteExpense(coDinh.id, "only")).toEqual({ ok: true, data: undefined });
  });

  it("\"Xoá và dừng lặp lại\" dòng định kỳ Nhập hàng ⇒ từ chối, dòng còn, mẫu KHÔNG bị dừng", async () => {
    const mau = await prisma.recurringExpense.create({
      data: { categoryId: "purchase", amount: 3_000_000, dayOfMonth: 5, description: "Nhập định kỳ", active: true, activeFrom: vn("2026-08-01") },
    });
    const dong = await dongCo("purchase", "2026-09-05", { source: "RECURRING", recurringId: mau.id, recurringMonth: "2026-09" });
    await batM();
    expect(await deleteExpense(dong.id, "stop_recurring")).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA" });
    expect(await prisma.expense.findUnique({ where: { id: dong.id } })).not.toBeNull();
    expect((await prisma.recurringExpense.findUniqueOrThrow({ where: { id: mau.id } })).active).toBe(true);
  });
});

describe("đã bật — khôi phục thùng rác", () => {
  it("xoá TRƯỚC khi bật ⇒ sau bật: Nhập hàng 05/09 (trước M) và 16/09 không khôi phục được, mỗi ca đúng câu; `fixed` 16/09 vẫn được", async () => {
    const nhap = await dongCo("purchase");
    const nhapSauM = await dongCo("purchase", "2026-09-16");
    const coDinh = await dongCo("fixed", "2026-09-16");
    for (const d of [nhap, nhapSauM, coDinh]) expect(await deleteExpense(d.id, "only")).toEqual({ ok: true, data: undefined });
    await batM();
    const [rNhap, rNhapSauM, rCoDinh] = await Promise.all(
      [nhap.id, nhapSauM.id, coDinh.id].map((banGhiId) => prisma.banGhiDaXoa.findFirstOrThrow({ where: { banGhiId } })),
    );
    const actor = nguoiDungGia();
    expect(await khoiPhucBanGhiDaXoa(rNhap.id, actor)).toEqual({ ok: false, lyDo: CAU_CHI_PHI_TRUOC_M_DA_KHOA_SO });
    expect(await khoiPhucBanGhiDaXoa(rNhapSauM.id, actor)).toEqual({ ok: false, lyDo: CAU_NHAP_HANG_DA_KHOA_SO });
    expect(await khoiPhucBanGhiDaXoa(rCoDinh.id, actor)).toEqual({ ok: true, canhBao: null });
    expect(await prisma.expense.findMany({ select: { id: true } })).toEqual([{ id: coDinh.id }]);
  });
});

describe("đã bật — màn duyệt phiếu nhập", () => {
  it("DA_BAT_NO_PHAI_TRA cho TOÀN action, không ghi dòng nào (cổng trong transaction: khe-dua ca phiếu < M)", async () => {
    await batM();
    const res = await ghiChiPhiNhapHang({ vanTay: "x", chon: [{ uuid: "u", soTien: 1 }] });
    expect(res).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA" });
    expect(await prisma.expense.count()).toBe(0);
  });
});

describe("đã bật — bộ sinh định kỳ + nơi chỉ đọc hiểu cùng luật", () => {
  /** Hai mẫu ngày 18 (lần tháng 9 ≥ M, lần tháng 8 < M). */
  const taoMau = async (ngay = 18) => {
    await prisma.recurringExpense.create({
      data: { categoryId: "purchase", amount: 2_000_000, dayOfMonth: ngay, description: "Nhập định kỳ", active: true, activeFrom: vn("2026-08-01") },
    });
    await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: 1_000_000, dayOfMonth: ngay, description: "Mặt bằng", active: true, activeFrom: vn("2026-08-01") },
    });
  };

  it("mẫu Nhập hàng active (lưới an toàn — bước bật đòi dừng hết): lần 18/09 ≥ M bỏ (đếm Nhập hàng), lần 18/08 < M bỏ (đếm trước M)", async () => {
    await taoMau();
    await batM();
    expect(await ensureRecurringExpensesChiTiet(vn("2026-09-20"))).toEqual({ daTao: 1, boQuaNhapHang: 1, boQuaTruocM: 0 });
    // Ghi bù tháng trước M sau khi bật cũng bị bỏ — mọi mẫu: tháng 8 hoàn toàn trước M.
    expect(await ensureRecurringExpensesForMonthsChiTiet([vn("2026-08-01"), vn("2026-09-01")])).toEqual({
      daTao: 0,
      boQuaNhapHang: 1,
      boQuaTruocM: 2,
    });
    expect(await prisma.expense.count({ where: { categoryId: "purchase" } })).toBe(0);
    expect(await prisma.expense.count({ where: { categoryId: "fixed" } })).toBe(1);
  });

  it("cảnh báo \"định kỳ đến hạn chưa sinh\" bỏ mẫu Nhập hàng đến hạn 05/08, 05/09 < M (bộ sinh không bao giờ sinh); chưa bật ⇒ báo 2", async () => {
    await prisma.recurringExpense.create({
      data: { categoryId: "purchase", amount: 2_000_000, dayOfMonth: 5, description: "Nhập định kỳ", active: true, activeFrom: vn("2026-08-01") },
    });
    await prisma.cashMovement.create({ data: { date: vn("2026-08-01"), kind: "CAPITAL_IN", amount: 100_000_000, description: "Mở sổ" } });
    const thang9 = { from: vn("2026-09-01"), to: vn("2026-09-30", "23:59:59") };
    expect((await tinhSoQuyThang(thang9)).canhBao.dinhKyChuaGhi.soKhoan).toBe(2);
    await batM();
    expect((await tinhSoQuyThang(thang9)).canhBao.dinhKyChuaGhi).toEqual({ soKhoan: 0, thang: [], khoang: null });
  });

  it("chưa bật ⇒ bộ sinh ghi Nhập hàng như cũ", async () => {
    await taoMau();
    expect(await ensureRecurringExpensesChiTiet(vn("2026-09-20"))).toEqual({ daTao: 2, boQuaNhapHang: 0, boQuaTruocM: 0 });
  });

  it("dự báo quỹ không trừ lần Nhập hàng đến hạn 05/09 < M (bộ sinh không bao giờ sinh nó); mẫu khác vẫn trừ", async () => {
    await taoMau();
    await prisma.cashMovement.create({ data: { date: vn("2026-08-01"), kind: "CAPITAL_IN", amount: 100_000_000, description: "Mở sổ" } });
    await batM();
    const db = await docDuBaoQuy();
    if (db.trangThai !== "CO_SO") throw new Error(`mong CO_SO, nhận ${db.trangThai}`);
    const dinhKy = db.khoanDuKien.filter((k) => k.loai === "DINH_KY").map((k) => k.moTa);
    expect(dinhKy.length).toBeGreaterThan(0);
    expect(dinhKy.every((m) => m.includes("Mặt bằng"))).toBe(true);
  });
});

describe("chưa bật ⇒ như cũ", () => {
  it("tạo / sửa / đổi sang Nhập hàng / xoá / khôi phục Nhập hàng ngày trước 15/09 đều được", async () => {
    expect(await createExpense(nhapHang())).toEqual({ ok: true, data: undefined });
    const nhap = await prisma.expense.findFirstOrThrow({ where: { categoryId: "purchase" } });
    expect(await updateExpense(nhap.id, nhapHang({ amount: 4_000_000 }))).toEqual({ ok: true, data: undefined });
    const coDinh = await dongCo("fixed");
    expect(
      await updateExpense(coDinh.id, { date: vn("2026-09-05"), categoryId: "purchase", amount: 3_000_000, description: "x", channelId: null }),
    ).toEqual({ ok: true, data: undefined });
    expect(await deleteExpense(nhap.id, "only")).toEqual({ ok: true, data: undefined });
    const rac = await prisma.banGhiDaXoa.findFirstOrThrow({ where: { banGhiId: nhap.id } });
    expect(await khoiPhucBanGhiDaXoa(rac.id, nguoiDungGia())).toEqual({ ok: true, canhBao: null });
    expect(await prisma.expense.count({ where: { categoryId: "purchase" } })).toBe(2);
  });
});
