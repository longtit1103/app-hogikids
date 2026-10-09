import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Khoá hồ sơ + hàng rào cha của 4 loại nợ phải trả qua action ghi tay thường, trên DB thật. Mỗi ca bắt
 * đúng MỘT đột biến từng sống (review độc lập S1+S2):
 *  - bỏ `khoaHoSoNo` ở TẠO ⇒ trả vào phiếu đang bị huỷ song song lọt (FK chỉ chờ, không kiểm lại `daHuy`);
 *  - bỏ `khoaHoSoNo` ở XOÁ ⇒ xoá dòng của thẻ đang bị đóng song song lọt, không chờ;
 *  - hàng rào cha (`KHOA_CHA` + `ghiCoHangRaoCha`) thiếu `viAdsId` / `cardId` / `phieuNhapId` ⇒ bản đọc
 *    ngoài transaction đã cũ (dòng vừa bị chuyển sang hồ sơ khác) mà câu ghi vẫn khớp, khoá nhầm cha.
 * M = 01/11/2026, hôm nay ghim 26/11/2026.
 */
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => ({
  ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
  docNguoiDungPhien: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import type { Prisma } from "@/generated/prisma/client";
import { createCashMovement, deleteCashMovement, updateCashMovement } from "@/lib/actions/cash-movements";
import { KEY_NO_PHAI_TRA_TU_NGAY } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { khoaCacPhieu } from "@/lib/no-phai-tra/phieu-nhap-no-queries";
import { khoaThe } from "@/lib/no-phai-tra/the-tin-dung-queries";
import { prisma } from "@/lib/prisma";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";

import { nguoiDungGia } from "../../helpers/nguoi-dung-gia";
import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

const vn = (ngay: string, gio = "00:00:00") => new Date(`${ngay}T${gio}+07:00`);
const tr = (n: number) => Math.round(n * 1_000_000);

async function taoThe(ten: string): Promise<string> {
  const id = (await prisma.theTinDung.create({ data: { ten, ngayChotSaoKe: 25, ngayHanTra: 10 } })).id;
  await prisma.kySaoKeThe.create({ data: { cardId: id, ngayChot: vn("2026-10-31"), soDu: 0, laNeoMoSo: true } });
  return id;
}

async function taoPhieu(ma: string): Promise<string> {
  return (
    await prisma.phieuNhapNo.create({
      data: { refId: `PO:${ma}:${Math.random()}`, shopId: "714995134", maPhieu: ma, ngayPhieu: vn("2026-11-02"), tongTien: tr(20) },
    })
  ).id;
}

async function taoVi(nenTang: string): Promise<string> {
  return (await prisma.viAdsTraTruoc.create({ data: { nenTang, soDuNeo: 0, ngayNeo: vn("2026-11-01", "23:59:59") } })).id;
}

/**
 * Một transaction khác GIỮ khoá dòng hồ sơ ~800 ms rồi mới commit thay đổi trạng thái (đóng thẻ / huỷ
 * phiếu). Trả `tha` (cho commit) + `xong` (chờ commit xong).
 */
async function giuKhoa(lam: (tx: Prisma.TransactionClient) => Promise<void>) {
  let tha!: () => void;
  const cho = new Promise<void>((res) => (tha = res));
  let daGiu!: () => void;
  const giuXong = new Promise<void>((res) => (daGiu = res));
  const xong = prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      await lam(tx);
      daGiu();
      await cho;
    },
    { timeout: 20_000 },
  );
  await giuXong;
  return { tha, xong };
}

/** Chạy `goi` trong lúc khoá đang bị giữ, nhả sau 800 ms. Trả kết quả + thời gian chờ. */
async function chayKhiBiGiu<T>(giu: { tha: () => void; xong: Promise<unknown> }, goi: () => Promise<T>) {
  const t0 = performance.now();
  const p = goi().then((r) => ({ r, ms: performance.now() - t0 }));
  await new Promise((res) => setTimeout(res, 800));
  // Trước khi khoá nhả: lượt ghi chưa được để lại dấu vết OK nào (nó phải đang chờ khoá).
  const nhatKyTruocKhiNha = await prisma.auditLog.count({ where: { hanhDong: { startsWith: "DONG_TIEN_" }, ketQua: "OK" } });
  giu.tha();
  await giu.xong;
  return { ...(await p), nhatKyTruocKhiNha };
}

/**
 * Ép lượt đọc `truoc` (findUnique ĐẦU TIÊN của action) trả bản CŨ; các lượt sau chạy thật. Mô phỏng một
 * lượt sửa khác vừa chuyển dòng sang hồ sơ khác giữa lúc đọc và lúc giành khoá.
 */
