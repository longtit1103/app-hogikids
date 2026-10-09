import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { CashMovement, Prisma } from "@/generated/prisma/client";
import { createCashMovement } from "@/lib/actions/cash-movements";
import { loiKhoanVay } from "@/lib/actions/khoan-vay-chung";
import { xoaKhoanVay } from "@/lib/actions/khoan-vay";
import { xoaSoTietKiem } from "@/lib/actions/so-tiet-kiem";
import { loiSoTietKiem } from "@/lib/actions/so-tiet-kiem-chung";
import { prisma } from "@/lib/prisma";
import {
  laLoiDongTienBan,
  LoiKhoaDongTienBan,
  THONG_BAO_KHOA_DONG_TIEN_BAN,
} from "@/lib/so-quy/khoa-dong-tien-co-han";
import { dungAnhBanGhi } from "@/lib/thung-rac/chup-anh-ban-ghi";
import { khoiPhucBanGhiDaXoa } from "@/lib/thung-rac/khoi-phuc-ban-ghi";

import { nguoiDungGia } from "./helpers/nguoi-dung-gia";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * MỌI hàm ánh xạ lỗi của đường khoá dòng tiền trả ĐÚNG câu "đang bận, thử lại" cho cả hai kết cục "chờ quá
 * hạn": hết hạn chờ khoá (`LoiKhoaDongTienBan`) và transaction quá hạn (P2028). Đi qua action/hàm THẬT:
 * `xoaKhoanVay` (→ `loiKhoanVay`), `xoaSoTietKiem` (→ `loiSoTietKiem`), `khoiPhucBanGhiDaXoa` (bắt riêng),
 * `createCashMovement` (→ `loiGhi`). Bỏ một nhánh ánh xạ là câu rơi về lỗi chung ("Lỗi khi xoá khoản vay"…).
 *
 * Helper khoá được bọc để (a) chờ khoá THẬT nhưng hạn rút ngắn — khỏi chờ 10s mỗi ca; (b) khi `che.loi` có giá
 * trị thì ném đúng lỗi đó (một P2028 THẬT lấy từ Prisma) từ trong transaction, như lúc hết hạn tx thật.
 */
const che = vi.hoisted(() => ({ HAN_NGAN_MS: 300, loi: undefined as unknown }));

