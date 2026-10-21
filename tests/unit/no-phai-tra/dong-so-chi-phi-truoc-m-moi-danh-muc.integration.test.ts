import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Đã bật nợ phải trả (M = 15/09/2026) ⇒ sổ chi phí TRƯỚC M khoá MỌI danh mục ở mọi đường ghi tay, trên DB thật:
 * chỉ còn đổi danh mục / mô tả / kênh khi giữ nguyên ngày VN + số tiền + thẻ. Lý do: quỹ cuối M−1 đã chốt theo tiền
 * thật bằng điều chỉnh mở sổ — thêm / xoá / khôi phục / đổi tiền-ngày-thẻ một dòng trước M (danh mục nào cũng trừ
 * quỹ) là quỹ từ M lệch khỏi tiền thật. Chỉ khoá Nhập hàng thì có đường vòng qua danh mục khác (ca vòng 3 bước
 * purchase → fixed → sửa tiền → purchase, hoặc purchase → fixed → xoá).
 *
 * Ngoại lệ có chủ đích khoá bằng test: cửa máy ads `ADS_API` ngày < M vẫn ghi/cập nhật được. Chưa bật ⇒ như cũ.
 * Hôm nay ghim 20/09/2026.
 */
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => ({
  ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
  docNguoiDungPhien: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createExpense, deleteExpense, updateExpense } from "@/lib/actions/expenses";
import { ensureRecurringExpensesForMonthsChiTiet } from "@/lib/expenses/ensure-recurring-expenses";
import { napSoChiTieuAds, upsertOneAdsExpense } from "@/lib/ingest/ads-expense-upsert";
import { refIdChoPhieu } from "@/lib/nhap-hang/doi-chieu-phieu-nhap";
import { KEY_NO_PHAI_TRA_TU_NGAY } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { daTraTruocHopLe } from "@/lib/no-phai-tra/luat-da-tra-truoc-phieu";
import { prisma } from "@/lib/prisma";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";
import { docDuBaoQuy } from "@/lib/so-quy/du-bao-quy-queries";
import { tinhSoQuyThang } from "@/lib/so-quy/so-quy-queries";
import { khoiPhucBanGhiDaXoa } from "@/lib/thung-rac/khoi-phuc-ban-ghi";
import { CAU_CHI_PHI_TRUOC_M_DA_KHOA_SO } from "@/lib/thung-rac/ly-do-khong-khoi-phuc";

import { nguoiDungGia } from "../../helpers/nguoi-dung-gia";
import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

const vn = (ngay: string, gio = "00:00:00") => new Date(`${ngay}T${gio}+07:00`);
const M = "2026-09-15";

async function batM() {
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
  await prisma.setting.create({ data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: M } });
}

const moSo = () =>
  prisma.cashMovement.create({ data: { date: vn("2026-08-01"), kind: "CAPITAL_IN", amount: 100_000_000, description: "Mở sổ" } });

/** Quỹ cuối 14/09 (= cuối M−1) và đầu kỳ từ M — hai con số điều chỉnh mở sổ đã chốt theo tiền thật. */
async function quyQuanhM() {
  const truocM = await tinhSoQuyThang({ from: vn("2026-09-01"), to: vn("2026-09-14", "23:59:59") });
  const tuM = await tinhSoQuyThang({ from: vn("2026-09-15"), to: vn("2026-09-30", "23:59:59") });
  return { cuoiTruocM: truocM.cuoiKy, dauTuM: tuM.dauKy };
}

/** Dòng Expense có sẵn (ghi trước khi bật) — chèn thẳng, không qua action. */
const dongCo = (categoryId: string, ngay = "2026-09-05", p: Record<string, unknown> = {}) =>
  prisma.expense.create({
    data: { date: vn(ngay), categoryId, amount: 3_000_000, description: `Dòng ${categoryId}`, source: "MANUAL", channelId: null, ...p },
  });

/** Input form Sổ chi phí. */
const form = (categoryId: string, ngay: string, p: Record<string, unknown> = {}) => ({
  date: vn(ngay),
  categoryId,
  amount: 3_000_000,
  description: `Dòng ${categoryId}`,
  channelId: null,
  ...p,
});

