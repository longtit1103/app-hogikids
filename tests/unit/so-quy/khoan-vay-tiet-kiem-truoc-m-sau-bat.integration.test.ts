import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * KHOÁ TIỀN TRƯỚC M ở khoản vay / thấu chi / sổ tiết kiệm khi đã bật nợ phải trả — DB thật (`hogikids_test`).
 *
 * Bất biến cần giữ: quỹ cuối M−1 (cộng điều chỉnh mở sổ đã chốt lúc bật) không đổi sau bật. Mọi lượt ghi/xoá
 * dòng tiền ngày < M ở các đường này phải trả `DA_BAT_NO_PHAI_TRA` và DB không đổi một dòng; ngày ≥ M qua như cũ;
 * chưa bật thì không có gì đổi. Riêng:
 *  - duyệt kỳ vay đến hạn < M: CHỈ "Ngân hàng không thu kỳ này" (không tiền) còn đóng được kỳ;
 *  - thấu chi có ngày rút < M: đã được đối chiếu lúc bật (sửa/xoá/khai lại làm dư nợ và quỹ lệch) ⇒ chặn tạo (kể cả mang
 *    sang, không dòng tiền nào), sửa dư nợ / ngày rút, xoá;
 *  - ca đua: bước bật (giữ khoá EXCLUSIVE + Setting M chưa commit) chạy trước ⇒ đường ghi CHỜ rồi đọc M mới ⇒ từ
 *    chối. Bỏ khoá chung thì đường ghi đọc M = null và ghi dòng < M sau lưng bước bật.
 *
 * M = 01/10/2026; "hôm nay" 20/10/2026 (fake timer chỉ `Date` — setTimeout/performance thật).
 */
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => {
  const { nguoiDungGia } = await import("../../helpers/nguoi-dung-gia");
  return {
    ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
    docNguoiDungPhien: vi.fn(async () => nguoiDungGia()),
  };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { ghiKyTraNo, suaKhoanVay, taoKhoanVay, tatToanKhoanVay, xoaKhoanVay } from "@/lib/actions/khoan-vay";
import { suaSoTietKiem, taoSoTietKiem, xoaSoTietKiem } from "@/lib/actions/so-tiet-kiem";
import { moLaiSoTietKiem, tatToanSoTietKiem } from "@/lib/actions/tat-toan-so-tiet-kiem";
import { tatToanThauChi } from "@/lib/actions/tat-toan-thau-chi";
import { KEY_NO_PHAI_TRA_TU_NGAY, KHOA_BAT_NO_PHAI_TRA } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { prisma } from "@/lib/prisma";

import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

const M = "2026-10-01";
const vn = (ngay: string) => new Date(`${ngay}T00:00:00+07:00`);

const batM = () =>
  prisma.setting.upsert({
    where: { key: KEY_NO_PHAI_TRA_TU_NGAY },
    create: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: M },
    update: { value: M },
  });

/** Toàn bộ dòng của các bảng tiền + hồ sơ — so trước/sau lượt bị từ chối: phải bằng nhau tuyệt đối. */
async function anhDb() {
  const [loans, dongTien, chiPhi, thuNhap, so, thungRac] = await Promise.all([
    prisma.loan.findMany({ orderBy: { id: "asc" } }),
    prisma.cashMovement.findMany({ orderBy: { id: "asc" } }),
    prisma.expense.findMany({ orderBy: { id: "asc" } }),
    prisma.thuNhap.findMany({ orderBy: { id: "asc" } }),
    prisma.soTietKiem.findMany({ orderBy: { id: "asc" } }),
    prisma.banGhiDaXoa.count(),
  ]);
  return { loans, dongTien, chiPhi, thuNhap, so, thungRac };
}

