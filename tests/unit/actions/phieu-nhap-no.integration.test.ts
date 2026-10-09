import { format } from "date-fns";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Prisma } from "@/generated/prisma/client";
import { refIdChoPhieu } from "@/lib/nhap-hang/doi-chieu-phieu-nhap";
import { hauKiemPhieu, khoaCacPhieu } from "@/lib/no-phai-tra/phieu-nhap-no-queries";
import { prisma } from "@/lib/prisma";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";

import { nguoiDungGia } from "../../helpers/nguoi-dung-gia";
import { datMocM, donFixtureNoPhaiTra, seedBronze, vn } from "../../helpers/phieu-nhap-no-fixture";
import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

/**
 * Action hồ sơ phiếu nợ trên DB thật (`hogikids_test`): ghi nhận (ba ca theo M — spec phase-03 Bước 2),
 * đã trả trước theo dòng Sổ chi phí / phiếu trước D0, refId trùng, quyền, và bốn nút hậu kiểm.
 *
 * Fixture: D0 = 15/09 (dòng góp vốn đầu tiên). Phiếu #1 ngày 20/09 tổng 100tr; #0 ngày 10/08 (trước
 * D0) tổng 50tr; #5 ngày 22/09 tổng 53,6tr có dòng Sổ chi phí cùng refId 53,6tr; #9 đã huỷ bên Pancake.
 * M (khi bật) = 01/10/2026 — trong quá khứ so với ngày chạy để ngày trả hợp lệ không thành "tương lai".
 */

vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => {
  const { nguoiDungGia: gia } = await import("../../helpers/nguoi-dung-gia");
  return {
    ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
    docNguoiDungPhien: vi.fn(async () => gia()),
  };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { ghiNhanPhieuVaoSoNo, capNhatTongPhieu, danhDauHuyPhieu, capNhatDaTraTruoc, boQuaLechDaGiaiThich } =
  await import("@/lib/actions/phieu-nhap-no");

const TR = 1_000_000;
const D0 = vn("2026-09-15T00:00:00");
const M = "2026-10-01";

const P1 = { uuid: "uuid-p1", displayId: 1, insertedAt: "2026-09-20T03:00:00", tongTien: 100 * TR };
const P0 = { uuid: "uuid-p0", displayId: 0, insertedAt: "2026-08-10T03:00:00", tongTien: 50 * TR };
const P5 = { uuid: "uuid-p5", displayId: 5, insertedAt: "2026-09-22T03:00:00", tongTien: 53_600_000 };
const P9 = { uuid: "uuid-p9", displayId: 9, insertedAt: "2026-09-25T03:00:00", tongTien: 7 * TR, status: 2 };

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  vi.mocked(docNguoiDungPhien).mockImplementation(async () => nguoiDungGia());
  await truncateBusinessTables();
  await donFixtureNoPhaiTra();
  await prisma.cashMovement.create({ data: { date: D0, kind: "CAPITAL_IN", amount: 500 * TR, description: "Mở sổ" } });
  for (const p of [P1, P0, P5, P9]) await seedBronze(p, vn("2026-09-30T12:00:00"));
  await prisma.expense.create({
    data: {
      date: vn("2026-09-22T00:00:00"),
      categoryId: "purchase",
      amount: 53_600_000,
      description: "Phiếu nhập #5",
      refId: refIdChoPhieu(P5.uuid),
    },
  });
});

afterAll(async () => {
  await truncateBusinessTables();
  await donFixtureNoPhaiTra();
  await prisma.$disconnect();
});

const demTraNcc = () => prisma.cashMovement.count({ where: { kind: "SUPPLIER_PAY" } });