const anh = (id: string) =>
  prisma.expense.findUniqueOrThrow({
    where: { id },
    select: { date: true, categoryId: true, amount: true, description: true, channelId: true, cardId: true },
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

describe("ca vòng qua danh mục khác — khoá tiền Nhập hàng trước M không bị rửa", () => {
  it("purchase 4tr (phiếu) → fixed 4tr (được) → fixed 9tr BỊ CHẶN → purchase 9tr bị chặn; quỹ cuối 14/09 + đã trả trước phiếu không đổi", async () => {
    await moSo();
    const refId = refIdChoPhieu("phieu-uuid-r1");
    const dong = await dongCo("purchase", "2026-09-05", { date: vn("2026-09-05", "10:30:00"), amount: 4_000_000, refId });
    await batM();
    const quyTruoc = await quyQuanhM();
    const traTruoc = () => daTraTruocHopLe(prisma, { refId, ngayPhieu: vn("2026-09-05") }, undefined, { laChuShop: true, lyDoLech: undefined });
    const traTruocCu = await traTruoc();

    // Bước 1 (ngoại lệ hợp lệ): đổi danh mục giữ tiền + ngày.
    expect(await updateExpense(dong.id, form("fixed", "2026-09-05", { amount: 4_000_000 }))).toEqual({ ok: true, data: undefined });
    // Bước 2: sửa tiền dòng `fixed` trước M — trước đây lọt (cổng chỉ xét Nhập hàng).
    const r2 = await updateExpense(dong.id, form("fixed", "2026-09-05", { amount: 9_000_000 }));
    expect(r2).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA", error: expect.stringContaining("đã chốt vào số dư mở sổ") });
    expect(r2).not.toHaveProperty("field");
    // Bước 3: đổi lại Nhập hàng với 9tr (so với bản hiện tại 4tr ⇒ đổi tiền) ⇒ chặn.
    expect(await updateExpense(dong.id, form("purchase", "2026-09-05", { amount: 9_000_000 }))).toMatchObject({
      ok: false,
      code: "DA_BAT_NO_PHAI_TRA",
    });

    expect(await anh(dong.id)).toMatchObject({ categoryId: "fixed", amount: 4_000_000 });
    expect(await quyQuanhM()).toEqual(quyTruoc);
    expect(await traTruoc()).toEqual(traTruocCu);
  });

  it("biến thể xoá: purchase → fixed (được) → xoá BỊ CHẶN; dòng còn, thùng rác trống, quỹ cuối 14/09 không đổi", async () => {
    await moSo();
    const dong = await dongCo("purchase", "2026-09-05", { amount: 4_000_000, refId: refIdChoPhieu("phieu-uuid-r1b") });
    await batM();
    const quyTruoc = await quyQuanhM();

    expect(await updateExpense(dong.id, form("fixed", "2026-09-05", { amount: 4_000_000 }))).toEqual({ ok: true, data: undefined });
    const r = await deleteExpense(dong.id, "only");
    expect(r).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA" });
    expect(r).not.toHaveProperty("field");

    expect(await prisma.expense.findUnique({ where: { id: dong.id } })).not.toBeNull();
    expect(await prisma.banGhiDaXoa.count()).toBe(0);
    expect(await quyQuanhM()).toEqual(quyTruoc);
  });
});

describe("đã bật — danh mục khác ngày < M", () => {
  it("tạo ⇒ chặn ở ô Ngày (thường lẫn lặp hàng tháng), không ghi; tạo ngày ≥ M ⇒ được", async () => {
    await batM();
    for (const p of [{}, { recurringMonthly: true }]) {
      expect(await createExpense(form("fixed", "2026-09-14", p)), JSON.stringify(p)).toMatchObject({
        ok: false,
        code: "DA_BAT_NO_PHAI_TRA",
        field: "date",
      });
    }
    expect(await createExpense(form("shipping", "2026-08-02"))).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA" });
    expect(await prisma.expense.count()).toBe(0);
    expect(await prisma.recurringExpense.count()).toBe(0);
    expect(await createExpense(form("fixed", "2026-09-15"))).toEqual({ ok: true, data: undefined });
    expect(await prisma.expense.count()).toBe(1);
  });

  it("sửa số tiền / ngày (trong vùng < M) / dời qua M / gỡ thẻ ⇒ chặn (toast), dòng nguyên", async () => {
    const the = await prisma.theTinDung.create({ data: { ten: "Thẻ A", ngayChotSaoKe: 25, ngayHanTra: 10 } });
    const coDinh = await dongCo("fixed");
    const coThe = await dongCo("other", "2026-09-05", { cardId: the.id });
    await batM();
    const truoc = await anh(coDinh.id);
    for (const doi of [{ amount: 3_500_000 }, { date: vn("2026-09-06") }, { date: vn("2026-09-16") }]) {
      const r = await updateExpense(coDinh.id, form("fixed", "2026-09-05", doi));
      expect(r, JSON.stringify(doi)).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA" });
      expect(r, JSON.stringify(doi)).not.toHaveProperty("field");
    }
    expect(await anh(coDinh.id)).toEqual(truoc);
    expect(await updateExpense(coThe.id, form("other", "2026-09-05", { cardId: null }))).toMatchObject({
      ok: false,
      code: "DA_BAT_NO_PHAI_TRA",
    });
    expect((await anh(coThe.id)).cardId).toBe(the.id);
  });

  it("đổi mô tả / kênh / danh mục GIỮ tiền + ngày ⇒ được; quỹ quanh M không đổi", async () => {
    await moSo();
    const coDinh = await dongCo("fixed");
    await batM();
    const quyTruoc = await quyQuanhM();
    expect(await updateExpense(coDinh.id, form("fixed", "2026-09-05", { description: "Thuê kho T9" }))).toEqual({ ok: true, data: undefined });
    expect(await updateExpense(coDinh.id, form("fixed", "2026-09-05", { description: "Thuê kho T9", channelId: "shopee" }))).toEqual({
      ok: true,
      data: undefined,
    });
    expect(await updateExpense(coDinh.id, form("other", "2026-09-05", { description: "Thuê kho T9", channelId: "shopee" }))).toEqual({
      ok: true,
      data: undefined,
    });
    expect(await anh(coDinh.id)).toMatchObject({ categoryId: "other", description: "Thuê kho T9", channelId: "shopee", amount: 3_000_000 });
    expect(await quyQuanhM()).toEqual(quyTruoc);
  });

  it("xoá (cả \"Xoá và dừng lặp lại\") ⇒ chặn, dòng còn, mẫu vẫn chạy", async () => {
    const coDinh = await dongCo("fixed");
    const mau = await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: 3_000_000, dayOfMonth: 5, description: "Mặt bằng", active: true, activeFrom: vn("2026-08-01") },
    });
    const dinhKy = await dongCo("fixed", "2026-09-05", { source: "RECURRING", recurringId: mau.id, recurringMonth: "2026-09" });
    await batM();
    expect(await deleteExpense(coDinh.id, "only")).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA" });
    expect(await deleteExpense(dinhKy.id, "stop_recurring")).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA" });
    expect(await prisma.expense.count()).toBe(2);
    expect((await prisma.recurringExpense.findUniqueOrThrow({ where: { id: mau.id } })).active).toBe(true);
  });

  it("khôi phục thùng rác dòng < M (xoá trước khi bật) ⇒ chặn, đúng câu", async () => {
    const coDinh = await dongCo("fixed");
    expect(await deleteExpense(coDinh.id, "only")).toEqual({ ok: true, data: undefined });
    await batM();
    const rac = await prisma.banGhiDaXoa.findFirstOrThrow({ where: { banGhiId: coDinh.id } });
    expect(await khoiPhucBanGhiDaXoa(rac.id, nguoiDungGia())).toEqual({ ok: false, lyDo: CAU_CHI_PHI_TRUOC_M_DA_KHOA_SO });
    expect(await prisma.expense.count()).toBe(0);
  });
});

