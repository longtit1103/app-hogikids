import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Dòng tiền ghi tay kind CŨ (tab Dòng tiền — `cash-movements.ts`) ngày < M bị khoá khi đã bật nợ phải trả, trên DB
 * thật (`hogikids_test`). M = 01/10/2026, hôm nay ghim 13/10/2026 (fake timer CHỈ `Date`).
 *
 * Bất biến: `Q(M−1) + Σ CUTOVER_net = hằng`. Dòng < M đã chốt vào điều chỉnh mở sổ ⇒ sau bật không thêm, xoá, đổi
 * ngày / tiền / loại / khoản gắn, không dời qua lại mốc M; chỉ sửa mô tả được qua. Đủ ba nhánh (dòng trơn, gắn
 * khoản vay, gắn sổ tiết kiệm) × tạo / sửa / xoá; chưa bật ⇒ như cũ.
 *
 * Khoá chung với bước bật: bước bật (giả lập: giữ EXCLUSIVE + ghi M chưa commit 0,8s) chạy trước ⇒ lượt ghi CHỜ
 * rồi đọc M mới ⇒ từ chối; dòng bị dời ngày giữa lượt đọc ngoài transaction và lượt giữ khoá ⇒ xét bản ĐỌC LẠI.
 */

/**
 * Bọc `khoaChiaSeBatNoPhaiTra` THẬT: `bao` báo hiệu ngay trước khi xin khoá (action đã đọc bản cũ ngoài
 * transaction); `hanNganMs` rút ngắn hạn chờ (cùng câu khoá SHARED) để thử ca hết hạn khỏi chờ 10s.
 */