describe("ghiNhanPhieuVaoSoNo — ba ca theo M", () => {
  it("(a) M null, chỉ hồ sơ ⇒ thành công, không dòng tiền nào", async () => {
    const res = await ghiNhanPhieuVaoSoNo({ uuid: P1.uuid });
    expect(res).toMatchObject({ ok: true, data: { tongTien: 100 * TR, daTraTruoc: 0, conNo: 100 * TR } });
    const p = await prisma.phieuNhapNo.findUniqueOrThrow({ where: { refId: refIdChoPhieu(P1.uuid) } });
    expect(p).toMatchObject({ maPhieu: "#1", tongTien: 100 * TR, shopId: "714995134" });
    expect(format(p.ngayPhieu, "yyyy-MM-dd HH:mm")).toBe("2026-09-20 00:00");
    expect(await demTraNcc()).toBe(0);
    expect(await prisma.auditLog.count({ where: { hanhDong: "NHAP_HANG_GHI_NO", doiTuongId: p.id, ketQua: "OK" } })).toBe(1);
  });

  it("(b) M null + đã trả ngay 10 ⇒ CHUA_BAT_NO_PHAI_TRA, không hồ sơ lẫn dòng tiền", async () => {
    const res = await ghiNhanPhieuVaoSoNo({ uuid: P1.uuid, daTraNgay: { soTien: 10 * TR, ngay: "2026-10-05" } });
    expect(res).toMatchObject({ ok: false, code: "CHUA_BAT_NO_PHAI_TRA" });
    expect(await prisma.phieuNhapNo.count()).toBe(0);
    expect(await demTraNcc()).toBe(0);
  });

  it("(c) M có + đã trả ngay 10 ⇒ hồ sơ + 1 SUPPLIER_PAY cùng tx, còn nợ 90", async () => {
    await datMocM(M);
    const res = await ghiNhanPhieuVaoSoNo({ uuid: P1.uuid, daTraNgay: { soTien: 10 * TR, ngay: "2026-10-05" } });
    expect(res).toMatchObject({ ok: true, data: { conNo: 90 * TR } });
    const dong = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "SUPPLIER_PAY" } });
    expect(dong.amount).toBe(10 * TR);
    expect(format(dong.date, "yyyy-MM-dd HH:mm")).toBe("2026-10-05 00:00");
    expect(dong.phieuNhapId).toBe(res.ok ? res.data.phieuNhapId : "");
  });

  it("M có + đã trả ngay ngày TRƯỚC M ⇒ từ chối ô daTraNgay, không ghi gì", async () => {
    await datMocM(M);
    const res = await ghiNhanPhieuVaoSoNo({ uuid: P1.uuid, daTraNgay: { soTien: 10 * TR, ngay: "2026-09-30" } });
    expect(res).toMatchObject({ ok: false, field: "daTraNgay" });
    expect(await prisma.phieuNhapNo.count()).toBe(0);
    expect(await demTraNcc()).toBe(0);
  });
});

describe("ghiNhanPhieuVaoSoNo — đã trả trước", () => {
  it("phiếu có dòng Sổ chi phí cùng refId 53,6 ⇒ daTraTruoc 53,6, còn nợ 0", async () => {
    const res = await ghiNhanPhieuVaoSoNo({ uuid: P5.uuid });
    expect(res).toMatchObject({ ok: true, data: { daTraTruoc: 53_600_000, conNo: 0 } });
  });

  it("phiếu có dòng Sổ chi phí mà gõ số khác ⇒ từ chối ô daTraTruoc", async () => {
    const res = await ghiNhanPhieuVaoSoNo({ uuid: P5.uuid, daTraTruoc: 10 * TR });
    expect(res).toMatchObject({ ok: false, field: "daTraTruoc" });
    expect(await prisma.phieuNhapNo.count()).toBe(0);
  });

  it("phiếu TRƯỚC D0, không dòng chi phí ⇒ gõ được daTraTruoc", async () => {
    const res = await ghiNhanPhieuVaoSoNo({ uuid: P0.uuid, daTraTruoc: 20 * TR });
    expect(res).toMatchObject({ ok: true, data: { tongTien: 50 * TR, daTraTruoc: 20 * TR, conNo: 30 * TR } });
  });

  it("phiếu từ D0 trở đi, không dòng chi phí, gõ daTraTruoc ⇒ từ chối; không gõ ⇒ 0", async () => {
    expect(await ghiNhanPhieuVaoSoNo({ uuid: P1.uuid, daTraTruoc: 5 * TR })).toMatchObject({ ok: false, field: "daTraTruoc" });
    expect(await ghiNhanPhieuVaoSoNo({ uuid: P1.uuid })).toMatchObject({ ok: true, data: { daTraTruoc: 0 } });
  });
});

