import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * KHE ĐUA "ghi chi phí Nhập hàng" ↔ "bước bật nợ phải trả" trên DB thật (`hogikids_test`).
 *
 * Bước bật giữ khoá EXCLUSIVE `KHOA_BAT_NO_PHAI_TRA`, kiểm "không còn Expense Nhập hàng ngày ≥ M" rồi ghi
 * Setting M. Mọi đường ghi Nhập hàng giữ khoá SHARED (câu đầu transaction) ⇒ hai chiều đều tuần tự:
 *  (1)(2)(3) bước bật (giả lập: giữ EXCLUSIVE + ghi M chưa commit 0,8s) chạy trước ⇒ `createExpense` /
 *     `ghiChiPhiNhapHang` / bộ sinh định kỳ CHỜ rồi đọc M mới ⇒ từ chối / không chèn. Bỏ khoá thì chúng đọc
 *     M = null (chưa commit) và chèn dòng ngày ≥ M sau lưng bước bật.
 *  (4) đường ghi chạy trước (giữ SHARED, dòng đã chèn chưa commit 0,8s) ⇒ `xacNhanBatNoPhaiTra` thật CHỜ rồi
 *     thấy dòng vừa commit ⇒ `CON_NHAP_HANG_SAU_M`. Bỏ khoá thì bước bật không thấy dòng chưa commit ⇒ bật.
 *  (5)(6)(7) bật lại mẫu định kỳ (`batLaiDinhKy`) giữ SHARED khi mẫu là Nhập hàng, và đã bật thì từ chối mẫu
 *     Nhập hàng: bước bật (giả lập) chạy trước ⇒ lượt bật lại CHỜ nó commit rồi đọc M mới ⇒ `DA_BAT_NO_PHAI_TRA`
 *     (mẫu khác danh mục không chờ); lượt bật lại chạy trước ⇒ `xacNhanBatNoPhaiTra` thật CHỜ rồi thấy mẫu vừa
 *     bật ⇒ `CON_MAU_DINH_KY_NHAP_HANG`; tuần tự sau khi bật (M giữa tháng) ⇒ từ chối, bộ sinh không chèn gì.
 *  (13) phần TIỀN của dòng cũ cũng đọc LẠI sau khoá: dòng Nhập hàng 4tr đổi số tiền thành 5tr (lúc chưa bật)
 *     giữa lượt đọc ngoài transaction và lượt giữ khoá; form U1 vẫn mang 4tr và chỉ đổi danh mục ⇒ thực chất là
 *     đổi số tiền sau khi bật ⇒ phải bị từ chối (so với bản `existing` 4tr là cho qua nhầm).
 *  (11)(12) danh mục CŨ phải đọc LẠI sau khoá chung: U1 mở sửa/xoá một dòng `fixed` (đọc `existing` ngoài
 *     transaction), dòng bị đổi SANG Nhập hàng (lúc chưa bật) rồi bước bật commit, sau đó U1 mới giành khoá ⇒
 *     phải bị từ chối. Xét theo `existing` là đổi/xoá một dòng Nhập hàng trước M sau khi đã bật.
 *  (8)(9)(10) Nhập hàng khoá sổ MỌI ngày khi đã bật: `deleteExpense` / `updateExpense` dòng Nhập hàng TRƯỚC M và
 *     `ghiChiPhiNhapHang` với mọi phiếu trước M (M giả lập 16/09) CHỜ bước bật rồi đọc M mới ⇒ từ chối. Bỏ khoá
 *     (hay cổng chỉ xét ngày ≥ M) thì chúng xoá/sửa/ghi dòng trước M sau lưng bước bật — quỹ cuối M−1 lệch
 *     khỏi số dư thật mà điều chỉnh mở sổ vừa chốt.
 *  (14)–(17) sổ chi phí TRƯỚC M khoá MỌI danh mục: `updateExpense` đổi số tiền / `createExpense` / `deleteExpense` một
 *     dòng `fixed` 20/08 < M, và bộ sinh định kỳ mẫu `fixed` lần 20/08, CHỜ bước bật rồi đọc M mới ⇒ từ chối / không
 *     chèn. Khoá có điều kiện theo danh mục (như trước) thì chúng không chờ, đọc M = null và đổi quỹ cuối M−1 sau lưng
 *     bước bật.
 *  (18)(19) NGÀY của dòng cũ cũng đọc LẠI sau khoá: dòng `fixed` 18/09 (≥ M = 15/09 sẽ bật) bị dời về 05/09 (< M,
 *     lúc chưa bật) giữa lượt đọc ngoài transaction và lượt giữ khoá. Xét theo ngày 18/09 của `existing` thì form cũ
 *     (ngày 18/09) chỉ là "đổi số tiền dòng ≥ M" và xoá dòng 18/09 là "xoá dòng ≥ M" — thực chất là sửa/xoá dòng
 *     05/09 sau khi bật ⇒ quỹ cuối M−1 lệch. Phải bị từ chối, dòng vẫn 05/09 nguyên tiền.
 * M = 01/09/2026; 20/09/2026 (fake timer chỉ `Date` — setTimeout/performance thật). Phiếu nhập
 * Bronze là fixture thật 04–15/09 (cùng fixture `tests/nhap-hang/chi-phi-nhap-hang.integration.test.ts`).
 */