/** Chạy `hanhDong`, đòi bị từ chối `DA_BAT_NO_PHAI_TRA` (+ field nếu có) và DB không đổi một dòng. */
async function phaiBiChan(
  hanhDong: () => Promise<unknown>,
  mong: { field?: string; cauChua?: string } = {}
): Promise<void> {
  const truoc = await anhDb();
  const r = (await hanhDong()) as { ok: boolean; code?: string; field?: string; error?: string };
  expect(r).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA", ...(mong.field ? { field: mong.field } : {}) });
  if (mong.cauChua) expect(r.error).toContain(mong.cauChua);
  expect(await anhDb()).toEqual(truoc);
}

function idCua(r: { ok: boolean; data?: unknown; error?: string }): string {
  if (!r.ok) throw new Error(r.error);
  return (r.data as { id: string }).id;
}

// ---------- khuôn khoản vay ----------

/** Vay kỳ hạn mang sang: dư nợ 120tr, mốc 15/08, kỳ đầu 15/09 ⇒ hôm nay 20/10 có kỳ 15/09 và 15/10 tới hạn. */
const VAY_MANG_SANG = {
  name: "Vay VPBank",
  lender: "VPBank",
  annualRateBp: 1050,
  kind: "TERM",
  coLich: true,
  termMonths: 12,
  firstDueDate: "2026-09-15",
  cheDo: "mang-sang",
  duNoMoSo: 120_000_000,
  startDate: "2026-08-15",
  note: "",
};

/** Vay kỳ hạn mới, không lịch — chỉ để thử dòng `LOAN_IN`. */
const vayMoi = (ngayGiaiNgan: string, soTienGiaiNgan = 50_000_000) => ({
  name: "Vay mới",
  lender: "ACB",
  annualRateBp: 1000,
  kind: "TERM",
  coLich: false,
  cheDo: "moi",
  soTienGiaiNgan,
  ngayGiaiNgan,
  note: "",
});

const thauChiMoi = (ngayGiaiNgan: string) => ({
  name: "Thấu chi MB",
  lender: "MB",
  annualRateBp: 1200,
  kind: "OVERDRAFT",
  coLich: false,
  cheDo: "moi",
  soTienGiaiNgan: 100_000_000,
  ngayGiaiNgan,
  note: "",
});

const thauChiMangSang = (startDate: string, duNoMoSo = 50_000_000) => ({
  name: "Thấu chi mang sang",
  lender: "MB",
  annualRateBp: 1200,
  kind: "OVERDRAFT",
  coLich: false,
  cheDo: "mang-sang",
  duNoMoSo,
  startDate,
  note: "",
});

// ---------- khuôn sổ tiết kiệm ----------

const so = (startDate: string) => ({
  name: "Sổ 6 tháng VCB",
  bank: "Vietcombank",
  principal: 200_000_000,
  startDate,
  termMonths: 6,
  maturityDate: "2027-03-05",
  annualRateBp: 520,
  note: "",
});

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

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 20, 10, 0, 0));
});

afterEach(async () => {
  vi.useRealTimers();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

describe("duyệt kỳ trả nợ khi đã bật", () => {
  it("kỳ 15/09 < M: ghi tiền bị chặn (không Expense lãi, không dòng gốc, con dấu không đóng); 'không thu kỳ này' qua; kỳ 15/10 ghi bình thường", async () => {
    const loanId = idCua(await taoKhoanVay(VAY_MANG_SANG));
    await batM();

    await phaiBiChan(() => ghiKyTraNo({ loanId, dueDate: "2026-09-15", lai: 1_000_000, goc: 10_000_000 }), {
      cauChua: "Ngân hàng không thu kỳ này",
    });
    expect((await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })).lastDueHandled).toBeNull();

    // "Ngân hàng không thu kỳ này": chỉ đóng dấu + để vết, KHÔNG một đồng nào ⇒ vẫn được.
    expect(await ghiKyTraNo({ loanId, dueDate: "2026-09-15", lai: 0, goc: 0, boQua: true })).toMatchObject({ ok: true });
    expect((await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })).lastDueHandled).toEqual(vn("2026-09-15"));
    expect(await prisma.cashMovement.count()).toBe(0);
    expect(await prisma.expense.count()).toBe(0);

    expect(await ghiKyTraNo({ loanId, dueDate: "2026-10-15", lai: 1_000_000, goc: 10_000_000 })).toMatchObject({ ok: true });
    expect(await prisma.cashMovement.findMany({ select: { kind: true, amount: true, date: true } })).toEqual([
      { kind: "LOAN_REPAY", amount: 10_000_000, date: vn("2026-10-15") },
    ]);
    expect(await prisma.expense.findMany({ select: { categoryId: true, amount: true, date: true } })).toEqual([
      { categoryId: "interest", amount: 1_000_000, date: vn("2026-10-15") },
    ]);
  });
});