describe("đã trả trước lệch Sổ chi phí — phương án X / Y (spec §5.4)", () => {
  const NHAN_SU = () => nguoiDungGia({ role: "STAFF", quyen: new Set(["tai-chinh-so-quy:sua"]) });
  const LY_DO = "Duyệt T9 53,6 nhưng thực trả 33,6 — phần thừa vào điều chỉnh mở sổ";

  it("X: gõ ĐÚNG số Sổ chi phí (53,6) ⇒ nhân sự có quyền Sổ quỹ ghi được, không cờ giải thích", async () => {
    vi.mocked(docNguoiDungPhien).mockImplementation(async () => NHAN_SU());
    const res = await ghiNhanPhieuVaoSoNo({ uuid: P5.uuid, daTraTruoc: 53_600_000 });
    expect(res).toMatchObject({ ok: true, data: { daTraTruoc: 53_600_000, conNo: 0 } });
    expect(await prisma.phieuNhapNo.findUniqueOrThrow({ where: { refId: refIdChoPhieu(P5.uuid) } })).toMatchObject({
      lechDaGiaiThich: false,
      lechDaGiaiThichSo: null,
      note: "",
    });
  });

  it("Y lúc ghi nhận (53,6 vs 33,6): nhân sự + lý do ⇒ từ chối; chủ shop không lý do ⇒ từ chối; chủ shop + lý do ⇒ OK", async () => {
    vi.mocked(docNguoiDungPhien).mockImplementation(async () => NHAN_SU());
    const nhanSu = await ghiNhanPhieuVaoSoNo({ uuid: P5.uuid, daTraTruoc: 33_600_000, lyDoLech: LY_DO });
    expect(nhanSu).toMatchObject({ ok: false, field: "daTraTruoc" });
    expect(nhanSu.ok ? "" : nhanSu.error).toContain("chủ shop");
    expect(nhanSu.ok ? "" : nhanSu.error).toContain("lý do");

    vi.mocked(docNguoiDungPhien).mockImplementation(async () => nguoiDungGia());
    expect(await ghiNhanPhieuVaoSoNo({ uuid: P5.uuid, daTraTruoc: 33_600_000 })).toMatchObject({ ok: false, field: "daTraTruoc" });
    // Lý do toàn khoảng trắng = không có lý do; quá ngắn ⇒ zod ô lyDoLech.
    expect(await ghiNhanPhieuVaoSoNo({ uuid: P5.uuid, daTraTruoc: 33_600_000, lyDoLech: "   " })).toMatchObject({
      ok: false,
      field: "daTraTruoc",
    });
    expect(await ghiNhanPhieuVaoSoNo({ uuid: P5.uuid, daTraTruoc: 33_600_000, lyDoLech: " ab " })).toMatchObject({
      ok: false,
      field: "lyDoLech",
    });
    expect(await prisma.phieuNhapNo.count()).toBe(0);

    const ok = await ghiNhanPhieuVaoSoNo({ uuid: P5.uuid, daTraTruoc: 33_600_000, lyDoLech: `  ${LY_DO}  ` });
    expect(ok).toMatchObject({ ok: true, data: { tongTien: 53_600_000, daTraTruoc: 33_600_000, conNo: 20 * TR } });
    expect(await prisma.phieuNhapNo.findUniqueOrThrow({ where: { refId: refIdChoPhieu(P5.uuid) } })).toMatchObject({
      daTraTruoc: 33_600_000,
      lechDaGiaiThich: true,
      lechDaGiaiThichSo: 53_600_000,
      note: LY_DO,
    });
    expect(await hauKiemPhieu()).toEqual([]);

    // Sổ chi phí đổi tiếp 53,6 → 40 ⇒ lời giải thích cũ hết áp, cảnh báo hiện lại.
    await prisma.expense.update({ where: { refId: refIdChoPhieu(P5.uuid) }, data: { amount: 40 * TR } });
    expect(await hauKiemPhieu()).toEqual([
      expect.objectContaining({ loai: "LECH_DA_TRA_TRUOC", soCu: 33_600_000, soMoi: 40 * TR }),
    ]);
  });

  it("Y qua capNhatDaTraTruoc: không lý do ⇒ từ chối; nhân sự + lý do ⇒ từ chối; chủ shop + lý do ⇒ cờ bật; về đúng số ⇒ cờ tắt", async () => {
    const res = await ghiNhanPhieuVaoSoNo({ uuid: P5.uuid });
    if (!res.ok) throw new Error(res.error);
    const id = res.data.phieuNhapId;

    expect(await capNhatDaTraTruoc({ phieuNhapId: id, daTraTruoc: 33_600_000 })).toMatchObject({ ok: false, field: "daTraTruoc" });
    vi.mocked(docNguoiDungPhien).mockImplementation(async () => NHAN_SU());
    expect(await capNhatDaTraTruoc({ phieuNhapId: id, daTraTruoc: 33_600_000, lyDoLech: LY_DO })).toMatchObject({
      ok: false,
      field: "daTraTruoc",
    });

    vi.mocked(docNguoiDungPhien).mockImplementation(async () => nguoiDungGia());
    expect(await capNhatDaTraTruoc({ phieuNhapId: id, daTraTruoc: 33_600_000, lyDoLech: LY_DO })).toMatchObject({
      ok: true,
      data: { daTraTruoc: 33_600_000, conNo: 20 * TR },
    });
    expect(await prisma.phieuNhapNo.findUniqueOrThrow({ where: { id } })).toMatchObject({
      lechDaGiaiThich: true,
      lechDaGiaiThichSo: 53_600_000,
      note: LY_DO,
    });
    expect(await hauKiemPhieu()).toEqual([]);

    // Về đúng số Sổ chi phí (không lý do) ⇒ cờ + số tắt, ghi chú giữ làm lịch sử.
    expect(await capNhatDaTraTruoc({ phieuNhapId: id, daTraTruoc: 53_600_000 })).toMatchObject({ ok: true, data: { conNo: 0 } });
    expect(await prisma.phieuNhapNo.findUniqueOrThrow({ where: { id } })).toMatchObject({
      lechDaGiaiThich: false,
      lechDaGiaiThichSo: null,
      note: LY_DO,
    });
  });

  it("phiếu từ D0 không có dòng chi phí: chủ shop + lý do gõ 5 ⇒ OK, số giải thích 0, hậu kiểm im", async () => {
    const res = await ghiNhanPhieuVaoSoNo({ uuid: P1.uuid, daTraTruoc: 5 * TR, lyDoLech: "Trả tay NCC trước D0 cho phiếu sau" });
    expect(res).toMatchObject({ ok: true, data: { daTraTruoc: 5 * TR, conNo: 95 * TR } });
    expect(await prisma.phieuNhapNo.findUniqueOrThrow({ where: { refId: refIdChoPhieu(P1.uuid) } })).toMatchObject({
      lechDaGiaiThich: true,
      lechDaGiaiThichSo: 0,
    });
    expect(await hauKiemPhieu()).toEqual([]);
  });
});

