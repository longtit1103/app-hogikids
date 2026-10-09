import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Bước xác nhận bật nợ phải trả trên DB thật (spec §5.4, §7 mục 9) — fixture §6, M = 01/11/2026, hôm nay
 * ghim 03/11/2026 10:00 VN. Quỹ mở sổ 10/10 = 150; thẻ A (sao kê 25/10 = 12 hạn 10/11 trả trước 5; cuối
 * 31/10 = 9) + thẻ B (25/10 = 4; cuối 31/10 = 6).
 */
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => ({
  ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
  docNguoiDungPhien: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { docChenhLechTaiM, xacNhanBatNoPhaiTra } from "@/lib/actions/bat-no-phai-tra";
import { taoViAds } from "@/lib/actions/vi-ads";
import { KEY_NO_PHAI_TRA_TU_NGAY } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { kiemDieuKienBat } from "@/lib/no-phai-tra/dieu-kien-bat-no-phai-tra";
import { ghiKhoiTaoNoPhaiTra } from "@/lib/no-phai-tra/ghi-khoi-tao-no-phai-tra";
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
});

afterEach(async () => {
  vi.useRealTimers();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

async function seed(): Promise<{ A: string; B: string }> {
  await prisma.cashMovement.create({
    data: { date: vn("2026-10-10"), kind: "CAPITAL_IN", amount: tr(150), description: "mở sổ" },
  });
  const A = (await prisma.theTinDung.create({ data: { ten: "Thẻ A", ngayChotSaoKe: 25, ngayHanTra: 10 } })).id;
  const B = (await prisma.theTinDung.create({ data: { ten: "Thẻ B", ngayChotSaoKe: 25, ngayHanTra: 10 } })).id;
  return { A, B };
}

const theFixture = (A: string, B: string) => [
  {
    cardId: A,
    saoKeCuoi: { ngayChot: "2026-10-25", soDu: tr(12), hanTra: "2026-11-10", daTraTruocMoSo: tr(5) },
    duNoCuoiMTru1: tr(9),
  },
  {
    cardId: B,
    saoKeCuoi: { ngayChot: "2026-10-25", soDu: tr(4), hanTra: "2026-11-10", daTraTruocMoSo: 0 },
    duNoCuoiMTru1: tr(6),
  },
];

const yeuCau = (A: string, B: string, ghiDe: Record<string, unknown> = {}) => ({
  yeuCauId: randomUUID(),
  mocM: "2026-11-01",
  the: theFixture(A, B),
  viAds: [] as { viAdsId: string; soDuNeo: number }[],
  dieuChinh: [
    { chieu: "IN", soTien: tr(9), moTa: "nợ thẻ A" },
    { chieu: "IN", soTien: tr(6), moTa: "nợ thẻ B" },
  ],
  ...ghiDe,
});

const demCutover = () => prisma.cashMovement.count({ where: { kind: { in: ["CUTOVER_ADJ_IN", "CUTOVER_ADJ_OUT"] } } });
// Nhật ký không nằm trong bộ dọn bảng nghiệp vụ và `thoiDiem` dính đồng hồ giả ⇒ so SỐ DÒNG trước/sau.
const demNhatKyBat = (chua?: string) =>
  prisma.auditLog.count({
    where: { hanhDong: "NO_PHAI_TRA_BAT", ...(chua === undefined ? {} : { doiTuongMoTa: { contains: chua } }) },
  });
const docM = async () =>
  (await prisma.setting.findUnique({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } }))?.value ?? null;

describe("xacNhanBatNoPhaiTra", () => {
  it("bật lần đầu: sao kê + neo M−1 mỗi thẻ, 2 dòng CUTOVER_ADJ_IN đúng ngày M, Setting M, nhật ký", async () => {
    const { A, B } = await seed();
    const r = await xacNhanBatNoPhaiTra(yeuCau(A, B));
    expect(r).toMatchObject({ ok: true, data: { mocM: "2026-11-01", soThe: 2, tacDong: tr(15) } });
    expect(r).not.toHaveProperty("code");

    expect(await docM()).toBe("2026-11-01");
    const kyA = await prisma.kySaoKeThe.findMany({ where: { cardId: A }, orderBy: { ngayChot: "asc" } });
    expect(kyA).toHaveLength(2);
    expect(kyA[0]).toMatchObject({ soDu: tr(12), daTraTruocMoSo: tr(5), laNeoMoSo: false });
    expect(kyA[0].ngayChot).toEqual(vn("2026-10-25"));
    expect(kyA[0].hanTra).toEqual(vn("2026-11-10"));
    expect(kyA[1]).toMatchObject({ soDu: tr(9), laNeoMoSo: true, hanTra: null });
    expect(kyA[1].ngayChot).toEqual(vn("2026-10-31"));

    const cut = await prisma.cashMovement.findMany({ where: { kind: "CUTOVER_ADJ_IN" }, orderBy: { amount: "desc" } });
    expect(cut.map((c) => [c.amount, c.description])).toEqual([
      [tr(9), "nợ thẻ A"],
      [tr(6), "nợ thẻ B"],
    ]);
    for (const c of cut) expect(c.date).toEqual(vn("2026-11-01"));

    const nk = await prisma.auditLog.findFirstOrThrow({ where: { hanhDong: "NO_PHAI_TRA_BAT" } });
    expect(nk.doiTuongMoTa).toContain("2026-11-01");
  });

  it("gửi lại CÙNG mã ⇒ DA_GHI_ROI, không thêm điều chỉnh; mã KHÁC sau khi bật ⇒ DA_BAT_ROI, không ghi", async () => {
    const { A, B } = await seed();
    const yc = yeuCau(A, B);
    expect(await xacNhanBatNoPhaiTra(yc)).toMatchObject({ ok: true });
    expect(await demCutover()).toBe(2);

    const lai = await xacNhanBatNoPhaiTra(yc);
    expect(lai).toMatchObject({ ok: true, code: "DA_GHI_ROI", data: { mocM: "2026-11-01" } });
    expect(await demCutover()).toBe(2);

    const khac = await xacNhanBatNoPhaiTra(yeuCau(A, B));
    expect(khac).toMatchObject({ ok: false, code: "DA_BAT_ROI" });
    expect(await demCutover()).toBe(2);
    expect(await prisma.kySaoKeThe.count()).toBe(4);
    // Lượt bị từ chối rollback CẢ dòng giữ mã — chỉ còn yêu cầu đầu tiên.
    expect(await prisma.yeuCauGhi.count({ where: { loai: "XAC_NHAN_BAT" } })).toBe(1);
  });

  it("cùng mã khác nội dung ⇒ từ chối", async () => {
    const { A, B } = await seed();
    const yc = yeuCau(A, B);
    expect(await xacNhanBatNoPhaiTra(yc)).toMatchObject({ ok: true });
    const r = await xacNhanBatNoPhaiTra({ ...yc, dieuChinh: [] });
    expect(r).toMatchObject({ ok: false });
    expect(await demCutover()).toBe(2);
  });

  it("hai tab bấm đồng thời (hai mã) ⇒ đúng một lượt bật, lượt kia DA_BAT_ROI", async () => {
    const { A, B } = await seed();
    const [r1, r2] = await Promise.all([xacNhanBatNoPhaiTra(yeuCau(A, B)), xacNhanBatNoPhaiTra(yeuCau(A, B))]);
    const ok = [r1, r2].filter((r) => r.ok);
    const tuChoi = [r1, r2].filter((r) => !r.ok);
    expect(ok).toHaveLength(1);
    expect(tuChoi[0]).toMatchObject({ code: "DA_BAT_ROI" });
    expect(await demCutover()).toBe(2);
    expect(await prisma.kySaoKeThe.count({ where: { laNeoMoSo: true } })).toBe(2);
  });

  it("chênh 0 ⇒ không dòng điều chỉnh nào (vẫn bật); chênh âm ⇒ CUTOVER_ADJ_OUT", async () => {
    const { A, B } = await seed();
    expect(await xacNhanBatNoPhaiTra(yeuCau(A, B, { dieuChinh: [{ chieu: "IN", soTien: 0, moTa: "" }] }))).toMatchObject({
      ok: true,
      data: { dieuChinh: [], tacDong: 0 },
    });
    expect(await demCutover()).toBe(0);
    expect(await docM()).toBe("2026-11-01");

    await truncateBusinessTables();
    await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
    const s = await seed();
    const r = await xacNhanBatNoPhaiTra(
      yeuCau(s.A, s.B, { dieuChinh: [{ chieu: "OUT", soTien: tr(2), moTa: "chi chưa ghi" }] })
    );
    expect(r).toMatchObject({ ok: true, data: { tacDong: -tr(2) } });
    const out = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "CUTOVER_ADJ_OUT" } });
    expect(out.amount).toBe(tr(2));
  });

  it("NGUYÊN TỬ: ném ở bước điều chỉnh ⇒ không kỳ sao kê, không neo ví, không CUTOVER, không Setting", async () => {
    const { A, B } = await seed();
    const vi1 = await prisma.viAdsTraTruoc.create({
      data: { nenTang: "SHOPEE_ADS", soDuNeo: 0, ngayNeo: vn("2026-10-20") },
    });
    await expect(
      prisma.$transaction((tx) =>
        ghiKhoiTaoNoPhaiTra(tx, {
          mocM: vn("2026-11-01"),
          yeuCauId: randomUUID(),
          the: theFixture(A, B).map((t) => ({
            ...t,
            saoKeCuoi: { ...t.saoKeCuoi, ngayChot: vn(t.saoKeCuoi.ngayChot), hanTra: vn(t.saoKeCuoi.hanTra) },
          })),
          viAds: [{ viAdsId: vi1.id, soDuNeo: tr(3) }],
          // Dòng đầu ghi được, dòng hai mô tả toàn khoảng trắng ⇒ ném SAU khi đã ghi thẻ, ví, một CUTOVER.
          dieuChinh: [
            { chieu: "IN", soTien: tr(9), moTa: "nợ thẻ A" },
            { chieu: "IN", soTien: tr(6), moTa: " \t " },
          ],
        })
      )
    ).rejects.toMatchObject({ code: "THIEU_MO_TA" });
    expect(await prisma.kySaoKeThe.count()).toBe(0);
    expect(await demCutover()).toBe(0);
    expect(await docM()).toBeNull();
    expect(await prisma.viAdsTraTruoc.findUniqueOrThrow({ where: { id: vi1.id } })).toMatchObject({ soDuNeo: 0 });
  });

  it("thiếu một thẻ đang mở ⇒ THIEU_THE (thẻ không neo thì sau bật không có điểm xuất phát dư nợ)", async () => {
    const { A, B } = await seed();
    const r = await xacNhanBatNoPhaiTra(yeuCau(A, B, { the: theFixture(A, B).slice(0, 1) }));
    expect(r).toMatchObject({ ok: false, code: "THIEU_THE" });
    expect(r.ok === false && r.error).toContain("Thẻ B");
    expect(await docM()).toBeNull();
  });

  it("điều kiện tiên quyết: chưa tới M · tháng đã chốt số dư · Shopee Ads thiếu hồ sơ ví · còn mẫu định kỳ Nhập hàng", async () => {
    const { A, B } = await seed();
    expect(await xacNhanBatNoPhaiTra(yeuCau(A, B, { mocM: "2026-11-04" }))).toMatchObject({
      ok: false,
      code: "CHUA_TOI_NGAY_M",
    });

    await prisma.soDuChotThang.create({ data: { thang: vn("2026-11-01"), soDuBank: 0, tienMat: 0 } });
    expect(await xacNhanBatNoPhaiTra(yeuCau(A, B))).toMatchObject({ ok: false, code: "M_KHONG_SAU_THANG_DA_CHOT" });
    await prisma.soDuChotThang.deleteMany();
    // Chốt tháng 10 thì M = 01/11 hợp lệ.
    await prisma.soDuChotThang.create({ data: { thang: vn("2026-10-01"), soDuBank: 0, tienMat: 0 } });

    await prisma.expense.create({
      data: {
        date: vn("2026-10-20"),
        categoryId: "ads",
        adsSource: "SHOPEE_ADS",
        amount: tr(1),
        description: "Shopee Ads",
        source: "MANUAL",
      },
    });
    const thieuVi = await xacNhanBatNoPhaiTra(yeuCau(A, B));
    expect(thieuVi).toMatchObject({ ok: false, code: "THIEU_HO_SO_VI" });

    const vi1 = await taoViAds({ nenTang: "SHOPEE_ADS", nguonNap: "BANK" });
    expect(vi1).toMatchObject({ ok: true });
    await prisma.recurringExpense.create({
      data: { categoryId: "purchase", amount: tr(5), dayOfMonth: 5, description: "Nhập hàng tháng", active: true },
    });
    const conMau = await xacNhanBatNoPhaiTra(
      yeuCau(A, B, { viAds: [{ viAdsId: vi1.ok ? vi1.data.id : "", soDuNeo: tr(3) }] })
    );
    expect(conMau).toMatchObject({ ok: false, code: "CON_MAU_DINH_KY_NHAP_HANG" });
    expect(conMau.ok === false && conMau.error).toContain("Nhập hàng tháng");
    expect(await docM()).toBeNull();

    await prisma.recurringExpense.updateMany({ data: { active: false } });
    const ok = await xacNhanBatNoPhaiTra(
      yeuCau(A, B, { viAds: [{ viAdsId: vi1.ok ? vi1.data.id : "", soDuNeo: tr(3) }] })
    );
    expect(ok).toMatchObject({ ok: true, data: { soVi: 1 } });
    const vi = await prisma.viAdsTraTruoc.findFirstOrThrow();
    expect(vi.soDuNeo).toBe(tr(3));
    expect(vi.ngayNeo).toEqual(vn("2026-10-31"));
  });

  it("còn chi phí Nhập hàng ngày ≥ M (phiếu 30 ngày 02/11, bật 03/11) ⇒ CON_NHAP_HANG_SAU_M kèm danh sách + 3 trường hợp; ngày ghi nhầm sửa về ngày thật trước M ⇒ bật được", async () => {
    const { A, B } = await seed();
    const phieu = await prisma.expense.create({
      data: {
        date: vn("2026-11-02"),
        categoryId: "purchase",
        amount: tr(30),
        description: "Nhập hàng phiếu #9",
        source: "MANUAL",
        refId: "PNK:9",
      },
    });
    const r = await xacNhanBatNoPhaiTra(yeuCau(A, B));
    expect(r).toMatchObject({ ok: false, code: "CON_NHAP_HANG_SAU_M" });
    expect(r.ok === false && r.error).toContain("02/11/2026");
    expect(r.ok === false && r.error).toContain("Nhập hàng phiếu #9");
    expect(r.ok === false && r.error).toMatch(/30\.000\.000/);
    // Ba trường hợp theo thực tế + cảnh báo không đổi ngày để vượt cổng (câu lỗi server, máy đọc được).
    expect(r.ok === false && r.error).toContain("(1) Ngày ghi nhầm (khoản thật diễn ra trước 01/11/2026) ⇒ sửa ngày về đúng ngày thật");
    expect(r.ok === false && r.error).toContain("(2) Đã trả thật trong khoảng từ 01/11/2026 tới nay ⇒ xoá dòng chi phí");
    expect(r.ok === false && r.error).toContain('"Đã trả ngay" đúng ngày trả');
    expect(r.ok === false && r.error).toContain("(3) Chưa trả ⇒ xoá dòng chi phí; sau khi bật, ghi nhận phiếu vào sổ nợ không kèm trả");
    expect(r.ok === false && r.error).toContain("Không đổi ngày chỉ để vượt cổng");
    expect(r.ok === false && r.error).not.toMatch(/đổi ngày về trước 01\/11\/2026 ở Sổ chi phí/);
    expect(await docM()).toBeNull();
    expect(await demCutover()).toBe(0);

    // Danh sách có cấu trúc cho màn hình (link Sổ chi phí đúng ngày của dòng).
    const loi = (await kiemDieuKienBat({ mocM: vn("2026-11-01") })).find((l) => l.code === "CON_NHAP_HANG_SAU_M");
    expect(loi?.nhapHangSauM).toEqual({
      khoaM: "2026-11-01",
      khoaHomNay: "2026-11-03",
      dong: [{ id: phieu.id, khoaNgay: "2026-11-02", amount: tr(30), description: "Nhập hàng phiếu #9" }],
      soDongKhac: 0,
    });

    await prisma.expense.update({ where: { id: phieu.id }, data: { date: vn("2026-10-31") } });
    expect(await xacNhanBatNoPhaiTra(yeuCau(A, B))).toMatchObject({ ok: true });
  });

  it("Shopee Ads có chi 90 ngày, không hồ sơ ví: không cờ xác nhận ⇒ THIEU_HO_SO_VI; có cờ ⇒ bật, lưu vết nhật ký + kết quả yêu cầu", async () => {
    const { A, B } = await seed();
    await prisma.expense.create({
      data: { date: vn("2026-10-20"), categoryId: "ads", adsSource: "SHOPEE_ADS", amount: tr(1), description: "Shopee Ads", source: "MANUAL" },
    });
    expect(await xacNhanBatNoPhaiTra(yeuCau(A, B, { xacNhanViShopeeChuaTheoDoi: false }))).toMatchObject({
      ok: false,
      code: "THIEU_HO_SO_VI",
    });
    expect(await docM()).toBeNull();

    const truoc = await demNhatKyBat("ví Shopee Ads chưa theo dõi");
    const yc = yeuCau(A, B, { xacNhanViShopeeChuaTheoDoi: true });
    expect(await xacNhanBatNoPhaiTra(yc)).toMatchObject({ ok: true, data: { viShopeeChuaTheoDoi: true, soVi: 0 } });
    expect(await docM()).toBe("2026-11-01");
    expect(await demNhatKyBat("ví Shopee Ads chưa theo dõi")).toBe(truoc + 1);
    const kq = await prisma.yeuCauGhi.findUniqueOrThrow({ where: { id: yc.yeuCauId } });
    expect(kq.ketQua).toMatchObject({ ok: true, data: { viShopeeChuaTheoDoi: true } });
  });

  it("cờ xác nhận ví khi KHÔNG thiếu hồ sơ ví ⇒ bật bình thường, không lưu vết 'chưa theo dõi'", async () => {
    const { A, B } = await seed();
    const [tong, chuaTheoDoi] = await Promise.all([demNhatKyBat(), demNhatKyBat("chưa theo dõi")]);
    const r = await xacNhanBatNoPhaiTra(yeuCau(A, B, { xacNhanViShopeeChuaTheoDoi: true }));
    expect(r).toMatchObject({ ok: true, data: { viShopeeChuaTheoDoi: false } });
    expect(await demNhatKyBat()).toBe(tong + 1);
    expect(await demNhatKyBat("chưa theo dõi")).toBe(chuaTheoDoi);
  });

  it("chốt thứ hai: gỡ Setting rồi bật mã khác ⇒ DA_BAT_ROI (còn CUTOVER); gỡ cả CUTOVER ⇒ vẫn DA_BAT_ROI (yêu cầu bật đã ghi)", async () => {
    const { A, B } = await seed();
    expect(await xacNhanBatNoPhaiTra(yeuCau(A, B))).toMatchObject({ ok: true });
    expect(await demCutover()).toBe(2);

    await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
    const lai = await xacNhanBatNoPhaiTra(yeuCau(A, B));
    expect(lai).toMatchObject({ ok: false, code: "DA_BAT_ROI" });
    expect(lai.ok === false && lai.error).toContain("gỡ Setting không phải cách tắt");
    expect(await demCutover()).toBe(2);
    expect(await docM()).toBeNull();

    await prisma.cashMovement.deleteMany({ where: { kind: { in: ["CUTOVER_ADJ_IN", "CUTOVER_ADJ_OUT"] } } });
    expect(await xacNhanBatNoPhaiTra(yeuCau(A, B))).toMatchObject({ ok: false, code: "DA_BAT_ROI" });
    expect(await demCutover()).toBe(0);
    expect(await prisma.yeuCauGhi.count({ where: { loai: "XAC_NHAN_BAT" } })).toBe(1);
  });

  it("M lùi quá đầu tháng trước ⇒ M_LUI_QUA_XA", async () => {
    const { A, B } = await seed();
    // Mở sổ sớm để M_TRUOC_MO_SO không che mã đang kiểm.
    await prisma.cashMovement.create({ data: { date: vn("2026-08-01"), kind: "CAPITAL_IN", amount: 1, description: "mở sổ sớm" } });
    const r = await xacNhanBatNoPhaiTra(yeuCau(A, B, { mocM: "2026-09-30" }));
    expect(r).toMatchObject({ ok: false, code: "M_LUI_QUA_XA" });
    expect(r.ok === false && r.error).toContain("01/10/2026");
    expect(await docM()).toBeNull();
  });

  it("có hồ sơ ví mà không khai số dư ví ⇒ THIEU_VI", async () => {
    const { A, B } = await seed();
    await prisma.viAdsTraTruoc.create({ data: { nenTang: "SHOPEE_ADS", soDuNeo: 0, ngayNeo: vn("2026-10-20") } });
    expect(await xacNhanBatNoPhaiTra(yeuCau(A, B))).toMatchObject({ ok: false, code: "THIEU_VI" });
  });

  it("sao kê chốt ĐÚNG ngày M−1 ⇒ một dòng làm cả sao kê lẫn neo; hai số khác nhau ⇒ từ chối", async () => {
    const { A, B } = await seed();
    const the = theFixture(A, B);
    const lech = [{ ...the[0], saoKeCuoi: { ...the[0].saoKeCuoi, ngayChot: "2026-10-31", soDu: tr(10) } }, the[1]];
    expect(await xacNhanBatNoPhaiTra(yeuCau(A, B, { the: lech }))).toMatchObject({
      ok: false,
      code: "SAO_KE_CHOT_DUNG_NGAY_TRUOC_M",
    });
    const khop = [{ ...the[0], saoKeCuoi: { ...the[0].saoKeCuoi, ngayChot: "2026-10-31", soDu: tr(9) } }, the[1]];
    expect(await xacNhanBatNoPhaiTra(yeuCau(A, B, { the: khop }))).toMatchObject({ ok: true });
    const kyA = await prisma.kySaoKeThe.findMany({ where: { cardId: A } });
    expect(kyA).toHaveLength(1);
    expect(kyA[0]).toMatchObject({ soDu: tr(9), laNeoMoSo: false });
    expect(kyA[0].hanTra).toEqual(vn("2026-11-10"));
  });

  it("mô tả toàn TAB/NBSP ⇒ zod từ chối (CHECK btrim trong DB không bắt)", async () => {
    const { A, B } = await seed();
    const r = await xacNhanBatNoPhaiTra(yeuCau(A, B, { dieuChinh: [{ chieu: "IN", soTien: tr(9), moTa: "\t " }] }));
    expect(r).toMatchObject({ ok: false });
    expect(await docM()).toBeNull();
  });

  it("không phải chủ shop ⇒ từ chối", async () => {
    const { A, B } = await seed();
    vi.mocked(docNguoiDungPhien).mockResolvedValue(
      nguoiDungGia({ role: "STAFF", quyen: new Set(["tai-chinh-so-quy:sua", "tai-chinh-so-quy:xem"]) })
    );
    expect(await xacNhanBatNoPhaiTra(yeuCau(A, B))).toMatchObject({ ok: false });
    expect(await docM()).toBeNull();
  });
});