describe("tạo / sửa / xoá / tất toán khoản vay khi đã bật", () => {
  it("tạo khoản 'mới' giải ngân 20/09 < M bị chặn ở ô ngày, gợi ý 'mang sang'; 'mang sang' 20/09 qua (0 LOAN_IN); 'mới' 05/10 qua", async () => {
    await batM();
    await phaiBiChan(() => taoKhoanVay(vayMoi("2026-09-20")), { field: "ngayGiaiNgan", cauChua: "mang sang" });

    idCua(await taoKhoanVay({ ...VAY_MANG_SANG, startDate: "2026-09-20", firstDueDate: "2026-10-20" }));
    expect(await prisma.cashMovement.count()).toBe(0);

    // 'Mang sang' ngày ≥ M: tiền giải ngân đó vào tài khoản SAU mốc, không nằm trong số dư mở sổ ⇒ khai 'mang sang'
    // (không LOAN_IN) là quỹ thấp hơn tiền thật đúng số giải ngân.
    await phaiBiChan(
      () => taoKhoanVay({ ...VAY_MANG_SANG, startDate: "2026-10-05", firstDueDate: "2026-11-05" }),
      { field: "startDate", cauChua: 'chế độ "mới"' }
    );
    await phaiBiChan(
      () => taoKhoanVay({ ...VAY_MANG_SANG, startDate: M, firstDueDate: "2026-11-01" }),
      { field: "startDate", cauChua: 'chế độ "mới"' }
    );

    const id = idCua(await taoKhoanVay(vayMoi("2026-10-05")));
    expect(await prisma.cashMovement.findMany({ where: { loanId: id }, select: { kind: true, date: true } })).toEqual([
      { kind: "LOAN_IN", date: vn("2026-10-05") },
    ]);
  });

  it("sửa khoản 'mới' có LOAN_IN 05/09 < M: đổi số tiền bị chặn; đổi tên qua. LOAN_IN 05/10 dời về 20/09 bị chặn", async () => {
    const cu = idCua(await taoKhoanVay(vayMoi("2026-09-05")));
    const moi = idCua(await taoKhoanVay(vayMoi("2026-10-05")));
    await batM();

    await phaiBiChan(() => suaKhoanVay(cu, vayMoi("2026-09-05", 60_000_000)), { field: "soTienGiaiNgan" });
    expect(await suaKhoanVay(cu, { ...vayMoi("2026-09-05"), name: "Vay mới (đổi tên)" })).toMatchObject({ ok: true });

    await phaiBiChan(() => suaKhoanVay(moi, vayMoi("2026-09-20")), { field: "ngayGiaiNgan" });
    // ≥ M → ≥ M đổi số tiền: qua như cũ.
    expect(await suaKhoanVay(moi, vayMoi("2026-10-06", 70_000_000))).toMatchObject({ ok: true });
  });

  it("xoá khoản có LOAN_IN 05/09 < M bị chặn (thùng rác trống); LOAN_IN 05/10 xoá được", async () => {
    const cu = idCua(await taoKhoanVay(vayMoi("2026-09-05")));
    const moi = idCua(await taoKhoanVay(vayMoi("2026-10-05")));
    await batM();

    await phaiBiChan(() => xoaKhoanVay(cu));
    expect(await xoaKhoanVay(moi)).toMatchObject({ ok: true });
    expect(await prisma.loan.count()).toBe(1);
  });

  it("tất toán khoản có tiền gửi bắt buộc (trả gốc sớm, kỳ cuối = M): ngày 20/09 < M bị chặn, câu KHÔNG gợi ý chọn ngày từ ngày bật; 02/10 qua", async () => {
    // Kỳ cuối 01/10 = M: ngân hàng hoàn tiền gửi từ M trở đi ⇒ tất toán sau bật đề ngày ≥ M là đúng. (Kỳ cuối < M
    // thì bước bật thật đã đòi tất toán trước — `CON_TIEN_GUI_CHUA_TAT_TOAN_TRUOC_M`.)
    const id = idCua(
      await taoKhoanVay({
        name: "Vay NH Chính sách",
        lender: "NHCS",
        annualRateBp: 1050,
        kind: "BULLET",
        coLich: true,
        termMonths: 3,
        firstDueDate: "2026-08-01",
        cheDo: "moi",
        soTienGiaiNgan: 10_000_000,
        ngayGiaiNgan: "2026-06-01",
        laiCoDinhMoiKy: 100_000,
        tienGuiBatBuocMoiKy: 300_000,
        note: "",
      })
    );
    // Dựng thẳng trạng thái "đã trả hết gốc, ngân hàng còn giữ 300k" (đường ghi kỳ đã có test riêng).
    await prisma.cashMovement.createMany({
      data: [
        { date: vn("2026-09-15"), kind: "LOAN_REPAY", amount: 10_000_000, loanId: id, description: "Trả gốc" },
        { date: vn("2026-09-15"), kind: "DEPOSIT_OUT", amount: 300_000, loanId: id, description: "Gửi bắt buộc" },
      ],
    });
    await batM();

    const r = await tatToanKhoanVay(id, { ngayTatToan: "2026-09-20" });
    expect(r).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA", field: "ngayTatToan" });
    const cau = (r as { error?: string }).error ?? "";
    expect(cau).toContain("đã nằm trong số dư mở sổ");
    expect(cau).toContain("KHÔNG tất toán lại với ngày từ ngày bật trở đi");
    expect(cau).toContain("phải làm TRƯỚC khi bật");
    expect(cau).not.toContain("Ngày tất toán phải từ ngày bật");
    await phaiBiChan(() => tatToanKhoanVay(id, { ngayTatToan: "2026-09-20" }), { field: "ngayTatToan" });
    expect(await tatToanKhoanVay(id, { ngayTatToan: "2026-10-02" })).toMatchObject({ ok: true });
    expect(await prisma.cashMovement.findFirst({ where: { kind: "DEPOSIT_IN" }, select: { amount: true, date: true } })).toEqual({
      amount: 300_000,
      date: vn("2026-10-02"),
    });
  });

  it("tất toán khoản KHÔNG tiền gửi đề ngày < M vẫn qua — lượt này không ghi đồng nào", async () => {
    const id = idCua(await taoKhoanVay(vayMoi("2026-06-01", 10_000_000)));
    await prisma.cashMovement.create({
      data: { date: vn("2026-09-15"), kind: "LOAN_REPAY", amount: 10_000_000, loanId: id, description: "Trả hết" },
    });
    await batM();
    const truoc = await prisma.cashMovement.count();
    expect(await tatToanKhoanVay(id, { ngayTatToan: "2026-09-20" })).toMatchObject({ ok: true });
    expect(await prisma.cashMovement.count()).toBe(truoc);
  });
});