describe("đã bật — dòng ngày ≥ M (danh mục không phải Nhập hàng)", () => {
  it("dời ngày về < M ⇒ chặn ở ô Ngày; sửa tiền/ngày/danh mục trong vùng ≥ M ⇒ được; xoá ⇒ được", async () => {
    const sauM = await dongCo("fixed", "2026-09-16");
    await batM();
    expect(await updateExpense(sauM.id, form("fixed", "2026-09-14"))).toMatchObject({
      ok: false,
      code: "DA_BAT_NO_PHAI_TRA",
      field: "date",
      error: expect.stringContaining("đã chốt vào số dư mở sổ"),
    });
    expect((await anh(sauM.id)).date).toEqual(vn("2026-09-16"));
    expect(await updateExpense(sauM.id, form("shipping", "2026-09-18", { amount: 7_000_000 }))).toEqual({ ok: true, data: undefined });
    expect(await anh(sauM.id)).toMatchObject({ categoryId: "shipping", amount: 7_000_000, date: vn("2026-09-18") });
    expect(await deleteExpense(sauM.id, "only")).toEqual({ ok: true, data: undefined });
  });
});

describe("chưa bật ⇒ như cũ", () => {
  it("tạo / sửa tiền / xoá / khôi phục dòng `fixed` ngày trước 15/09 đều được", async () => {
    expect(await createExpense(form("fixed", "2026-09-05"))).toEqual({ ok: true, data: undefined });
    const dong = await prisma.expense.findFirstOrThrow({ where: { categoryId: "fixed" } });
    expect(await updateExpense(dong.id, form("fixed", "2026-09-06", { amount: 9_000_000 }))).toEqual({ ok: true, data: undefined });
    expect(await deleteExpense(dong.id, "only")).toEqual({ ok: true, data: undefined });
    const rac = await prisma.banGhiDaXoa.findFirstOrThrow({ where: { banGhiId: dong.id } });
    expect(await khoiPhucBanGhiDaXoa(rac.id, nguoiDungGia())).toEqual({ ok: true, canhBao: null });
    expect(await anh(dong.id)).toMatchObject({ amount: 9_000_000, date: vn("2026-09-06") });
  });
});

