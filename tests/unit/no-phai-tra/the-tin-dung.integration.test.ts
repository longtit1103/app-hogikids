import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Action hồ sơ thẻ tín dụng trên DB thật (`hogikids_test`) — spec §5.1, §5.4 ("Thẻ thêm SAU B"), §5.8.
 * Phiên giả = chủ shop; "hôm nay" ghim bằng fake timer chỉ cho `Date`.
 */
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => ({
  ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
  docNguoiDungPhien: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { dongThe, ganNenTang, suaThe, taoThe, xoaGanNenTang, xoaThe } from "@/lib/actions/the-tin-dung";
import { KEY_NO_PHAI_TRA_TU_NGAY, KHOA_BAT_NO_PHAI_TRA } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { docTheKemTrangThai } from "@/lib/no-phai-tra/the-tin-dung-queries";
import { prisma } from "@/lib/prisma";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";

import { nguoiDungGia } from "../../helpers/nguoi-dung-gia";
import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

const vn = (ngay: string, gio = "00:00:00") => new Date(`${ngay}T${gio}+07:00`);
const tr = (n: number) => Math.round(n * 1_000_000);
const HO_SO = { ten: "Thẻ VPB", nganHang: "VPBank", ngayChotSaoKe: 25, ngayHanTra: 10, note: "" };

async function batNoPhaiTra(m = "2026-11-01") {
  await prisma.setting.upsert({
    where: { key: KEY_NO_PHAI_TRA_TU_NGAY },
    create: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: m },
    update: { value: m },
  });
}

async function taoTheOk(ghiDe: Record<string, unknown> = {}): Promise<string> {
  const r = await taoThe({ ...HO_SO, ...ghiDe });
  if (!r.ok) throw new Error(r.error);
  return r.data.id;
}

/** Thẻ + neo M − 1 ghi THẲNG DB — giả lập dòng (ii) bước bật sinh (chỉ bước bật được neo `soDu > 0`). */
async function theTuBuocBat(soDu: number, ten = "Thẻ B"): Promise<string> {
  const id = (await prisma.theTinDung.create({ data: { ...HO_SO, ten } })).id;
  await prisma.kySaoKeThe.create({ data: { cardId: id, ngayChot: vn("2026-10-31"), soDu, laNeoMoSo: true } });
  return id;
}

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
  vi.mocked(docNguoiDungPhien).mockResolvedValue(nguoiDungGia());
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(vn("2026-12-01", "10:00:00"));
});