describe("hậu kiểm khi dòng Sổ chi phí biến mất", () => {
  it("ghi nhận #5 (Expense 53,6) ⇒ xoá Expense ⇒ LECH_DA_TRA_TRUOC soMoi 0; cập nhật 0 ⇒ còn nợ 53,6, hết cảnh báo", async () => {
    const res = await ghiNhanPhieuVaoSoNo({ uuid: P5.uuid });
    if (!res.ok) throw new Error(res.error);
    const id = res.data.phieuNhapId;
    await prisma.expense.deleteMany({ where: { refId: refIdChoPhieu(P5.uuid) } });

    expect(await hauKiemPhieu()).toEqual([
      expect.objectContaining({ phieuNhapId: id, loai: "LECH_DA_TRA_TRUOC", soCu: 53_600_000, soMoi: 0 }),
    ]);
    expect(await capNhatDaTraTruoc({ phieuNhapId: id, daTraTruoc: 0 })).toMatchObject({
      ok: true,
      data: { daTraTruoc: 0, conNo: 53_600_000 },
    });
    expect(await hauKiemPhieu()).toEqual([]);
  });

  it("xoá Expense ⇒ chủ shop bấm 'đã giải thích' ⇒ lưu số 0, ẩn cảnh báo", async () => {
    const res = await ghiNhanPhieuVaoSoNo({ uuid: P5.uuid });
    if (!res.ok) throw new Error(res.error);
    await prisma.expense.deleteMany({ where: { refId: refIdChoPhieu(P5.uuid) } });
    expect((await boQuaLechDaGiaiThich({ phieuNhapId: res.data.phieuNhapId, note: "NCC đã nhận đủ ngoài sổ" })).ok).toBe(true);
    expect(await prisma.phieuNhapNo.findUniqueOrThrow({ where: { id: res.data.phieuNhapId } })).toMatchObject({
      lechDaGiaiThich: true,
      lechDaGiaiThichSo: 0,
    });
    expect(await hauKiemPhieu()).toEqual([]);
  });

  it("phiếu TRƯỚC D0 gõ tay, không dòng chi phí ⇒ không cảnh báo", async () => {
    expect((await ghiNhanPhieuVaoSoNo({ uuid: P0.uuid, daTraTruoc: 20 * TR })).ok).toBe(true);
    expect(await hauKiemPhieu()).toEqual([]);
  });
});

