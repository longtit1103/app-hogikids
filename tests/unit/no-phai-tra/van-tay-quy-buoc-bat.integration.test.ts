import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Vân tay số liệu trước ngày bật trên DB thật: màn hình tính chênh lệch ở bước 2 (đọc {quỹ app, dư nợ thấu chi,
 * Σ phiếu Y} cuối M − 1), rồi một lượt ghi trước M commit TRƯỚC khi chủ shop bấm bật (ghi tay, hay nguồn máy không
 * lấy khoá bật như chi ads cửa máy) ⇒ điều chỉnh màn hình gửi đã cũ ⇒ bước bật tính lại trong transaction và từ
 * chối `QUY_DA_DOI`, không ghi gì. M = 01/11/2026, hôm nay ghim 03/11/2026 10:00 VN; mở sổ 10/10 = 150tr.
 */
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => ({
  ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
  docNguoiDungPhien: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { docChenhLechTaiM, xacNhanBatNoPhaiTra } from "@/lib/actions/bat-no-phai-tra";
import { KEY_NO_PHAI_TRA_TU_NGAY } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import type { VanTayQuyTruocM } from "@/lib/no-phai-tra/doc-chenh-lech-tai-m";
import { prisma } from "@/lib/prisma";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";

import { nguoiDungGia } from "../../helpers/nguoi-dung-gia";
import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

const vn = (ngay: string, gio = "00:00:00") => new Date(`${ngay}T${gio}+07:00`);
const tr = (n: number) => Math.round(n * 1_000_000);

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

/** Bước 2 của màn hình: ngân hàng 150tr, không thẻ/ví ⇒ trả vân tay màn hình đang hiện. */
async function tinhBuoc2(): Promise<VanTayQuyTruocM> {
  const r = await docChenhLechTaiM({ mocM: "2026-11-01", soDuBank: tr(150), tienMat: 0, the: [], viAds: [] });
  if (!r.ok) throw new Error(r.error);
  return r.data.vanTay;
}

const bat = (vanTayQuy: VanTayQuyTruocM, yeuCauId: string = randomUUID()) =>
  xacNhanBatNoPhaiTra({ yeuCauId, mocM: "2026-11-01", the: [], viAds: [], dieuChinh: [], vanTayQuy });

async function khongGhiGi(): Promise<void> {
  expect(await prisma.setting.findUnique({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } })).toBeNull();
  expect(await prisma.yeuCauGhi.count()).toBe(0);
  expect(await prisma.cashMovement.count({ where: { kind: { in: ["CUTOVER_ADJ_IN", "CUTOVER_ADJ_OUT"] } } })).toBe(0);
}

describe("vân tay số liệu trước ngày bật", () => {
  it("không ai ghi chen ⇒ bật được, vân tay lúc bật lưu trong kết quả yêu cầu bật", async () => {
    const thay = await tinhBuoc2();
    expect(thay).toEqual({ quyApp: tr(150), duNoThauChi: 0, tongPhieuY: 0 });
    const yeuCauId = randomUUID();
    expect(await bat(thay, yeuCauId)).toMatchObject({ ok: true, data: { vanTayQuy: thay } });
    const yc = await prisma.yeuCauGhi.findUniqueOrThrow({ where: { id: yeuCauId } });
    expect(yc.ketQua).toMatchObject({ ok: true, data: { vanTayQuy: { quyApp: tr(150), duNoThauChi: 0, tongPhieuY: 0 } } });
  });

  it("ghi tay một khoản thu trước M sau khi tính ⇒ QUY_DA_DOI (câu nêu số cũ → mới), không ghi gì; tính lại ⇒ bật được", async () => {
    const thay = await tinhBuoc2();
    await prisma.cashMovement.create({
      data: { date: vn("2026-10-20"), kind: "OTHER_IN", amount: tr(1), description: "thu khác ghi muộn" },
    });
    const r = await bat(thay);
    expect(r).toMatchObject({ ok: false, code: "QUY_DA_DOI" });
    expect(r.ok === false && r.error).toMatch(/quỹ của app cuối 31\/10\/2026: 150\.000\.000.*→ 151\.000\.000/);
    await khongGhiGi();

    expect(await bat(await tinhBuoc2())).toMatchObject({ ok: true, data: { vanTayQuy: { quyApp: tr(151) } } });
  });

  it("chi ads cửa máy (không lấy khoá bật) ghi vào trước M sau khi tính ⇒ QUY_DA_DOI", async () => {
    const thay = await tinhBuoc2();
    await prisma.expense.create({
      data: {
        date: vn("2026-10-31", "12:00:00"),
        categoryId: "ads",
        adsSource: "TIKTOK_ADS",
        amount: 750_000,
        description: "TikTok Ads 31/10",
        source: "ADS_API",
      },
    });
    expect(await bat(thay)).toMatchObject({ ok: false, code: "QUY_DA_DOI" });
    await khongGhiGi();
  });

  it("dòng ghi ĐÚNG ngày bật (không thuộc quỹ cuối M − 1) ⇒ vân tay không đổi, bật được", async () => {
    const thay = await tinhBuoc2();
    await prisma.cashMovement.create({
      data: { date: vn("2026-11-01", "08:00:00"), kind: "OTHER_IN", amount: tr(1), description: "thu ngày bật" },
    });
    expect(await bat(thay)).toMatchObject({ ok: true });
  });

  it("phiếu Y vừa đánh dấu 'đã giải thích' (quỹ KHÔNG đổi) ⇒ vẫn QUY_DA_DOI — vân tay so cả phiếu Y", async () => {
    await prisma.expense.create({
      data: { date: vn("2026-10-17"), categoryId: "purchase", amount: tr(53.6), description: "phiếu #8", source: "MANUAL", refId: "PNK:#8" },
    });
    await prisma.phieuNhapNo.create({
      data: {
        refId: "PNK:#8",
        shopId: "kho",
        maPhieu: "#8",
        ngayPhieu: vn("2026-10-17"),
        tongTien: tr(100),
        daTraTruoc: tr(33.6),
        lechDaGiaiThich: false,
      },
    });
    const thay = await tinhBuoc2();
    expect(thay.tongPhieuY).toBe(0);
    await prisma.phieuNhapNo.update({
      where: { refId: "PNK:#8" },
      data: { lechDaGiaiThich: true, lechDaGiaiThichSo: tr(53.6) },
    });
    const r = await bat(thay);
    expect(r).toMatchObject({ ok: false, code: "QUY_DA_DOI" });
    expect(r.ok === false && r.error).toContain("phiếu nhập duyệt khác số đã trả");
    expect(r.ok === false && r.error).not.toContain("quỹ của app");
    await khongGhiGi();
  });

  it("rút thấu chi trước M sau khi tính ⇒ QUY_DA_DOI (quỹ và dư nợ thấu chi cùng đổi)", async () => {
    const od = await prisma.loan.create({ data: { name: "Thấu chi", kind: "OVERDRAFT", startDate: vn("2026-10-01") } });
    const thay = await tinhBuoc2();
    await prisma.cashMovement.create({
      data: { date: vn("2026-10-25"), kind: "LOAN_IN", amount: tr(10), loanId: od.id, description: "rút thấu chi" },
    });
    const r = await bat(thay);
    expect(r).toMatchObject({ ok: false, code: "QUY_DA_DOI" });
    expect(r.ok === false && r.error).toContain("dư nợ thấu chi cuối 31/10/2026");
    await khongGhiGi();
  });

  it("thiếu vân tay ⇒ zod từ chối, không ghi gì", async () => {
    const r = await xacNhanBatNoPhaiTra({ yeuCauId: randomUUID(), mocM: "2026-11-01", the: [], viAds: [], dieuChinh: [] });
    expect(r).toMatchObject({ ok: false });
    await khongGhiGi();
  });
});