/** Ca (4): giữ transaction của `ghiChiPhiNhapHang` mở thêm `ms` sau câu nhật ký (đã chèn, chưa commit). */
const treNhatKy = vi.hoisted(() => ({ hanhDong: null as string | null, ms: 0, daVao: null as (() => void) | null }));

/**
 * Ca (11)(12): báo hiệu NGAY TRƯỚC khi action xin khoá chung — lúc đó nó đã đọc xong bản `existing` NGOÀI
 * transaction, chưa đọc gì trong transaction. Bọc hàm thật, không đổi hành vi khoá.
 */
const vaoKhoaChung = vi.hoisted(() => ({ bao: null as (() => void) | null }));
vi.mock("@/lib/no-phai-tra/cong-bat-no-phai-tra", async (goc) => {
  const that = await goc<typeof import("@/lib/no-phai-tra/cong-bat-no-phai-tra")>();
  return {
    ...that,
    khoaChiaSeBatNoPhaiTra: async (...a: Parameters<typeof that.khoaChiaSeBatNoPhaiTra>) => {
      vaoKhoaChung.bao?.();
      return that.khoaChiaSeBatNoPhaiTra(...a);
    },
  };
});

vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => ({
  ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
  docNguoiDungPhien: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/nhat-ky/ghi-nhat-ky", async (goc) => {
  const that = await goc<typeof import("@/lib/nhat-ky/ghi-nhat-ky")>();
  return {
    ...that,
    ghiNhatKy: async (...a: Parameters<typeof that.ghiNhatKy>) => {
      await that.ghiNhatKy(...a);
      if (treNhatKy.hanhDong !== null && a[1].hanhDong === treNhatKy.hanhDong) {
        treNhatKy.daVao?.();
        await new Promise((res) => setTimeout(res, treNhatKy.ms));
      }
    },
  };
});

import { xacNhanBatNoPhaiTra } from "@/lib/actions/bat-no-phai-tra";
import { ghiChiPhiNhapHang } from "@/lib/actions/chi-phi-nhap-hang";
import { batLaiDinhKy, createExpense, deleteExpense, updateExpense } from "@/lib/actions/expenses";
import { ensureRecurringExpensesChiTiet } from "@/lib/expenses/ensure-recurring-expenses";
import { docDeXuatPhieuNhap } from "@/lib/nhap-hang/doc-phieu-nhap-bronze";
import { vanTayDeXuatPhieuNhap } from "@/lib/nhap-hang/doi-chieu-phieu-nhap";
import { KEY_NO_PHAI_TRA_TU_NGAY, KHOA_BAT_NO_PHAI_TRA } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { prisma } from "@/lib/prisma";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";

import { nguoiDungGia } from "../../helpers/nguoi-dung-gia";
import { SHOP_KHO } from "../../helpers/shop-ids-fixture";
import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

const vn = (ngay: string, gio = "00:00:00") => new Date(`${ngay}T${gio}+07:00`);
const M = "2026-09-01";

const PHIEU_THAT = JSON.parse(
  readFileSync(path.resolve(process.cwd(), "tests/fixtures/pancake/phieu-nhap-sample.json"), "utf8")
) as { id: string }[];

