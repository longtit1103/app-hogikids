import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hồ sơ ví ads trả trước (`taoViAds` / `suaViAds` / `xoaViAds`) trên DB thật — spec §5.9. Hôm nay ghim
 * 05/11/2026 10:00 VN; M (khi bật) = 01/11/2026.
 */
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => ({
  ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
  docNguoiDungPhien: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { suaViAds, taoViAds, xoaViAds } from "@/lib/actions/vi-ads";
import { KEY_NO_PHAI_TRA_TU_NGAY, KHOA_BAT_NO_PHAI_TRA } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
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
  vi.setSystemTime(vn("2026-11-05", "10:00:00"));
});

afterEach(async () => {
  vi.useRealTimers();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

const bat = () => prisma.setting.create({ data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: "2026-11-01" } });

describe("taoViAds", () => {
  it("trước khi bật: hồ sơ tạm (số dư 0, neo hôm qua), nguồn nạp lưu; nhật ký VI_ADS_TAO", async () => {
    const r = await taoViAds({ nenTang: "SHOPEE_ADS", nguonNap: "CARD", note: "ví chính" });
    expect(r).toMatchObject({ ok: true });
    const vi1 = await prisma.viAdsTraTruoc.findFirstOrThrow();
    expect(vi1).toMatchObject({ nenTang: "SHOPEE_ADS", nguonNap: "CARD", soDuNeo: 0, note: "ví chính" });
    expect(vi1.ngayNeo).toEqual(vn("2026-11-04"));
    expect(await prisma.auditLog.count({ where: { hanhDong: "VI_ADS_TAO", doiTuongId: vi1.id } })).toBe(1);
  });

  it("nguồn 'ví bán hàng Shopee' ⇒ từ chối với câu hướng dẫn, không ghi", async () => {
    const r = await taoViAds({ nenTang: "SHOPEE_ADS", nguonNap: "VI_BAN_HANG" });
    expect(r).toMatchObject({ ok: false, field: "nguonNap" });
    expect(r.ok === false && r.error).toContain("Chưa nhận diện tự động được dòng nạp từ ví bán hàng");
    expect(await prisma.viAdsTraTruoc.count()).toBe(0);
  });

  it("nền tảng ngoài danh sách trả trước ⇒ từ chối; trùng nền tảng ⇒ từ chối", async () => {
    expect(await taoViAds({ nenTang: "META", nguonNap: "BANK" })).toMatchObject({ ok: false, field: "nenTang" });
    expect(await taoViAds({ nenTang: "SHOPEE_ADS", nguonNap: "BANK" })).toMatchObject({ ok: true });
    expect(await taoViAds({ nenTang: "SHOPEE_ADS", nguonNap: "BANK" })).toMatchObject({ ok: false, field: "nenTang" });
  });

  it("trước khi bật: ngày neo hôm nay ⇒ từ chối (số dư cuối ngày chưa có)", async () => {
    expect(await taoViAds({ nenTang: "SHOPEE_ADS", nguonNap: "BANK", ngayNeo: "2026-11-05" })).toMatchObject({
      ok: false,
      field: "ngayNeo",
    });
  });

  it("trước khi bật: số dư neo tuỳ ý (5tr) được nhận — số tạm, bước bật ghi đè", async () => {
    const r = await taoViAds({ nenTang: "SHOPEE_ADS", nguonNap: "BANK", soDuNeo: tr(5) });
    expect(r).toMatchObject({ ok: true });
    expect((await prisma.viAdsTraTruoc.findFirstOrThrow()).soDuNeo).toBe(tr(5));
  });

  it("sau khi bật: số dư neo 5tr ⇒ từ chối NEO_KHAC_0 (nêu lý do quỹ cao hơn ngân hàng), không ghi", async () => {
    await bat();
    const r = await taoViAds({ nenTang: "SHOPEE_ADS", nguonNap: "BANK", soDuNeo: tr(5) });
    expect(r).toMatchObject({ ok: false, code: "NEO_KHAC_0", field: "soDuNeo" });
    expect(r.ok === false && r.error).toContain("quỹ sẽ cao hơn ngân hàng");
    expect(await prisma.viAdsTraTruoc.count()).toBe(0);
  });

  it("sau khi bật: số dư 0 (hoặc bỏ trống) ⇒ nhận, neo luôn HÔM QUA (bỏ ngày gửi lên), KHÔNG tạo điều chỉnh quỹ", async () => {
    await bat();
    const r = await taoViAds({ nenTang: "SHOPEE_ADS", nguonNap: "BANK", soDuNeo: 0, ngayNeo: "2026-10-01" });
    expect(r).toMatchObject({ ok: true });
    const vi1 = await prisma.viAdsTraTruoc.findFirstOrThrow();
    expect(vi1.soDuNeo).toBe(0);
    expect(vi1.ngayNeo).toEqual(vn("2026-11-04"));
    expect(await prisma.cashMovement.count()).toBe(0);

    await prisma.viAdsTraTruoc.deleteMany();
    expect(await taoViAds({ nenTang: "SHOPEE_ADS", nguonNap: "CARD" })).toMatchObject({ ok: true });
    expect((await prisma.viAdsTraTruoc.findFirstOrThrow()).soDuNeo).toBe(0);
  });

  it("không phải chủ shop ⇒ từ chối", async () => {
    vi.mocked(docNguoiDungPhien).mockResolvedValue(
      nguoiDungGia({ role: "STAFF", quyen: new Set(["tai-chinh-so-quy:sua", "tai-chinh-so-quy:xem"]) })
    );
    expect(await taoViAds({ nenTang: "SHOPEE_ADS", nguonNap: "BANK" })).toMatchObject({ ok: false });
    expect(await prisma.viAdsTraTruoc.count()).toBe(0);
  });
});

describe("suaViAds / xoaViAds", () => {
  it("sửa nguồn nạp + ghi chú; số dư neo giữ nguyên", async () => {
    const r = await taoViAds({ nenTang: "SHOPEE_ADS", nguonNap: "BANK", soDuNeo: tr(1) });
    const id = r.ok ? r.data.id : "";
    expect(await suaViAds(id, { nguonNap: "CARD", note: "đổi sang thẻ" })).toMatchObject({ ok: true });
    expect(await prisma.viAdsTraTruoc.findUniqueOrThrow({ where: { id } })).toMatchObject({
      nguonNap: "CARD",
      note: "đổi sang thẻ",
      soDuNeo: tr(1),
    });
    expect(await suaViAds(id, { nguonNap: "VI_BAN_HANG" })).toMatchObject({ ok: false, field: "nguonNap" });
  });

  it("trước khi bật: xoá được, ảnh chụp vào thùng rác", async () => {
    const r = await taoViAds({ nenTang: "SHOPEE_ADS", nguonNap: "BANK" });
    const id = r.ok ? r.data.id : "";
    expect(await xoaViAds(id)).toMatchObject({ ok: true });
    expect(await prisma.viAdsTraTruoc.count()).toBe(0);
    expect(await prisma.banGhiDaXoa.count({ where: { bang: "ViAdsTraTruoc" } })).toBe(1);
  });

  it("sau khi bật: ví đã khai ở bước bật (neo trước M) ⇒ không xoá được", async () => {
    const vi1 = await prisma.viAdsTraTruoc.create({ data: { nenTang: "SHOPEE_ADS", soDuNeo: tr(3), ngayNeo: vn("2026-10-31") } });
    await bat();
    expect(await xoaViAds(vi1.id)).toMatchObject({ ok: false, code: "KHONG_XOA_DUOC_VI" });
    expect(await prisma.viAdsTraTruoc.count()).toBe(1);
  });

  it("sau khi bật: ví tạo sau M đã có lần nạp, hoặc đã gánh chi ads ⇒ không xoá được; ví trắng ⇒ xoá được", async () => {
    await bat();
    const vi1 = await prisma.viAdsTraTruoc.create({ data: { nenTang: "SHOPEE_ADS", soDuNeo: 0, ngayNeo: vn("2026-11-02") } });
    await prisma.expense.create({
      data: { date: vn("2026-11-03"), categoryId: "ads", adsSource: "SHOPEE_ADS", amount: tr(1), description: "ads", source: "MANUAL" },
    });
    expect(await xoaViAds(vi1.id)).toMatchObject({ ok: false, code: "KHONG_XOA_DUOC_VI" });

    await prisma.expense.deleteMany();
    await prisma.cashMovement.create({
      data: { date: vn("2026-11-04"), kind: "ADS_TOPUP", amount: tr(5), viAdsId: vi1.id, description: "nạp" },
    });
    expect(await xoaViAds(vi1.id)).toMatchObject({ ok: false, code: "KHONG_XOA_DUOC_VI" });

    await prisma.cashMovement.deleteMany();
    expect(await xoaViAds(vi1.id)).toMatchObject({ ok: true });
  });
});

describe("khoá SHARED với bước bật (đua taoViAds ↔ bước bật)", () => {
  /**
   * Giả lập bước bật: giữ khoá EXCLUSIVE `KHOA_BAT_NO_PHAI_TRA` + ghi M (chưa commit) trong 0,8s rồi commit.
   * `taoViAds` chạy giữa chừng phải CHỜ rồi đọc M SAU khi giành khoá — không khoá thì đọc M = null (chưa
   * commit) và nhận số dư 5tr như hồ sơ chuẩn bị, mà bước bật lại không thấy ví đó.
   */
  it("taoViAds số dư 5tr CHỜ bước bật rồi bị từ chối NEO_KHAC_0", async () => {
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
    const p = taoViAds({ nenTang: "SHOPEE_ADS", nguonNap: "BANK", soDuNeo: tr(5) }).then((r) => ({
      r,
      ms: performance.now() - t0,
    }));
    await new Promise((res) => setTimeout(res, 800));
    tha();
    await buocBat;
    const { r, ms } = await p;
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(r).toMatchObject({ ok: false, code: "NEO_KHAC_0" });
    expect(await prisma.viAdsTraTruoc.count()).toBe(0);
  });
});