afterEach(async () => {
  vi.useRealTimers();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

describe("taoThe — neo ban đầu theo trạng thái bật", () => {
  it("TRƯỚC khi bật: tạo hồ sơ không neo OK; gửi kèm neo ⇒ từ chối", async () => {
    const id = await taoTheOk();
    expect(await prisma.kySaoKeThe.count({ where: { cardId: id } })).toBe(0);
    const coNeo = await taoThe({ ...HO_SO, neoBanDau: { ngayChot: "2026-11-30", soDu: 0 } });
    expect(coNeo).toMatchObject({ ok: false, field: "neoBanDau" });
    expect(await prisma.theTinDung.count()).toBe(1);
    const nk = await prisma.auditLog.findMany({ where: { hanhDong: "THE_TAO", doiTuongId: id } });
    expect(nk).toHaveLength(1);
  });

  it("SAU khi bật: thiếu neo ⇒ từ chối; neo soDu 0 ngày hôm qua (gõ 15:00) ⇒ OK, lưu 00:00 VN", async () => {
    await batNoPhaiTra();
    expect(await taoThe(HO_SO)).toMatchObject({ ok: false, field: "neoBanDau" });
    expect(await prisma.theTinDung.count()).toBe(0);

    const id = await taoTheOk({ neoBanDau: { ngayChot: vn("2026-11-30", "15:00:00"), soDu: 0 } });
    const neo = await prisma.kySaoKeThe.findMany({ where: { cardId: id } });
    expect(neo).toHaveLength(1);
    expect(neo[0]).toMatchObject({ laNeoMoSo: true, soDu: 0, hanTra: null });
    expect(neo[0].ngayChot).toEqual(vn("2026-11-30"));
  });

  it("SAU khi bật: neo soDu > 0 ⇒ NEO_KHAC_0 (nợ cũ đã trừ quỹ qua chi phí — trả thẻ là trừ hai lần)", async () => {
    await batNoPhaiTra();
    const r = await taoThe({ ...HO_SO, neoBanDau: { ngayChot: "2026-11-30", soDu: 1 } });
    expect(r).toMatchObject({ ok: false, field: "neoBanDau", code: "NEO_KHAC_0", error: expect.stringContaining("trừ quỹ hai lần") });
    expect(await prisma.theTinDung.count()).toBe(0);
    expect(await prisma.kySaoKeThe.count()).toBe(0);
  });

  it("SAU khi bật: neo đúng M − 1 ⇒ OK; M − 2 ⇒ từ chối (neo trước M chỉ sinh ở bước bật)", async () => {
    await batNoPhaiTra("2026-11-01");
    const r = await taoThe({ ...HO_SO, neoBanDau: { ngayChot: "2026-10-30", soDu: 0 } });
    expect(r).toMatchObject({ ok: false, field: "neoBanDau", error: expect.stringContaining("31/10/2026") });
    const id = await taoTheOk({ neoBanDau: { ngayChot: "2026-10-31", soDu: 0 } });
    expect((await prisma.kySaoKeThe.findFirstOrThrow({ where: { cardId: id } })).ngayChot).toEqual(vn("2026-10-31"));
    const nk = await prisma.auditLog.findFirstOrThrow({ where: { hanhDong: "THE_TAO", doiTuongId: id } });
    expect(nk.doiTuongMoTa).toContain("coNeoMoSo");
  });

  it("SAU khi bật: neo ngày hôm nay ⇒ từ chối; soDu âm ⇒ từ chối", async () => {
    await batNoPhaiTra();
    expect(await taoThe({ ...HO_SO, neoBanDau: { ngayChot: "2026-12-01", soDu: 0 } })).toMatchObject({ ok: false });
    expect(await taoThe({ ...HO_SO, neoBanDau: { ngayChot: "2026-11-30", soDu: -1 } })).toMatchObject({ ok: false });
    expect(await prisma.theTinDung.count()).toBe(0);
  });

  it("ngày chốt/hạn ngoài 1..31 ⇒ zod từ chối", async () => {
    expect(await taoThe({ ...HO_SO, ngayChotSaoKe: 32 })).toMatchObject({ ok: false, field: "ngayChotSaoKe" });
    expect(await taoThe({ ...HO_SO, ngayHanTra: 0 })).toMatchObject({ ok: false, field: "ngayHanTra" });
  });

  it("DB chặn 2 neo mở sổ cho cùng thẻ (unique partial KySaoKeThe_mot_neo_mo_so_moi_the)", async () => {
    await batNoPhaiTra();
    const id = await taoTheOk({ neoBanDau: { ngayChot: "2026-11-30", soDu: 0 } });
    await expect(
      prisma.kySaoKeThe.create({ data: { cardId: id, ngayChot: vn("2026-11-29"), soDu: 0, laNeoMoSo: true } })
    ).rejects.toThrow();
    expect(await prisma.kySaoKeThe.count({ where: { cardId: id } })).toBe(1);
  });

  it("nhân sự thiếu quyền Sổ quỹ ⇒ KHONG_CO_QUYEN, không ghi", async () => {
    vi.mocked(docNguoiDungPhien).mockResolvedValue(nguoiDungGia({ id: "nv", role: "STAFF", quyen: new Set() }));
    expect(await taoThe(HO_SO)).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    expect(await prisma.theTinDung.count()).toBe(0);
  });
});

describe("suaThe / xoaThe", () => {
  it("sửa hồ sơ OK; thẻ không tồn tại ⇒ 'Không tìm thấy thẻ'", async () => {
    const id = await taoTheOk();
    expect(await suaThe(id, { ...HO_SO, ten: "Thẻ VPB mới", ngayChotSaoKe: 31 })).toEqual({ ok: true, data: undefined });
    expect(await prisma.theTinDung.findUnique({ where: { id } })).toMatchObject({ ten: "Thẻ VPB mới", ngayChotSaoKe: 31 });
    expect(await suaThe("khong-co", HO_SO)).toMatchObject({ ok: false, error: "Không tìm thấy thẻ" });
  });

  it("thẻ trắng xoá được; thẻ có mốc gắn ⇒ từ chối (chỉ đóng)", async () => {
    const trang = await taoTheOk();
    expect(await xoaThe(trang)).toEqual({ ok: true, data: undefined });
    expect(await prisma.theTinDung.count()).toBe(0);

    const coGan = await taoTheOk();
    expect((await ganNenTang({ cardId: coGan, nenTang: "META", tuNgay: "2026-11-01" })).ok).toBe(true);
    expect(await xoaThe(coGan)).toMatchObject({ ok: false, error: expect.stringContaining("chỉ đóng") });
    expect(await prisma.theTinDung.count()).toBe(1);
  });

  it("thẻ sau khi bật CHỈ có neo 0 ⇒ xoá được, neo xoá cùng, nhật ký ghi coNeoMoSo", async () => {
    await batNoPhaiTra();
    const id = await taoTheOk({ neoBanDau: { ngayChot: "2026-11-30", soDu: 0 } });
    expect(await xoaThe(id)).toEqual({ ok: true, data: undefined });
    expect(await prisma.theTinDung.count()).toBe(0);
    expect(await prisma.kySaoKeThe.count()).toBe(0);
    const nk = await prisma.auditLog.findFirstOrThrow({ where: { hanhDong: "THE_XOA", doiTuongId: id } });
    expect(nk.doiTuongMoTa).toContain("coNeoMoSo");
  });

  it("neo + kỳ sao kê thật ⇒ chặn; neo + mốc gắn ⇒ chặn; neo soDu > 0 (bước bật sinh) ⇒ chặn", async () => {
    await batNoPhaiTra();
    const coKy = await taoTheOk({ neoBanDau: { ngayChot: "2026-11-29", soDu: 0 } });
    await prisma.kySaoKeThe.create({
      data: { cardId: coKy, ngayChot: vn("2026-11-30"), soDu: 0, hanTra: vn("2026-12-10"), laNeoMoSo: false },
    });
    expect(await xoaThe(coKy)).toMatchObject({ ok: false, error: expect.stringContaining("kỳ sao kê") });

    const coGan = await taoTheOk({ ten: "Thẻ G", neoBanDau: { ngayChot: "2026-11-30", soDu: 0 } });
    expect((await ganNenTang({ cardId: coGan, nenTang: "META", tuNgay: "2026-12-05" })).ok).toBe(true);
    expect(await xoaThe(coGan)).toMatchObject({ ok: false, error: expect.stringContaining("gắn nền tảng") });

    const tuB = await theTuBuocBat(tr(2));
    expect(await xoaThe(tuB)).toMatchObject({ ok: false, error: expect.stringContaining("dư nợ mở sổ khác 0") });
    expect(await prisma.theTinDung.count()).toBe(3);
    expect(await prisma.kySaoKeThe.count()).toBe(4);
  });
});

describe("dongThe", () => {
  it("thẻ còn nợ ⇒ từ chối; dư nợ 0 và không gánh nền tảng ⇒ đóng được", async () => {
    await batNoPhaiTra();
    const conNo = await theTuBuocBat(tr(5));
    expect(await dongThe(conNo)).toMatchObject({ ok: false, error: expect.stringContaining("dư nợ") });

    const sach = await taoTheOk({ neoBanDau: { ngayChot: "2026-11-30", soDu: 0 } });
    expect(await dongThe(sach)).toEqual({ ok: true, data: undefined });
    expect((await prisma.theTinDung.findUnique({ where: { id: sach } }))?.closedAt).not.toBeNull();
    expect(await dongThe(sach)).toMatchObject({ ok: false, error: "Thẻ đã đóng" });
  });

  it("thẻ đang gánh META ⇒ từ chối; chuyển META sang thẻ khác (mốc tương lai chưa đủ) rồi mới đóng được", async () => {
    // Hồ sơ + mốc gắn từ 01/11 dựng TRƯỚC khi bật (sau khi bật không gắn lùi ngày được).
    const A = await taoTheOk();
    const C = await taoTheOk({ ten: "Thẻ C" });
    expect((await ganNenTang({ cardId: A, nenTang: "META", tuNgay: "2026-11-01" })).ok).toBe(true);
    await batNoPhaiTra();
    expect(await dongThe(A)).toMatchObject({ ok: false, error: expect.stringContaining("gánh quảng cáo") });

    // Mốc chuyển ở TƯƠNG LAI: A vẫn gánh tới hôm đó ⇒ vẫn chặn.
    expect((await ganNenTang({ cardId: C, nenTang: "META", tuNgay: "2026-12-05" })).ok).toBe(true);
    expect(await dongThe(A)).toMatchObject({ ok: false });

    // Mốc chuyển đã hiệu lực (hôm nay) ⇒ A không còn gánh.
    expect((await ganNenTang({ cardId: C, nenTang: "META", tuNgay: "2026-12-01" })).ok).toBe(true);
    expect(await dongThe(A)).toEqual({ ok: true, data: undefined });
    // Thẻ đã đóng không nhận gắn mới.
    expect(await ganNenTang({ cardId: A, nenTang: "TIKTOK_ADS", tuNgay: "2026-12-10" })).toMatchObject({ ok: false });
  });
});

describe("ganNenTang / xoaGanNenTang", () => {
  it("tuNgay gõ 10:00 ⇒ lưu 00:00 VN; cùng nền tảng cùng ngày khác giờ ⇒ 'đã có mốc'", async () => {
    const A = await taoTheOk();
    const B = await taoTheOk({ ten: "Thẻ B" });
    const r = await ganNenTang({ cardId: A, nenTang: "META", tuNgay: vn("2026-11-01", "10:00:00") });
    if (!r.ok) throw new Error(r.error);
    expect((await prisma.ganNenTangThe.findUnique({ where: { id: r.data.id } }))?.tuNgay).toEqual(vn("2026-11-01"));

    const trung = await ganNenTang({ cardId: B, nenTang: "META", tuNgay: vn("2026-11-01", "15:00:00") });
    expect(trung).toMatchObject({ ok: false, field: "tuNgay", error: expect.stringContaining("đã có mốc") });
    expect(await prisma.ganNenTangThe.count()).toBe(1);
  });

  it("SAU khi bật: tuNgay hôm qua ⇒ GAN_LUI_NGAY; hôm nay / tương lai ⇒ OK", async () => {
    await batNoPhaiTra();
    const A = await taoTheOk({ neoBanDau: { ngayChot: "2026-11-30", soDu: 0 } });
    expect(await ganNenTang({ cardId: A, nenTang: "META", tuNgay: vn("2026-11-30", "23:59:00") })).toMatchObject({
      ok: false,
      field: "tuNgay",
      code: "GAN_LUI_NGAY",
    });
    expect(await prisma.ganNenTangThe.count()).toBe(0);
    expect((await ganNenTang({ cardId: A, nenTang: "META", tuNgay: "2026-12-01" })).ok).toBe(true);
    expect((await ganNenTang({ cardId: A, nenTang: "TIKTOK_ADS", tuNgay: "2026-12-20" })).ok).toBe(true);
  });

  it("TRƯỚC khi bật: tuNgay quá khứ ⇒ OK (hồ sơ chuẩn bị)", async () => {
    const A = await taoTheOk();
    expect((await ganNenTang({ cardId: A, nenTang: "META", tuNgay: "2026-10-01" })).ok).toBe(true);
  });

  it("SHOPEE_ADS không gắn thẻ được (nạp ví trả trước)", async () => {
    const A = await taoTheOk();
    expect(await ganNenTang({ cardId: A, nenTang: "SHOPEE_ADS", tuNgay: "2026-11-01" })).toMatchObject({
      ok: false,
      field: "nenTang",
    });
  });

  it("xoá mốc đã hiệu lực (≤ hôm nay) ⇒ từ chối; mốc tương lai ⇒ xoá được", async () => {
    const A = await taoTheOk();
    const daHieuLuc = await ganNenTang({ cardId: A, nenTang: "META", tuNgay: "2026-12-01" });
    const tuongLai = await ganNenTang({ cardId: A, nenTang: "TIKTOK_ADS", tuNgay: "2026-12-02" });
    if (!daHieuLuc.ok || !tuongLai.ok) throw new Error("seed gắn hỏng");

    expect(await xoaGanNenTang(daHieuLuc.data.id)).toMatchObject({ ok: false, error: expect.stringContaining("đã có hiệu lực") });
    expect(await xoaGanNenTang(tuongLai.data.id)).toEqual({ ok: true, data: undefined });
    expect(await prisma.ganNenTangThe.findMany({ select: { id: true } })).toEqual([{ id: daHieuLuc.data.id }]);
    const nk = await prisma.auditLog.count({ where: { hanhDong: "THE_XOA_GAN_NEN_TANG", doiTuongId: tuongLai.data.id } });
    expect(nk).toBe(1);
  });
});

describe("docTheKemTrangThai", () => {
  it("dư nợ, mốc gắn (xoaDuoc), lý do chặn xoá/đóng, nhắc chưa chốt sao kê tháng này", async () => {
    await batNoPhaiTra();
    vi.setSystemTime(vn("2026-12-26", "10:00:00"));
    const A = await theTuBuocBat(tr(3));
    await ganNenTang({ cardId: A, nenTang: "META", tuNgay: "2027-01-01" });
    const ds = await docTheKemTrangThai(prisma, new Date());
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({
      id: A,
      duNo: tr(3),
      phaiTra: null,
      kyGanNhat: { soDu: tr(3), laNeoMoSo: true },
      gan: [{ nenTang: "META", xoaDuoc: true }],
      nenTangDangGan: ["META"],
      chuaChotKyGanNhat: true,
    });
    expect(ds[0].lyDoKhongXoa).toContain("chỉ đóng");
    expect(ds[0].lyDoKhongDong).toContain("dư nợ");
  });
});

describe("khoá SHARED với bước bật (đua taoThe / ganNenTang ↔ bước bật)", () => {
  /**
   * Giả lập bước bật: giữ khoá EXCLUSIVE `KHOA_BAT_NO_PHAI_TRA` + ghi M (chưa commit) trong 0,8s rồi commit.
   * Action chạy giữa chừng phải CHỜ, rồi đọc M SAU khi giành khoá — không khoá thì đọc M = null (chưa commit).
   */
  async function trongLucBuocBat<T>(hanhDong: () => Promise<T>): Promise<{ r: T; ms: number }> {
    let tha!: () => void;
    const cho = new Promise<void>((res) => (tha = res));
    let daGiu!: () => void;
    const giuXong = new Promise<void>((res) => (daGiu = res));
    const buocBat = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${KHOA_BAT_NO_PHAI_TRA}::text))`;
        await tx.setting.create({ data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: "2026-11-01" } });
        daGiu();
        await cho;
      },
      { timeout: 20_000 }
    );
    await giuXong;
    const t0 = performance.now();
    const p = hanhDong().then((r) => ({ r, ms: performance.now() - t0 }));
    await new Promise((res) => setTimeout(res, 800));
    tha();
    await buocBat;
    return p;
  }

  it("taoThe không neo CHỜ bước bật rồi bị từ chối 'nhập ngày của dư nợ ban đầu'", async () => {
    const { r, ms } = await trongLucBuocBat(() => taoThe(HO_SO));
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(r).toMatchObject({ ok: false, field: "neoBanDau" });
    expect(await prisma.theTinDung.count()).toBe(0);
  });

  it("ganNenTang lùi ngày CHỜ bước bật rồi bị từ chối GAN_LUI_NGAY", async () => {
    const A = await taoTheOk();
    const { r, ms } = await trongLucBuocBat(() => ganNenTang({ cardId: A, nenTang: "META", tuNgay: "2026-11-05" }));
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(r).toMatchObject({ ok: false, code: "GAN_LUI_NGAY" });
    expect(await prisma.ganNenTangThe.count()).toBe(0);
  });
});