describe("kiemDieuKienBat — biên M_LUI_QUA_XA (đầu tháng trước, giờ VN)", () => {
  const coMa = async (mocM: string, homNay: Date) =>
    (await kiemDieuKienBat({ mocM: vn(mocM), homNay })).some((l) => l.code === "M_LUI_QUA_XA");

  it("hôm nay 03/11: 30/09 bị chặn, 01/10 được", async () => {
    expect(await coMa("2026-09-30", vn("2026-11-03", "10:00:00"))).toBe(true);
    expect(await coMa("2026-10-01", vn("2026-11-03", "10:00:00"))).toBe(false);
  });

  it("qua năm: hôm nay 01/01/2027 00:30 VN ⇒ sàn 01/12/2026", async () => {
    expect(await coMa("2026-11-30", vn("2027-01-01", "00:30:00"))).toBe(true);
    expect(await coMa("2026-12-01", vn("2027-01-01", "00:30:00"))).toBe(false);
  });
});

describe("docChenhLechTaiM", () => {
  it("fixture §6: quỹ 150, ngân hàng 158 + tiền mặt 7, thẻ 9 + 6 ⇒ chênh 15, chưa giải thích 0", async () => {
    const { A, B } = await seed();
    const r = await docChenhLechTaiM({
      mocM: "2026-11-01",
      soDuBank: tr(158),
      tienMat: tr(7),
      the: [
        { cardId: A, duNo: tr(9) },
        { cardId: B, duNo: tr(6) },
      ],
      viAds: [],
    });
    expect(r).toMatchObject({
      ok: true,
      data: { quyApp: tr(150), chenh: tr(15), tongGiaiThich: tr(15), chuaGiaiThich: 0, ngayTruocM: "2026-10-31" },
    });
  });

  it("phiếu Y: chỉ Sổ chi phí TRƯỚC M vào giải thích (phiếu #9 ghi 02/11 không thuộc quỹ 31/10); nhãn in mã phiếu nguyên văn", async () => {
    const { A, B } = await seed();
    const phieuY = (ma: string, ngay: string, soSo: number, daTra: number) =>
      Promise.all([
        prisma.expense.create({
          data: { date: vn(ngay), categoryId: "purchase", amount: tr(soSo), description: `phiếu ${ma}`, source: "MANUAL", refId: `PNK:${ma}` },
        }),
        prisma.phieuNhapNo.create({
          data: {
            refId: `PNK:${ma}`,
            shopId: "kho",
            maPhieu: ma,
            ngayPhieu: vn(ngay),
            tongTien: tr(100),
            daTraTruoc: tr(daTra),
            lechDaGiaiThich: true,
            lechDaGiaiThichSo: tr(soSo),
          },
        }),
      ]);
    // #8 trước M: sổ ghi 53,6, thật trả 33,6 ⇒ sổ trừ thừa 20. #9 ghi 02/11 (≥ M): quỹ 31/10 không chứa ⇒ 0.
    await phieuY("#8", "2026-10-17", 53.6, 33.6);
    await phieuY("#9", "2026-11-02", 30, 0);
    const r = await docChenhLechTaiM({
      mocM: "2026-11-01",
      soDuBank: tr(150 - 53.6 + 15 + 20),
      tienMat: 0,
      the: [
        { cardId: A, duNo: tr(9) },
        { cardId: B, duNo: tr(6) },
      ],
      viAds: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.quyApp).toBe(tr(150 - 53.6));
    expect(r.data.giaiThichDuoc.phieuY).toBe(tr(20));
    expect(r.data.chuaGiaiThich).toBe(0);
    expect(r.data.muc.filter((m) => m.khoa.startsWith("phieu:")).map((m) => [m.khoa, m.nhan])).toEqual([
      ["phieu:PNK:#8", "phiếu #8 duyệt khác số đã trả"],
    ]);
  });

  it("thấu chi còn 10 cuối 31/10, trả hết 02/11 ⇒ dùng 10; phiếu Y +20; ví neo 3 ⇒ −3; chi ngày M không vào quỹ M−1", async () => {
    const { A, B } = await seed();
    const od = await prisma.loan.create({
      data: { name: "Thấu chi", startDate: vn("2026-10-01"), kind: "OVERDRAFT" },
    });
    await prisma.cashMovement.create({
      data: { date: vn("2026-10-15"), kind: "LOAN_IN", amount: tr(10), loanId: od.id, description: "rút thấu chi" },
    });
    await prisma.cashMovement.create({
      data: { date: vn("2026-11-02"), kind: "LOAN_REPAY", amount: tr(10), loanId: od.id, description: "trả thấu chi" },
    });
    // Phiếu Y: Sổ chi phí ghi 53,6 nhưng thật trả 33,6 ⇒ sổ trừ thừa 20.
    await prisma.expense.create({
      data: { date: vn("2026-10-17"), categoryId: "purchase", amount: tr(53.6), description: "phiếu #1", source: "MANUAL", refId: "PNK:1" },
    });
    await prisma.phieuNhapNo.create({
      data: {
        refId: "PNK:1",
        shopId: "kho",
        maPhieu: "1",
        ngayPhieu: vn("2026-10-17"),
        tongTien: tr(100),
        daTraTruoc: tr(33.6),
        lechDaGiaiThich: true,
        lechDaGiaiThichSo: tr(53.6),
      },
    });
    const vi1 = await prisma.viAdsTraTruoc.create({ data: { nenTang: "SHOPEE_ADS", soDuNeo: 0, ngayNeo: vn("2026-10-20") } });
    // Chi đúng ngày M — không thuộc quỹ cuối M − 1.
    await prisma.expense.create({
      data: { date: vn("2026-11-01", "09:00:00"), categoryId: "other", amount: tr(4), description: "ngày M", source: "MANUAL" },
    });

    // Quỹ 31/10 = 150 + 10 (rút thấu chi) − 53,6 = 106,4. Ngân hàng thật (thấu chi âm phần đó): 106,4 − 10 + 15
    // (nợ thẻ) + 20 (phiếu Y) − 3 (đã nạp ví) − 7 (tiền mặt nằm ngoài ngân hàng) = 121,4.
    const r = await docChenhLechTaiM({
      mocM: "2026-11-01",
      soDuBank: tr(121.4),
      tienMat: tr(7),
      the: [
        { cardId: A, duNo: tr(9) },
        { cardId: B, duNo: tr(6) },
      ],
      viAds: [{ viAdsId: vi1.id, soDu: tr(3) }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.quyApp).toBe(tr(106.4));
    expect(r.data.duNoThauChi).toBe(tr(10));
    expect(r.data.giaiThichDuoc).toEqual({ the: tr(15), phieuY: tr(20), viAds: -tr(3) });
    expect(r.data.chenh).toBe(tr(32));
    expect(r.data.chuaGiaiThich).toBe(0);
  });
});