describe("ghiNhanPhieuVaoSoNo — trùng / phiếu không hợp lệ / quyền", () => {
  it("refId trùng (gửi lại) ⇒ DA_GHI_ROI, vẫn một hồ sơ", async () => {
    expect((await ghiNhanPhieuVaoSoNo({ uuid: P1.uuid })).ok).toBe(true);
    const lan2 = await ghiNhanPhieuVaoSoNo({ uuid: P1.uuid });
    expect(lan2).toMatchObject({ ok: false, code: "DA_GHI_ROI" });
    expect(await prisma.phieuNhapNo.count()).toBe(1);
  });

  it("refId trùng kèm đã trả ngay ⇒ DA_GHI_ROI và KHÔNG thêm dòng tiền", async () => {
    await datMocM(M);
    expect((await ghiNhanPhieuVaoSoNo({ uuid: P1.uuid, daTraNgay: { soTien: 10 * TR, ngay: "2026-10-05" } })).ok).toBe(true);
    const lan2 = await ghiNhanPhieuVaoSoNo({ uuid: P1.uuid, daTraNgay: { soTien: 10 * TR, ngay: "2026-10-05" } });
    expect(lan2).toMatchObject({ ok: false, code: "DA_GHI_ROI" });
    expect(await demTraNcc()).toBe(1);
  });

  it("phiếu đã huỷ bên Pancake ⇒ PHIEU_KHONG_HIEU_LUC; uuid lạ ⇒ DANH_SACH_DA_DOI", async () => {
    expect(await ghiNhanPhieuVaoSoNo({ uuid: P9.uuid })).toMatchObject({ ok: false, code: "PHIEU_KHONG_HIEU_LUC" });
    expect(await ghiNhanPhieuVaoSoNo({ uuid: "khong-co" })).toMatchObject({ ok: false, code: "DANH_SACH_DA_DOI" });
    expect(await prisma.phieuNhapNo.count()).toBe(0);
  });

  it("nhân sự KHÔNG có tai-chinh-so-quy:sua ⇒ KHONG_CO_QUYEN; có quyền ⇒ ghi được", async () => {
    vi.mocked(docNguoiDungPhien).mockImplementation(async () => nguoiDungGia({ role: "STAFF", quyen: new Set(["chi-phi:sua"]) }));
    expect(await ghiNhanPhieuVaoSoNo({ uuid: P1.uuid })).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    vi.mocked(docNguoiDungPhien).mockImplementation(async () =>
      nguoiDungGia({ role: "STAFF", quyen: new Set(["tai-chinh-so-quy:sua"]) }),
    );
    expect((await ghiNhanPhieuVaoSoNo({ uuid: P1.uuid })).ok).toBe(true);
  });
});