describe("thấu chi khi đã bật", () => {
  it("tất toán ngày 30/09 < M bị chặn (không lãi, không trả gốc, khoản còn mở); 01/10 qua", async () => {
    const loanId = idCua(await taoKhoanVay(thauChiMoi("2026-09-05")));
    await batM();

    await phaiBiChan(
      () => tatToanThauChi({ loanId, ngayTatToan: "2026-09-30", lai: 900_000, conDauDaThay: null }),
      { field: "ngayTatToan", cauChua: "Ngày tất toán phải từ ngày bật" }
    );
    expect(await tatToanThauChi({ loanId, ngayTatToan: "2026-10-01", lai: 900_000, conDauDaThay: null })).toMatchObject({
      ok: true,
      data: { lai: 900_000, goc: 100_000_000 },
    });
    expect(await prisma.cashMovement.findFirst({ where: { kind: "LOAN_REPAY" }, select: { date: true } })).toEqual({
      date: vn("2026-10-01"),
    });
  });

  it("tạo thấu chi ngày rút < M bị chặn ở CẢ HAI chế độ (mang sang không có dòng tiền vẫn chặn); ≥ M chỉ chế độ 'mới' qua", async () => {
    await batM();
    await phaiBiChan(() => taoKhoanVay(thauChiMangSang("2026-09-20")), { field: "startDate", cauChua: "Thấu chi" });
    await phaiBiChan(() => taoKhoanVay(thauChiMoi("2026-09-20")), { field: "ngayGiaiNgan", cauChua: "Thấu chi" });
    await phaiBiChan(() => taoKhoanVay(thauChiMangSang("2026-10-02")), { field: "startDate", cauChua: 'chế độ "mới"' });

    idCua(await taoKhoanVay(thauChiMoi("2026-10-02")));
    expect(await prisma.loan.count()).toBe(1);
  });

  it("thấu chi mang sang rút 01/09 < M: sửa dư nợ / ngày rút bị chặn, xoá bị chặn; sửa tên qua", async () => {
    const id = idCua(await taoKhoanVay(thauChiMangSang("2026-09-01")));
    await batM();

    await phaiBiChan(() => suaKhoanVay(id, thauChiMangSang("2026-09-01", 60_000_000)), { field: "duNoMoSo" });
    await phaiBiChan(() => suaKhoanVay(id, thauChiMangSang("2026-10-05")), { field: "startDate" });
    await phaiBiChan(() => xoaKhoanVay(id), { cauChua: "Thấu chi" });

    expect(await suaKhoanVay(id, { ...thauChiMangSang("2026-09-01"), name: "Thấu chi MB (đổi tên)" })).toMatchObject({ ok: true });
  });

  it("thấu chi mang sang rút 02/10 ≥ M (khai trước khi bật): dời ngày rút về 20/09 < M hay sang 05/10 bị chặn; đổi dư nợ giữ ngày qua", async () => {
    const id = idCua(await taoKhoanVay(thauChiMangSang("2026-10-02")));
    await batM();

    await phaiBiChan(() => suaKhoanVay(id, thauChiMangSang("2026-09-20")), { field: "startDate" });
    await phaiBiChan(() => suaKhoanVay(id, thauChiMangSang("2026-10-05")), {
      field: "startDate",
      cauChua: 'chế độ "mới"',
    });
    expect(await suaKhoanVay(id, thauChiMangSang("2026-10-02", 70_000_000))).toMatchObject({ ok: true });
  });

  it("vay kỳ hạn mang sang 20/09 < M: dời ngày bắt đầu sang 05/10 ≥ M bị chặn; giữ ngày < M đổi dư nợ qua", async () => {
    const id = idCua(await taoKhoanVay({ ...VAY_MANG_SANG, startDate: "2026-09-20", firstDueDate: "2026-11-20" }));
    await batM();

    await phaiBiChan(
      () => suaKhoanVay(id, { ...VAY_MANG_SANG, startDate: "2026-10-05", firstDueDate: "2026-11-20" }),
      { field: "startDate", cauChua: 'chế độ "mới"' }
    );
    expect(
      await suaKhoanVay(id, { ...VAY_MANG_SANG, duNoMoSo: 110_000_000, startDate: "2026-09-20", firstDueDate: "2026-11-20" })
    ).toMatchObject({ ok: true });
  });
});