describe("bộ sinh định kỳ + nơi chỉ đọc — lần đến hạn < M của mẫu bất kỳ", () => {
  /** Mẫu `fixed` ngày 10 (lần T9 < M) và ngày 18 (lần T9 ≥ M), chạy từ T8. */
  const taoMau = async () => {
    await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: 1_000_000, dayOfMonth: 10, description: "Điện nước", active: true, activeFrom: vn("2026-08-01") },
    });
    await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: 2_000_000, dayOfMonth: 18, description: "Mặt bằng", active: true, activeFrom: vn("2026-08-01") },
    });
  };

  it("đã bật ⇒ không sinh lần < M (10/08, 18/08, 10/09), đếm bỏ qua; lần 18/09 ≥ M vẫn sinh", async () => {
    await taoMau();
    await batM();
    expect(await ensureRecurringExpensesForMonthsChiTiet([vn("2026-08-01"), vn("2026-09-01")])).toEqual({
      daTao: 1,
      boQuaNhapHang: 0,
      boQuaTruocM: 3,
    });
    const dong = await prisma.expense.findMany({ select: { date: true, description: true } });
    expect(dong).toEqual([{ date: vn("2026-09-18"), description: "Mặt bằng" }]);
  });

  it("chưa bật ⇒ sinh đủ 4 lần như cũ", async () => {
    await taoMau();
    expect(await ensureRecurringExpensesForMonthsChiTiet([vn("2026-08-01"), vn("2026-09-01")])).toEqual({
      daTao: 4,
      boQuaNhapHang: 0,
      boQuaTruocM: 0,
    });
  });

  it("cảnh báo \"định kỳ đến hạn chưa sinh\": chưa bật ⇒ 4 khoản; đã bật ⇒ chỉ còn 18/09 (bộ sinh không bao giờ ghi bù lần < M)", async () => {
    await taoMau();
    await moSo();
    const thang9 = { from: vn("2026-09-01"), to: vn("2026-09-30", "23:59:59") };
    expect((await tinhSoQuyThang(thang9)).canhBao.dinhKyChuaGhi.soKhoan).toBe(4);
    await batM();
    expect((await tinhSoQuyThang(thang9)).canhBao.dinhKyChuaGhi).toMatchObject({ soKhoan: 1, thang: ["09/2026"] });
  });

  it("dự báo quỹ: đã bật ⇒ không trừ lần 10/09 < M chưa sinh, vẫn trừ 18/09; chưa bật ⇒ trừ cả hai", async () => {
    await taoMau();
    await moSo();
    const denHanDien = async () => {
      const db = await docDuBaoQuy();
      if (db.trangThai !== "CO_SO") throw new Error(`mong CO_SO, nhận ${db.trangThai}`);
      const dinhKy = db.khoanDuKien.filter((k) => k.loai === "DINH_KY" && k.moTa.includes("đến hạn")).map((k) => k.moTa);
      return { dien: dinhKy.some((m) => m.includes("Điện nước")), matBang: dinhKy.some((m) => m.includes("Mặt bằng")) };
    };
    expect(await denHanDien()).toEqual({ dien: true, matBang: true });
    await batM();
    expect(await denHanDien()).toEqual({ dien: false, matBang: true });
  });
});

describe("ngoại lệ có chủ đích — cửa máy ads ADS_API", () => {
  it("đã bật ⇒ vẫn tạo dòng ads ngày < M và cập nhật số của dòng ADS_API < M", async () => {
    await batM();
    const m = { refId: "META:2026-09-05:camp-1", date: vn("2026-09-05"), dateKey: "2026-09-05", description: "Camp 1", amount: 500_000 };
    const stats = { adsExpensesUpserted: 0, skipped: 0, boQuaCoChuDich: 0 };
    const warnings: string[] = [];
    await upsertOneAdsExpense(prisma, "META", m, await napSoChiTieuAds(prisma), stats, warnings);
    await upsertOneAdsExpense(prisma, "META", { ...m, amount: 650_000 }, await napSoChiTieuAds(prisma), stats, warnings);
    expect(warnings).toEqual([]);
    expect(await prisma.expense.findMany({ select: { categoryId: true, source: true, amount: true, date: true } })).toEqual([
      { categoryId: "ads", source: "ADS_API", amount: 650_000, date: vn("2026-09-05") },
    ]);
  });
});
