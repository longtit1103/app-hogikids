import { addMonths, endOfMonth, startOfMonth } from "date-fns";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { luuSoDuChotThang, xoaSoDuChotThang } from "@/lib/actions/so-du-chot-thang";
import { prisma } from "@/lib/prisma";
import { doiChieuSoDuChot, tinhKhoanCauTruc } from "@/lib/so-quy/doi-chieu-so-du-chot";
import { listKhoanVay } from "@/lib/so-quy/khoan-vay-queries";
import { tinhSoQuyThang } from "@/lib/so-quy/so-quy-queries";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Integration (`hogikids_test`) cho bản chốt số dư cuối tháng. Mock `requireUser` + `revalidatePath`
 * như `cash-movements-actions.integration.test.ts`.
 *
 * Fixture: mở sổ D0 = 05/07/2026 (góp vốn 100tr), rút vốn 10tr ngày 10/08/2026
 *   ⇒ sổ quỹ CUỐI KỲ tháng 8/2026 = 90tr (luỹ kế từ D0).
 * Tháng 6/2026 nằm TRƯỚC D0 · tháng sau tháng hiện tại là TƯƠNG LAI.
 */
vi.mock("@/lib/session", () => ({ requireUser: vi.fn(async () => "test-user-id") }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const T8 = { from: startOfMonth(new Date(2026, 7, 1)), to: endOfMonth(new Date(2026, 7, 1)) };
const CUOI_KY_T8 = 90_000_000;

const chot = (ghiDe: Record<string, unknown> = {}) => ({
  thang: "2026-08-15", // giữa tháng — action phải tự về đầu tháng
  soDuBank: 85_000_000,
  tienMat: 5_000_000,
  note: "Đếm két cuối T8",
  ...ghiDe,
});

async function moSo(): Promise<void> {
  await prisma.cashMovement.createMany({
    data: [
      { date: new Date(2026, 6, 5), kind: "CAPITAL_IN", amount: 100_000_000, description: "Góp vốn mở sổ" },
      { date: new Date(2026, 7, 10), kind: "CAPITAL_OUT", amount: 10_000_000, description: "Rút vốn" },
    ],
  });
}

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

describe("luuSoDuChotThang", () => {
  it("tạo bản chốt: khoá về ĐẦU tháng, đúng 1 dòng", async () => {
    await moSo();
    const res = await luuSoDuChotThang(chot());
    expect(res.ok).toBe(true);

    const rows = await prisma.soDuChotThang.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ soDuBank: 85_000_000, tienMat: 5_000_000, note: "Đếm két cuối T8" });
    expect(rows[0].thang).toEqual(new Date(2026, 7, 1));
  });

  it("lưu lại CÙNG tháng ⇒ sửa đè, vẫn 1 dòng, số mới", async () => {
    await moSo();
    expect((await luuSoDuChotThang(chot())).ok).toBe(true);
    expect((await luuSoDuChotThang(chot({ thang: "2026-08-31", tienMat: 3_000_000 }))).ok).toBe(true);

    const rows = await prisma.soDuChotThang.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].tienMat).toBe(3_000_000);
  });

  it("chưa mở sổ ⇒ từ chối, KHÔNG kèm field (toast, không rơi vào ô ẩn)", async () => {
    const res = await luuSoDuChotThang(chot());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("Chưa mở sổ quỹ");
      expect(res.field).toBeUndefined();
    }
    expect(await prisma.soDuChotThang.count()).toBe(0);
  });

  it("tháng TƯƠNG LAI ⇒ từ chối", async () => {
    await moSo();
    const thangSau = addMonths(startOfMonth(new Date()), 1);
    const res = await luuSoDuChotThang(chot({ thang: thangSau.toISOString() }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("tương lai");
    expect(await prisma.soDuChotThang.count()).toBe(0);
  });

  it("tháng TRƯỚC ngày mở sổ ⇒ từ chối", async () => {
    await moSo();
    const res = await luuSoDuChotThang(chot({ thang: "2026-06-30" }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("trước ngày mở sổ");
    expect(await prisma.soDuChotThang.count()).toBe(0);
  });

  it("tiền mặt ÂM ⇒ từ chối đúng ô 'tienMat'", async () => {
    await moSo();
    const res = await luuSoDuChotThang(chot({ tienMat: -1 }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.field).toBe("tienMat");
  });

  it("bank ÂM (thấu chi) ⇒ CHẤP NHẬN", async () => {
    await moSo();
    const res = await luuSoDuChotThang(chot({ soDuBank: -20_000_000 }));
    expect(res.ok).toBe(true);
    expect((await prisma.soDuChotThang.findFirstOrThrow()).soDuBank).toBe(-20_000_000);
  });

  it("vượt 2 tỷ ⇒ từ chối (trần Int32) — CẢ HAI chiều; đúng biên thì nhận", async () => {
    await moSo();
    const qua = await luuSoDuChotThang(chot({ soDuBank: 2_000_000_001 }));
    expect(qua.ok).toBe(false);
    if (!qua.ok) expect(qua.field).toBe("soDuBank");
    const quaAm = await luuSoDuChotThang(chot({ soDuBank: -2_000_000_001 }));
    expect(quaAm.ok).toBe(false);
    if (!quaAm.ok) expect(quaAm.field).toBe("soDuBank");
    expect((await luuSoDuChotThang(chot({ soDuBank: -2_000_000_000, tienMat: 2_000_000_000 }))).ok).toBe(true);
  });

  it("ghi chú 201 ký tự ⇒ từ chối đúng ô 'note' (maxLength ở client không phải cổng)", async () => {
    await moSo();
    const res = await luuSoDuChotThang(chot({ note: "x".repeat(201) }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.field).toBe("note");
  });

  it("chốt được THÁNG HIỆN TẠI (tháng chưa hết vẫn là tháng hợp lệ)", async () => {
    await prisma.cashMovement.create({
      data: { date: new Date(2026, 6, 5), kind: "CAPITAL_IN", amount: 1_000_000, description: "Mở sổ" },
    });
    expect((await luuSoDuChotThang(chot({ thang: new Date().toISOString() }))).ok).toBe(true);
  });
});

describe("CHECK tầng DB — zod là lớp MỘT, psql/script đi thẳng Prisma phải bị chặn ở lớp HAI", () => {
  it("tienMat âm bị Postgres từ chối (SoDuChotThang_tienMat_khong_am)", async () => {
    await expect(
      prisma.soDuChotThang.create({ data: { thang: new Date(2026, 7, 1), soDuBank: 0, tienMat: -1 } })
    ).rejects.toThrow();
    expect(await prisma.soDuChotThang.count()).toBe(0);
  });

  it("cùng tháng hai dòng bị UNIQUE từ chối", async () => {
    await prisma.soDuChotThang.create({ data: { thang: new Date(2026, 7, 1), soDuBank: 1, tienMat: 0 } });
    await expect(
      prisma.soDuChotThang.create({ data: { thang: new Date(2026, 7, 1), soDuBank: 2, tienMat: 0 } })
    ).rejects.toThrow();
  });
});

describe("xoaSoDuChotThang", () => {
  it("xoá ⇒ 0 dòng; xoá lại ⇒ 'Không tìm thấy'", async () => {
    await moSo();
    expect((await luuSoDuChotThang(chot())).ok).toBe(true);

    expect((await xoaSoDuChotThang({ thang: "2026-08-20" })).ok).toBe(true);
    expect(await prisma.soDuChotThang.count()).toBe(0);

    const lai = await xoaSoDuChotThang({ thang: "2026-08-20" });
    expect(lai.ok).toBe(false);
    if (!lai.ok) expect(lai.error).toContain("Không tìm thấy");
  });
});

describe("doiChieuSoDuChot — số THẬT trong DB", () => {
  it("cuối kỳ T8 = 90tr; chốt 85tr + 3tr = 88tr ⇒ chênh lệch −2.000.000 (sổ nhiều hơn tiền thật)", async () => {
    await moSo();
    expect((await luuSoDuChotThang(chot({ tienMat: 3_000_000 }))).ok).toBe(true);

    const soQuy = await tinhSoQuyThang(T8);
    expect(soQuy.cuoiKy).toBe(CUOI_KY_T8);

    const dc = await doiChieuSoDuChot(T8, soQuy);
    expect(dc.khaDung).toBe("ok");
    expect(dc.cuoiKy).toBe(90_000_000);
    expect(dc.soChot).toBe(88_000_000);
    expect(dc.chenhLech).toBe(-2_000_000);
    expect(dc.chot?.note).toBe("Đếm két cuối T8");
  });

  it("chưa chốt ⇒ khaDung 'ok' nhưng chot/chenhLech null", async () => {
    await moSo();
    const dc = await doiChieuSoDuChot(T8, await tinhSoQuyThang(T8));
    expect(dc).toMatchObject({ khaDung: "ok", chot: null, chenhLech: null, cuoiKy: CUOI_KY_T8 });
  });

  it("tháng trước chưa chốt ⇒ nhắc; chốt xong ⇒ hết nhắc; tháng trước D0 ⇒ không nhắc", async () => {
    await moSo(); // D0 = 05/07 ⇒ tháng mở sổ = T7
    // Xem T8: T7 đã tới lúc chốt mà chưa có dòng ⇒ nhắc T7.
    let dc = await doiChieuSoDuChot(T8, await tinhSoQuyThang(T8));
    expect(dc.thangTruocChuaChot).toEqual(new Date(2026, 6, 1));
    // Chốt T7 ⇒ hết nhắc.
    expect((await luuSoDuChotThang(chot({ thang: "2026-07-31" }))).ok).toBe(true);
    dc = await doiChieuSoDuChot(T8, await tinhSoQuyThang(T8));
    expect(dc.thangTruocChuaChot).toBeNull();
    // Xem T7: tháng trước là T6 < tháng mở sổ ⇒ không có gì để nhắc.
    const T7 = { from: startOfMonth(new Date(2026, 6, 1)), to: endOfMonth(new Date(2026, 6, 1)) };
    expect((await doiChieuSoDuChot(T7, await tinhSoQuyThang(T7))).thangTruocChuaChot).toBeNull();
  });

  it("THẤU CHI thật: góp 30tr + thấu chi 20tr cầm mặt ⇒ bank 10tr + tiền mặt 20tr là KHỚP, không phải chi thiếu 20tr", async () => {
    const loan = await prisma.loan.create({
      data: { name: "Thấu chi test", kind: "OVERDRAFT", startDate: new Date(2026, 6, 5), annualRateBp: 1500 },
    });
    await prisma.cashMovement.createMany({
      data: [
        { date: new Date(2026, 6, 5), kind: "CAPITAL_IN", amount: 30_000_000, description: "Góp vốn TK B" },
        { date: new Date(2026, 7, 10), kind: "LOAN_IN", amount: 20_000_000, description: "Rút thấu chi TK A", loanId: loan.id },
      ],
    });
    expect((await luuSoDuChotThang(chot({ soDuBank: 10_000_000, tienMat: 20_000_000 }))).ok).toBe(true);

    const soQuy = await tinhSoQuyThang(T8);
    expect(soQuy.cuoiKy).toBe(50_000_000);
    const cauTruc = tinhKhoanCauTruc(await listKhoanVay(), 0);
    expect(cauTruc.duNoThauChi).toBe(20_000_000);

    const dc = await doiChieuSoDuChot(T8, soQuy, cauTruc);
    expect(dc.chenhLechTho).toBe(-20_000_000); // thô: trông như "chi thiếu 20tr"
    expect(dc.chenhLech).toBe(0); // thật: khớp — dư nợ thấu chi đã được cộng
  });

  it("chưa mở sổ ⇒ 'chua_mo_so'; tháng trước D0 ⇒ 'truoc_mo_so'", async () => {
    expect((await doiChieuSoDuChot(T8, await tinhSoQuyThang(T8))).khaDung).toBe("chua_mo_so");

    await moSo();
    const T6 = { from: startOfMonth(new Date(2026, 5, 1)), to: endOfMonth(new Date(2026, 5, 1)) };
    expect((await doiChieuSoDuChot(T6, await tinhSoQuyThang(T6))).khaDung).toBe("truoc_mo_so");
  });
});