describe("sổ tiết kiệm khi đã bật", () => {
  it("tạo sổ gửi 20/09 < M bị chặn ở ô ngày gửi; 02/10 qua", async () => {
    await batM();
    await phaiBiChan(() => taoSoTietKiem(so("2026-09-20")), { field: "startDate" });
    idCua(await taoSoTietKiem(so("2026-10-02")));
    expect(await prisma.cashMovement.count({ where: { kind: "SAVINGS_OUT" } })).toBe(1);
  });

  it("sổ gửi 05/09 < M: đổi số tiền / dời ngày sang ≥ M bị chặn, đổi tên qua; sổ gửi 02/10 dời về 20/09 bị chặn", async () => {
    const cu = idCua(await taoSoTietKiem(so("2026-09-05")));
    const moi = idCua(await taoSoTietKiem(so("2026-10-02")));
    await batM();

    await phaiBiChan(() => suaSoTietKiem({ ...so("2026-09-05"), id: cu, principal: 250_000_000 }), { field: "startDate" });
    await phaiBiChan(() => suaSoTietKiem({ ...so("2026-10-05"), id: cu }), { field: "startDate" });
    expect(await suaSoTietKiem({ ...so("2026-09-05"), id: cu, name: "Sổ VCB (đổi tên)" })).toMatchObject({ ok: true });

    await phaiBiChan(() => suaSoTietKiem({ ...so("2026-09-20"), id: moi }), { field: "startDate" });
    expect(await suaSoTietKiem({ ...so("2026-10-03"), id: moi, principal: 210_000_000 })).toMatchObject({ ok: true });
  });

  it("xoá sổ gửi 05/09 < M bị chặn (thùng rác trống); sổ gửi 02/10 xoá được", async () => {
    const cu = idCua(await taoSoTietKiem(so("2026-09-05")));
    const moi = idCua(await taoSoTietKiem(so("2026-10-02")));
    await batM();

    await phaiBiChan(() => xoaSoTietKiem({ id: cu }));
    expect(await xoaSoTietKiem({ id: moi })).toMatchObject({ ok: true });
  });

  it("tất toán đề 30/09 < M bị chặn (không SAVINGS_IN, không lãi, sổ còn mở); 05/10 qua", async () => {
    const id = idCua(await taoSoTietKiem(so("2026-09-05")));
    await batM();

    await phaiBiChan(() => tatToanSoTietKiem({ id, ngayTatToan: "2026-09-30", lai: 1_000_000 }), {
      field: "ngayTatToan",
    });
    expect(await tatToanSoTietKiem({ id, ngayTatToan: "2026-10-05", lai: 1_000_000 })).toMatchObject({ ok: true });
    expect(await prisma.thuNhap.findFirst({ select: { amount: true, date: true } })).toEqual({
      amount: 1_000_000,
      date: vn("2026-10-05"),
    });
  });

  it("mở lại sổ tất toán 25/09 < M bị chặn (dòng nhận gốc + lãi còn nguyên); sổ tất toán 05/10 mở lại được", async () => {
    const cu = idCua(await taoSoTietKiem(so("2026-09-05")));
    expect(await tatToanSoTietKiem({ id: cu, ngayTatToan: "2026-09-25", lai: 500_000 })).toMatchObject({ ok: true });
    const moi = idCua(await taoSoTietKiem(so("2026-09-06")));
    await batM();
    expect(await tatToanSoTietKiem({ id: moi, ngayTatToan: "2026-10-05", lai: 600_000 })).toMatchObject({ ok: true });

    await phaiBiChan(() => moLaiSoTietKiem({ id: cu }));
    expect(await moLaiSoTietKiem({ id: moi })).toMatchObject({ ok: true });
    expect(await prisma.thuNhap.count()).toBe(1);
  });
});