const epDocCu = (cu: Record<string, unknown>) =>
  vi.spyOn(prisma.cashMovement, "findUnique").mockImplementationOnce((async () => ({
    loanId: null,
    savingsId: null,
    cardId: null,
    phieuNhapId: null,
    viAdsId: null,
    ...cu,
  })) as never);

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.auditLog.deleteMany();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
  await prisma.setting.create({ data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: "2026-11-01" } });
  vi.mocked(docNguoiDungPhien).mockResolvedValue(nguoiDungGia());
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(vn("2026-11-26", "10:00:00"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

describe("khoá hồ sơ ở TẠO và XOÁ dòng nợ phải trả", () => {
  it("TẠO SUPPLIER_PAY khi lượt huỷ phiếu đang giữ khoá ⇒ chờ ≥ 0,7s rồi thấy phiếu đã huỷ, không ghi", async () => {
    const p = await taoPhieu("PN-KHOA");
    const giu = await giuKhoa(async (tx) => {
      await khoaCacPhieu(tx, [p]);
      await tx.phieuNhapNo.update({ where: { id: p }, data: { daHuy: true } });
    });
    const { r, ms, nhatKyTruocKhiNha } = await chayKhiBiGiu(giu, () =>
      createCashMovement({ date: vn("2026-11-20"), kind: "SUPPLIER_PAY", amount: tr(5), description: "", phieuNhapId: p }),
    );
    expect(ms).toBeGreaterThan(700);
    expect(nhatKyTruocKhiNha).toBe(0);
    expect(r).toMatchObject({ ok: false, code: "PHIEU_DA_HUY" });
    expect(await prisma.cashMovement.count()).toBe(0);
  });

  it("XOÁ CARD_PAY khi lượt đóng thẻ đang giữ khoá ⇒ chờ ≥ 0,7s rồi thấy thẻ đã đóng, dòng còn nguyên", async () => {
    const cardId = await taoThe("Thẻ X");
    expect(
      await createCashMovement({ date: vn("2026-11-20"), kind: "CARD_PAY", amount: tr(2), description: "", cardId }),
    ).toEqual({ ok: true, data: undefined });
    const dong = await prisma.cashMovement.findFirstOrThrow();
    await prisma.auditLog.deleteMany();
    const giu = await giuKhoa(async (tx) => {
      await khoaThe(tx, cardId);
      await tx.theTinDung.update({ where: { id: cardId }, data: { closedAt: vn("2026-11-26") } });
    });
    const { r, ms, nhatKyTruocKhiNha } = await chayKhiBiGiu(giu, () => deleteCashMovement(dong.id));
    expect(ms).toBeGreaterThan(700);
    expect(nhatKyTruocKhiNha).toBe(0);
    expect(r).toMatchObject({ ok: false, code: "THE_DA_DONG" });
    expect(await prisma.cashMovement.count({ where: { id: dong.id } })).toBe(1);
  });
});

describe("hàng rào cha khi bản đọc ngoài transaction đã cũ (3 khoá nợ phải trả)", () => {
  const CAU = "vừa được sửa sang mục khác";

  it("ADS_TOPUP: DB đã sang ví B, bản đọc cũ còn ví A ⇒ sửa bị từ chối, dòng giữ ví B", async () => {
    const a = await taoVi("SHOPEE_ADS");
    const b = await taoVi("TIKTOK_ADS");
    const dong = await prisma.cashMovement.create({
      data: { date: vn("2026-11-20"), kind: "ADS_TOPUP", amount: tr(1), description: "", viAdsId: b },
    });
    epDocCu({ kind: "ADS_TOPUP", date: dong.date, amount: dong.amount, viAdsId: a });
    const res = await updateCashMovement(dong.id, {
      date: vn("2026-11-20"),
      kind: "ADS_TOPUP",
      amount: tr(3),
      description: "ghi đè lén",
      viAdsId: a,
    });
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining(CAU) });
    expect(await prisma.cashMovement.findUniqueOrThrow({ where: { id: dong.id } })).toMatchObject({ viAdsId: b, amount: tr(1) });
  });

  it("CARD_PAY: DB đã sang thẻ B, bản đọc cũ còn thẻ A ⇒ sửa bị từ chối, dòng giữ thẻ B", async () => {
    const a = await taoThe("Thẻ A");
    const b = await taoThe("Thẻ B");
    const dong = await prisma.cashMovement.create({
      data: { date: vn("2026-11-20"), kind: "CARD_PAY", amount: tr(1), description: "", cardId: b },
    });
    epDocCu({ kind: "CARD_PAY", date: dong.date, amount: dong.amount, cardId: a });
    const res = await updateCashMovement(dong.id, {
      date: vn("2026-11-20"),
      kind: "CARD_PAY",
      amount: tr(3),
      description: "",
      cardId: a,
    });
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining(CAU) });
    expect(await prisma.cashMovement.findUniqueOrThrow({ where: { id: dong.id } })).toMatchObject({ cardId: b, amount: tr(1) });
  });

  it("SUPPLIER_PAY: DB đã sang phiếu B, bản đọc cũ còn phiếu A ⇒ sửa bị từ chối, dòng giữ phiếu B", async () => {
    const a = await taoPhieu("PN-A");
    const b = await taoPhieu("PN-B");
    const dong = await prisma.cashMovement.create({
      data: { date: vn("2026-11-20"), kind: "SUPPLIER_PAY", amount: tr(1), description: "", phieuNhapId: b },
    });
    epDocCu({ kind: "SUPPLIER_PAY", date: dong.date, amount: dong.amount, phieuNhapId: a });
    const res = await updateCashMovement(dong.id, {
      date: vn("2026-11-20"),
      kind: "SUPPLIER_PAY",
      amount: tr(3),
      description: "",
      phieuNhapId: a,
    });
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining(CAU) });
    expect(await prisma.cashMovement.findUniqueOrThrow({ where: { id: dong.id } })).toMatchObject({
      phieuNhapId: b,
      amount: tr(1),
    });
  });
});
