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
 * M = 01/09/2026; hôm nay ghim 20/09/2026 (fake timer chỉ `Date` — setTimeout/performance thật). Phiếu nhập
 * Bronze là fixture thật 04–15/09 (cùng fixture `tests/nhap-hang/chi-phi-nhap-hang.integration.test.ts`).
 */

/** Ca (4): giữ transaction của `ghiChiPhiNhapHang` mở thêm `ms` sau câu nhật ký (đã chèn, chưa commit). */
const treNhatKy = vi.hoisted(() => ({ hanhDong: null as string | null, ms: 0, daVao: null as (() => void) | null }));

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
import { createExpense } from "@/lib/actions/expenses";
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
async function trongLucBuocBatGiuKhoa<T>(hanhDong: () => Promise<T>): Promise<{ r: T; ms: number }> {
  let tha!: () => void;
  const cho = new Promise<void>((res) => (tha = res));
  let daGiu!: () => void;
  const giuXong = new Promise<void>((res) => (daGiu = res));
  const buocBat = prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${KHOA_BAT_NO_PHAI_TRA}::text))`;
      await tx.setting.create({ data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: M } });
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
    expect(r).toEqual({ daTao: 0, boQuaNhapHang: 1 });
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
    const bat = await xacNhanBatNoPhaiTra({ yeuCauId: randomUUID(), mocM: M, the: [], viAds: [], dieuChinh: [] });
    const ms = performance.now() - t0;

    expect(await ghi).toMatchObject({ ok: true, data: { daGhi: duyet.chon.length } });
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(bat).toMatchObject({ ok: false, code: "CON_NHAP_HANG_SAU_M" });
    expect(await docM()).toBeNull();
    expect(await prisma.expense.count({ where: { categoryId: "purchase" } })).toBe(duyet.chon.length);
  });
});