const cheKhoa = vi.hoisted(() => ({ bao: null as (() => void) | null, hanNganMs: null as number | null }));
vi.mock("@/lib/no-phai-tra/cong-bat-no-phai-tra", async (goc) => {
  const that = await goc<typeof import("@/lib/no-phai-tra/cong-bat-no-phai-tra")>();
  const { khoaDongTienCoHan } = await import("@/lib/so-quy/khoa-dong-tien-co-han");
  return {
    ...that,
    khoaChiaSeBatNoPhaiTra: async (tx: Parameters<typeof that.khoaChiaSeBatNoPhaiTra>[0]) => {
      cheKhoa.bao?.();
      if (cheKhoa.hanNganMs === null) return that.khoaChiaSeBatNoPhaiTra(tx);
      await khoaDongTienCoHan(
        tx,
        [() => tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${that.KHOA_BAT_NO_PHAI_TRA}::text))`],
        cheKhoa.hanNganMs
      );
    },
  };
});
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => ({
  ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
  docNguoiDungPhien: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createCashMovement, deleteCashMovement, updateCashMovement } from "@/lib/actions/cash-movements";
import { cauDongTienTruocM } from "@/lib/no-phai-tra/chan-dong-tien-truoc-m";
import { KEY_NO_PHAI_TRA_TU_NGAY, KHOA_BAT_NO_PHAI_TRA } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { prisma } from "@/lib/prisma";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";
import { THONG_BAO_KHOA_DONG_TIEN_BAN } from "@/lib/so-quy/khoa-dong-tien-co-han";

import { nguoiDungGia } from "../../helpers/nguoi-dung-gia";
import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

const vn = (ngay: string, gio = "00:00:00") => new Date(`${ngay}T${gio}+07:00`);
const tr = (n: number) => Math.round(n * 1_000_000);
const M = "2026-10-01";
const TU_CHOI = { ok: false, code: "DA_BAT_NO_PHAI_TRA", field: "date", error: cauDongTienTruocM(vn(M)) };
/** Xoá không có ô Ngày ⇒ không `field`, câu rơi về toast. */
const TU_CHOI_XOA = { ok: false, code: "DA_BAT_NO_PHAI_TRA", error: cauDongTienTruocM(vn(M)) };

async function datM(ngay: string | null) {
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
  if (ngay) await prisma.setting.create({ data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: ngay } });
}

const dongTron = (date: string, ghiDe: Record<string, unknown> = {}) =>
  prisma.cashMovement.create({
    data: { date: vn(date), kind: "CAPITAL_IN", amount: tr(10), description: "Góp vốn", ...ghiDe },
  });

const form = (date: string, ghiDe: Record<string, unknown> = {}) => ({
  date: vn(date),
  kind: "CAPITAL_IN",
  amount: tr(10),
  description: "Góp vốn",
  ...ghiDe,
});

/** Ảnh tiền của cả bảng — so trước/sau lượt bị từ chối: không đổi một dòng. */
const anhDongTien = () =>
  prisma.cashMovement.findMany({
    select: { id: true, date: true, kind: true, amount: true, description: true, loanId: true, savingsId: true },
    orderBy: { id: "asc" },
  });

/**
 * Giả lập bước bật: giữ EXCLUSIVE + ghi Setting M (chưa commit) 0,8s rồi commit. `hanhDong` chạy giữa chừng; `giua`
 * chạy sau khi nó đã bắt đầu, TRƯỚC khi bước bật commit. Trả kết quả + thời gian `hanhDong` phải chờ.
 */
async function trongLucBuocBatGiuKhoa<T>(
  hanhDong: () => Promise<T>,
  giua?: () => Promise<void>
): Promise<{ r: T; ms: number }> {
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
  if (giua) await giua();
  await new Promise((res) => setTimeout(res, 800));
  tha();
  await buocBat;
  return p;
}

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await datM(null);
  vi.mocked(docNguoiDungPhien).mockResolvedValue(nguoiDungGia());
  cheKhoa.bao = null;
  cheKhoa.hanNganMs = null;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(vn("2026-10-13", "10:00:00"));
});

afterEach(async () => {
  vi.useRealTimers();
  cheKhoa.bao = null;
  cheKhoa.hanNganMs = null;
  await datM(null);
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

describe("chưa bật ⇒ dòng trước M ghi / sửa / xoá như cũ", () => {
  it("tạo 20/09, đổi số tiền, dời sang 05/10, xoá — đều qua", async () => {
    expect(await createCashMovement(form("2026-09-20"))).toEqual({ ok: true, data: undefined });
    const dong = await prisma.cashMovement.findFirstOrThrow();
    expect(await updateCashMovement(dong.id, form("2026-09-20", { amount: tr(12) }))).toEqual({ ok: true, data: undefined });
    expect(await updateCashMovement(dong.id, form("2026-10-05", { amount: tr(12) }))).toEqual({ ok: true, data: undefined });
    expect(await deleteCashMovement(dong.id)).toEqual({ ok: true, data: undefined });
    expect(await prisma.cashMovement.count()).toBe(0);
    expect(await prisma.banGhiDaXoa.count()).toBe(1);
  });
});

describe("đã bật — dòng trơn", () => {
  beforeEach(() => datM(M));

  it("tạo ngày 30/09 23:59 (< M) ⇒ từ chối ô Ngày, không ghi; đúng 01/10 00:00 ⇒ qua", async () => {
    expect(await createCashMovement(form("2026-09-30", { date: vn("2026-09-30", "23:59:59") }))).toEqual(TU_CHOI);
    expect(await prisma.cashMovement.count()).toBe(0);
    expect(await createCashMovement(form(M))).toEqual({ ok: true, data: undefined });
    expect(await prisma.cashMovement.count()).toBe(1);
  });

  it("tạo bán trực tiếp ngày < M ⇒ từ chối (đơn tại quầy trước M đã nằm trong điều chỉnh mở sổ)", async () => {
    expect(await createCashMovement(form("2026-09-25", { kind: "DIRECT_SALE" }))).toEqual(TU_CHOI);
    expect(await prisma.cashMovement.count()).toBe(0);
  });

  it("sửa dòng < M: đổi số tiền / đổi loại ⇒ từ chối, dòng nguyên vẹn; chỉ đổi mô tả (giờ khác, cùng ngày VN) ⇒ qua", async () => {
    const dong = await dongTron("2026-09-20");
    const truoc = await anhDongTien();
    expect(await updateCashMovement(dong.id, form("2026-09-20", { amount: tr(11) }))).toEqual(TU_CHOI);
    expect(await updateCashMovement(dong.id, form("2026-09-20", { kind: "OTHER_IN" }))).toEqual(TU_CHOI);
    expect(await anhDongTien()).toEqual(truoc);

    // Form gửi chuỗi "yyyy-MM-dd" ⇒ 07:00 giờ VN cùng ngày 20/09 — vẫn là sửa chỉ mô tả.
    expect(await updateCashMovement(dong.id, { ...form("2026-09-20"), date: "2026-09-20", description: "Góp vốn đợt 1" })).toEqual({
      ok: true,
      data: undefined,
    });
    expect(await prisma.cashMovement.findUniqueOrThrow({ where: { id: dong.id } })).toMatchObject({
      description: "Góp vốn đợt 1",
      amount: tr(10),
      kind: "CAPITAL_IN",
    });
  });

  it("dời ≥ M → < M và < M → ≥ M ⇒ từ chối; sửa tiền dòng ≥ M giữ ngày ≥ M ⇒ qua", async () => {
    const sau = await dongTron("2026-10-05");
    const truocM = await dongTron("2026-09-20");
    expect(await updateCashMovement(sau.id, form("2026-09-28"))).toEqual(TU_CHOI);
    expect(await updateCashMovement(truocM.id, form("2026-10-02"))).toEqual(TU_CHOI);
    expect(await prisma.cashMovement.findUniqueOrThrow({ where: { id: sau.id } })).toMatchObject({ date: vn("2026-10-05") });
    expect(await prisma.cashMovement.findUniqueOrThrow({ where: { id: truocM.id } })).toMatchObject({ date: vn("2026-09-20") });

    expect(await updateCashMovement(sau.id, form("2026-10-06", { amount: tr(15) }))).toEqual({ ok: true, data: undefined });
    expect(await prisma.cashMovement.findUniqueOrThrow({ where: { id: sau.id } })).toMatchObject({ amount: tr(15) });
  });

  it("xoá dòng < M ⇒ từ chối (toast), dòng còn, thùng rác trống, nhật ký LOI mang mã; xoá dòng ≥ M ⇒ qua", async () => {
    const truocM = await dongTron("2026-09-20");
    const sau = await dongTron("2026-10-05");
    expect(await deleteCashMovement(truocM.id)).toEqual(TU_CHOI_XOA);
    expect(await prisma.cashMovement.count({ where: { id: truocM.id } })).toBe(1);
    expect(await prisma.banGhiDaXoa.count()).toBe(0);
    const loi = await prisma.auditLog.findFirstOrThrow({ where: { hanhDong: "DONG_TIEN_XOA", ketQua: "LOI", doiTuongId: truocM.id } });
    expect(loi.ghiChu).toMatchObject({ lyDo: "DA_BAT_NO_PHAI_TRA" });

    expect(await deleteCashMovement(sau.id)).toEqual({ ok: true, data: undefined });
    expect(await prisma.banGhiDaXoa.count()).toBe(1);
  });
});

describe("đã bật — dòng gắn khoản vay / sổ tiết kiệm", () => {
  let loanId = "";
  let savingsId = "";
  let giaiNganId = "";
  let guiId = "";

  beforeEach(async () => {
    loanId = (
      await prisma.loan.create({
        data: {
          name: "Vay VPBank",
          startDate: vn("2026-09-20"),
          annualRateBp: 1050,
          termMonths: 12,
          firstDueDate: vn("2026-10-20"),
        },
      })
    ).id;
    giaiNganId = (await dongTron("2026-09-20", { kind: "LOAN_IN", amount: tr(100), description: "Giải ngân", loanId })).id;
    savingsId = (
      await prisma.soTietKiem.create({
        data: {
          name: "Sổ 6 tháng",
          bank: "VCB",
          principal: tr(50),
          startDate: vn("2026-09-20"),
          termMonths: 6,
          maturityDate: vn("2027-03-20"),
          annualRateBp: 520,
        },
      })
    ).id;
    guiId = (await dongTron("2026-09-20", { kind: "SAVINGS_OUT", amount: tr(50), description: "Gửi", savingsId })).id;
    await datM(M);
  });

  const traGoc = (date: string, amount = tr(10)) => form(date, { kind: "LOAN_REPAY", amount, description: "Trả gốc", loanId });

  it("tạo trả gốc 25/09 ⇒ từ chối; 05/10 ⇒ qua", async () => {
    expect(await createCashMovement(traGoc("2026-09-25"))).toEqual(TU_CHOI);
    expect(await prisma.cashMovement.count({ where: { kind: "LOAN_REPAY" } })).toBe(0);
    expect(await createCashMovement(traGoc("2026-10-05"))).toEqual({ ok: true, data: undefined });
  });

  it("giải ngân 20/09: đổi số tiền ⇒ từ chối; gỡ khỏi khoản vay (đổi loại) ⇒ từ chối; chỉ đổi mô tả ⇒ qua", async () => {
    const truoc = await anhDongTien();
    expect(
      await updateCashMovement(giaiNganId, form("2026-09-20", { kind: "LOAN_IN", amount: tr(90), description: "Giải ngân", loanId }))
    ).toEqual(TU_CHOI);
    expect(await updateCashMovement(giaiNganId, form("2026-09-20", { amount: tr(100), description: "Giải ngân" }))).toEqual(TU_CHOI);
    expect(await anhDongTien()).toEqual(truoc);

    expect(
      await updateCashMovement(
        giaiNganId,
        form("2026-09-20", { kind: "LOAN_IN", amount: tr(100), description: "Giải ngân VPBank", loanId })
      )
    ).toEqual({ ok: true, data: undefined });
    expect(await prisma.cashMovement.findUniqueOrThrow({ where: { id: giaiNganId } })).toMatchObject({
      description: "Giải ngân VPBank",
      amount: tr(100),
    });
  });

  it("trả gốc 05/10 dời về 25/09 ⇒ từ chối, giữ 05/10", async () => {
    await createCashMovement(traGoc("2026-10-05"));
    const tra = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "LOAN_REPAY" } });
    expect(await updateCashMovement(tra.id, traGoc("2026-09-25"))).toEqual(TU_CHOI);
    expect(await prisma.cashMovement.findUniqueOrThrow({ where: { id: tra.id } })).toMatchObject({ date: vn("2026-10-05") });
  });

  it("xoá giải ngân 20/09 / dòng gửi tiết kiệm 20/09 ⇒ từ chối, thùng rác trống", async () => {
    expect(await deleteCashMovement(giaiNganId)).toEqual(TU_CHOI_XOA);
    expect(await deleteCashMovement(guiId)).toEqual(TU_CHOI_XOA);
    expect(await prisma.cashMovement.count({ where: { id: { in: [giaiNganId, guiId] } } })).toBe(2);
    expect(await prisma.banGhiDaXoa.count()).toBe(0);
  });

  it("nhận lại tiền tiết kiệm 25/09 ⇒ từ chối; 05/10 ⇒ qua", async () => {
    const nhan = (date: string) => form(date, { kind: "SAVINGS_IN", amount: tr(5), description: "Rút", savingsId });
    expect(await createCashMovement(nhan("2026-09-25"))).toEqual(TU_CHOI);
    expect(await createCashMovement(nhan("2026-10-05"))).toEqual({ ok: true, data: undefined });
    expect(await prisma.cashMovement.count({ where: { kind: "SAVINGS_IN" } })).toBe(1);
  });
});

describe("đua với bước bật đang giữ khoá EXCLUSIVE", () => {
  it("tạo dòng trơn 20/09 CHỜ bước bật commit rồi bị từ chối; dòng 05/10 chờ rồi qua", async () => {
    const { r, ms } = await trongLucBuocBatGiuKhoa(() => createCashMovement(form("2026-09-20")));
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(r).toEqual(TU_CHOI);
    expect(await prisma.cashMovement.count()).toBe(0);

    await datM(null);
    const sau = await trongLucBuocBatGiuKhoa(() => createCashMovement(form("2026-10-05")));
    expect(sau.ms).toBeGreaterThanOrEqual(700);
    expect(sau.r).toEqual({ ok: true, data: undefined });
  });

  it("sửa số tiền dòng trơn 20/09 CHỜ bước bật rồi bị từ chối, số tiền giữ nguyên", async () => {
    const dong = await dongTron("2026-09-20");
    const { r, ms } = await trongLucBuocBatGiuKhoa(() => updateCashMovement(dong.id, form("2026-09-20", { amount: tr(20) })));
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(r).toEqual(TU_CHOI);
    expect((await prisma.cashMovement.findUniqueOrThrow({ where: { id: dong.id } })).amount).toBe(tr(10));
  });

  it("xoá giải ngân 20/09 (nhánh khoản vay) CHỜ bước bật rồi bị từ chối, thùng rác trống", async () => {
    const loanId = (
      await prisma.loan.create({
        data: { name: "Vay", startDate: vn("2026-09-20"), annualRateBp: 1050, termMonths: 12, firstDueDate: vn("2026-10-20") },
      })
    ).id;
    const dong = await dongTron("2026-09-20", { kind: "LOAN_IN", amount: tr(100), loanId });
    const { r, ms } = await trongLucBuocBatGiuKhoa(() => deleteCashMovement(dong.id));
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(r).toEqual(TU_CHOI_XOA);
    expect(await prisma.cashMovement.count({ where: { id: dong.id } })).toBe(1);
    expect(await prisma.banGhiDaXoa.count()).toBe(0);
  });

  /** Dòng 05/10 (≥ M); lượt khác dời nó về 20/09 (< M, lúc chưa bật) ngay trước khi action xin khoá chung. */
  async function dongBiDoiVeTruocM(): Promise<{ id: string; giua: () => Promise<void> }> {
    const dong = await dongTron("2026-10-05");
    const toiCuaKhoa = new Promise<void>((res) => (cheKhoa.bao = res));
    const giua = async () => {
      await toiCuaKhoa;
      cheKhoa.bao = null;
      await prisma.cashMovement.update({ where: { id: dong.id }, data: { date: vn("2026-09-20") } });
    };
    return { id: dong.id, giua };
  }

  it("sửa: form mang ngày cũ 05/10 + đổi số tiền, dòng vừa bị dời về 20/09 ⇒ xét bản đọc lại ⇒ từ chối", async () => {
    const { id, giua } = await dongBiDoiVeTruocM();
    const { r } = await trongLucBuocBatGiuKhoa(() => updateCashMovement(id, form("2026-10-05", { amount: tr(30) })), giua);
    expect(r).toEqual(TU_CHOI);
    expect(await prisma.cashMovement.findUniqueOrThrow({ where: { id } })).toMatchObject({ date: vn("2026-09-20"), amount: tr(10) });
  });

  it("xoá: dòng đọc ngoài transaction là 05/10 nhưng vừa bị dời về 20/09 ⇒ từ chối, dòng còn", async () => {
    const { id, giua } = await dongBiDoiVeTruocM();
    const { r } = await trongLucBuocBatGiuKhoa(() => deleteCashMovement(id), giua);
    expect(r).toEqual(TU_CHOI_XOA);
    expect(await prisma.cashMovement.count({ where: { id } })).toBe(1);
    expect(await prisma.banGhiDaXoa.count()).toBe(0);
  });

  it("bước bật giữ khoá quá hạn chờ ⇒ báo bận, không ghi", async () => {
    cheKhoa.hanNganMs = 300;
    const { r } = await trongLucBuocBatGiuKhoa(() => createCashMovement(form("2026-10-05")));
    expect(r).toEqual({ ok: false, error: THONG_BAO_KHOA_DONG_TIEN_BAN });
    expect(await prisma.cashMovement.count()).toBe(0);
  });
});
