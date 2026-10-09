import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { bamNoiDung, ghiKetQua, giuYeuCau } from "@/lib/no-phai-tra/yeu-cau-ghi";
import { prisma } from "@/lib/prisma";

/**
 * `YeuCauGhi` — chống ghi lặp khi mất phản hồi (spec §5.3 bước 1 và 6). Bước giữ mã là
 * `INSERT … ON CONFLICT (id) DO NOTHING RETURNING id`: KHÔNG bao giờ để Postgres ném unique violation,
 * vì lỗi đó huỷ CẢ transaction (mọi câu sau đều "current transaction is aborted"). Bốn ca:
 *  (a) mã mới ⇒ "MOI"; (b) mã đã commit ⇒ trả dòng cũ mà tx KHÔNG abort; (c) lượt đầu rollback ⇒ lượt
 *  sau ghi được; (d) hai lượt đồng thời cùng mã ⇒ lượt 2 CHỜ ở unique index tới khi lượt 1 commit rồi
 *  mới thấy dòng cũ — không bao giờ hai lượt cùng ghi.
 */
const TIEN_TO = "test-ycg-";
const maMoi = () => `${TIEN_TO}${randomUUID()}`;
const ngu = (ms: number) => new Promise((r) => setTimeout(r, ms));

const don = () => prisma.yeuCauGhi.deleteMany({ where: { id: { startsWith: TIEN_TO } } });
beforeEach(don);
afterAll(async () => {
  await don();
  await prisma.$disconnect();
});

describe("bamNoiDung", () => {
  it("không phụ thuộc thứ tự khoá (kể cả lồng nhau), đổi nội dung là đổi vân tay", () => {
    const a = bamNoiDung({ tong: 10, phanBo: [{ phieu: "p1", tien: 4 }, { tien: 6, phieu: "p2" }], ngay: "2026-11-05" });
    const b = bamNoiDung({ ngay: "2026-11-05", phanBo: [{ tien: 4, phieu: "p1" }, { phieu: "p2", tien: 6 }], tong: 10 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(bamNoiDung({ tong: 11 })).not.toBe(bamNoiDung({ tong: 10 }));
    // Thứ tự PHẦN TỬ mảng là nội dung (phân bổ đổi chỗ = yêu cầu khác) — không được sắp lại.
    expect(bamNoiDung([1, 2])).not.toBe(bamNoiDung([2, 1]));
  });
});

describe("giuYeuCau / ghiKetQua", () => {
  it("(a) mã mới ⇒ MOI; ghiKetQua cùng tx ⇒ sau commit đọc được kết quả", async () => {
    const id = maMoi();
    const bam = bamNoiDung({ x: 1 });
    const kq = await prisma.$transaction(async (tx) => {
      const r = await giuYeuCau(tx, { id, loai: "TRA_GOP_NCC", bam });
      await ghiKetQua(tx, id, { ok: true, data: { soDong: 2 } });
      return r;
    });
    expect(kq).toBe("MOI");
    expect(await prisma.yeuCauGhi.findUniqueOrThrow({ where: { id } })).toMatchObject({
      loai: "TRA_GOP_NCC",
      bamNoiDung: bam,
      ketQua: { ok: true, data: { soDong: 2 } },
    });
  });

  it("(b) mã đã commit ⇒ trả dòng cũ và tx KHÔNG bị abort (câu sau vẫn chạy)", async () => {
    const id = maMoi();
    const bam = bamNoiDung({ x: 2 });
    await prisma.$transaction(async (tx) => {
      await giuYeuCau(tx, { id, loai: "TRA_GOP_NCC", bam });
      await ghiKetQua(tx, id, { ok: true, data: "lan-dau" });
    });

    const { lan2, motCau } = await prisma.$transaction(async (tx) => {
      const lan2 = await giuYeuCau(tx, { id, loai: "TRA_GOP_NCC", bam });
      const motCau = await tx.$queryRaw<{ x: number }[]>`SELECT 1 AS x`;
      return { lan2, motCau };
    });
    expect(lan2).toEqual({ cu: { bamNoiDung: bam, ketQua: { ok: true, data: "lan-dau" } } });
    expect(motCau).toEqual([{ x: 1 }]);
    expect(await prisma.yeuCauGhi.count({ where: { id } })).toBe(1);
  });

  it("(c) lượt đầu rollback ⇒ mã không bị giữ, lượt sau ghi được (MOI)", async () => {
    const id = maMoi();
    const bam = bamNoiDung({ x: 3 });
    await expect(
      prisma.$transaction(async (tx) => {
        await giuYeuCau(tx, { id, loai: "TRA_GOP_NCC", bam });
        throw new Error("vân tay đổi sau khoá — huỷ");
      }),
    ).rejects.toThrow(/huỷ/);
    expect(await prisma.yeuCauGhi.count({ where: { id } })).toBe(0);

    const lai = await prisma.$transaction(async (tx) => {
      const r = await giuYeuCau(tx, { id, loai: "TRA_GOP_NCC", bam });
      await ghiKetQua(tx, id, { ok: true, data: null });
      return r;
    });
    expect(lai).toBe("MOI");
  });

  it(
    "(d) hai tx song song cùng mã ⇒ tx 2 chờ tới khi tx 1 commit rồi thấy dòng cũ",
    async () => {
      const id = maMoi();
      const bam = bamNoiDung({ x: 4 });
      let bao1DaGiu!: () => void;
      const tx1DaGiu = new Promise<void>((r) => (bao1DaGiu = r));
      let tx1XongThan = 0;
      let tx2CoKetQua = 0;

      const tx1 = prisma.$transaction(
        async (tx) => {
          const r = await giuYeuCau(tx, { id, loai: "XAC_NHAN_BAT", bam });
          bao1DaGiu();
          await ngu(1_500); // tx 2 phải đứng chờ suốt khoảng này
          await ghiKetQua(tx, id, { ok: true, data: "tx1" });
          tx1XongThan = Date.now(); // ngay trước COMMIT
          return r;
        },
        { timeout: 15_000 },
      );

      const tx2 = (async () => {
        await tx1DaGiu;
        return prisma.$transaction(
          async (tx) => {
            const r = await giuYeuCau(tx, { id, loai: "XAC_NHAN_BAT", bam });
            tx2CoKetQua = Date.now();
            return r;
          },
          { timeout: 15_000 },
        );
      })();

      const [r1, r2] = await Promise.all([tx1, tx2]);
      expect(r1).toBe("MOI");
      expect(r2).toEqual({ cu: { bamNoiDung: bam, ketQua: { ok: true, data: "tx1" } } });
      expect(tx1XongThan).toBeGreaterThan(0);
      expect(tx2CoKetQua).toBeGreaterThanOrEqual(tx1XongThan);
      expect(await prisma.yeuCauGhi.count({ where: { id } })).toBe(1);
    },
    30_000,
  );

  it("ghiKetQua cho mã chưa giữ ⇒ ném (đường ghi quên bước 1)", async () => {
    await expect(prisma.$transaction((tx) => ghiKetQua(tx, maMoi(), { ok: true, data: 1 }))).rejects.toThrow();
  });
});
