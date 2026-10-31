import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Nhập sao kê thẻ từ file PDF (`xemTruocSaoKeThe` → `chotSaoKeTuPdf`) trên DB thật, với sao kê Techcombank 20/10
 * (đã gột) + 480 hoá đơn TikTok phía app (10/09 → 25/10). Lớp đọc PDF được thay bằng text đã trích sẵn
 * (`docTextPdf` giả) — parser + lõi đối chiếu chạy THẬT.
 *
 * Bối cảnh như prod: bật theo dõi nợ M = 15/10, neo mở sổ 14/10 = 33.650.000, TikTok Ads gắn thẻ từ 15/10. Hôm nay ghim
 * 26/10 10:00 VN. Số kỳ vọng: đề xuất = 32.475.000 (dư nợ sao kê) + 15 bill ngày 17–20/10 ghi sổ sau ngày sao kê
 * (2.364.000) = 34.839.000; chốt rồi trả thẻ 32.475.000 ⇒ dư nợ 25/10 = 34.839.000 + bill 21–25/10 (10.727.000) −
 * 32.475.000 = 13.091.000.
 */
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => ({
  ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
  docNguoiDungPhien: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/sao-ke-the/doc-text-pdf", () => ({ docTextPdf: vi.fn() }));

import { Prisma } from "@/generated/prisma/client";
import { chotSaoKeTuPdf, xemTruocSaoKeThe, type XemTruocSaoKe } from "@/lib/actions/sao-ke-the";
import { clearBronzeBacklog, markBronzeBacklog } from "@/lib/bronze/bronze-only";
import { KEY_NO_PHAI_TRA_TU_NGAY } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { docDuNoCacThe } from "@/lib/no-phai-tra/du-no-the";
import { docPhaiTraCacThe } from "@/lib/no-phai-tra/phai-tra-the-queries";
import { uocTinhDuNoTai } from "@/lib/no-phai-tra/uoc-tinh-du-no-tai";
import { prisma } from "@/lib/prisma";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";
import { docTextPdf } from "@/lib/sao-ke-the/doc-text-pdf";
import { ghiTraChuaLenChoCacKy, lietKeKyCanTinhLai } from "@/lib/sao-ke-the/tinh-lai-tra-chua-len-sao-ke";
import { khoanTraThe } from "@/lib/so-quy/du-bao-quy";

import { nguoiDungGia } from "../../helpers/nguoi-dung-gia";
import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

const FIXTURE = path.resolve(__dirname, "../../fixtures/sao-ke-the");
const TEXT_SAO_KE_2010 = readFileSync(path.join(FIXTURE, "techcombank-2026-10-20.txt"), "utf8");
const BILLS_APP = JSON.parse(readFileSync(path.join(FIXTURE, "app-bills-2026-09-10-den-10-25.json"), "utf8")) as {
  id: string;
  thoiGianVn: string;
  soTien: number;
}[];

const vn = (ngay: string, gio = "00:00:00") => new Date(`${ngay}T${gio}+07:00`);

const SO_DE_XUAT = 34_839_000;

beforeAll(async () => {
  await seedReference();
}, 60_000);

/** BC gánh TikTok Ads của thẻ trong các test (bc_id = `shopId` của trang ingest hoá đơn). */
const BC = "7129545797879726081";
const BC_HAI = "7200000000000000002";

/**
 * `truncateBusinessTables` không xoá `SyncLog` / kho thô hoá đơn / bảng bền trạng thái BC / cờ backlog — dọn để cổng độ
 * tươi hoá đơn không dính test trước.
 */
async function donLuotKeoTiktok(): Promise<void> {
  await prisma.tiktokBcHoaDon.deleteMany();
  await prisma.syncLog.deleteMany({ where: { kind: "TIKTOK_ADS" } });
  await prisma.rawTiktokBusinessInvoice.deleteMany();
  await clearBronzeBacklog();
}

/** BC `bcId` đã land hoá đơn vào kho thô lúc `fetchedAt` — cổng xét mọi BC land trong 30 ngày trước ngày sao kê. */
async function bcDaLandHoaDon(bcId: string, fetchedAt: Date): Promise<void> {
  await prisma.rawTiktokBusinessInvoice.create({
    data: {
      shopId: bcId,
      externalId: `tx-${bcId}-${fetchedAt.getTime()}`,
      payloadHash: `h-${bcId}-${fetchedAt.getTime()}`,
      payload: { transaction_id: `tx-${bcId}` },
      fetchedAt,
    },
  });
}

/** Một trang ingest hoá đơn TikTok (`/api/ingest/raw`) đã xong — đúng hình `stats` route ghi. */
async function luotKeoHoaDon(
  startedAt: Date,
  o: { status?: "OK" | "ERROR"; stream?: string; mode?: string; landed?: number; bcId?: string; luotId?: string } = {}
): Promise<void> {
  await prisma.syncLog.create({
    data: {
      kind: "TIKTOK_ADS",
      status: o.status ?? "OK",
      startedAt,
      finishedAt: startedAt,
      stats: {
        stream: o.stream ?? "tiktokbusiness/invoice",
        shopId: o.bcId ?? BC,
        landed: o.landed ?? 0,
        mode: o.mode ?? "land+transform",
        ...(o.luotId !== undefined ? { luotId: o.luotId } : {}),
        warnings: [],
      },
    },
  });
}

beforeEach(async () => {
  await truncateBusinessTables();
  await donLuotKeoTiktok();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
  vi.mocked(docNguoiDungPhien).mockResolvedValue(nguoiDungGia());
  // `clearMocks: false` toàn cục ⇒ tự xoá lịch sử gọi, kẻo phép "không gọi đọc PDF" dính lượt của test trước.
  vi.mocked(docTextPdf).mockReset().mockResolvedValue(TEXT_SAO_KE_2010);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(vn("2026-10-26", "10:00:00"));
});

afterEach(async () => {
  vi.useRealTimers();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
  await donLuotKeoTiktok();
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

/**
 * Thẻ Techcombank đuôi 9999 như prod: M 15/10, neo 14/10, TikTok Ads gắn từ 15/10, 480 hoá đơn TikTok, lần trả
 * thẻ 6.850.000 ngày 17/10 (có trên sao kê, sau neo ⇒ app phải có `CARD_PAY`), và lượt kéo hoá đơn đêm 25/10 OK.
 */
async function seedThe(): Promise<string> {
  await prisma.setting.create({ data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: "2026-10-15" } });
  const id = (await prisma.theTinDung.create({ data: { ten: "Techcombank 9999", ngayChotSaoKe: 20, ngayHanTra: 5 } })).id;
  await prisma.ganNenTangThe.create({ data: { cardId: id, nenTang: "TIKTOK_ADS", tuNgay: vn("2026-10-15") } });
  await prisma.kySaoKeThe.create({ data: { cardId: id, ngayChot: vn("2026-10-14"), soDu: 33_650_000, laNeoMoSo: true } });
  await prisma.tiktokAdsHoaDon.createMany({
    data: BILLS_APP.map((b) => ({
      transactionId: b.id,
      bcId: "bc",
      advertiserId: "adv",
      createTime: new Date(`${b.thoiGianVn.replace(" ", "T")}+07:00`),
      amount: b.soTien,
      transactionType: "BILL_PAYMENT",
      billingType: "CASH",
      amountType: "POSITIVE",
    })),
  });
  await prisma.cashMovement.create({
    data: { date: vn("2026-10-17", "09:00:00"), kind: "CARD_PAY", amount: 6_850_000, cardId: id, description: "Trả thẻ" },
  });
  await bcDaLandHoaDon(BC, vn("2026-10-19", "01:15:00"));
  await luotKeoHoaDon(vn("2026-10-25", "01:15:00"));
  return id;
}

const filePdf = (noiDung = "%PDF-1.7 sao ke 20/10") => new File([noiDung], "sao-ke.pdf", { type: "application/pdf" });

function formXem(cardId: string, file: File = filePdf()): FormData {
  const fd = new FormData();
  fd.set("cardId", cardId);
  fd.set("file", file);
  return fd;
}

function formChot(cardId: string, x: XemTruocSaoKe, ghiDe: Record<string, string> = {}, file: File = filePdf()): FormData {
  const fd = new FormData();
  const truong: Record<string, string> = {
    cardId,
    yeuCauId: randomUUID(),
    hash: x.hash,
    soDu: String(x.ketQua.soDeXuat),
    soDeXuat: String(x.ketQua.soDeXuat),
    hanTra: x.saoKe.hanTra,
    note: "",
    ...ghiDe,
  };
  for (const [k, v] of Object.entries(truong)) fd.set(k, v);
  fd.set("file", file);
  return fd;
}

async function xem(cardId: string, file?: File): Promise<XemTruocSaoKe> {
  const r = await xemTruocSaoKeThe(formXem(cardId, file));
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

describe("xemTruocSaoKeThe", () => {
  it("sao kê 20/10 ⇒ đề xuất 34.839.000 = 32.475.000 + 15 bill ghi sổ trễ 2.364.000; neo trước 14/10; chốt được", async () => {
    const A = await seedThe();
    const x = await xem(A);
    expect(x.saoKe).toMatchObject({ ngaySaoKe: "2026-10-20", duNoCuoiKy: 32_475_000, hanTra: "2026-11-05", soCuoiThe: "9999", soDong: 357 });
    expect(x.saoKe).not.toHaveProperty("dong");
    expect(x.ngayChotTruoc).toBe("2026-10-14");
    expect(x.ketQua.billGhiSoTre).toHaveLength(15);
    expect(x.ketQua.tongBillGhiSoTre).toBe(2_364_000);
    expect(x.ketQua.soDeXuat).toBe(SO_DE_XUAT);
    expect(x.ketQua.soKhop).toBe(348);
    expect(x.ketQua).not.toHaveProperty("khop");
    expect(x.ketQua.saoKeKhongCoTrongApp).toHaveLength(0);
    expect(x.ketQua.dongKhac.ghiNo.map((d) => d.ghiNo).sort()).toEqual([978_000, 14_000].sort());
    expect(x.ketQua.dongKhac.ghiCo.map((d) => d.ghiCo)).toEqual([821_000]);
    expect(x.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(x.lyDoKhongChot).toBeNull();
    // Tên thẻ có 9999 ⇒ không cảnh báo sai thẻ; thanh toán trước neo không bị nhắc ghi.
    expect(x.canhBao.join(" ")).not.toContain("kiểm đúng thẻ");
    expect(x.thanhToanChuaGhi).toEqual([]);
    // App: neo 33.650.000 + bill 15–20/10 (8.860.000) − trả 6.850.000 = 35.660.000 — chênh đề xuất đúng phần hoàn phí.
    expect(x.uocTinhApp).toBe(35_660_000);
    // Xem trước KHÔNG ghi.
    expect(await prisma.kySaoKeThe.count({ where: { laNeoMoSo: false } })).toBe(0);
  });

  it("hoá đơn ví TikTok Shop trả (không lên sao kê) ⇒ bỏ khỏi bill ghi sổ trễ, số đề xuất không đổi, có cảnh báo", async () => {
    const A = await seedThe();
    await prisma.tiktokAdsHoaDon.create({
      data: {
        transactionId: "vi-tra-2010",
        bcId: "bc",
        createTime: vn("2026-10-20", "23:00:00"),
        amount: 99_000,
        transactionType: "BILL_PAYMENT",
        billingType: "CASH",
        amountType: "POSITIVE",
      },
    });
    await prisma.tiktokAdsSettlement.create({
      data: { transactionId: "vi-2010", shopId: "s", orderCreateTime: vn("2026-10-20", "23:01:00"), settlementAmount: -99_000 },
    });
    const x = await xem(A);
    expect(x.ketQua.soDeXuat).toBe(SO_DE_XUAT);
    expect(x.canhBao.join(" ")).toContain("Đã bỏ 1 hoá đơn TikTok ví TikTok Shop trả");
  });

  it("lần trả thẻ trên sao kê sau neo mà app chưa ghi ⇒ nhắc ghi 'Trả thẻ' (không chặn)", async () => {
    const A = await seedThe();
    await prisma.cashMovement.deleteMany({ where: { cardId: A, kind: "CARD_PAY" } });
    const x = await xem(A);
    expect(x.thanhToanChuaGhi.map((d) => [d.ngayGiaoDich, d.ghiCo])).toEqual([["2026-10-17", 6_850_000]]);
    expect(x.canhBao.join(" ")).toContain("ngày 17/10 chưa ghi trong app");
    expect(x.lyDoKhongChot).toBeNull();
  });

  it("tên thẻ không có 4 số cuối ⇒ chỉ CẢNH BÁO, vẫn chốt được", async () => {
    const A = await seedThe();
    await prisma.theTinDung.update({ where: { id: A }, data: { ten: "Visa" } });
    const x = await xem(A);
    expect(x.canhBao.join(" ")).toContain("đuôi 9999");
    expect(x.lyDoKhongChot).toBeNull();
  });

  it("ngày sao kê trước M ⇒ chỉ xem (lý do)", async () => {
    const A = await seedThe();
    await prisma.setting.update({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY }, data: { value: "2026-10-21" } });
    expect((await xem(A)).lyDoKhongChot).toContain("trước ngày bật theo dõi nợ");
  });

  it("file không phải PDF / quá 3 MB / thiếu file ⇒ từ chối trước khi đọc", async () => {
    const A = await seedThe();
    expect(await xemTruocSaoKeThe(formXem(A, new File(["PK\u0003\u0004"], "a.pdf", { type: "application/pdf" })))).toMatchObject({
      ok: false,
      error: "File không phải PDF",
    });
    const to = new File([new Uint8Array(3 * 1024 * 1024 + 1)], "a.pdf", { type: "application/pdf" });
    expect(await xemTruocSaoKeThe(formXem(A, to))).toMatchObject({ ok: false, error: "File quá lớn (tối đa 3 MB)" });
    const fd = new FormData();
    fd.set("cardId", A);
    expect(await xemTruocSaoKeThe(fd)).toMatchObject({ ok: false, error: "Chưa chọn file sao kê" });
    expect(docTextPdf).not.toHaveBeenCalled();
  });

  it("đọc PDF lỗi (scan) / text không phải sao kê ⇒ câu lỗi tiếng Việt, không ném", async () => {
    const A = await seedThe();
    vi.mocked(docTextPdf).mockRejectedValueOnce(new Error("PDF không có lớp chữ (ảnh scan)"));
    expect(await xemTruocSaoKeThe(formXem(A))).toMatchObject({ ok: false, error: expect.stringContaining("ảnh scan") });
    vi.mocked(docTextPdf).mockResolvedValueOnce("Hoá đơn tiền điện tháng 10");
    expect(await xemTruocSaoKeThe(formXem(A))).toMatchObject({ ok: false, error: expect.stringContaining("Không tách được sao kê") });
  });

  it("nhân sự (kể cả có quyền Sổ quỹ) ⇒ KHONG_CO_QUYEN", async () => {
    const A = await seedThe();
    vi.mocked(docNguoiDungPhien).mockResolvedValue(
      nguoiDungGia({ id: "nv", role: "STAFF", quyen: new Set(["tai-chinh-so-quy:sua"]) })
    );
    expect(await xemTruocSaoKeThe(formXem(A))).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
  });
});

describe("xemTruocSaoKeThe — giao dịch thẻ khác, độ tươi hoá đơn, đúng thẻ, neo trước", () => {
  it("như prod: CARD_PAY 19/10 6.850.000 + 23/10 32.475.000 ⇒ lần trả 17/10 trên sao kê ghép 19/10, đề xuất 34.839.000; chốt ⇒ 25/10 = 13.091.000", async () => {
    const A = await seedThe();
    await prisma.cashMovement.deleteMany({ where: { cardId: A, kind: "CARD_PAY" } });
    await prisma.cashMovement.createMany({
      data: [
        { date: vn("2026-10-19", "09:00:00"), kind: "CARD_PAY", amount: 6_850_000, cardId: A, description: "Trả thẻ" },
        { date: vn("2026-10-23", "09:00:00"), kind: "CARD_PAY", amount: 32_475_000, cardId: A, description: "Trả thẻ" },
      ],
    });
    const x = await xem(A);
    expect(x.ketQua.soDeXuat).toBe(SO_DE_XUAT);
    expect(x.ketQua.traChuaLenSaoKe).toEqual([]);
    expect(x.ketQua.traSaiNgay).toEqual([]);
    expect(x.thanhToanChuaGhi).toEqual([]);
    expect(x.lyDoKhongChot).toBeNull();
    expect((await chotSaoKeTuPdf(formChot(A, x))).ok).toBe(true);
    // Neo 34.839.000 + bill 21–25/10 10.727.000 − trả 23/10 32.475.000 (trả 19/10 ≤ ngày chốt đã nằm trong neo).
    expect(await uocTinhDuNoTai(A, "2026-10-25")).toBe(13_091_000);
  });

  it("trả thẻ ngày sao kê mà ngân hàng ghi sổ sau ⇒ TRỪ khỏi đề xuất; chốt ⇒ dư nợ không còn tính lần trả đó", async () => {
    const A = await seedThe();
    await prisma.cashMovement.create({
      data: { date: vn("2026-10-20", "16:00:00"), kind: "CARD_PAY", amount: 3_000_000, cardId: A, description: "Trả thẻ" },
    });
    const x = await xem(A);
    expect(x.ketQua.traChuaLenSaoKe.map((g) => [g.ngay, g.soTien])).toEqual([["2026-10-20", 3_000_000]]);
    expect(x.ketQua.soDeXuat).toBe(SO_DE_XUAT - 3_000_000);
    expect(x.ketQua.giaiThich[0]).toContain("− 1 lần trả thẻ ngày 20/10 chưa lên sao kê 3.000.000 ₫");
    expect((await chotSaoKeTuPdf(formChot(A, x))).ok).toBe(true);
    expect(await uocTinhDuNoTai(A, "2026-10-25")).toBe(SO_DE_XUAT - 3_000_000 + 10_727_000);
  });

  it("chi ghi tay 'trừ vào thẻ' ngày 19/10 chưa lên sao kê ⇒ CỘNG vào đề xuất", async () => {
    const A = await seedThe();
    await prisma.expense.create({
      data: { date: vn("2026-10-19"), categoryId: "other", amount: 250_000, description: "Mua đồ", cardId: A },
    });
    const x = await xem(A);
    expect(x.ketQua.chiTayChuaLenSaoKe.map((g) => [g.ngay, g.soTien, g.loai])).toEqual([["2026-10-19", 250_000, "CHI_TAY"]]);
    expect(x.ketQua.soDeXuat).toBe(SO_DE_XUAT + 250_000);
  });

  it("hôm nay < ngày sao kê + 2 ⇒ CHẶN (xem trước + chốt), nói ngày nhập lại", async () => {
    const A = await seedThe();
    vi.setSystemTime(vn("2026-10-21", "10:00:00"));
    const x = await xem(A);
    expect(x.lyDoKhongChot).toBe("Hoá đơn TikTok tối ngày chốt về app sau 2 đêm; nhập lại từ 22/10");
    expect(await chotSaoKeTuPdf(formChot(A, x))).toMatchObject({ ok: false, code: "HOA_DON_CHUA_VE" });
    expect(await prisma.kySaoKeThe.count({ where: { laNeoMoSo: false } })).toBe(0);
  });

  it("chưa có lượt kéo hoá đơn từ ngày sao kê + 2 ⇒ CHẶN dù hôm nay đủ muộn", async () => {
    const A = await seedThe();
    await donLuotKeoTiktok();
    await bcDaLandHoaDon(BC, vn("2026-10-19", "01:15:00"));
    await luotKeoHoaDon(vn("2026-10-21", "01:15:00"));
    const x = await xem(A);
    expect(x.lyDoKhongChot).toContain(`Chưa có lượt kéo hoá đơn TikTok sau ngày chốt BC ${BC} (lượt mới nhất ngày 21/10)`);
    expect(await chotSaoKeTuPdf(formChot(A, x))).toMatchObject({ ok: false, code: "HOA_DON_CHUA_VE" });
  });

  it("ngừng ads sau ngày chốt: hoá đơn mới nhất về 21/10, lượt kéo đêm 22/10 POST lại hoá đơn cũ (landed 0) ⇒ mốc tiến, chốt được", async () => {
    const A = await seedThe();
    await donLuotKeoTiktok();
    await bcDaLandHoaDon(BC, vn("2026-10-19", "01:15:00"));
    // Không có hoá đơn mới nào sau 21/10 — mốc cũ `max(syncedAt)` đứng yên ở đây và chặn chốt mãi.
    await prisma.tiktokAdsHoaDon.updateMany({ data: { syncedAt: vn("2026-10-21", "01:15:00") } });
    await luotKeoHoaDon(vn("2026-10-21", "01:15:00"), { landed: 3 });
    await luotKeoHoaDon(vn("2026-10-22", "01:15:00"), { landed: 0 });
    const x = await xem(A);
    expect(x.lyDoKhongChot).toBeNull();
    expect((await chotSaoKeTuPdf(formChot(A, x))).ok).toBe(true);
  });

  it("lượt kéo sau ngày chốt mà HỎNG / chỉ land Bronze / là stream khác ⇒ không tính, vẫn chặn", async () => {
    const A = await seedThe();
    await donLuotKeoTiktok();
    await bcDaLandHoaDon(BC, vn("2026-10-19", "01:15:00"));
    await luotKeoHoaDon(vn("2026-10-21", "01:15:00"));
    await luotKeoHoaDon(vn("2026-10-23", "01:15:00"), { status: "ERROR" });
    // Lượt riêng (đêm sau) chỉ land Bronze: lượt mới nhất không lỗi nhưng chưa dựng Silver ⇒ không phải lượt sạch.
    await luotKeoHoaDon(vn("2026-10-24", "01:10:00"), { mode: "bronze-only" });
    await luotKeoHoaDon(vn("2026-10-24", "01:15:00"), { stream: "tiktokbusiness/report" });
    await luotKeoHoaDon(vn("2026-10-24", "01:20:00"), { stream: "tiktokbusiness/cost" });
    const x = await xem(A);
    expect(x.lyDoKhongChot).toContain("lượt mới nhất ngày 21/10");
    expect(await chotSaoKeTuPdf(formChot(A, x))).toMatchObject({ ok: false, code: "HOA_DON_CHUA_VE" });
  });

  it("2 BC đã land hoá đơn trong 30 ngày: BC này kéo OK 25/10, BC kia không có lượt nào từ 22/10 (mất quyền finance) ⇒ CHẶN", async () => {
    const A = await seedThe();
    await bcDaLandHoaDon(BC_HAI, vn("2026-10-10", "01:15:00"));
    await luotKeoHoaDon(vn("2026-10-20", "01:15:00"), { bcId: BC_HAI });
    const x = await xem(A);
    expect(x.lyDoKhongChot).toBe(
      `Chưa có lượt kéo hoá đơn TikTok sau ngày chốt BC ${BC_HAI} (lượt mới nhất ngày 20/10) — đợi lượt kéo đêm từ 22/10 rồi nhập lại`,
    );
    expect(await chotSaoKeTuPdf(formChot(A, x))).toMatchObject({ ok: false, code: "HOA_DON_CHUA_VE" });

    // BC kia kéo OK từ 22/10 ⇒ mở.
    await luotKeoHoaDon(vn("2026-10-24", "01:15:00"), { bcId: BC_HAI });
    expect((await xem(A)).lyDoKhongChot).toBeNull();
  });

  it("cùng đêm: một trang OK rồi một trang LỖI của cùng BC ⇒ CHẶN (hoá đơn có thể thiếu)", async () => {
    const A = await seedThe();
    await luotKeoHoaDon(vn("2026-10-25", "01:16:00"), { status: "ERROR" });
    const x = await xem(A);
    expect(x.lyDoKhongChot).toContain(`mới nhất có trang LỖI (BC ${BC})`);
    expect(await chotSaoKeTuPdf(formChot(A, x))).toMatchObject({ ok: false, code: "HOA_DON_CHUA_VE" });

    // Lượt kéo lại thành công SAU trang lỗi ⇒ mở.
    await luotKeoHoaDon(vn("2026-10-25", "09:00:00"));
    expect((await xem(A)).lyDoKhongChot).toBeNull();
  });

  it("cùng lượt: trang LỖI rồi trang OK SAU nó (cách 3') ⇒ vẫn CHẶN — trang lỗi chưa được kéo lại; lượt sau sạch ⇒ mở", async () => {
    const A = await seedThe();
    await luotKeoHoaDon(vn("2026-10-25", "01:16:00"), { status: "ERROR" });
    await luotKeoHoaDon(vn("2026-10-25", "01:19:00"));
    const x = await xem(A);
    expect(x.lyDoKhongChot).toContain(`mới nhất có trang LỖI (BC ${BC})`);
    expect(await chotSaoKeTuPdf(formChot(A, x))).toMatchObject({ ok: false, code: "HOA_DON_CHUA_VE" });

    // Lượt kéo lại cách xa (lượt mới) chạy hết không lỗi ⇒ mở.
    await luotKeoHoaDon(vn("2026-10-25", "09:00:00"));
    expect((await xem(A)).lyDoKhongChot).toBeNull();
  });

  it("hai trang OK cách 20' cùng một lượt ⇒ lượt sạch, chốt được", async () => {
    const A = await seedThe();
    await luotKeoHoaDon(vn("2026-10-25", "01:35:00"));
    expect((await xem(A)).lyDoKhongChot).toBeNull();
  });

  it("lượt hôm trước có trang LỖI, lượt hôm sau sạch ⇒ chốt được", async () => {
    const A = await seedThe();
    await luotKeoHoaDon(vn("2026-10-24", "01:15:00"));
    await luotKeoHoaDon(vn("2026-10-24", "01:17:00"), { status: "ERROR" });
    expect((await xem(A)).lyDoKhongChot).toBeNull(); // lượt 25/10 01:15 (seedThe) sạch, là lượt mới nhất
  });

  it("trang mang luotId khác nhau dù cách 5' ⇒ hai lượt: lượt sau sạch ⇒ mở; lượt sau có LỖI ⇒ chặn", async () => {
    const A = await seedThe();
    await donLuotKeoTiktok();
    await bcDaLandHoaDon(BC, vn("2026-10-19", "01:15:00"));
    // Gom theo khoảng cách thì hai trang này cùng lượt (cách 5') ⇒ chặn; theo luotId thì là hai lượt.
    await luotKeoHoaDon(vn("2026-10-25", "01:15:00"), { status: "ERROR", luotId: "exec-101" });
    await luotKeoHoaDon(vn("2026-10-25", "01:20:00"), { luotId: "exec-102" });
    expect((await xem(A)).lyDoKhongChot).toBeNull();

    await luotKeoHoaDon(vn("2026-10-25", "01:25:00"), { status: "ERROR", luotId: "exec-103" });
    expect((await xem(A)).lyDoKhongChot).toContain(`mới nhất có trang LỖI (BC ${BC})`);
  });

  it("CÙNG luotId: trang LỖI rồi trang OK cách 45' (quãng nghỉ dài) ⇒ vẫn một lượt có lỗi ⇒ CHẶN", async () => {
    const A = await seedThe();
    await donLuotKeoTiktok();
    await bcDaLandHoaDon(BC, vn("2026-10-19", "01:15:00"));
    // Gom theo khoảng cách thì trang 02:00 là lượt mới sạch ⇒ mở sai; theo luotId thì cùng lượt với trang lỗi.
    await luotKeoHoaDon(vn("2026-10-25", "01:15:00"), { status: "ERROR", luotId: "exec-201" });
    await luotKeoHoaDon(vn("2026-10-25", "02:00:00"), { luotId: "exec-201" });
    expect((await xem(A)).lyDoKhongChot).toContain(`mới nhất có trang LỖI (BC ${BC})`);
  });

  it("hai lượt chồng nhau xen kẽ trang ⇒ lượt mới nhất xét theo mốc bắt đầu: lượt bắt đầu sau sạch ⇒ mở", async () => {
    const A = await seedThe();
    await donLuotKeoTiktok();
    await bcDaLandHoaDon(BC, vn("2026-10-19", "01:15:00"));
    // Lượt 301 bắt đầu 01:15, lượt 302 (chạy tay) bắt đầu 01:16; trang LỖI của 301 rơi SAU trang đầu của 302.
    await luotKeoHoaDon(vn("2026-10-25", "01:15:00"), { luotId: "exec-301" });
    await luotKeoHoaDon(vn("2026-10-25", "01:16:00"), { luotId: "exec-302" });
    await luotKeoHoaDon(vn("2026-10-25", "01:17:00"), { status: "ERROR", luotId: "exec-301" });
    await luotKeoHoaDon(vn("2026-10-25", "01:18:00"), { luotId: "exec-302" });
    expect((await xem(A)).lyDoKhongChot).toBeNull();

    // Ngược lại: lượt bắt đầu SAU có trang lỗi ⇒ chặn dù lượt bắt đầu trước có trang OK muộn hơn.
    await donLuotKeoTiktok();
    await bcDaLandHoaDon(BC, vn("2026-10-19", "01:15:00"));
    await luotKeoHoaDon(vn("2026-10-25", "01:15:00"), { luotId: "exec-401" });
    await luotKeoHoaDon(vn("2026-10-25", "01:16:00"), { status: "ERROR", luotId: "exec-402" });
    await luotKeoHoaDon(vn("2026-10-25", "01:17:00"), { luotId: "exec-401" });
    expect((await xem(A)).lyDoKhongChot).toContain(`mới nhất có trang LỖI (BC ${BC})`);
  });

  it("kho thô còn backlog chưa dựng Silver ⇒ CHẶN dù lượt kéo OK", async () => {
    const A = await seedThe();
    await markBronzeBacklog();
    const x = await xem(A);
    expect(x.lyDoKhongChot).toContain("Kho thô còn dữ liệu chưa dựng sang bảng nghiệp vụ");
    expect(await chotSaoKeTuPdf(formChot(A, x))).toMatchObject({ ok: false, code: "HOA_DON_CHUA_VE" });
  });

  it("trả thẻ MƠ HỒ (sao kê trả 17/10, app có CARD_PAY 16/10 và 18/10 cùng tiền) ⇒ CHẶN, không đoán P", async () => {
    const A = await seedThe();
    await prisma.cashMovement.deleteMany({ where: { cardId: A, kind: "CARD_PAY" } });
    await prisma.cashMovement.createMany({
      data: [
        { date: vn("2026-10-16", "09:00:00"), kind: "CARD_PAY", amount: 6_850_000, cardId: A, description: "Trả thẻ" },
        { date: vn("2026-10-18", "09:00:00"), kind: "CARD_PAY", amount: 6_850_000, cardId: A, description: "Trả thẻ" },
      ],
    });
    const x = await xem(A);
    expect(x.lyDoKhongChot).toContain("Trả thẻ MƠ HỒ");
    expect(x.lyDoKhongChot).toContain("sao kê có 1 lần trả 6.850.000 ₫ ngày 17/10 ↔ app có 2 lần 6.850.000 ₫ ngày 16/10, 18/10");
    expect(x.ketQua.traChuaLenSaoKe).toEqual([]);
    expect(await chotSaoKeTuPdf(formChot(A, x))).toMatchObject({ ok: false, code: "TRA_THE_MO_HO" });
    expect(await prisma.kySaoKeThe.count({ where: { laNeoMoSo: false } })).toBe(0);
  });

  it("tên thẻ mang 4 số KHÁC số trên sao kê ⇒ CHẶN (xem trước + chốt)", async () => {
    const A = await seedThe();
    const x = await xem(A);
    await prisma.theTinDung.update({ where: { id: A }, data: { ten: "VPBank 1234" } });
    expect((await xem(A)).lyDoKhongChot).toContain("mang số 1234");
    expect(await chotSaoKeTuPdf(formChot(A, x))).toMatchObject({ ok: false, code: "SAI_THE" });
  });

  it("neo trước là kỳ gõ tay 18/10 (trong cửa sổ trễ) ⇒ bill 17/10 ghi sổ trễ vẫn cộng, đề xuất không đổi", async () => {
    const A = await seedThe();
    await prisma.kySaoKeThe.create({ data: { cardId: A, ngayChot: vn("2026-10-18"), soDu: 1, hanTra: vn("2026-11-05") } });
    const x = await xem(A);
    expect(x.ngayChotTruoc).toBe("2026-10-18");
    expect(x.ketQua.billGhiSoTre).toHaveLength(15);
    expect(x.ketQua.soDeXuat).toBe(SO_DE_XUAT);
  });

  it("neo trước là kỳ PDF 18/10 đã ghép một bill 17/10 ⇒ bill đó KHÔNG cộng lại lần hai", async () => {
    const A = await seedThe();
    const bill17 = await prisma.tiktokAdsHoaDon.findFirstOrThrow({
      where: { transactionId: "bill-0401", createTime: { gte: vn("2026-10-17"), lt: vn("2026-10-18") } },
    });
    const ky = await prisma.kySaoKeThe.create({
      data: {
        cardId: A,
        ngayChot: vn("2026-10-18"),
        soDu: 1,
        hanTra: vn("2026-11-05"),
        nguon: "SAO_KE_PDF",
        saoKeSoDu: 1,
        saoKeTongBillGhiSoTre: 0,
        saoKeHash: "b".repeat(64),
      },
    });
    await prisma.dongSaoKeThe.create({
      data: {
        kyId: ky.id,
        ngayGiaoDich: vn("2026-10-17"),
        ngayGhiSo: vn("2026-10-18"),
        ghiNo: 166_000,
        ghiCo: 0,
        dienGiai: "9PAY*TikTok Ads HA NOI VN",
        laTiktok: true,
        hoaDonId: bill17.id,
      },
    });
    const x = await xem(A);
    expect(x.ketQua.billGhiSoTre).toHaveLength(14);
    expect(x.ketQua.billGhiSoTre.some((b) => b.id === bill17.id)).toBe(false);
    expect(x.ketQua.soDeXuat).toBe(SO_DE_XUAT - 166_000);
  });
});

describe("chotSaoKeTuPdf", () => {
  it("chốt ⇒ kỳ SAO_KE_PDF 20/10 = 34.839.000 + 357 dòng sao kê (348 ghép hoá đơn); trả thẻ ⇒ dư nợ 25/10 = 13.091.000", async () => {
    const A = await seedThe();
    const x = await xem(A);
    const r = await chotSaoKeTuPdf(formChot(A, x));
    expect(r).toMatchObject({ ok: true, data: { cardId: A, ngayChot: "2026-10-20", soDu: SO_DE_XUAT, soDeXuat: SO_DE_XUAT } });
    expect(r).not.toHaveProperty("code");

    const ky = await prisma.kySaoKeThe.findFirstOrThrow({ where: { cardId: A, laNeoMoSo: false } });
    expect(ky).toMatchObject({
      nguon: "SAO_KE_PDF",
      soDu: SO_DE_XUAT,
      saoKeSoDu: 32_475_000,
      saoKeTongBillGhiSoTre: 2_364_000,
      saoKeHash: x.hash,
      saoKeTraChuaLen: 0,
    });
    expect(ky.ngayChot).toEqual(vn("2026-10-20"));
    expect(ky.hanTra).toEqual(vn("2026-11-05"));
    expect(await prisma.dongSaoKeThe.count({ where: { kyId: ky.id } })).toBe(357);
    expect(await prisma.dongSaoKeThe.count({ where: { kyId: ky.id, hoaDonId: { not: null } } })).toBe(348);
    const nk = await prisma.auditLog.findFirstOrThrow({ where: { hanhDong: "CHOT_SAO_KE_PDF", doiTuongId: ky.id } });
    expect(nk.doiTuongMoTa).toContain("đề xuất");

    await prisma.cashMovement.create({
      data: { date: vn("2026-10-24", "10:00:00"), kind: "CARD_PAY", amount: 32_475_000, cardId: A, description: "Trả thẻ" },
    });
    expect(await uocTinhDuNoTai(A, "2026-10-25")).toBe(13_091_000);
  });

  it("phải trả theo SỐ SAO KÊ (32.475.000), không theo neo 34.839.000: trả đủ 23/10 ⇒ đã trả hết kỳ, dư nợ không đổi", async () => {
    const A = await seedThe();
    const x = await xem(A);
    expect((await chotSaoKeTuPdf(formChot(A, x))).ok).toBe(true);

    // Trước khi trả: phải trả đúng số ngân hàng in, không gồm 15 bill ghi sổ trễ (ngân hàng xếp sang kỳ 20/11).
    const truocTra = (await docDuNoCacThe(vn("2026-10-22"))).find((d) => d.cardId === A);
    expect(truocTra?.phaiTra?.nghiaVuKy).toBe(32_475_000);

    await prisma.cashMovement.create({
      data: { date: vn("2026-10-23", "10:00:00"), kind: "CARD_PAY", amount: 32_475_000, cardId: A, description: "Trả thẻ" },
    });
    const sauTra = (await docDuNoCacThe(vn("2026-10-25"))).find((d) => d.cardId === A);
    expect(sauTra).toMatchObject({ duNo: 13_091_000, phaiTra: { nghiaVuKy: 0, phanTruoc: null, phanMoi: null } });
    expect(await uocTinhDuNoTai(A, "2026-10-25")).toBe(13_091_000);
    // Dự báo quỹ (khoản trả thẻ) đọc cùng trần nghĩa vụ.
    expect((await docPhaiTraCacThe(vn("2026-10-25"))).find((d) => d.cardId === A)?.phaiTra?.nghiaVuKy).toBe(0);
  });

  it("hạn trả client gửi khác hạn in trên sao kê ⇒ ghi hạn IN (05/11), trả cảnh báo + nhật ký nêu cả hai ngày", async () => {
    const A = await seedThe();
    const x = await xem(A);
    const r = await chotSaoKeTuPdf(formChot(A, x, { hanTra: "2026-11-10" }));
    expect(r).toMatchObject({
      ok: true,
      data: { canhBaoHanTra: "Hạn trả nhập 10/11/2026 khác hạn in trên sao kê 05/11/2026 — đã dùng hạn trên sao kê" },
    });
    const ky = await prisma.kySaoKeThe.findFirstOrThrow({ where: { cardId: A, laNeoMoSo: false } });
    expect(ky.hanTra).toEqual(vn("2026-11-05"));
    const nk = await prisma.auditLog.findFirstOrThrow({ where: { hanhDong: "CHOT_SAO_KE_PDF", doiTuongId: ky.id } });
    expect(nk.doiTuongMoTa).toContain("khác hạn in trên sao kê 05/11/2026");
  });

  it("hạn trả client trùng hạn in / để trống ⇒ không cảnh báo, ghi hạn in", async () => {
    const A = await seedThe();
    const x = await xem(A);
    const r = await chotSaoKeTuPdf(formChot(A, x, { hanTra: "" }));
    expect(r.ok).toBe(true);
    expect(r.ok && r.data).not.toHaveProperty("canhBaoHanTra");
    expect((await prisma.kySaoKeThe.findFirstOrThrow({ where: { cardId: A, laNeoMoSo: false } })).hanTra).toEqual(vn("2026-11-05"));
  });

  it("chủ shop sửa số chốt ⇒ bắt buộc ghi chú; có ghi chú ⇒ ghi số đã sửa (số đề xuất vẫn phải khớp server)", async () => {
    const A = await seedThe();
    const x = await xem(A);
    expect(await chotSaoKeTuPdf(formChot(A, x, { soDu: "34935000" }))).toMatchObject({ ok: false, field: "note" });
    expect((await chotSaoKeTuPdf(formChot(A, x, { soDu: "34935000", note: "ngân hàng báo thêm phí" }))).ok).toBe(true);
    expect((await prisma.kySaoKeThe.findFirstOrThrow({ where: { cardId: A, laNeoMoSo: false } })).soDu).toBe(34_935_000);
  });

  it("gửi lại CÙNG mã ⇒ DA_GHI_ROI, không thêm kỳ", async () => {
    const A = await seedThe();
    const x = await xem(A);
    const yeuCauId = randomUUID();
    const dau = await chotSaoKeTuPdf(formChot(A, x, { yeuCauId }));
    expect(dau.ok).toBe(true);
    const lai = await chotSaoKeTuPdf(formChot(A, x, { yeuCauId }));
    expect(lai).toEqual({ ...dau, code: "DA_GHI_ROI" });
    expect(await prisma.kySaoKeThe.count({ where: { laNeoMoSo: false } })).toBe(1);
    expect(await prisma.dongSaoKeThe.count()).toBe(357);
  });

  it("cùng file, mã KHÁC ⇒ 'đã nhập' (một file một lần); xem trước sau đó ⇒ chỉ xem", async () => {
    const A = await seedThe();
    const x = await xem(A);
    expect((await chotSaoKeTuPdf(formChot(A, x))).ok).toBe(true);
    const lan2 = formChot(A, x);
    expect(await chotSaoKeTuPdf(lan2)).toMatchObject({ ok: false, code: "SAO_KE_DA_NHAP" });
    expect(await prisma.yeuCauGhi.findUnique({ where: { id: String(lan2.get("yeuCauId")) } })).toBeNull();
    expect((await xem(A)).lyDoKhongChot).toContain("đã nhập");
  });

  it("unique có điều kiện chặn kỳ PDF thứ hai cùng file ở tầng DB; kỳ gõ tay (hash NULL) không dính", async () => {
    const A = await seedThe();
    const x = await xem(A);
    expect((await chotSaoKeTuPdf(formChot(A, x))).ok).toBe(true);
    const chen = prisma.kySaoKeThe.create({
      data: {
        cardId: A,
        ngayChot: vn("2026-10-21"),
        soDu: 1,
        hanTra: vn("2026-11-05"),
        nguon: "SAO_KE_PDF",
        saoKeSoDu: 1,
        saoKeTongBillGhiSoTre: 0,
        saoKeHash: x.hash,
      },
    });
    await expect(chen).rejects.toThrow();
    await prisma.kySaoKeThe.create({ data: { cardId: A, ngayChot: vn("2026-10-22"), soDu: 1, hanTra: vn("2026-11-05") } });
    await prisma.kySaoKeThe.create({ data: { cardId: A, ngayChot: vn("2026-10-23"), soDu: 1, hanTra: vn("2026-11-05") } });
  });

  it("CHECK: kỳ PDF thiếu vân tay / kỳ gõ tay mang số sao kê ⇒ DB từ chối", async () => {
    const A = await seedThe();
    await expect(
      prisma.kySaoKeThe.create({ data: { cardId: A, ngayChot: vn("2026-10-21"), soDu: 1, hanTra: vn("2026-11-05"), nguon: "SAO_KE_PDF" } })
    ).rejects.toThrow();
    await expect(
      prisma.kySaoKeThe.create({ data: { cardId: A, ngayChot: vn("2026-10-21"), soDu: 1, hanTra: vn("2026-11-05"), saoKeSoDu: 1 } })
    ).rejects.toThrow();
  });

  it("số đề xuất client khác server (hoá đơn mới về sau khi xem) ⇒ SO_DA_DOI, không ghi gì", async () => {
    const A = await seedThe();
    const x = await xem(A);
    // Một lần TikTok trừ ngày 19/10 về app SAU lúc xem trước ⇒ bill ghi sổ trễ +1 ⇒ đề xuất đổi.
    await prisma.tiktokAdsHoaDon.create({
      data: {
        transactionId: "ve-muon-1910",
        bcId: "bc",
        createTime: vn("2026-10-19", "21:00:00"),
        amount: 77_000,
        transactionType: "BILL_PAYMENT",
        billingType: "CASH",
        amountType: "POSITIVE",
      },
    });
    const fd = formChot(A, x);
    expect(await chotSaoKeTuPdf(fd)).toMatchObject({ ok: false, code: "SO_DA_DOI", error: expect.stringContaining("34.916.000") });
    expect(await chotSaoKeTuPdf(formChot(A, x, { soDeXuat: "1", note: "thử số sai" }))).toMatchObject({ ok: false, code: "SO_DA_DOI" });
    expect(await prisma.kySaoKeThe.count({ where: { laNeoMoSo: false } })).toBe(0);
    expect(await prisma.dongSaoKeThe.count()).toBe(0);
    expect(await prisma.yeuCauGhi.findUnique({ where: { id: String(fd.get("yeuCauId")) } })).toBeNull();
  });

  it("file gửi lúc chốt khác file đã xem ⇒ FILE_DA_DOI", async () => {
    const A = await seedThe();
    const x = await xem(A);
    expect(await chotSaoKeTuPdf(formChot(A, x, {}, filePdf("%PDF-1.7 file khac")))).toMatchObject({
      ok: false,
      code: "FILE_DA_DOI",
    });
  });

  it("ngày sao kê trước M ⇒ từ chối ngayChot; hôm nay = ngày sao kê ⇒ từ chối; hạn IN ≤ ngày sao kê ⇒ từ chối, nói do file", async () => {
    const A = await seedThe();
    const x = await xem(A);
    // Hạn lấy từ sao kê (không từ client) ⇒ ca hạn ≤ ngày sao kê chỉ xảy ra khi chính file in như vậy: lỗi KHÔNG trỏ
    // vào ô nào (chủ shop không sửa được hạn), xem trước cũng chỉ cho xem.
    const textHanSai = TEXT_SAO_KE_2010.replace("17:00 05/11/2026", "17:00 20/10/2026");
    vi.mocked(docTextPdf).mockResolvedValueOnce(textHanSai);
    const loiHan = await chotSaoKeTuPdf(formChot(A, x));
    expect(loiHan).toEqual({
      ok: false,
      error: "Sao kê in hạn trả 20/10/2026 không sau ngày sao kê 20/10/2026 — file có thể đọc sai",
      code: "HAN_TRA_PDF",
    });
    vi.mocked(docTextPdf).mockResolvedValueOnce(textHanSai);
    expect((await xem(A)).lyDoKhongChot).toBe(
      "Sao kê in hạn trả 20/10/2026 không sau ngày sao kê 20/10/2026 — file có thể đọc sai — chỉ xem",
    );
    expect(await chotSaoKeTuPdf(formChot(A, x, { soDu: "" }))).toMatchObject({ ok: false, field: "soDu" });
    vi.setSystemTime(vn("2026-10-20", "15:00:00"));
    expect(await chotSaoKeTuPdf(formChot(A, x))).toMatchObject({ ok: false, field: "ngayChot" });
    vi.setSystemTime(vn("2026-10-26", "10:00:00"));
    await prisma.setting.update({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY }, data: { value: "2026-10-21" } });
    expect(await chotSaoKeTuPdf(formChot(A, x))).toMatchObject({ ok: false, field: "ngayChot" });
    expect(await prisma.kySaoKeThe.count({ where: { laNeoMoSo: false } })).toBe(0);
    expect(await prisma.yeuCauGhi.count()).toBe(0);
  });

  it("thẻ đã đóng ⇒ từ chối; nhân sự ⇒ KHONG_CO_QUYEN", async () => {
    const A = await seedThe();
    const x = await xem(A);
    await prisma.theTinDung.update({ where: { id: A }, data: { closedAt: vn("2026-10-25") } });
    expect(await chotSaoKeTuPdf(formChot(A, x))).toMatchObject({ ok: false, error: "Thẻ đã đóng" });
    vi.mocked(docNguoiDungPhien).mockResolvedValue(
      nguoiDungGia({ id: "nv", role: "STAFF", quyen: new Set(["tai-chinh-so-quy:sua"]) })
    );
    expect(await chotSaoKeTuPdf(formChot(A, x))).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
  });

  it("YeuCauGhi cũ cùng vân tay mà ketQua NULL ⇒ ném (không coi là đã ghi)", async () => {
    const A = await seedThe();
    const x = await xem(A);
    const yeuCauId = randomUUID();
    expect((await chotSaoKeTuPdf(formChot(A, x, { yeuCauId }))).ok).toBe(true);
    await prisma.yeuCauGhi.update({ where: { id: yeuCauId }, data: { ketQua: Prisma.DbNull } });
    expect(await chotSaoKeTuPdf(formChot(A, x, { yeuCauId }))).toMatchObject({ ok: false, error: "Lỗi khi chốt sao kê" });
  });
});

/** Lần trả thẻ 3.000.000 ngày sao kê 20/10 mà ngân hàng ghi sổ sau ⇒ đề xuất 31.839.000, ngân hàng đòi 29.475.000. */
const P_TRA_CHUA_LEN = 3_000_000;
const S_SAO_KE = 32_475_000;

async function chotCoTraChuaLen(): Promise<{ A: string; kyId: string }> {
  const A = await seedThe();
  await prisma.cashMovement.create({
    data: { date: vn("2026-10-20", "16:00:00"), kind: "CARD_PAY", amount: P_TRA_CHUA_LEN, cardId: A, description: "Trả thẻ" },
  });
  const x = await xem(A);
  expect(x.ketQua.soDeXuat).toBe(SO_DE_XUAT - P_TRA_CHUA_LEN);
  const r = await chotSaoKeTuPdf(formChot(A, x));
  if (!r.ok) throw new Error(r.error);
  return { A, kyId: r.data.id };
}

describe("nghĩa vụ kỳ PDF = số sao kê − trả chưa lên sao kê", () => {
  it("chốt ⇒ lưu saoKeTraChuaLen; phải trả = 32.475.000 − 3.000.000 (không phải neo 31.839.000); dự báo TRA_THE cùng số", async () => {
    const { A, kyId } = await chotCoTraChuaLen();
    const ky = await prisma.kySaoKeThe.findUniqueOrThrow({ where: { id: kyId } });
    expect(ky).toMatchObject({ soDu: SO_DE_XUAT - P_TRA_CHUA_LEN, saoKeSoDu: S_SAO_KE, saoKeTraChuaLen: P_TRA_CHUA_LEN });

    const NGHIA_VU = S_SAO_KE - P_TRA_CHUA_LEN;
    expect((await docDuNoCacThe(vn("2026-10-22"))).find((d) => d.cardId === A)?.phaiTra?.nghiaVuKy).toBe(NGHIA_VU);
    const phaiTraThe = await docPhaiTraCacThe(vn("2026-10-22"));
    expect(phaiTraThe.find((d) => d.cardId === A)?.phaiTra?.nghiaVuKy).toBe(NGHIA_VU);
    // Dự báo quỹ đọc đúng `docPhaiTraCacThe` (`du-bao-quy-queries.ts`) ⇒ khoản TRA_THE hạn 05/11 = −29.475.000.
    expect(khoanTraThe(phaiTraThe, "2026-10-22", "2026-11-21")).toEqual([
      { ngay: "2026-11-05", soTien: -NGHIA_VU, moTa: "Techcombank 9999 — hạn 05/11", loai: "TRA_THE" },
    ]);

    // Trả đúng phần ngân hàng còn đòi ⇒ hết nghĩa vụ kỳ.
    await prisma.cashMovement.create({
      data: { date: vn("2026-10-23", "10:00:00"), kind: "CARD_PAY", amount: NGHIA_VU, cardId: A, description: "Trả thẻ" },
    });
    expect((await docPhaiTraCacThe(vn("2026-10-25"))).find((d) => d.cardId === A)?.phaiTra?.nghiaVuKy).toBe(0);
  });

  it("kỳ PDF ghi trước khi có cột (NULL) ⇒ như cũ: kẹp tại neo", async () => {
    const { A, kyId } = await chotCoTraChuaLen();
    await prisma.kySaoKeThe.update({ where: { id: kyId }, data: { saoKeTraChuaLen: null } });
    expect((await docPhaiTraCacThe(vn("2026-10-22"))).find((d) => d.cardId === A)?.phaiTra?.nghiaVuKy).toBe(
      SO_DE_XUAT - P_TRA_CHUA_LEN,
    );
  });
});

describe("tính lại 'trả chưa lên sao kê' cho kỳ PDF đã chốt (script)", () => {
  it("liệt kê kỳ PDF cột NULL kèm P tính lại từ dòng sao kê đã lưu + CARD_PAY; ghi ⇒ cột + nhật ký; chạy lại ⇒ bỏ qua", async () => {
    const { A, kyId } = await chotCoTraChuaLen();
    await prisma.kySaoKeThe.update({ where: { id: kyId }, data: { saoKeTraChuaLen: null } });
    // Kỳ gõ tay không phải ứng viên — chốt TRƯỚC kỳ PDF (20/10) để "phải trả tại 22/10" bên dưới vẫn
    // đọc kỳ PDF (lõi lấy kỳ có ngày chốt lớn nhất ≤ t).
    await prisma.kySaoKeThe.create({ data: { cardId: A, ngayChot: vn("2026-10-19"), soDu: 1, hanTra: vn("2026-11-05") } });

    const ds = await lietKeKyCanTinhLai(prisma);
    expect(ds.map((k) => [k.kyId, k.tong, k.traChuaLen.map((g) => [g.ngay, g.soTien])])).toEqual([
      [kyId, P_TRA_CHUA_LEN, [["2026-10-20", P_TRA_CHUA_LEN]]],
    ]);
    // Xem trước KHÔNG ghi.
    expect((await prisma.kySaoKeThe.findUniqueOrThrow({ where: { id: kyId } })).saoKeTraChuaLen).toBeNull();

    const actor = { id: "chu-shop", email: "chu@shop.vn" };
    const lan1 = await ghiTraChuaLenChoCacKy(prisma, [kyId], actor);
    expect(lan1).toMatchObject({ ghi: [{ kyId, tong: P_TRA_CHUA_LEN }], boQua: [] });
    expect((await prisma.kySaoKeThe.findUniqueOrThrow({ where: { id: kyId } })).saoKeTraChuaLen).toBe(P_TRA_CHUA_LEN);
    const nk = await prisma.auditLog.findFirstOrThrow({ where: { doiTuongLoai: "KySaoKeThe", doiTuongId: kyId, actorId: "chu-shop" } });
    expect(nk.doiTuongMoTa).toContain("trả chưa lên sao kê");
    expect((await docPhaiTraCacThe(vn("2026-10-22"))).find((d) => d.cardId === A)?.phaiTra?.nghiaVuKy).toBe(
      S_SAO_KE - P_TRA_CHUA_LEN,
    );

    const lan2 = await ghiTraChuaLenChoCacKy(prisma, [kyId], actor);
    expect(lan2).toMatchObject({ ghi: [], boQua: [{ kyId, lyDo: expect.stringContaining("đã có số") }] });
    expect(await lietKeKyCanTinhLai(prisma)).toEqual([]);
  });

  it("id không phải kỳ PDF / không tồn tại ⇒ bỏ qua có lý do, không ghi gì", async () => {
    const A = await seedThe();
    const tay = await prisma.kySaoKeThe.create({ data: { cardId: A, ngayChot: vn("2026-10-21"), soDu: 1, hanTra: vn("2026-11-05") } });
    const kq = await ghiTraChuaLenChoCacKy(prisma, [tay.id, "khong-co"], { id: "chu-shop", email: "chu@shop.vn" });
    expect(kq.ghi).toEqual([]);
    expect(kq.boQua.map((b) => b.kyId).sort()).toEqual([tay.id, "khong-co"].sort());
    expect((await prisma.kySaoKeThe.findUniqueOrThrow({ where: { id: tay.id } })).saoKeTraChuaLen).toBeNull();
  });
});

/** Dòng hoàn phí 821.000 ngày 19/10 trên sao kê đổi thành dòng HOÀN TIỀN TikTok (số giữ nguyên ⇒ cổng tổng khớp). */
const TEXT_SAO_KE_HOAN_TIKTOK = TEXT_SAO_KE_2010.replace(
  "19/10/2026 821,000 Hoan phi thuong nien nam 01 the\n...9999 theo uu dai chi tieu",
  "19/10/2026 821,000 Hoan tien giao dich 9PAY*TikTok Ads HA NOI VN",
);

const hoanTiktok = (transactionId: string, gioVn: string, amount: number) =>
  prisma.tiktokAdsHoaDon.create({
    data: {
      transactionId,
      bcId: "bc",
      createTime: new Date(`${gioVn.replace(" ", "T")}+07:00`),
      amount,
      transactionType: "BILL_PAYMENT",
      billingType: "CASH",
      amountType: "NEGATIVE",
    },
  });

describe("hoàn tiền TikTok về thẻ (hoá đơn NEGATIVE) trong neo PDF", () => {
  it("hoàn 200.000 ngày 20/10 chưa lên sao kê ⇒ TRỪ khỏi đề xuất; số sao kê lưu giữ nguyên; chốt ⇒ dư nợ không mất khoản hoàn", async () => {
    const A = await seedThe();
    await hoanTiktok("hoan-2010", "2026-10-20 15:00:00", 200_000);
    const x = await xem(A);
    expect(x.ketQua.hoanGhiSoTre.map((h) => [h.ngay, h.soTien])).toEqual([["2026-10-20", 200_000]]);
    expect(x.ketQua.soDeXuat).toBe(SO_DE_XUAT - 200_000);
    expect((await chotSaoKeTuPdf(formChot(A, x))).ok).toBe(true);
    const ky = await prisma.kySaoKeThe.findFirstOrThrow({ where: { cardId: A, laNeoMoSo: false } });
    expect(ky).toMatchObject({ soDu: SO_DE_XUAT - 200_000, saoKeSoDu: S_SAO_KE });
    // Neo đã trừ khoản hoàn; lõi không đếm lại (ngày hoàn ≤ ngày chốt) ⇒ 25/10 = neo + bill 21–25/10.
    expect(await uocTinhDuNoTai(A, "2026-10-25")).toBe(SO_DE_XUAT - 200_000 + 10_727_000);
  });

  it("hoàn đã lên sao kê (dòng ghi có TikTok 19/10 821.000) ⇒ ghép, đề xuất không đổi; chốt ⇒ dòng sao kê mang id hoá đơn hoàn", async () => {
    vi.mocked(docTextPdf).mockResolvedValue(TEXT_SAO_KE_HOAN_TIKTOK);
    const A = await seedThe();
    const h = await hoanTiktok("hoan-1910", "2026-10-19 11:00:00", 821_000);
    const x = await xem(A);
    expect(x.ketQua.soDeXuat).toBe(SO_DE_XUAT);
    expect(x.ketQua.hoanGhiSoTre).toEqual([]);
    expect(x.ketQua.soKhopHoan).toBe(1);
    expect(x.ketQua.dongKhac.ghiCo).toEqual([]);
    expect((await chotSaoKeTuPdf(formChot(A, x))).ok).toBe(true);
    const ky = await prisma.kySaoKeThe.findFirstOrThrow({ where: { cardId: A, laNeoMoSo: false } });
    expect(await prisma.dongSaoKeThe.findFirstOrThrow({ where: { kyId: ky.id, ghiCo: 821_000 } })).toMatchObject({
      laTiktok: true,
      hoaDonId: h.id,
    });
    expect(await prisma.dongSaoKeThe.count({ where: { kyId: ky.id, hoaDonId: { not: null } } })).toBe(349);
  });

  it("hai lần hoàn trùng ngày + số (19/10, 821.000), sao kê in một ⇒ trừ đúng một lần", async () => {
    vi.mocked(docTextPdf).mockResolvedValue(TEXT_SAO_KE_HOAN_TIKTOK);
    const A = await seedThe();
    await hoanTiktok("hoan-1910-a", "2026-10-19 11:00:00", 821_000);
    await hoanTiktok("hoan-1910-b", "2026-10-19 12:00:00", 821_000);
    const x = await xem(A);
    expect(x.ketQua.soKhopHoan).toBe(1);
    expect(x.ketQua.hoanGhiSoTre).toHaveLength(1);
    expect(x.ketQua.soDeXuat).toBe(SO_DE_XUAT - 821_000);
  });

  it("hoàn thuộc kỳ trước (10/10, ≤ neo 14/10) ⇒ không đổi đề xuất", async () => {
    const A = await seedThe();
    await hoanTiktok("hoan-1010", "2026-10-10 11:00:00", 300_000);
    const x = await xem(A);
    expect(x.ketQua.hoanGhiSoTre).toEqual([]);
    expect(x.ketQua.soDeXuat).toBe(SO_DE_XUAT);
  });

  it("hoàn 17/10 đã ghép ở kỳ PDF 18/10 trước ⇒ KHÔNG trừ lần hai", async () => {
    const A = await seedThe();
    const h = await hoanTiktok("hoan-1710", "2026-10-17 11:00:00", 150_000);
    const kyTruoc = await prisma.kySaoKeThe.create({
      data: {
        cardId: A,
        ngayChot: vn("2026-10-18"),
        soDu: 1,
        hanTra: vn("2026-11-05"),
        nguon: "SAO_KE_PDF",
        saoKeSoDu: 1,
        saoKeTongBillGhiSoTre: 0,
        saoKeHash: "c".repeat(64),
      },
    });
    await prisma.dongSaoKeThe.create({
      data: {
        kyId: kyTruoc.id,
        ngayGiaoDich: vn("2026-10-17"),
        ngayGhiSo: vn("2026-10-18"),
        ghiNo: 0,
        ghiCo: 150_000,
        dienGiai: "Hoan tien giao dich 9PAY*TikTok Ads HA NOI VN",
        laTiktok: true,
        hoaDonId: h.id,
      },
    });
    const x = await xem(A);
    expect(x.ngayChotTruoc).toBe("2026-10-18");
    expect(x.ketQua.hoanGhiSoTre).toEqual([]);
    expect(x.ketQua.soDeXuat).toBe(SO_DE_XUAT);
  });
});