async function seedBronzePhieuNhap(): Promise<void> {
  await prisma.rawPancakePurchase.deleteMany();
  await prisma.rawPancakePurchase.createMany({
    data: PHIEU_THAT.map((p, i) => ({ shopId: SHOP_KHO, externalId: p.id, payloadHash: `hash-${i}`, payload: p as object })),
  });
}

async function duyetTatCa(): Promise<{ vanTay: string; chon: { uuid: string; soTien: number }[] }> {
  const { deXuat } = await docDeXuatPhieuNhap();
  return { vanTay: vanTayDeXuatPhieuNhap(deXuat), chon: deXuat.map((d) => ({ uuid: d.uuid, soTien: d.soTien })) };
}

/**
 * Giả lập bước bật: giữ EXCLUSIVE + ghi Setting M (chưa commit) 0,8s rồi commit. `hanhDong` chạy giữa chừng;
 * trả kết quả + thời gian nó phải chờ.
 */
/**
 * Vân tay quỹ bất kỳ cho lượt bật chỉ cốt thấy LỖI ĐIỀU KIỆN: điều kiện tiên quyết kiểm TRƯỚC vân tay, nên số ở
 * đây không bao giờ được so tới.
 */
const VAN_TAY_BAT_KY = { quyApp: 0, duNoThauChi: 0, tongPhieuY: 0 };

