/**
 * Cổng ghi với `$transaction` của singleton `prisma` THẬT:
 * - tx lẻ mở SAU cờ ⇒ đọc được, ném ở op ghi đầu (cả model lẫn raw trên client `tx`), không commit.
 * - batch: PrismaPromise tạo TRƯỚC cờ, thực thi SAU cờ ⇒ ném.
 * - tx của request vào TRƯỚC cờ chạy xong; drain chờ tới khi tx COMMIT.
 * - tx lẻ (không cửa) mở TRƯỚC cờ: ghi sau cờ vẫn qua, drain chờ cả tx.
 * - action trả promise tx mà quên `await` (cửa đóng sớm): tx vẫn được đếm riêng, drain chờ tới COMMIT.
 * - `vi.spyOn(prisma, "$transaction")` trên singleton đã bọc cổng vẫn thay được hàm, gỡ spy trả lại
 *   đúng bản bọc (vẫn đếm tx lẻ cho drain).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { choDrain, docBoDem, laLoiCongGhiDangKhoa, routeQuaCua, vaoCuaGhi } from "@/lib/backup/cong-ghi-toan-cuc";
import { prisma } from "@/lib/prisma";

import { anhDuLieu, batCo, chayGocRieng, daSettle, datLaiCongGhi, doiChieu, donDuLieu, k, taoBarrier, traCoNeuCon } from "./cong-ghi-helpers";

beforeEach(() => donDuLieu());
afterEach(() => datLaiCongGhi());
afterAll(async () => {
  await donDuLieu();
  await doiChieu.$disconnect();
});

describe("transaction", () => {
  it("tx lẻ mở SAU cờ: đọc được, ném ở op ghi đầu, không commit", async () => {
    batCo();
    let daDoc = false;
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.setting.count();
        daDoc = true;
        await tx.setting.create({ data: { key: k("tx-sau"), value: "x" } });
      }),
    ).rejects.toSatisfy(laLoiCongGhiDangKhoa);
    expect(daDoc).toBe(true);
    traCoNeuCon();
    expect(await anhDuLieu()).toEqual([]);
  });

  it("tx lẻ mở SAU cờ: raw ghi trên client tx cũng ném", async () => {
    batCo();
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`INSERT INTO "Setting" (key, value) VALUES (${k("tx-raw")}, 'x')`;
      }),
    ).rejects.toSatisfy(laLoiCongGhiDangKhoa);
    traCoNeuCon();
    expect(await anhDuLieu()).toEqual([]);
  });

  it("batch: PrismaPromise tạo TRƯỚC cờ, thực thi SAU cờ ⇒ ném, không commit", async () => {
    const p1 = prisma.setting.create({ data: { key: k("b1"), value: "x" } });
    const p2 = prisma.setting.create({ data: { key: k("b2"), value: "x" } });
    batCo();
    await expect(prisma.$transaction([p1, p2])).rejects.toSatisfy(laLoiCongGhiDangKhoa);
    traCoNeuCon();
    expect(await anhDuLieu()).toEqual([]);
  });

  it("batch trong request vào trước cờ ⇒ chạy xong", async () => {
    const b = taoBarrier();
    const req = chayGocRieng(() =>
      routeQuaCua(async () => {
        const p1 = prisma.setting.create({ data: { key: k("rb1"), value: "x" } });
        const p2 = prisma.$executeRaw`INSERT INTO "Setting" (key, value) VALUES (${k("rb2")}, 'x')`;
        await b.cho();
        await prisma.$transaction([p1, p2]);
        return new Response("ok");
      }),
    );
    await b.daToi;
    batCo();
    b.mo();
    expect((await req).status).toBe(200);
    expect(await anhDuLieu()).toEqual([`${k("rb1")}=x`, `${k("rb2")}=x`]);
  });

  it("tx của request vào TRƯỚC cờ: ghi sau cờ qua, drain chờ tới khi tx commit", async () => {
    const b = taoBarrier();
    const req = chayGocRieng(() =>
      routeQuaCua(async () => {
        await prisma.$transaction(async (tx) => {
          await tx.setting.create({ data: { key: k("rq1"), value: "x" } });
          await b.cho();
          await tx.setting.create({ data: { key: k("rq2"), value: "x" } });
        });
        return new Response("ok");
      }),
    );
    await b.daToi;
    batCo();
    // Lúc drain báo sạch, đọc từ kết nối KHÁC: tx phải đã COMMIT (thấy cả 2 dòng).
    const drain = choDrain(30_000).then(async (ok) => ({ ok, anh: await anhDuLieu() }));
    expect(await daSettle(drain)).toBe(false);
    b.mo();
    await req;
    expect(await drain).toEqual({ ok: true, anh: [`${k("rq1")}=x`, `${k("rq2")}=x`] });
  });

  it("tx lẻ (không cửa) mở TRƯỚC cờ: drain chờ cả tx, ghi sau cờ vẫn qua", async () => {
    const b = taoBarrier();
    const tx = chayGocRieng(() =>
      prisma.$transaction(async (t) => {
        await t.setting.create({ data: { key: k("le1"), value: "x" } });
        await b.cho();
        await t.setting.create({ data: { key: k("le2"), value: "x" } });
      }),
    );
    await b.daToi;
    batCo();
    expect(docBoDem().soOpLe).toBe(1);
    const drain = choDrain(30_000).then(async (ok) => ({ ok, anh: await anhDuLieu() }));
    expect(await daSettle(drain)).toBe(false);
    b.mo();
    await tx;
    expect(await drain).toEqual({ ok: true, anh: [`${k("le1")}=x`, `${k("le2")}=x`] });
    expect(docBoDem()).toMatchObject({ soRequest: 0, soOpLe: 0 });
  });

  it("action trả promise tx KHÔNG `await`: cửa đóng sớm nhưng drain vẫn chờ tx COMMIT, ghi sau cờ vẫn qua", async () => {
    const b = taoBarrier();
    // Đúng khuôn action (`vaoCuaGhi` + try/finally) nhưng thiếu `await` ở `return` ⇒ `finally` chạy ngay.
    function actionQuenAwait(): Promise<unknown> {
      const cua = vaoCuaGhi();
      if (!cua.ok) return Promise.resolve(cua.loi);
      try {
        return prisma.$transaction(async (tx) => {
          await tx.setting.create({ data: { key: k("qa1"), value: "x" } });
          await b.cho();
          await tx.setting.create({ data: { key: k("qa2"), value: "x" } });
        });
      } finally {
        cua.ra();
      }
    }
    const req = chayGocRieng(() => actionQuenAwait());
    await b.daToi;
    expect(docBoDem()).toMatchObject({ soRequest: 0, soOpLe: 1 }); // cửa đã đóng, tx vẫn được đếm
    batCo();
    // Lúc drain báo sạch, đọc từ kết nối KHÁC: tx phải đã COMMIT (thấy cả 2 dòng).
    const drain = choDrain(30_000).then(async (ok) => ({ ok, anh: await anhDuLieu() }));
    expect(await daSettle(drain)).toBe(false);
    b.mo();
    await req;
    expect(await drain).toEqual({ ok: true, anh: [`${k("qa1")}=x`, `${k("qa2")}=x`] });
    expect(docBoDem()).toMatchObject({ soRequest: 0, soOpLe: 0 });
  });

  it("spyOn `$transaction` trên singleton có cổng: thay được hàm, gỡ spy trả lại bản bọc cổng", async () => {
    // Test giả lập lỗi/xen giữa lượt ghi dựa vào spy này — spy "gắn" mà không thay được hàm thì
    // lượt chạy vào tx thật trong khi test tưởng đã giả lập.
    const spy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("giả lập DB sập"));
    try {
      await expect(prisma.$transaction(async () => undefined)).rejects.toThrow("giả lập DB sập");
    } finally {
      spy.mockRestore();
    }

    // Gỡ spy ⇒ bản bọc cổng quay lại: tx lẻ vẫn được đếm cho drain.
    const b = taoBarrier();
    const tx = chayGocRieng(() =>
      prisma.$transaction(async (t) => {
        await b.cho();
        await t.setting.create({ data: { key: k("sau-spy"), value: "x" } });
      }),
    );
    await b.daToi;
    expect(docBoDem().soOpLe).toBe(1);
    b.mo();
    await tx;
    expect(docBoDem().soOpLe).toBe(0);
    expect(await anhDuLieu()).toEqual([`${k("sau-spy")}=x`]);
  });
});
