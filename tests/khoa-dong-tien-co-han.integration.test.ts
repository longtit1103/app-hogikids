import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createCashMovement, updateCashMovement } from "@/lib/actions/cash-movements";
import { prisma } from "@/lib/prisma";
import {
  HAN_CHO_KHOA_DONG_TIEN_MS,
  LoiKhoaDongTienBan,
  OPT_TX_DONG_TIEN,
  THONG_BAO_KHOA_DONG_TIEN_BAN,
} from "@/lib/so-quy/khoa-dong-tien-co-han";
import { khoaCacKhoanVay, khoaKhoanVay } from "@/lib/so-quy/vi-tu-du-no";
import { taoPrismaClient } from "@/lib/tao-prisma-client";
import { khoaCacSoTietKiem, khoaSoTietKiem } from "@/lib/tiet-kiem/vi-tu-so-tiet-kiem";

import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Chờ khoá dòng tiền CÓ HẠN (`src/lib/so-quy/khoa-dong-tien-co-han.ts`): lượt khác giữ dòng `Loan` /
 * `SoTietKiem` quá hạn ⇒ lượt sau rút ra với câu "đang bận", KHÔNG ghi dòng nào, kết nối về pool. Không có
 * hạn (Postgres mặc định `lock_timeout = 0`) thì lượt sau treo tới khi lượt trước nhả — và mỗi lượt treo
 * giữ một kết nối của pool 10.
 *
 * Hạn là NGÂN SÁCH CHUNG của cả transaction (chủ shop chốt 01/10: tối đa 10 giây cho cả lượt bấm), không
 * phải của từng câu khoá: khoá [A, B] mà A nhả muộn thì B chỉ còn phần thời gian còn lại.
 *
 * Đa số ca dùng hạn NGẮN qua tham số nội bộ `hanChoMs` cho nhanh; vài ca đi hạn thật (10s) — đường action
 * `createCashMovement`/`updateCashMovement` và `OPT_TX_DONG_TIEN` — chứng minh người dùng nhận câu "đang
 * bận" chứ không phải P2028 chung chung ("Lỗi khi ghi khoản tiền").
 */
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => {
  const { nguoiDungGia } = await import("./helpers/nguoi-dung-gia");
  return {
    ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
    docNguoiDungPhien: vi.fn(async () => nguoiDungGia()),
  };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const HAN_NGAN_MS = 400;

let loanId: string;

async function taoKhoanVayPhu(name: string): Promise<string> {
  const l = await prisma.loan.create({
    data: {
      name,
      startDate: new Date("2026-07-01T00:00:00+07:00"),
      annualRateBp: 1000,
      termMonths: 12,
      firstDueDate: new Date("2026-08-01T00:00:00+07:00"),
    },
  });
  return l.id;
}

/** Hai khoản vay theo đúng THỨ TỰ KHOÁ của `khoaCacKhoanVay` (id tăng dần): `[truoc, sau]`. */
async function haiKhoanTheoThuTuKhoa(): Promise<[string, string]> {
  const khac = await taoKhoanVayPhu("Vay thử khoá B");
  return [loanId, khac].sort() as [string, string];
}

/** Hẹn giờ nhả khoá của lượt giữ, đếm từ lúc gọi. */
const nhaSau = (giu: { nha: () => void }, ms: number) => setTimeout(() => giu.nha(), ms);

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  const loan = await prisma.loan.create({
    data: {
      name: "Vay thử khoá",
      startDate: new Date("2026-07-01T00:00:00+07:00"),
      annualRateBp: 1000,
      termMonths: 12,
      firstDueDate: new Date("2026-08-01T00:00:00+07:00"),
    },
  });
  loanId = loan.id;
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

/**
 * Transaction A giành khoá dòng `bang`/`id` (`FOR UPDATE`) rồi GIỮ cho tới khi `nha()` được gọi hoặc hết
 * `giuToiDaMs` (chốt chặn: test đỏ giữa chừng cũng không để khoá treo). `daGiu` resolve khi khoá đã nằm
 * trong tay A.
 */
function giuKhoaDong(bang: "Loan" | "SoTietKiem", id: string, giuToiDaMs: number) {
  let nha!: () => void;
  const choNha = new Promise<void>((r) => {
    nha = r;
    setTimeout(r, giuToiDaMs);
  });
  let baoDaGiu!: () => void;
  const daGiu = new Promise<void>((r) => (baoDaGiu = r));
  const xong = prisma.$transaction(
    async (tx) => {
      if (bang === "Loan") await tx.$queryRaw`SELECT id FROM "Loan" WHERE id = ${id} FOR UPDATE`;
      else await tx.$queryRaw`SELECT id FROM "SoTietKiem" WHERE id = ${id} FOR UPDATE`;
      baoDaGiu();
      await choNha;
    },
    { timeout: giuToiDaMs + 10_000, maxWait: 5_000 }
  );
  return { daGiu, nha, xong };
}

async function soPhienKetTrongTransaction(): Promise<number> {
  const [r] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM pg_stat_activity
    WHERE datname = current_database() AND state LIKE 'idle in transaction%' AND pid <> pg_backend_pid()`;
  return Number(r.n);
}

describe("khoá dòng tiền có hạn chờ", () => {
  it("lượt khác giữ dòng Loan quá hạn ⇒ LoiKhoaDongTienBan đúng câu, transaction lùi, không ghi dòng nào", async () => {
    const giu = giuKhoaDong("Loan", loanId, 8_000);
    await giu.daGiu;

    const batDau = Date.now();
    const ketQua = prisma.$transaction(
      async (tx) => {
        await khoaKhoanVay(tx, loanId, HAN_NGAN_MS);
        await tx.cashMovement.create({
          data: { date: new Date("2026-07-10T00:00:00+07:00"), kind: "CAPITAL_IN", amount: 1_000, description: "không được ghi" },
        });
      },
      { timeout: 10_000, maxWait: 5_000 }
    );
    await expect(ketQua).rejects.toBeInstanceOf(LoiKhoaDongTienBan);
    await expect(ketQua).rejects.toThrow(THONG_BAO_KHOA_DONG_TIEN_BAN);
    const daCho = Date.now() - batDau;
    // Rút ra quanh hạn chờ — KHÔNG đợi A nhả (A giữ tới 8s).
    expect(daCho).toBeGreaterThanOrEqual(HAN_NGAN_MS - 50);
    expect(daCho).toBeLessThan(3_000);

    giu.nha();
    await giu.xong;
    expect(await prisma.cashMovement.count()).toBe(0);
    expect(await soPhienKetTrongTransaction()).toBe(0);
  }, 30_000);

  it("khoá sổ tiết kiệm cũng có hạn", async () => {
    const so = await prisma.soTietKiem.create({
      data: {
        name: "Sổ thử khoá",
        principal: 10_000_000,
        startDate: new Date("2026-07-01T00:00:00+07:00"),
        termMonths: 6,
        maturityDate: new Date("2027-01-01T00:00:00+07:00"),
        annualRateBp: 500,
      },
    });
    const giu = giuKhoaDong("SoTietKiem", so.id, 8_000);
    await giu.daGiu;

    const batDau = Date.now();
    await expect(
      prisma.$transaction((tx) => khoaSoTietKiem(tx, so.id, HAN_NGAN_MS), { timeout: 10_000, maxWait: 5_000 })
    ).rejects.toBeInstanceOf(LoiKhoaDongTienBan);
    expect(Date.now() - batDau).toBeLessThan(3_000);

    giu.nha();
    await giu.xong;
  }, 30_000);

  it("hạn chờ phải là số nguyên dương — chặn trước khi chạm DB", async () => {
    for (const han of [0, -1, 1.5, Number.NaN]) {
      await expect(prisma.$transaction((tx) => khoaKhoanVay(tx, loanId, han))).rejects.toThrow(/số nguyên dương/);
    }
  });

  it("giành được khoá ⇒ lock_timeout trả về giá trị cũ cho phần còn lại của transaction (phạm vi hẹp)", async () => {
    const [truoc, sau] = await prisma.$transaction(async (tx) => {
      const [t] = await tx.$queryRaw<{ v: string }[]>`SELECT current_setting('lock_timeout') AS v`;
      await khoaCacKhoanVay(tx, [loanId, loanId]);
      const [s] = await tx.$queryRaw<{ v: string }[]>`SELECT current_setting('lock_timeout') AS v`;
      return [t.v, s.v];
    });
    expect(truoc).toBe("0");
    expect(sau).toBe("0");
  });

  it("12 lượt chờ cùng lúc (pool 10) đều rút ra có hạn — pool không cạn, câu sau chạy ngay", async () => {
    const giu = giuKhoaDong("Loan", loanId, 15_000);
    await giu.daGiu;

    const batDau = Date.now();
    const ket = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        prisma.$transaction((tx) => khoaKhoanVay(tx, loanId, HAN_NGAN_MS), { timeout: 10_000, maxWait: 8_000 })
      )
    );
    expect(ket.map((k) => (k.status === "rejected" && k.reason instanceof LoiKhoaDongTienBan ? "ban" : k.status))).toEqual(
      Array(12).fill("ban")
    );
    // Mỗi lượt giữ kết nối tối đa ~hạn chờ ⇒ cả 12 xong trong vài giây dù A vẫn đang giữ khoá (tới 15s).
    expect(Date.now() - batDau).toBeLessThan(6_000);

    const t0 = Date.now();
    expect(await prisma.loan.count()).toBe(1);
    expect(Date.now() - t0).toBeLessThan(1_000);

    giu.nha();
    await giu.xong;
    expect(await soPhienKetTrongTransaction()).toBe(0);
  }, 40_000);

  it(
    "đường action thật (hạn 10s): createCashMovement trả đúng câu tiếng Việt, không ghi dòng trả gốc nào",
    async () => {
      expect(HAN_CHO_KHOA_DONG_TIEN_MS).toBe(10_000);
      const giu = giuKhoaDong("Loan", loanId, HAN_CHO_KHOA_DONG_TIEN_MS + 8_000);
      await giu.daGiu;

      const batDau = Date.now();
      const res = await createCashMovement({
        date: "2026-07-01",
        kind: "LOAN_IN",
        amount: 50_000_000,
        description: "Giải ngân",
        loanId,
      });
      const daCho = Date.now() - batDau;
      expect(res).toEqual({ ok: false, error: THONG_BAO_KHOA_DONG_TIEN_BAN });
      expect(daCho).toBeGreaterThanOrEqual(HAN_CHO_KHOA_DONG_TIEN_MS - 100);
      // Rút ra NGAY sau hạn — không đợi A nhả (A giữ tới 18s).
      expect(daCho).toBeLessThan(HAN_CHO_KHOA_DONG_TIEN_MS + 4_000);

      giu.nha();
      await giu.xong;
      expect(await prisma.cashMovement.count({ where: { loanId } })).toBe(0);
      expect(await soPhienKetTrongTransaction()).toBe(0);
    },
    60_000
  );
  describe("ngân sách hạn CHUNG cho cả transaction (không phải từng câu khoá)", () => {
    const HAN_MS = 2_000;

    it("khoá [A, B]: A nhả ở 60% hạn, B bị giữ lâu ⇒ báo bận quanh HẠN, không phải 60% + trọn hạn nữa", async () => {
      const [a, b] = await haiKhoanTheoThuTuKhoa();
      const giuA = giuKhoaDong("Loan", a, 15_000);
      const giuB = giuKhoaDong("Loan", b, 15_000);
      await Promise.all([giuA.daGiu, giuB.daGiu]);

      const batDau = Date.now();
      nhaSau(giuA, HAN_MS * 0.6);
      const ketQua = prisma.$transaction((tx) => khoaCacKhoanVay(tx, [a, b], HAN_MS), {
        timeout: HAN_MS + 10_000,
        maxWait: 5_000,
      });
      await expect(ketQua).rejects.toBeInstanceOf(LoiKhoaDongTienBan);
      const daCho = Date.now() - batDau;
      expect(daCho).toBeGreaterThanOrEqual(HAN_MS - 50);
      // Hạn từng câu (bản cũ) rút ra ở ≈ 1,6 × hạn = 3,2s.
      expect(daCho).toBeLessThan(HAN_MS + 600);

      giuB.nha();
      await Promise.all([giuA.xong, giuB.xong]);
      expect(await soPhienKetTrongTransaction()).toBe(0);
    }, 30_000);

    it("hạn dùng CHUNG giữa hai helper trong một tx (`khoaCacKhoanVay` rồi `khoaCacSoTietKiem`)", async () => {
      const so = await prisma.soTietKiem.create({
        data: {
          name: "Sổ thử ngân sách",
          principal: 10_000_000,
          startDate: new Date("2026-07-01T00:00:00+07:00"),
          termMonths: 6,
          maturityDate: new Date("2027-01-01T00:00:00+07:00"),
          annualRateBp: 500,
        },
      });
      const giuVay = giuKhoaDong("Loan", loanId, 15_000);
      const giuSo = giuKhoaDong("SoTietKiem", so.id, 15_000);
      await Promise.all([giuVay.daGiu, giuSo.daGiu]);

      const batDau = Date.now();
      nhaSau(giuVay, HAN_MS * 0.6);
      const ketQua = prisma.$transaction(
        async (tx) => {
          await khoaCacKhoanVay(tx, [loanId], HAN_MS);
          await khoaCacSoTietKiem(tx, [so.id], HAN_MS);
        },
        { timeout: HAN_MS + 10_000, maxWait: 5_000 }
      );
      await expect(ketQua).rejects.toBeInstanceOf(LoiKhoaDongTienBan);
      const daCho = Date.now() - batDau;
      expect(daCho).toBeGreaterThanOrEqual(HAN_MS - 50);
      expect(daCho).toBeLessThan(HAN_MS + 600);

      giuSo.nha();
      await Promise.all([giuVay.xong, giuSo.xong]);
    }, 30_000);

    it("ngân sách đã cạn trước câu khoá kế ⇒ báo bận NGAY, không gửi câu nào xuống DB", async () => {
      const [a, b] = await haiKhoanTheoThuTuKhoa();
      const giuB = giuKhoaDong("Loan", b, 15_000);
      await giuB.daGiu;

      const ketQua = prisma.$transaction(
        async (tx) => {
          await khoaCacKhoanVay(tx, [a], 300);
          // Ăn hết ngân sách bằng việc ngoài khoá — lần khoá sau không còn gì để chờ.
          await tx.$executeRaw`SELECT pg_sleep(0.4)`;
          const t0 = Date.now();
          try {
            await khoaCacKhoanVay(tx, [b], 300);
          } finally {
            // Không chờ ở DB: nếu câu FOR UPDATE được gửi đi thì nó kẹt sau lượt giữ B (15s).
            expect(Date.now() - t0).toBeLessThan(100);
          }
        },
        { timeout: 10_000, maxWait: 5_000 }
      );
      await expect(ketQua).rejects.toBeInstanceOf(LoiKhoaDongTienBan);

      giuB.nha();
      await giuB.xong;
    }, 30_000);
  });

  it(
    "đường action thật, khoá 2 khoản (chuyển dòng A → B): A nhả 6s, B nhả 13s ⇒ câu 'đang bận' quanh 10s, KHÔNG P2028",
    async () => {
      const [a, b] = await haiKhoanTheoThuTuKhoa();
      await prisma.loan.updateMany({ where: { id: { in: [a, b] } }, data: { duNoMoSo: 100_000_000 } });
      const dong = await prisma.cashMovement.create({
        data: { date: new Date("2026-07-10T00:00:00+07:00"), kind: "LOAN_REPAY", amount: 1_000_000, description: "Trả gốc", loanId: a },
      });
      const giuA = giuKhoaDong("Loan", a, 20_000);
      const giuB = giuKhoaDong("Loan", b, 20_000);
      await Promise.all([giuA.daGiu, giuB.daGiu]);

      const batDau = Date.now();
      nhaSau(giuA, 6_000);
      nhaSau(giuB, 13_000);
      const res = await updateCashMovement(dong.id, {
        date: "2026-07-10",
        kind: "LOAN_REPAY",
        amount: 1_000_000,
        description: "Trả gốc",
        loanId: b,
      });
      const daCho = Date.now() - batDau;
      expect(res).toEqual({ ok: false, error: THONG_BAO_KHOA_DONG_TIEN_BAN });
      expect(daCho).toBeGreaterThanOrEqual(HAN_CHO_KHOA_DONG_TIEN_MS - 100);
      // Hạn từng câu: giành B ở 13s rồi mới chạy tiếp (> 10s) — và khi đó timeout 10s cũ ra P2028.
      expect(daCho).toBeLessThan(HAN_CHO_KHOA_DONG_TIEN_MS + 1_500);

      await Promise.all([giuA.xong, giuB.xong]);
      expect((await prisma.cashMovement.findUniqueOrThrow({ where: { id: dong.id } })).loanId).toBe(a);
      expect(await soPhienKetTrongTransaction()).toBe(0);
    },
    60_000
  );

  it(
    "OPT_TX_DONG_TIEN chừa chỗ cho câu chạy TRƯỚC khoá: giành khoá sát hạn (10,3s) vẫn commit, không P2028",
    async () => {
      expect(OPT_TX_DONG_TIEN.timeout).toBe(HAN_CHO_KHOA_DONG_TIEN_MS + 10_000);
      const giu = giuKhoaDong("Loan", loanId, 30_000);
      await giu.daGiu;

      const batDau = Date.now();
      nhaSau(giu, HAN_CHO_KHOA_DONG_TIEN_MS + 300);
      await prisma.$transaction(async (tx) => {
        // Câu đứng trước khoá (đọc dòng, CAS…) — mốc hạn khoá tính từ lần khoá đầu nên lùi theo 0,5s.
        await tx.$executeRaw`SELECT pg_sleep(0.5)`;
        await khoaKhoanVay(tx, loanId);
        await tx.cashMovement.create({
          data: { date: new Date("2026-07-10T00:00:00+07:00"), kind: "CAPITAL_IN", amount: 1_000, description: "sau khoá" },
        });
      }, OPT_TX_DONG_TIEN);
      expect(Date.now() - batDau).toBeGreaterThanOrEqual(HAN_CHO_KHOA_DONG_TIEN_MS + 250);

      await giu.xong;
      expect(await prisma.cashMovement.count()).toBe(1);
    },
    60_000
  );

  it("lock_timeout KHÔNG rò ra phiên: pool 1 kết nối, sau commit kết nối đó vẫn lock_timeout mặc định", async () => {
    const url = new URL(process.env.DATABASE_URL as string);
    url.searchParams.set("connection_limit", "1");
    const motKetNoi = taoPrismaClient(url.toString());
    try {
      const [pidTrong] = await motKetNoi.$transaction(async (tx) => {
        await khoaKhoanVay(tx, loanId);
        return tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      });
      const [sau] = await motKetNoi.$queryRaw<{ v: string; pid: number }[]>`
        SELECT current_setting('lock_timeout') AS v, pg_backend_pid() AS pid`;
      // Cùng MỘT kết nối vật lý — nếu không, phép đo không nói gì về rò phiên.
      expect(sau.pid).toBe(pidTrong.pid);
      expect(sau.v).toBe("0");
    } finally {
      await motKetNoi.$disconnect();
    }
  });
});