async function trongLucBuocBatGiuKhoa<T>(
  hanhDong: () => Promise<T>,
  moc: string = M,
  /** Chạy sau khi `hanhDong` đã bắt đầu, TRƯỚC khi bước bật commit (đổi dữ liệu xen giữa). */
  giua?: () => Promise<void>
): Promise<{ r: T; ms: number }> {
  let tha!: () => void;
  const cho = new Promise<void>((res) => (tha = res));
  let daGiu!: () => void;
  const giuXong = new Promise<void>((res) => (daGiu = res));
  const buocBat = prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${KHOA_BAT_NO_PHAI_TRA}::text))`;
      await tx.setting.create({ data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: moc } });
      daGiu();
      await cho;
    },
    { timeout: 20_000 }
  );
  await giuXong;
  const t0 = performance.now();
  const p = hanhDong().then((r) => ({ r, ms: performance.now() - t0 }));
  if (giua) await giua();
  await new Promise((res) => setTimeout(res, 800));
  tha();
  await buocBat;
  return p;
}

const docM = async () => (await prisma.setting.findUnique({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } }))?.value ?? null;

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
  await seedBronzePhieuNhap();
  // Mở sổ 12/05 (trước M) — bước bật đòi sổ quỹ đã mở; phiếu nhập đề xuất tính từ ngày mở sổ.
  await prisma.cashMovement.create({
    data: { date: new Date(2026, 4, 12), kind: "CAPITAL_IN", amount: 500_000_000, description: "Góp vốn mở sổ" },
  });
  vi.mocked(docNguoiDungPhien).mockResolvedValue(nguoiDungGia());
  treNhatKy.hanhDong = null;
  treNhatKy.daVao = null;
  vaoKhoaChung.bao = null;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(vn("2026-09-20", "10:00:00"));
});

afterEach(async () => {
  vi.useRealTimers();
  treNhatKy.hanhDong = null;
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.rawPancakePurchase.deleteMany();
  await prisma.$disconnect();
});

describe("bước bật chạy trước ⇒ đường ghi Nhập hàng chờ rồi bị từ chối", () => {
  it("(1) createExpense Nhập hàng ngày ≥ M CHỜ bước bật rồi bị từ chối DA_BAT_NO_PHAI_TRA", async () => {
    const { r, ms } = await trongLucBuocBatGiuKhoa(() =>
      createExpense({ date: vn("2026-09-10"), categoryId: "purchase", amount: 5_000_000, description: "Nhập lô áo", channelId: null })
    );
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(r).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA", field: "categoryId" });
    expect(await prisma.expense.count()).toBe(0);
  });

  it("(2) ghiChiPhiNhapHang (màn duyệt phiếu) CHỜ bước bật rồi bị từ chối, không ghi dòng nào", async () => {
    const duyet = await duyetTatCa();
    expect(duyet.chon.length).toBeGreaterThan(0);
    const { r, ms } = await trongLucBuocBatGiuKhoa(() => ghiChiPhiNhapHang(duyet));
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(r).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA" });
    expect(await prisma.expense.count()).toBe(0);
  });

  it("(3) bộ sinh định kỳ mẫu Nhập hàng CHỜ bước bật rồi không chèn (bỏ qua lần phát sinh ≥ M)", async () => {
    await prisma.recurringExpense.create({
      data: { categoryId: "purchase", amount: 2_000_000, dayOfMonth: 5, description: "Nhập định kỳ", active: true, activeFrom: vn("2026-08-01") },
    });
    const { r, ms } = await trongLucBuocBatGiuKhoa(() => ensureRecurringExpensesChiTiet(vn("2026-09-15")));
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(r).toEqual({ daTao: 0, boQuaNhapHang: 1, boQuaTruocM: 0 });
    expect(await prisma.expense.count()).toBe(0);
  });
});

describe("đường ghi Nhập hàng chạy trước ⇒ bước bật chờ rồi thấy dòng vừa ghi", () => {
  it("(4) ghiChiPhiNhapHang giữ transaction 0,8s sau câu chèn ⇒ xacNhanBatNoPhaiTra CHỜ rồi CON_NHAP_HANG_SAU_M", async () => {
    const duyet = await duyetTatCa();
    let daVao!: () => void;
    const vaoNhatKy = new Promise<void>((res) => (daVao = res));
    treNhatKy.hanhDong = "NHAP_HANG_GHI_CHI_PHI";
    treNhatKy.ms = 800;
    treNhatKy.daVao = daVao;

    const ghi = ghiChiPhiNhapHang(duyet);
    await vaoNhatKy; // dòng Nhập hàng đã chèn trong transaction, chưa commit
    const t0 = performance.now();
    const bat = await xacNhanBatNoPhaiTra({ yeuCauId: randomUUID(), mocM: M, the: [], viAds: [], dieuChinh: [], vanTayQuy: VAN_TAY_BAT_KY });
    const ms = performance.now() - t0;

    expect(await ghi).toMatchObject({ ok: true, data: { daGhi: duyet.chon.length } });
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(bat).toMatchObject({ ok: false, code: "CON_NHAP_HANG_SAU_M" });
    expect(await docM()).toBeNull();
    expect(await prisma.expense.count({ where: { categoryId: "purchase" } })).toBe(duyet.chon.length);
  });
});

describe("bật lại mẫu định kỳ Nhập hàng ↔ bước bật", () => {
  const mauDaDung = (categoryId: string) =>
    prisma.recurringExpense.create({
      data: { categoryId, amount: 2_000_000, dayOfMonth: 5, description: `Mẫu ${categoryId}`, active: false, activeFrom: vn("2026-08-01") },
    });

  it("(5) bước bật giữ khoá ⇒ batLaiDinhKy mẫu Nhập hàng CHỜ bước bật commit rồi bị từ chối DA_BAT_NO_PHAI_TRA; mẫu danh mục khác không chờ", async () => {
    const nhapHang = await mauDaDung("purchase");
    const { r, ms } = await trongLucBuocBatGiuKhoa(() => batLaiDinhKy(nhapHang.id, { thangBatDau: "2026-09" }));
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(r).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA" });
    expect(await docM()).toBe(M);
    expect(await prisma.recurringExpense.findUniqueOrThrow({ where: { id: nhapHang.id } })).toMatchObject({ active: false });

    await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
    const coDinh = await mauDaDung("fixed");
    const khac = await trongLucBuocBatGiuKhoa(() => batLaiDinhKy(coDinh.id, { thangBatDau: "2026-09" }));
    expect(khac.ms).toBeLessThan(700);
    expect(khac.r).toMatchObject({ ok: true });
  });

  it("(6) batLaiDinhKy mẫu Nhập hàng giữ transaction 0,8s sau câu bật ⇒ xacNhanBatNoPhaiTra CHỜ rồi CON_MAU_DINH_KY_NHAP_HANG", async () => {
    const mau = await mauDaDung("purchase");
    let daVao!: () => void;
    const vaoNhatKy = new Promise<void>((res) => (daVao = res));
    treNhatKy.hanhDong = "CHI_PHI_BAT_DINH_KY";
    treNhatKy.ms = 800;
    treNhatKy.daVao = daVao;

    const batLai = batLaiDinhKy(mau.id, { thangBatDau: "2026-09" });
    await vaoNhatKy; // mẫu đã bật trong transaction, chưa commit
    const t0 = performance.now();
    const bat = await xacNhanBatNoPhaiTra({ yeuCauId: randomUUID(), mocM: M, the: [], viAds: [], dieuChinh: [], vanTayQuy: VAN_TAY_BAT_KY });
    const ms = performance.now() - t0;

    expect(await batLai).toMatchObject({ ok: true });
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(bat).toMatchObject({ ok: false, code: "CON_MAU_DINH_KY_NHAP_HANG" });
    expect(await docM()).toBeNull();
    expect(await prisma.recurringExpense.findUniqueOrThrow({ where: { id: mau.id } })).toMatchObject({ active: true });
  });

  it("(7) đã bật với M giữa tháng (15/09) ⇒ bật lại mẫu Nhập hàng ngày 5 bị từ chối dù chọn tháng nào, bộ sinh không chèn; mẫu khác danh mục vẫn bật lại được", async () => {
    await prisma.setting.create({ data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: "2026-09-15" } });
    const nhapHang = await mauDaDung("purchase");
    for (const thangBatDau of ["2026-09", "2026-10"]) {
      expect(await batLaiDinhKy(nhapHang.id, { thangBatDau })).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA" });
    }
    expect(await prisma.recurringExpense.findUniqueOrThrow({ where: { id: nhapHang.id } })).toMatchObject({ active: false });

    const coDinh = await mauDaDung("fixed");
    expect(await batLaiDinhKy(coDinh.id, { thangBatDau: "2026-09" })).toMatchObject({ ok: true });

    // Lần phát sinh 05/09 < M: bật lại mà lọt thì bộ sinh chèn dòng trước M SAU khi đã bật ⇒ quỹ trước M bị trừ
    // thêm, lệch khỏi số dư thật mà điều chỉnh ngày bật đã chốt. Mẫu `fixed` bật lại "tháng này" (M cùng tháng)
    // cũng KHÔNG sinh lần 05/09 < M — bộ sinh bỏ qua và đếm; lần tháng sau sinh bình thường.
    expect(await ensureRecurringExpensesChiTiet(vn("2026-09-20"))).toEqual({ daTao: 0, boQuaNhapHang: 0, boQuaTruocM: 1 });
    expect(await prisma.expense.count({ where: { categoryId: "purchase" } })).toBe(0);
    expect(await prisma.expense.count({ where: { recurringId: coDinh.id } })).toBe(0);
  });
});

describe("Nhập hàng TRƯỚC M khoá sổ khi đã bật — đường ghi chờ bước bật rồi bị từ chối", () => {
  const nhapTruocM = () =>
    prisma.expense.create({
      data: { date: vn("2026-08-20"), categoryId: "purchase", amount: 4_000_000, description: "Nhập lô cũ", source: "MANUAL", channelId: null },
    });

  it("(8) deleteExpense dòng Nhập hàng 20/08 < M CHỜ bước bật commit rồi bị từ chối, dòng còn nguyên", async () => {
    const dong = await nhapTruocM();
    const { r, ms } = await trongLucBuocBatGiuKhoa(() => deleteExpense(dong.id, "only"));
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(r).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA" });
    expect(await prisma.expense.findUnique({ where: { id: dong.id } })).not.toBeNull();
    expect(await prisma.banGhiDaXoa.count()).toBe(0);
  });

  it("(9) updateExpense đổi số tiền dòng Nhập hàng 20/08 < M CHỜ bước bật rồi bị từ chối, số tiền giữ nguyên", async () => {
    const dong = await nhapTruocM();
    const { r, ms } = await trongLucBuocBatGiuKhoa(() =>
      updateExpense(dong.id, { date: vn("2026-08-20"), categoryId: "purchase", amount: 9_000_000, description: "Nhập lô cũ", channelId: null })
    );
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(r).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA" });
    expect((await prisma.expense.findUniqueOrThrow({ where: { id: dong.id } })).amount).toBe(4_000_000);
  });

  it("(10) ghiChiPhiNhapHang mọi phiếu 04–15/09 < M = 16/09 CHỜ bước bật rồi bị từ chối, không ghi dòng nào", async () => {
    const duyet = await duyetTatCa();
    expect(duyet.chon.length).toBeGreaterThan(0);
    const { r, ms } = await trongLucBuocBatGiuKhoa(() => ghiChiPhiNhapHang(duyet), "2026-09-16");
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(r).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA" });
    expect(await prisma.expense.count()).toBe(0);
  });
});

describe("danh mục cũ đọc LẠI sau khoá chung — dòng đổi sang Nhập hàng giữa lượt đọc và lượt ghi", () => {
  /**
   * Dòng 20/08 < M (`danhMuc`, 4tr); trả id + hàm chạy xen giữa: chờ action tới cửa khoá chung (đã đọc `existing`
   * ngoài transaction) rồi đổi dòng theo `doi` (mặc định: sang Nhập hàng).
   */
  async function dongBiDoiGiuaChung(
    danhMuc = "fixed",
    doi: { categoryId?: string; amount?: number; date?: Date } = { categoryId: "purchase" },
    ngayDau = "2026-08-20"
  ): Promise<{ id: string; giua: () => Promise<void> }> {
    const dong = await prisma.expense.create({
      data: { date: vn(ngayDau), categoryId: danhMuc, amount: 4_000_000, description: "Dòng sẽ đổi", source: "MANUAL", channelId: null },
    });
    const toiCuaKhoa = new Promise<void>((res) => (vaoKhoaChung.bao = res));
    const giua = async () => {
      await toiCuaKhoa;
      vaoKhoaChung.bao = null;
      await prisma.expense.update({ where: { id: dong.id }, data: doi });
    };
    return { id: dong.id, giua };
  }
  const dongBiDoiSangNhapHang = () => dongBiDoiGiuaChung();

  it("(11) updateExpense giữ danh mục cũ `fixed` trên form ⇒ sau khi bật commit bị từ chối, dòng vẫn là Nhập hàng", async () => {
    const { id, giua } = await dongBiDoiSangNhapHang();
    const { r } = await trongLucBuocBatGiuKhoa(
      () => updateExpense(id, { date: vn("2026-08-20"), categoryId: "fixed", amount: 9_000_000, description: "Dòng sẽ đổi", channelId: null }),
      M,
      giua
    );
    expect(r).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA" });
    expect(await prisma.expense.findUniqueOrThrow({ where: { id } })).toMatchObject({ categoryId: "purchase", amount: 4_000_000 });
  });

  it("(12) deleteExpense dòng đọc ngoài transaction là `fixed` ⇒ sau khi bật commit bị từ chối, dòng Nhập hàng còn", async () => {
    const { id, giua } = await dongBiDoiSangNhapHang();
    const { r } = await trongLucBuocBatGiuKhoa(() => deleteExpense(id, "only"), M, giua);
    expect(r).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA" });
    expect(await prisma.expense.findUnique({ where: { id } })).toMatchObject({ categoryId: "purchase" });
    expect(await prisma.banGhiDaXoa.count()).toBe(0);
  });

  it("(13) dòng Nhập hàng 4tr bị đổi thành 5tr giữa chừng, form U1 (4tr) chỉ đổi danh mục ⇒ sau khi bật commit bị từ chối, giữ 5tr", async () => {
    const { id, giua } = await dongBiDoiGiuaChung("purchase", { amount: 5_000_000 });
    const { r } = await trongLucBuocBatGiuKhoa(
      () => updateExpense(id, { date: vn("2026-08-20"), categoryId: "fixed", amount: 4_000_000, description: "Dòng sẽ đổi", channelId: null }),
      M,
      giua
    );
    expect(r).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA" });
    expect(await prisma.expense.findUniqueOrThrow({ where: { id } })).toMatchObject({ categoryId: "purchase", amount: 5_000_000 });
  });

  // (18)(19) NGÀY dòng cũ đọc lại sau khoá: dòng ≥ M bị dời về < M giữa chừng.
  const MOC = "2026-09-15";
  /** Dòng `fixed` 18/09 (≥ M); lượt khác dời nó về 05/09 (< M) khi CHƯA bật, trước khi action xin khoá chung. */
  const dongBiDoiVeTruocM = () => dongBiDoiGiuaChung("fixed", { date: vn("2026-09-05") }, "2026-09-18");

  it("(18) updateExpense mang ngày cũ 18/09 + đổi số tiền ⇒ sau khi bật commit bị từ chối, dòng vẫn 05/09 nguyên tiền", async () => {
    const { id, giua } = await dongBiDoiVeTruocM();
    const { r } = await trongLucBuocBatGiuKhoa(
      () => updateExpense(id, { date: vn("2026-09-18"), categoryId: "fixed", amount: 9_000_000, description: "Dòng sẽ đổi", channelId: null }),
      MOC,
      giua
    );
    expect(r).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA" });
    expect(await prisma.expense.findUniqueOrThrow({ where: { id } })).toMatchObject({ date: vn("2026-09-05"), amount: 4_000_000 });
  });

  it("(19) deleteExpense dòng đọc ngoài transaction là 18/09 ⇒ sau khi bật commit bị từ chối, dòng 05/09 còn nguyên", async () => {
    const { id, giua } = await dongBiDoiVeTruocM();
    const { r } = await trongLucBuocBatGiuKhoa(() => deleteExpense(id, "only"), MOC, giua);
    expect(r).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA" });
    expect(await prisma.expense.findUniqueOrThrow({ where: { id } })).toMatchObject({ date: vn("2026-09-05"), amount: 4_000_000 });
    expect(await prisma.banGhiDaXoa.count()).toBe(0);
  });
});

describe("sổ chi phí TRƯỚC M khoá mọi danh mục — đường ghi chờ bước bật rồi bị từ chối", () => {
  const coDinhTruocM = () =>
    prisma.expense.create({
      data: { date: vn("2026-08-20"), categoryId: "fixed", amount: 4_000_000, description: "Thuê kho T8", source: "MANUAL", channelId: null },
    });

  it("(14) updateExpense đổi số tiền dòng `fixed` 20/08 < M CHỜ bước bật commit rồi bị từ chối, số tiền giữ nguyên", async () => {
    const dong = await coDinhTruocM();
    const { r, ms } = await trongLucBuocBatGiuKhoa(() =>
      updateExpense(dong.id, { date: vn("2026-08-20"), categoryId: "fixed", amount: 9_000_000, description: "Thuê kho T8", channelId: null })
    );
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(r).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA" });
    expect((await prisma.expense.findUniqueOrThrow({ where: { id: dong.id } })).amount).toBe(4_000_000);
  });

  it("(15) createExpense `fixed` 20/08 < M CHỜ bước bật rồi bị từ chối ở ô Ngày, không ghi", async () => {
    const { r, ms } = await trongLucBuocBatGiuKhoa(() =>
      createExpense({ date: vn("2026-08-20"), categoryId: "fixed", amount: 4_000_000, description: "Thuê kho T8", channelId: null })
    );
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(r).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA", field: "date" });
    expect(await prisma.expense.count()).toBe(0);
  });

  it("(16) deleteExpense dòng `fixed` 20/08 < M CHỜ bước bật rồi bị từ chối, dòng còn, thùng rác trống", async () => {
    const dong = await coDinhTruocM();
    const { r, ms } = await trongLucBuocBatGiuKhoa(() => deleteExpense(dong.id, "only"));
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(r).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA" });
    expect(await prisma.expense.findUnique({ where: { id: dong.id } })).not.toBeNull();
    expect(await prisma.banGhiDaXoa.count()).toBe(0);
  });

  it("(17) bộ sinh mẫu `fixed` lần 20/08 < M CHỜ bước bật rồi không chèn, đếm bỏ qua trước M", async () => {
    await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: 1_000_000, dayOfMonth: 20, description: "Mặt bằng", active: true, activeFrom: vn("2026-08-01") },
    });
    const { r, ms } = await trongLucBuocBatGiuKhoa(() => ensureRecurringExpensesChiTiet(vn("2026-08-01")));
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(r).toEqual({ daTao: 0, boQuaNhapHang: 0, boQuaTruocM: 1 });
    expect(await prisma.expense.count()).toBe(0);
  });
});
