import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Chỉ báo trôi quỹ trước ngày bật trên DB thật. Mở sổ 10/10 = 150tr; ngân hàng thật cuối 31/10 = 152tr ⇒ lúc
 * bật chủ shop ghi một dòng điều chỉnh vào 2tr (Σ điều chỉnh lúc bật = +2tr, khác 0 để bắt nhầm vế). M = 01/11/2026,
 * hôm nay ghim 03/11/2026 10:00 VN; lúc bật ghim 10:00:30, dòng về muộn ghi mốc TƯỜNG MINH 10:01:30.
 */
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => ({
  ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
  docNguoiDungPhien: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { docChenhLechTaiM, xacNhanBatNoPhaiTra } from "@/lib/actions/bat-no-phai-tra";
import { KEY_NO_PHAI_TRA_TU_NGAY } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { docTroiQuyTruocM } from "@/lib/no-phai-tra/doc-trang-no-phai-tra";
import { prisma } from "@/lib/prisma";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";

import { nguoiDungGia } from "../../helpers/nguoi-dung-gia";
import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

const vn = (ngay: string, gio = "00:00:00") => new Date(`${ngay}T${gio}+07:00`);
const tr = (n: number) => Math.round(n * 1_000_000);
const MOC_M = vn("2026-11-01");

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
  vi.mocked(docNguoiDungPhien).mockResolvedValue(nguoiDungGia());
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(vn("2026-11-03", "10:00:00"));
  await prisma.cashMovement.create({
    data: { date: vn("2026-10-10"), kind: "CAPITAL_IN", amount: tr(150), description: "mở sổ" },
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

/** Bật với một dòng điều chỉnh vào 2tr; trả mốc "lúc bật" (createdAt yêu cầu bật) + 1 phút. */
async function batVaLaySauLucBat(): Promise<Date> {
  const b2 = await docChenhLechTaiM({ mocM: "2026-11-01", soDuBank: tr(152), tienMat: 0, the: [], viAds: [] });
  if (!b2.ok) throw new Error(b2.error);
  const yeuCauId = randomUUID();
  const r = await xacNhanBatNoPhaiTra({
    yeuCauId,
    mocM: "2026-11-01",
    the: [],
    viAds: [],
    dieuChinh: [{ chieu: "IN", soTien: tr(2), moTa: "chênh chưa rõ lúc bật" }],
    vanTayQuy: b2.data.vanTay,
  });
  if (!r.ok) throw new Error(r.error);
  // `YeuCauGhi` chèn bằng SQL thô ⇒ `createdAt` lấy đồng hồ THẬT của DB, còn mặc định `now()` của Prisma (mốc ghi
  // các dòng khác) lấy đồng hồ GIẢ của test. Prod một đồng hồ; ở đây ghim lúc bật về dòng thời gian giả (sau dòng
  // mở sổ tạo lúc 10:00:00) để so "ghi sau lúc bật" không trộn hai đồng hồ.
  const lucBat = vn("2026-11-03", "10:00:30");
  await prisma.yeuCauGhi.update({ where: { id: yeuCauId }, data: { createdAt: lucBat } });
  return new Date(lucBat.getTime() + 60_000);
}

const rutViShopee = (txnTime: Date, amount: number, syncedAt: Date, ma = "rut-1") =>
  prisma.shopeeSettlement.create({
    data: {
      externalId: `${txnTime.toISOString()}|WITHDRAWAL|${ma}|${amount}`,
      shopId: "1942992175",
      txnTime,
      type: "WITHDRAWAL",
      amount,
      status: "Hoàn thành",
      runningBalance: 0,
      syncedAt,
    },
  });

describe("chỉ báo trôi quỹ trước ngày bật", () => {
  it("chưa bật ⇒ null (ẩn khối)", async () => {
    expect(await docTroiQuyTruocM(MOC_M)).toBeNull();
  });

  it("vừa bật, không gì đổi ⇒ trôi 0, không dò dòng về muộn", async () => {
    await batVaLaySauLucBat();
    expect(await docTroiQuyTruocM(MOC_M)).toMatchObject({
      troi: 0,
      quyLucBat: tr(150),
      quyHienTai: tr(150),
      soDongVeMuon: 0,
      dongNoiBat: [],
    });
  });

  it("ví Shopee import thêm lệnh rút ngày < M sau bật ⇒ trôi đúng số đó, liệt kê dòng; CUTOVER bù đúng Δ ⇒ trôi 0", async () => {
    const sau = await batVaLaySauLucBat();
    await rutViShopee(vn("2026-10-25", "09:15:00"), -tr(3), sau);

    const troi = await docTroiQuyTruocM(MOC_M);
    expect(troi).toMatchObject({
      troi: tr(3),
      quyLucBat: tr(150),
      quyHienTai: tr(153),
      soDongVeMuon: 1,
      tacDongVeMuon: tr(3),
      chamTran: false,
    });
    expect(troi?.dongNoiBat).toEqual([
      { nhanNguon: "Ví Shopee rút về ngân hàng", ngayNhan: "25/10/2026", tacDong: tr(3), moTa: "rút ví" },
    ]);

    // Chủ shop kiểm xong, thêm điều chỉnh ra đúng 3tr ngày M (cùng hình dạng dòng bù của lối sửa số tiền).
    await prisma.cashMovement.create({
      data: { date: MOC_M, kind: "CUTOVER_ADJ_OUT", amount: tr(3), description: "bù rút ví Shopee về muộn" },
    });
    expect(await docTroiQuyTruocM(MOC_M)).toMatchObject({ troi: 0, quyHienTai: tr(153), soDongVeMuon: 0 });
  });

  it("chủ shop SỬA chính dòng điều chỉnh lúc bật để bù ⇒ trôi 0 (Σ điều chỉnh hiện tại đọc từ bảng, không từ kết quả bật)", async () => {
    const sau = await batVaLaySauLucBat();
    await rutViShopee(vn("2026-10-30"), -tr(0.5), sau);
    await prisma.cashMovement.updateMany({ where: { kind: "CUTOVER_ADJ_IN" }, data: { amount: tr(1.5) } });
    expect(await docTroiQuyTruocM(MOC_M)).toMatchObject({ troi: 0 });
  });

  it("dòng ngày ≥ M (kể cả ngay 00:00 ngày M) ⇒ trôi 0", async () => {
    const sau = await batVaLaySauLucBat();
    await rutViShopee(vn("2026-11-01", "00:00:00"), -tr(4), sau, "rut-m");
    await rutViShopee(vn("2026-11-02", "14:00:00"), -tr(5), sau, "rut-m1");
    await prisma.expense.create({
      data: { date: vn("2026-11-01", "12:00:00"), categoryId: "ads", adsSource: "TIKTOK_ADS", amount: 750_000, description: "TikTok Ads 01/11", source: "ADS_API", createdAt: sau },
    });
    expect(await docTroiQuyTruocM(MOC_M)).toMatchObject({ troi: 0, soDongVeMuon: 0 });
  });

  it("chi ads tự động ngày < M về sau bật ⇒ trôi ÂM đúng số, nguồn Sổ chi phí", async () => {
    const sau = await batVaLaySauLucBat();
    await prisma.expense.create({
      data: { date: vn("2026-10-31", "12:00:00"), categoryId: "ads", adsSource: "TIKTOK_ADS", amount: 750_000, description: "TikTok Ads 31/10", source: "ADS_API", createdAt: sau },
    });
    const troi = await docTroiQuyTruocM(MOC_M);
    expect(troi).toMatchObject({ troi: -750_000, quyHienTai: tr(150) - 750_000, soDongVeMuon: 1 });
    expect(troi?.dongNoiBat[0]).toMatchObject({ nhanNguon: "Sổ chi phí", ngayNhan: "31/10/2026", tacDong: -750_000 });
  });

  it("dòng có sẵn trước bật đổi trạng thái sau bật (lệnh TikTok chuyển PAID) ⇒ có số trôi, KHÔNG liệt kê dòng nào", async () => {
    await prisma.tiktokPayment.create({
      data: {
        paymentId: "pay-1",
        shopId: "100975192",
        status: "PROCESSING",
        paidTime: vn("2026-10-28", "10:00:00"),
        settlementValue: tr(6),
        amountValue: tr(6),
        syncedAt: vn("2026-10-28", "10:05:00"),
      },
    });
    await batVaLaySauLucBat();
    await prisma.tiktokPayment.update({ where: { paymentId: "pay-1" }, data: { status: "PAID" } });
    expect(await docTroiQuyTruocM(MOC_M)).toMatchObject({ troi: tr(6), soDongVeMuon: 0, dongNoiBat: [] });
  });

  it("nhiều dòng về muộn ⇒ tổng đúng, nêu dòng tác động lớn nhất trước (trị tuyệt đối)", async () => {
    const sau = await batVaLaySauLucBat();
    await rutViShopee(vn("2026-10-20"), -tr(1), sau, "a");
    await rutViShopee(vn("2026-10-21"), -tr(4), sau, "b");
    // Ngày M: không thuộc quỹ cuối M − 1 ⇒ không vào số trôi lẫn danh sách.
    await rutViShopee(vn("2026-11-01", "08:00:00"), -tr(9), sau, "m");
    await prisma.expense.create({
      data: { date: vn("2026-10-22"), categoryId: "ads", adsSource: "META", amount: tr(2), description: "Meta 22/10", source: "ADS_API", createdAt: sau },
    });
    const troi = await docTroiQuyTruocM(MOC_M);
    expect(troi).toMatchObject({ troi: tr(3), soDongVeMuon: 3, tacDongVeMuon: tr(3) });
    expect(troi?.dongNoiBat.map((d) => d.tacDong)).toEqual([tr(4), -tr(2), tr(1)]);
  });

  it("kết quả bật bản cũ thiếu vân tay quỹ ⇒ null (ẩn khối), không vỡ", async () => {
    await batVaLaySauLucBat();
    const yc = await prisma.yeuCauGhi.findFirstOrThrow({ where: { loai: "XAC_NHAN_BAT" } });
    const ketQua = yc.ketQua as { ok: true; data: Record<string, unknown> };
    const { vanTayQuy: _bo, ...dataCu } = ketQua.data;
    await prisma.yeuCauGhi.update({ where: { id: yc.id }, data: { ketQua: { ok: true, data: dataCu } as object } });
    expect(await docTroiQuyTruocM(MOC_M)).toBeNull();
  });
});