describe("nút hậu kiểm", () => {
  async function ghiNhan(uuid: string, them: Record<string, unknown> = {}): Promise<string> {
    const res = await ghiNhanPhieuVaoSoNo({ uuid, ...them });
    if (!res.ok) throw new Error(res.error);
    return res.data.phieuNhapId;
  }

  it("capNhatTongPhieu: Pancake 100 → 95 ⇒ tổng 95; số client đã cũ ⇒ DANH_SACH_DA_DOI", async () => {
    const id = await ghiNhan(P1.uuid);
    await seedBronze({ ...P1, tongTien: 95 * TR }, vn("2026-10-02T12:00:00"));
    expect(await capNhatTongPhieu({ phieuNhapId: id, tongTienMoi: 90 * TR })).toMatchObject({ ok: false, code: "DANH_SACH_DA_DOI" });
    expect(await capNhatTongPhieu({ phieuNhapId: id, tongTienMoi: 95 * TR })).toMatchObject({ ok: true, data: { tongTien: 95 * TR } });
    expect(await hauKiemPhieu()).toEqual([]);
    expect(await prisma.auditLog.count({ where: { hanhDong: "NHAP_HANG_SUA_NO", doiTuongId: id, ketQua: "OK" } })).toBe(1);
  });

  it("danhDauHuyPhieu sau khi đã trả 5 ⇒ còn nợ −5 (cần thu hồi); nhân sự có quyền Sổ quỹ vẫn bị từ chối", async () => {
    await datMocM(M);
    const id = await ghiNhan(P1.uuid, { daTraNgay: { soTien: 5 * TR, ngay: "2026-10-05" } });

    vi.mocked(docNguoiDungPhien).mockImplementation(async () =>
      nguoiDungGia({ role: "STAFF", quyen: new Set(["tai-chinh-so-quy:sua"]) }),
    );
    expect(await danhDauHuyPhieu({ phieuNhapId: id })).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });

    vi.mocked(docNguoiDungPhien).mockImplementation(async () => nguoiDungGia());
    expect(await danhDauHuyPhieu({ phieuNhapId: id })).toMatchObject({ ok: true, data: { conNo: -5 * TR } });
    // Lịch sử tiền giữ nguyên.
    expect(await demTraNcc()).toBe(1);
    expect(await prisma.auditLog.count({ where: { hanhDong: "NHAP_HANG_HUY_NO", doiTuongId: id } })).toBe(1);
  });

  it("lệch Sổ chi phí 53,6 → 33,6: đã giải thích ⇒ ẩn; cập nhật đã trả trước ⇒ 33,6 và cờ tự tắt", async () => {
    const id = await ghiNhan(P5.uuid);
    await prisma.expense.update({ where: { refId: refIdChoPhieu(P5.uuid) }, data: { amount: 33_600_000 } });
    expect((await hauKiemPhieu()).map((c) => c.loai)).toEqual(["LECH_DA_TRA_TRUOC"]);

    expect(await boQuaLechDaGiaiThich({ phieuNhapId: id, note: "   " })).toMatchObject({ ok: false, field: "note" });
    expect((await boQuaLechDaGiaiThich({ phieuNhapId: id, note: "  NCC giảm giá sau  " })).ok).toBe(true);
    expect(await prisma.phieuNhapNo.findUniqueOrThrow({ where: { id } })).toMatchObject({
      lechDaGiaiThich: true,
      lechDaGiaiThichSo: 33_600_000,
      note: "NCC giảm giá sau",
    });
    expect(await hauKiemPhieu()).toEqual([]);

    // Gõ số không khớp dòng chi phí ⇒ từ chối; đúng số ⇒ cập nhật, cờ về false.
    expect(await capNhatDaTraTruoc({ phieuNhapId: id, daTraTruoc: 30 * TR })).toMatchObject({ ok: false, field: "daTraTruoc" });
    expect(await capNhatDaTraTruoc({ phieuNhapId: id, daTraTruoc: 33_600_000 })).toMatchObject({
      ok: true,
      data: { daTraTruoc: 33_600_000, conNo: 20 * TR },
    });
    expect((await prisma.phieuNhapNo.findUniqueOrThrow({ where: { id } })).lechDaGiaiThich).toBe(false);
    expect(await hauKiemPhieu()).toEqual([]);
  });

  /**
   * Tx khác KHOÁ phiếu rồi tự sửa đúng thứ lượt sửa định sửa, ngủ 0,8s, commit. Có `khoaCacPhieu` trong
   * `suaPhieu` ⇒ lượt sửa chờ khoá, đọc lại SAU commit ⇒ thấy đã đổi ⇒ "không có gì đổi", KHÔNG nhật ký.
   * Thiếu khoá ⇒ đọc bản cũ (READ COMMITTED), câu UPDATE chờ rồi ghi đè ⇒ có nhật ký ⇒ đỏ.
   */
  async function giuKhoaRoiSua(id: string, sua: (tx: Prisma.TransactionClient) => Promise<unknown>) {
    let daGiu!: () => void;
    const giuXong = new Promise<void>((r) => (daGiu = r));
    const giu = prisma.$transaction(
      async (tx) => {
        await khoaCacPhieu(tx, [id]);
        daGiu();
        await new Promise((r) => setTimeout(r, 800));
        await sua(tx);
      },
      { timeout: 20_000 },
    );
    await giuXong;
    // Bọc trong object: `return giu` trần từ hàm async sẽ khiến caller CHỜ cả tx xong mới chạy tiếp.
    return { giu };
  }

  it("capNhatTongPhieu chờ khoá phiếu: tx khác giữ khoá + đổi tổng ⇒ lượt sửa đọc SAU commit, không ghi đè", async () => {
    const id = await ghiNhan(P1.uuid);
    await seedBronze({ ...P1, tongTien: 95 * TR }, vn("2026-10-02T12:00:00"));
    const { giu } = await giuKhoaRoiSua(id, (tx) => tx.phieuNhapNo.update({ where: { id }, data: { tongTien: 95 * TR } }));
    const batDau = Date.now();
    const res = await capNhatTongPhieu({ phieuNhapId: id, tongTienMoi: 95 * TR });
    const choMs = Date.now() - batDau;
    await giu;
    expect(res).toMatchObject({ ok: true, data: { tongTien: 95 * TR } });
    expect(choMs).toBeGreaterThanOrEqual(700);
    expect(await prisma.auditLog.count({ where: { hanhDong: "NHAP_HANG_SUA_NO", doiTuongId: id } })).toBe(0);
  });

  it("danhDauHuyPhieu chờ khoá phiếu: tx khác giữ khoá + huỷ ⇒ lượt huỷ thấy đã huỷ, không nhật ký thừa", async () => {
    const id = await ghiNhan(P1.uuid);
    const { giu } = await giuKhoaRoiSua(id, (tx) => tx.phieuNhapNo.update({ where: { id }, data: { daHuy: true } }));
    const batDau = Date.now();
    const res = await danhDauHuyPhieu({ phieuNhapId: id });
    const choMs = Date.now() - batDau;
    await giu;
    expect(res).toMatchObject({ ok: true, data: { conNo: 0 } });
    expect(choMs).toBeGreaterThanOrEqual(700);
    expect(await prisma.auditLog.count({ where: { hanhDong: "NHAP_HANG_HUY_NO", doiTuongId: id } })).toBe(0);
  });

  it("phiếu không có trong sổ ⇒ KHONG_TIM_THAY", async () => {
    expect(await capNhatTongPhieu({ phieuNhapId: "id-khong-co", tongTienMoi: 1 })).toMatchObject({ ok: false, code: "KHONG_TIM_THAY" });
  });
});
