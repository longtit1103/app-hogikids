import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Thẻ tín dụng trên DB thật (`hogikids_test`): (1) nhắc "chưa chốt sao kê kỳ gần nhất" với thẻ chốt cuối
 * tháng (ngày chốt 29–31 bị kẹp về cuối tháng); (2) `chotSaoKe` / `dongThe` CHỜ khoá dòng thẻ (`khoaThe`)
 * của lượt khác — bỏ khoá là đọc trạng thái cũ (chốt vào thẻ đã đóng; đóng thẻ đang có nợ).
 * M = 01/11/2026. "Hôm nay" ghim bằng fake timer chỉ cho `Date` (setTimeout/performance thật).
 */
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => ({
  ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
  docNguoiDungPhien: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { chotSaoKe } from "@/lib/actions/chot-sao-ke";
import { dongThe } from "@/lib/actions/the-tin-dung";
import { KEY_NO_PHAI_TRA_TU_NGAY } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { docTheKemTrangThai, khoaThe } from "@/lib/no-phai-tra/the-tin-dung-queries";
import { prisma } from "@/lib/prisma";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";
import type { Prisma } from "@/generated/prisma/client";

import { nguoiDungGia } from "../../helpers/nguoi-dung-gia";
import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

const vn = (ngay: string, gio = "00:00:00") => new Date(`${ngay}T${gio}+07:00`);
const tr = (n: number) => Math.round(n * 1_000_000);

/** Thẻ + neo mở sổ M − 1 = 0 (như thẻ thêm sau khi bật / dòng (ii) bước bật với thẻ sạch nợ). */
async function theCoNeo0(ngayChotSaoKe = 25): Promise<string> {
  const id = (await prisma.theTinDung.create({ data: { ten: "Thẻ A", ngayChotSaoKe, ngayHanTra: 10 } })).id;
  await prisma.kySaoKeThe.create({ data: { cardId: id, ngayChot: vn("2026-10-31"), soDu: 0, laNeoMoSo: true } });
  return id;
}

async function kySaoKe(cardId: string, ngayChot: string, soDu = 0) {
  await prisma.kySaoKeThe.create({
    data: { cardId, ngayChot: vn(ngayChot), soDu, hanTra: new Date(vn(ngayChot).getTime() + 15 * 86_400_000) },
  });
}

/**
 * Lượt khác giữ `khoaThe(cardId)` (+ việc `lamGi` trong cùng tx, chưa commit) 0,8s; `hanhDong` chạy giữa
 * chừng. Trả kết quả + thời gian chờ của `hanhDong`.
 */
async function trongLucGiuKhoaThe<T>(
  cardId: string,
  lamGi: (tx: Prisma.TransactionClient) => Promise<unknown>,
  hanhDong: () => Promise<T>
): Promise<{ r: T; ms: number }> {
  let tha!: () => void;
  const cho = new Promise<void>((res) => (tha = res));
  let daGiu!: () => void;
  const giuXong = new Promise<void>((res) => (daGiu = res));
  const giu = prisma.$transaction(
    async (tx) => {
      await khoaThe(tx, cardId);
      await lamGi(tx);
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
  await giu;
  return p;
}

const chot = (cardId: string, soDu = tr(4)) =>
  chotSaoKe({ yeuCauId: randomUUID(), cardId, ngayChot: "2026-11-25", soDu, hanTra: "2026-12-10", note: "" });

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
  await prisma.setting.create({ data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: "2026-11-01" } });
  vi.mocked(docNguoiDungPhien).mockResolvedValue(nguoiDungGia());
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(vn("2026-11-26", "10:00:00"));
});

afterEach(async () => {
  vi.useRealTimers();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

describe("nhắc chưa chốt sao kê kỳ gần nhất — thẻ chốt ngày 31", () => {
  const nhac = async (cardId: string) =>
    (await docTheKemTrangThai(prisma, new Date())).find((t) => t.id === cardId)?.chuaChotKyGanNhat;

  it("hôm nay 05/03/2027 ⇒ kỳ cần có ngayChot ≥ 28/02/2027 (năm thường); kỳ 27/02 chưa đủ", async () => {
    const A = await theCoNeo0(31);
    vi.setSystemTime(vn("2027-03-05", "10:00:00"));
    expect(await nhac(A)).toBe(true);
    await kySaoKe(A, "2027-02-27");
    expect(await nhac(A)).toBe(true);
    await kySaoKe(A, "2027-02-28");
    expect(await nhac(A)).toBe(false);
  });

  it("hôm nay 01/12/2026 ⇒ kỳ gần nhất 30/11 (chưa chốt ⇒ nhắc); hôm nay 30/11 ⇒ kỳ gần nhất 31/10 = neo ⇒ không nhắc", async () => {
    const A = await theCoNeo0(31);
    vi.setSystemTime(vn("2026-12-01", "08:00:00"));
    expect(await nhac(A)).toBe(true);
    vi.setSystemTime(vn("2026-11-30", "08:00:00"));
    expect(await nhac(A)).toBe(false);
  });

  it("thẻ đã đóng hoặc chưa bật ⇒ không nhắc", async () => {
    const A = await theCoNeo0(31);
    vi.setSystemTime(vn("2026-12-01", "08:00:00"));
    await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
    expect(await nhac(A)).toBe(false);
    await prisma.setting.create({ data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: "2026-11-01" } });
    await prisma.theTinDung.update({ where: { id: A }, data: { closedAt: vn("2026-11-30") } });
    expect(await nhac(A)).toBe(false);
  });
});

describe("khoá dòng thẻ — chốt sao kê / đóng thẻ chờ lượt đang giữ", () => {
  it("chotSaoKe CHỜ khoaThe của lượt khác (0,8s) rồi chốt thành công", async () => {
    const A = await theCoNeo0();
    const { r, ms } = await trongLucGiuKhoaThe(A, async () => undefined, () => chot(A));
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(r).toMatchObject({ ok: true });
    expect(await prisma.kySaoKeThe.count({ where: { cardId: A, laNeoMoSo: false } })).toBe(1);
  });

  it("lượt đóng thẻ đang giữ khoá ⇒ chotSaoKe chờ rồi thấy 'Thẻ đã đóng', 0 kỳ", async () => {
    const A = await theCoNeo0();
    const { r, ms } = await trongLucGiuKhoaThe(
      A,
      (tx) => tx.theTinDung.update({ where: { id: A }, data: { closedAt: vn("2026-11-26") } }),
      () => chot(A)
    );
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(r).toMatchObject({ ok: false, error: "Thẻ đã đóng" });
    expect(await prisma.kySaoKeThe.count({ where: { cardId: A, laNeoMoSo: false } })).toBe(0);
  });

  it("lượt chốt sao kê có nợ đang giữ khoá ⇒ dongThe chờ rồi bị từ chối 'còn dư nợ'", async () => {
    const A = await theCoNeo0();
    const { r, ms } = await trongLucGiuKhoaThe(
      A,
      (tx) =>
        tx.kySaoKeThe.create({
          data: { cardId: A, ngayChot: vn("2026-11-25"), soDu: tr(4), hanTra: vn("2026-12-10") },
        }),
      () => dongThe(A)
    );
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("dư nợ") });
    expect((await prisma.theTinDung.findUniqueOrThrow({ where: { id: A } })).closedAt).toBeNull();
  });
});
