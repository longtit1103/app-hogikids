import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Quyen } from "@/lib/quyen/danh-muc-quyen";

/**
 * Dòng tiền gắn KHOẢN VAY / SỔ TIẾT KIỆM thuộc khối Sổ quỹ: ghi/sửa/xoá/khôi phục nó đòi THÊM
 * `tai-chinh-so-quy:sua` ngoài `tai-chinh-dong-tien:sua`.
 *
 * Hai điều phải đúng cùng lúc cho người chỉ có quyền dòng tiền:
 *  - KHÔNG ghi được gì vào dư nợ / số đang gửi (không dòng mới, không sửa, không xoá, không khôi phục);
 *  - KHÔNG dò được dư nợ qua câu lỗi: phép kiểm quyền chạy TRƯỚC mọi vị từ dư nợ, nên câu trả về
 *    là "không có quyền" chứ không phải "Vượt dư nợ còn lại (thiếu X)".
 * Dòng tiền trơn (góp vốn, thu khác…) vẫn ghi được như cũ.
 */
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => ({
  ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
  docNguoiDungPhien: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createCashMovement, deleteCashMovement, updateCashMovement } from "@/lib/actions/cash-movements";
import { taoKhoanVay } from "@/lib/actions/khoan-vay";
import { taoSoTietKiem } from "@/lib/actions/so-tiet-kiem";
import { khoiPhucBanGhi, xoaVinhVienBanGhi } from "@/lib/actions/thung-rac";
import { prisma } from "@/lib/prisma";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";
import { nguoiDungGia } from "./helpers/nguoi-dung-gia";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

const HOM_NAY = new Date(2026, 10, 1, 9, 0, 0);
const KHOAN_VAY = {
  name: "Vay dò dư nợ",
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
const SO = {
  name: "Sổ dò số gửi",
  bank: "Vietcombank",
  principal: 150_000_000,
  startDate: "2026-09-05",
  termMonths: 6,
  maturityDate: "2027-03-05",
  annualRateBp: 520,
  note: "",
};

const chuShop = () => nguoiDungGia();
const nhanVien = (...quyen: Quyen[]) =>
  nguoiDungGia({ id: "staff-1", email: "nv@hogikids.test", role: "STAFF", quyen: new Set(quyen) });
const CHI_DONG_TIEN = nhanVien("tai-chinh-dong-tien:xem", "tai-chinh-dong-tien:sua");
// Có XEM sổ quỹ vẫn chưa đủ: đụng dư nợ là SỬA.
const DONG_TIEN_XEM_SO_QUY = nhanVien("tai-chinh-dong-tien:xem", "tai-chinh-dong-tien:sua", "tai-chinh-so-quy:xem");
const DU_HAI_QUYEN = nhanVien("tai-chinh-dong-tien:xem", "tai-chinh-dong-tien:sua", "tai-chinh-so-quy:xem", "tai-chinh-so-quy:sua");
const dangNhapLa = (nd: ReturnType<typeof nguoiDungGia>) => vi.mocked(docNguoiDungPhien).mockResolvedValue(nd);
const tuChoi = () => prisma.auditLog.findMany({ where: { hanhDong: "TU_CHOI_QUYEN" }, orderBy: { thoiDiem: "asc" } });

async function taoKhoan(): Promise<string> {
  dangNhapLa(chuShop());
  const res = await taoKhoanVay(KHOAN_VAY);
  if (!res.ok) throw new Error(res.error);
  return res.data.id;
}

async function taoSo(): Promise<string> {
  dangNhapLa(chuShop());
  const res = await taoSoTietKiem(SO);
  if (!res.ok) throw new Error(res.error);
  return res.data.id;
}

/** Ảnh chụp dư nợ/số gửi để so trước–sau: không lượt từ chối nào được đổi một dòng nào. */
async function anhDongTien() {
  return prisma.cashMovement.findMany({ orderBy: { id: "asc" } });
}

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.auditLog.deleteMany();
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

describe("tạo dòng gắn khoản vay / sổ tiết kiệm", () => {
  it("chỉ quyền dòng tiền: trả gốc VƯỢT dư nợ ⇒ KHONG_CO_QUYEN, không có câu 'Vượt dư nợ', không dòng mới", async () => {
    const loanId = await taoKhoan();
    const truoc = await anhDongTien();
    await prisma.auditLog.deleteMany();
    dangNhapLa(CHI_DONG_TIEN);

    const res = await createCashMovement({ date: "2026-10-20", kind: "LOAN_REPAY", amount: 1_999_999_999, loanId });

    expect(res).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    if (!res.ok) {
      expect(res.error).not.toMatch(/dư nợ|thiếu/i);
      expect(res.error).not.toMatch(/\d/);
    }
    expect(await anhDongTien()).toEqual(truoc);
    expect(await tuChoi()).toMatchObject([
      { ketQua: "LOI", actorId: "staff-1", ghiChu: { quyenThieu: "tai-chinh-so-quy:sua" } },
    ]);
  });

  it("chỉ quyền dòng tiền (kể cả có XEM sổ quỹ): trả gốc TRONG dư nợ vẫn bị chặn — dư nợ không đổi", async () => {
    const loanId = await taoKhoan();
    dangNhapLa(DONG_TIEN_XEM_SO_QUY);

    const res = await createCashMovement({ date: "2026-10-20", kind: "LOAN_REPAY", amount: 50_000_000, loanId });

    expect(res).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    expect(await prisma.cashMovement.count({ where: { kind: "LOAN_REPAY" } })).toBe(0);
  });

  it("chỉ quyền dòng tiền: rút gốc sổ tiết kiệm (SAVINGS_IN) ⇒ KHONG_CO_QUYEN, không dò được số đang gửi", async () => {
    const savingsId = await taoSo();
    const truoc = await anhDongTien();
    dangNhapLa(CHI_DONG_TIEN);

    const res = await createCashMovement({ date: "2026-10-20", kind: "SAVINGS_IN", amount: 1_999_999_999, savingsId });

    expect(res).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    if (!res.ok) expect(res.error).not.toMatch(/\d/);
    expect(await anhDongTien()).toEqual(truoc);
  });

  it("chỉ quyền dòng tiền: dòng tiền trơn vẫn ghi được", async () => {
    dangNhapLa(CHI_DONG_TIEN);
    expect((await createCashMovement({ date: "2026-10-20", kind: "CAPITAL_IN", amount: 10_000_000 })).ok).toBe(true);
    expect(await tuChoi()).toHaveLength(0);
  });

  it("đủ cả quyền Sổ quỹ (sửa) ⇒ trả gốc ghi được", async () => {
    const loanId = await taoKhoan();
    dangNhapLa(DU_HAI_QUYEN);

    expect((await createCashMovement({ date: "2026-10-20", kind: "LOAN_REPAY", amount: 50_000_000, loanId })).ok).toBe(true);
    expect(await prisma.cashMovement.count({ where: { kind: "LOAN_REPAY" } })).toBe(1);
  });
});

describe("sửa / xoá dòng gắn khoản vay", () => {
  it("chỉ quyền dòng tiền: sửa dòng giải ngân (kể cả đổi sang loại trơn để gỡ khỏi khoản vay) ⇒ từ chối", async () => {
    await taoKhoan();
    const giaiNgan = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "LOAN_IN" } });
    const truoc = await anhDongTien();
    dangNhapLa(CHI_DONG_TIEN);

    const doiLoai = await updateCashMovement(giaiNgan.id, { date: "2026-09-05", kind: "CAPITAL_IN", amount: 1_000 });
    const doiTien = await updateCashMovement(giaiNgan.id, {
      date: "2026-09-05",
      kind: "LOAN_IN",
      amount: 1_000,
      loanId: giaiNgan.loanId,
    });

    expect(doiLoai).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    expect(doiTien).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    expect(await anhDongTien()).toEqual(truoc);
  });

  it("chỉ quyền dòng tiền: sửa dòng TRƠN thành trả gốc vay ⇒ từ chối, dòng giữ nguyên", async () => {
    const loanId = await taoKhoan();
    dangNhapLa(CHI_DONG_TIEN);
    const tao = await createCashMovement({ date: "2026-10-20", kind: "OTHER_IN", amount: 5_000_000 });
    expect(tao.ok).toBe(true);
    const tron = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "OTHER_IN" } });

    const res = await updateCashMovement(tron.id, { date: "2026-10-20", kind: "LOAN_REPAY", amount: 5_000_000, loanId });

    expect(res).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    expect(await prisma.cashMovement.findUniqueOrThrow({ where: { id: tron.id } })).toMatchObject({
      kind: "OTHER_IN",
      loanId: null,
    });
  });

  it("chỉ quyền dòng tiền: xoá dòng giải ngân ⇒ từ chối, dòng còn, thùng rác trống", async () => {
    await taoKhoan();
    const giaiNgan = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "LOAN_IN" } });
    await prisma.auditLog.deleteMany();
    dangNhapLa(CHI_DONG_TIEN);

    const res = await deleteCashMovement(giaiNgan.id);

    expect(res).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    expect(await prisma.cashMovement.count({ where: { id: giaiNgan.id } })).toBe(1);
    expect(await prisma.banGhiDaXoa.count()).toBe(0);
    expect(await tuChoi()).toMatchObject([{ ghiChu: { quyenThieu: "tai-chinh-so-quy:sua" } }]);
  });

  it("chỉ quyền dòng tiền: sửa + xoá dòng TRƠN vẫn làm được", async () => {
    dangNhapLa(CHI_DONG_TIEN);
    await createCashMovement({ date: "2026-10-20", kind: "CAPITAL_IN", amount: 10_000_000 });
    const row = await prisma.cashMovement.findFirstOrThrow();

    expect((await updateCashMovement(row.id, { date: "2026-10-20", kind: "CAPITAL_IN", amount: 9_000_000 })).ok).toBe(true);
    expect((await deleteCashMovement(row.id)).ok).toBe(true);
  });
});