describe("chưa bật ⇒ như cũ", () => {
  it("duyệt kỳ 15/09, tạo khoản 'mới' 20/09, tạo thấu chi mang sang 20/09, tạo sổ 20/09, tất toán thấu chi 30/09 đều qua", async () => {
    const loanId = idCua(await taoKhoanVay(VAY_MANG_SANG));
    expect(await ghiKyTraNo({ loanId, dueDate: "2026-09-15", lai: 1_000_000, goc: 10_000_000 })).toMatchObject({ ok: true });
    idCua(await taoKhoanVay(vayMoi("2026-09-20")));
    idCua(await taoKhoanVay(thauChiMangSang("2026-09-20")));
    idCua(await taoSoTietKiem(so("2026-09-20")));
    const thauChi = idCua(await taoKhoanVay(thauChiMoi("2026-09-05")));
    expect(
      await tatToanThauChi({ loanId: thauChi, ngayTatToan: "2026-09-30", lai: 0, conDauDaThay: null })
    ).toMatchObject({ ok: true });
  });
});

describe("ca đua: bước bật đang giữ khoá EXCLUSIVE ⇒ đường ghi < M CHỜ rồi bị từ chối", () => {
  it("duyệt kỳ 15/09 chờ bước bật commit rồi DA_BAT_NO_PHAI_TRA, con dấu không đóng", async () => {
    const loanId = idCua(await taoKhoanVay(VAY_MANG_SANG));
    const { r, ms } = await trongLucBuocBatGiuKhoa(() =>
      ghiKyTraNo({ loanId, dueDate: "2026-09-15", lai: 1_000_000, goc: 10_000_000 })
    );
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(r).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA" });
    expect((await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })).lastDueHandled).toBeNull();
    expect(await prisma.cashMovement.count()).toBe(0);
    expect(await prisma.expense.count()).toBe(0);
  });

  it("tất toán thấu chi 30/09 chờ bước bật commit rồi bị từ chối, khoản còn mở", async () => {
    const loanId = idCua(await taoKhoanVay(thauChiMoi("2026-09-05")));
    const { r, ms } = await trongLucBuocBatGiuKhoa(() =>
      tatToanThauChi({ loanId, ngayTatToan: "2026-09-30", lai: 900_000, conDauDaThay: null })
    );
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(r).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA" });
    expect((await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })).closedAt).toBeNull();
    expect(await prisma.cashMovement.count({ where: { kind: "LOAN_REPAY" } })).toBe(0);
  });

  it("tạo sổ tiết kiệm gửi 20/09 chờ bước bật commit rồi bị từ chối, không sổ, không dòng gửi", async () => {
    const { r, ms } = await trongLucBuocBatGiuKhoa(() => taoSoTietKiem(so("2026-09-20")));
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(r).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA", field: "startDate" });
    expect(await prisma.soTietKiem.count()).toBe(0);
    expect(await prisma.cashMovement.count()).toBe(0);
  });

  it("tất toán sổ tiết kiệm 30/09 chờ bước bật commit rồi bị từ chối, sổ còn mở", async () => {
    const id = idCua(await taoSoTietKiem(so("2026-09-05")));
    const { r, ms } = await trongLucBuocBatGiuKhoa(() =>
      tatToanSoTietKiem({ id, ngayTatToan: "2026-09-30", lai: 1_000_000 })
    );
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(r).toMatchObject({ ok: false, code: "DA_BAT_NO_PHAI_TRA" });
    expect((await prisma.soTietKiem.findUniqueOrThrow({ where: { id } })).closedAt).toBeNull();
    expect(await prisma.thuNhap.count()).toBe(0);
  });
});