vi.mock("@/lib/so-quy/vi-tu-du-no", async (goc) => {
  const g = await goc<typeof import("@/lib/so-quy/vi-tu-du-no")>();
  const nem = () => (che.loi === undefined ? null : Promise.reject(che.loi));
  return {
    ...g,
    khoaKhoanVay: (tx: Prisma.TransactionClient, id: string) => nem() ?? g.khoaKhoanVay(tx, id, che.HAN_NGAN_MS),
    khoaCacKhoanVay: (tx: Prisma.TransactionClient, ids: string[]) =>
      nem() ?? g.khoaCacKhoanVay(tx, ids, che.HAN_NGAN_MS),
  };
});
vi.mock("@/lib/tiet-kiem/vi-tu-so-tiet-kiem", async (goc) => {
  const g = await goc<typeof import("@/lib/tiet-kiem/vi-tu-so-tiet-kiem")>();
  const nem = () => (che.loi === undefined ? null : Promise.reject(che.loi));
  return {
    ...g,
    khoaSoTietKiem: (tx: Prisma.TransactionClient, id: string) => nem() ?? g.khoaSoTietKiem(tx, id, che.HAN_NGAN_MS),
    khoaCacSoTietKiem: (tx: Prisma.TransactionClient, ids: string[]) =>
      nem() ?? g.khoaCacSoTietKiem(tx, ids, che.HAN_NGAN_MS),
  };
});
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => {
  const { nguoiDungGia: gia } = await import("./helpers/nguoi-dung-gia");
  return {
    ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
    docNguoiDungPhien: vi.fn(async () => gia()),
  };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

/** Một P2028 THẬT: transaction hạn 100ms, câu đầu ngủ 300ms ⇒ Prisma từ chối câu kế vì tx đã hết hạn. */
async function layLoiP2028(): Promise<unknown> {
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_sleep(0.3)`;
        await tx.$executeRaw`SELECT 1`;
      },
      { timeout: 100 }
    );
  } catch (e) {
    return e;
  }
  throw new Error("transaction hạn 100ms lại không hết hạn");
}

let loiP2028: unknown;
let loanId: string;
let soId: string;

/** Transaction khác giữ khoá dòng tới khi `nha()` (chốt 15s phòng test đỏ giữa chừng). */
function giuKhoaDong(bang: "Loan" | "SoTietKiem", id: string) {
  let nha!: () => void;
  const choNha = new Promise<void>((r) => {
    nha = r;
    setTimeout(r, 15_000);
  });
  let baoDaGiu!: () => void;
  const daGiu = new Promise<void>((r) => (baoDaGiu = r));
  const xong = prisma.$transaction(
    async (tx) => {
      if (bang === "Loan") await tx.$executeRaw`SELECT id FROM "Loan" WHERE id = ${id} FOR UPDATE`;
      else await tx.$executeRaw`SELECT id FROM "SoTietKiem" WHERE id = ${id} FOR UPDATE`;
      baoDaGiu();
      await choNha;
    },
    { timeout: 25_000, maxWait: 5_000 }
  );
  return { daGiu, nha, xong };
}

/** Chạy `fn` trong lúc lượt khác giữ khoá dòng `bang`/`id`, nhả khoá xong mới trả kết quả. */
async function trongLucBiGiu<T>(bang: "Loan" | "SoTietKiem", id: string, fn: () => Promise<T>): Promise<T> {
  const giu = giuKhoaDong(bang, id);
  await giu.daGiu;
  try {
    return await fn();
  } finally {
    giu.nha();
    await giu.xong;
  }
}

/** Dòng thùng rác: dòng trả gốc của khoản vay `loanId`, ảnh dựng bằng CHÍNH `dungAnhBanGhi` của đường xoá thật. */
async function dongTraGocDaXoa(): Promise<string> {
  const banGhi: CashMovement = {
    id: "cm-tra-goc-da-xoa",
    date: new Date(2026, 6, 10),
    kind: "LOAN_REPAY",
    amount: 1_000_000,
    description: "Trả gốc",
    loanId,
    savingsId: null,
    cardId: null,
    phieuNhapId: null,
    viAdsId: null,
    yeuCauId: null,
    createdAt: new Date(2026, 6, 10),
  };
  const { nhan, soTien, ngay, anh } = dungAnhBanGhi({ bang: "CashMovement", banGhi });
  const dong = await prisma.banGhiDaXoa.create({
    data: {
      bang: "CashMovement",
      banGhiId: banGhi.id,
      nhan,
      soTien,
      ngay,
      anh: anh as unknown as Prisma.InputJsonValue,
      xoaLuc: new Date(2026, 6, 11),
    },
  });
  return dong.id;
}

const BAN = THONG_BAO_KHOA_DONG_TIEN_BAN;

beforeAll(async () => {
  await seedReference();
  loiP2028 = await layLoiP2028();
}, 60_000);

beforeEach(async () => {
  che.loi = undefined;
  await truncateBusinessTables();
  const loan = await prisma.loan.create({
    data: {
      name: "Vay thử ánh xạ",
      startDate: new Date("2026-07-01T00:00:00+07:00"),
      annualRateBp: 1000,
      termMonths: 12,
      firstDueDate: new Date("2026-08-01T00:00:00+07:00"),
      duNoMoSo: 50_000_000,
    },
  });
  loanId = loan.id;
  const so = await prisma.soTietKiem.create({
    data: {
      name: "Sổ thử ánh xạ",
      principal: 10_000_000,
      startDate: new Date("2026-07-01T00:00:00+07:00"),
      termMonths: 6,
      maturityDate: new Date("2027-01-01T00:00:00+07:00"),
      annualRateBp: 500,
    },
  });
  soId = so.id;
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

describe("laLoiDongTienBan", () => {
  it("nhận LoiKhoaDongTienBan và P2028 thật; không nhận lỗi khác", () => {
    expect((loiP2028 as { code?: string }).code).toBe("P2028");
    expect(laLoiDongTienBan(loiP2028)).toBe(true);
    expect(laLoiDongTienBan(new LoiKhoaDongTienBan())).toBe(true);
    expect(laLoiDongTienBan(new Error("khác"))).toBe(false);
    expect(laLoiDongTienBan(Object.assign(new Error("không thấy"), { code: "P2025" }))).toBe(false);
    expect(laLoiDongTienBan(undefined)).toBe(false);
  });

  it("hai hàm ánh xạ thuần trả đúng câu bận cho cả hai lỗi", () => {
    for (const e of [new LoiKhoaDongTienBan(), loiP2028]) {
      expect(loiKhoanVay(e, "Lỗi chung")).toEqual({ error: BAN });
      expect(loiSoTietKiem(e, "Lỗi chung")).toEqual({ error: BAN });
    }
  });
});

describe("action thật: khoá bị giữ quá hạn ⇒ câu 'đang bận', không đổi gì", () => {
  it("xoaKhoanVay (loiKhoanVay)", async () => {
    const res = await trongLucBiGiu("Loan", loanId, () => xoaKhoanVay(loanId));
    expect(res).toEqual({ ok: false, error: BAN });
    expect(await prisma.loan.count({ where: { id: loanId } })).toBe(1);
  }, 30_000);

  it("xoaSoTietKiem (loiSoTietKiem)", async () => {
    const res = await trongLucBiGiu("SoTietKiem", soId, () => xoaSoTietKiem({ id: soId }));
    expect(res).toEqual({ ok: false, error: BAN });
    expect(await prisma.soTietKiem.count({ where: { id: soId } })).toBe(1);
  }, 30_000);

  it("khoiPhucBanGhiDaXoa — con dấu 'đã khôi phục' lùi theo", async () => {
    const id = await dongTraGocDaXoa();
    const res = await trongLucBiGiu("Loan", loanId, () => khoiPhucBanGhiDaXoa(id, nguoiDungGia()));
    expect(res).toEqual({ ok: false, lyDo: BAN });
    expect((await prisma.banGhiDaXoa.findUniqueOrThrow({ where: { id } })).khoiPhucLuc).toBeNull();
    expect(await prisma.cashMovement.count()).toBe(0);
  }, 30_000);
});

describe("action thật: transaction quá hạn (P2028) ⇒ cùng câu 'đang bận', không đổi gì", () => {
  beforeEach(() => {
    che.loi = loiP2028;
  });

  it("xoaKhoanVay", async () => {
    expect(await xoaKhoanVay(loanId)).toEqual({ ok: false, error: BAN });
    expect(await prisma.loan.count({ where: { id: loanId } })).toBe(1);
  });

  it("xoaSoTietKiem", async () => {
    expect(await xoaSoTietKiem({ id: soId })).toEqual({ ok: false, error: BAN });
    expect(await prisma.soTietKiem.count({ where: { id: soId } })).toBe(1);
  });

  it("khoiPhucBanGhiDaXoa", async () => {
    const id = await dongTraGocDaXoa();
    expect(await khoiPhucBanGhiDaXoa(id, nguoiDungGia())).toEqual({ ok: false, lyDo: BAN });
    expect((await prisma.banGhiDaXoa.findUniqueOrThrow({ where: { id } })).khoiPhucLuc).toBeNull();
  });

  it("createCashMovement (loiGhi)", async () => {
    const res = await createCashMovement({
      date: "2026-07-10",
      kind: "LOAN_REPAY",
      amount: 1_000_000,
      description: "Trả gốc",
      loanId,
    });
    expect(res).toEqual({ ok: false, error: BAN });
    expect(await prisma.cashMovement.count()).toBe(0);
  });
});