describe("quyền XEM dòng tiền không đủ để sửa/xoá (kể cả có Sổ quỹ sửa)", () => {
  it("sửa + xoá dòng trơn ⇒ KHONG_CO_QUYEN nêu tai-chinh-dong-tien:sua, dòng giữ nguyên", async () => {
    dangNhapLa(chuShop());
    await createCashMovement({ date: "2026-10-20", kind: "CAPITAL_IN", amount: 10_000_000 });
    const row = await prisma.cashMovement.findFirstOrThrow();
    await prisma.auditLog.deleteMany();
    dangNhapLa(nhanVien("tai-chinh-dong-tien:xem", "tai-chinh-so-quy:xem", "tai-chinh-so-quy:sua"));

    const sua = await updateCashMovement(row.id, { date: "2026-10-20", kind: "CAPITAL_IN", amount: 1 });
    const xoa = await deleteCashMovement(row.id);

    expect(sua).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    expect(xoa).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    expect(await prisma.cashMovement.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ amount: 10_000_000 });
    const dong = await tuChoi();
    expect(dong).toHaveLength(2);
    for (const d of dong) expect(d).toMatchObject({ ghiChu: { quyenThieu: "tai-chinh-dong-tien:sua" } });
  });
});

describe("thùng rác — dòng CashMovement gắn khoản vay / sổ tiết kiệm", () => {
  /** Chủ shop ghi rồi xoá một dòng trả gốc ⇒ id mục thùng rác. */
  async function traGocTrongThungRac(): Promise<string> {
    const loanId = await taoKhoan();
    const tao = await createCashMovement({ date: "2026-10-20", kind: "LOAN_REPAY", amount: 30_000_000, loanId });
    if (!tao.ok) throw new Error(tao.error);
    const row = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "LOAN_REPAY" } });
    const xoa = await deleteCashMovement(row.id);
    if (!xoa.ok) throw new Error(xoa.error);
    return (await prisma.banGhiDaXoa.findFirstOrThrow({ where: { bang: "CashMovement" } })).id;
  }

  it("chỉ quyền dòng tiền: khôi phục ⇒ KHONG_CO_QUYEN, dòng không quay lại, con dấu vẫn null", async () => {
    const dongId = await traGocTrongThungRac();
    await prisma.auditLog.deleteMany();
    dangNhapLa(CHI_DONG_TIEN);

    const res = await khoiPhucBanGhi(dongId);

    expect(res).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    expect(await prisma.cashMovement.count({ where: { kind: "LOAN_REPAY" } })).toBe(0);
    expect((await prisma.banGhiDaXoa.findUniqueOrThrow({ where: { id: dongId } })).khoiPhucLuc).toBeNull();
    expect(await tuChoi()).toMatchObject([{ ghiChu: { quyenThieu: "tai-chinh-so-quy:sua" } }]);
  });

  it("chỉ quyền dòng tiền: xoá vĩnh viễn ⇒ KHONG_CO_QUYEN, mục còn nguyên", async () => {
    const dongId = await traGocTrongThungRac();
    dangNhapLa(CHI_DONG_TIEN);

    expect(await xoaVinhVienBanGhi(dongId)).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    expect(await prisma.banGhiDaXoa.count({ where: { id: dongId } })).toBe(1);
  });

  it("dòng gửi sổ tiết kiệm (SAVINGS_OUT) cũng đòi quyền Sổ quỹ khi khôi phục", async () => {
    await taoSo();
    const gui = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "SAVINGS_OUT" } });
    // Chụp thẳng như lượt xoá sẽ chụp — đường xoá dòng gửi của sổ còn hiệu lực đi qua action sổ.
    await prisma.$transaction(async (tx) => {
      const { chupVaoThungRac } = await import("@/lib/thung-rac/ghi-thung-rac");
      await chupVaoThungRac(tx, { bang: "CashMovement", banGhi: gui });
    });
    const dongId = (await prisma.banGhiDaXoa.findFirstOrThrow({ where: { bang: "CashMovement" } })).id;
    dangNhapLa(CHI_DONG_TIEN);

    expect(await khoiPhucBanGhi(dongId)).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
  });

  it("đủ quyền Sổ quỹ (sửa) ⇒ khôi phục được dòng trả gốc", async () => {
    const dongId = await traGocTrongThungRac();
    dangNhapLa(DU_HAI_QUYEN);

    expect((await khoiPhucBanGhi(dongId)).ok).toBe(true);
    expect(await prisma.cashMovement.count({ where: { kind: "LOAN_REPAY" } })).toBe(1);
  });

  it("chỉ quyền dòng tiền: dòng TRƠN trong thùng rác vẫn khôi phục được", async () => {
    dangNhapLa(CHI_DONG_TIEN);
    await createCashMovement({ date: "2026-10-20", kind: "CAPITAL_IN", amount: 10_000_000 });
    const row = await prisma.cashMovement.findFirstOrThrow();
    await deleteCashMovement(row.id);
    const dongId = (await prisma.banGhiDaXoa.findFirstOrThrow()).id;

    expect((await khoiPhucBanGhi(dongId)).ok).toBe(true);
  });
});
