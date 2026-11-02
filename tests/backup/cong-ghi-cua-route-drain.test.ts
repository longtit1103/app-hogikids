/**
 * Cửa ROUTE (`routeQuaCua`) + drain:
 * - cờ bật ⇒ 503 + `Retry-After: 60` NGAY, thân handler không chạy;
 * - request đã vào giữ cổng suốt land → transform (không nhả theo từng op); ném giữa chừng vẫn nhả;
 * - drain quá hạn ⇒ `false`, request vẫn chạy xong; bộ đếm không âm/không rò dưới tải song song;
 * - TTL cờ tự nhả ⇒ cửa mở lại;
 * - route SÓT cửa: land → cờ → transform ném ⇒ backlog + SyncLog ERROR vẫn ghi (lối miễn THẬT
 *   `markBronzeBacklog` + `withSyncLog`), Silver không có, n8n gửi lại trang ⇒ landed rỗng.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { choDrain, docBoDem, laLoiCongGhiDangKhoa, routeQuaCua } from "@/lib/backup/cong-ghi-toan-cuc";
import { TTL_KHOA_PHUC_HOI_MS } from "@/lib/backup/han-chay-lenh-pg";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { hasBronzeBacklog, markBronzeBacklog } from "@/lib/bronze/bronze-only";
import { withSyncLog } from "@/lib/ingest/sync-log";
import { prisma } from "@/lib/prisma";

import { anhDuLieu, batCo, chayGocRieng, daSettle, datLaiCongGhi, doiChieu, donDuLieu, k, taoBarrier, traCoNeuCon } from "./cong-ghi-helpers";

const KHOA_BACKLOG = "bronzeBacklogPending";

beforeEach(async () => {
  await donDuLieu();
  await doiChieu.setting.deleteMany({ where: { key: KHOA_BACKLOG } });
});
afterEach(async () => {
  datLaiCongGhi();
  vi.restoreAllMocks();
  await doiChieu.setting.deleteMany({ where: { key: KHOA_BACKLOG } });
});
afterAll(async () => {
  await donDuLieu();
  await doiChieu.$disconnect();
});

const SQL_LAND = `INSERT INTO "Setting" (key, value) VALUES ($1, 'bronze') ON CONFLICT (key) DO NOTHING RETURNING key`;

async function land(id: string): Promise<string[]> {
  const r = await prisma.$queryRawUnsafe<{ key: string }[]>(SQL_LAND, k(`bronze:${id}`));
  return r.map((x) => x.key);
}

describe("cửa route", () => {
  it("cờ bật ⇒ 503 + Retry-After 60, thân handler KHÔNG chạy", async () => {
    batCo();
    let daChay = false;
    const res = await chayGocRieng(() =>
      routeQuaCua(async () => {
        daChay = true;
        return new Response("ok");
      }),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(await res.json()).toEqual({ ok: false, error: LOI_DANG_PHUC_HOI });
    expect(daChay).toBe(false);
  });

  it("request dừng giữa land và transform ⇒ drain chưa xong; xong ⇒ drain thấy cả Bronze + Silver", async () => {
    const b = taoBarrier();
    const req = chayGocRieng(() =>
      routeQuaCua(async () => {
        await land("1");
        await b.cho();
        await prisma.setting.upsert({ where: { key: k("silver:1") }, create: { key: k("silver:1"), value: "s" }, update: {} });
        return new Response("ok");
      }),
    );
    await b.daToi;
    batCo();
    const drain = choDrain(30_000).then(async (ok) => ({ ok, anh: await anhDuLieu() }));
    expect(await daSettle(drain)).toBe(false);
    b.mo();
    await req;
    expect(await drain).toEqual({ ok: true, anh: [`${k("bronze:1")}=bronze`, `${k("silver:1")}=s`] });
  });

  it("request ném giữa chừng ⇒ đếm về 0, drain xong", async () => {
    const b = taoBarrier();
    const req = chayGocRieng(() =>
      routeQuaCua(async () => {
        await land("2");
        await b.cho();
        throw new Error("transform hỏng");
      }),
    );
    await b.daToi;
    batCo();
    const drain = choDrain(30_000);
    expect(await daSettle(drain)).toBe(false);
    b.mo();
    await expect(req).rejects.toThrow("transform hỏng");
    expect(await drain).toBe(true);
    expect(docBoDem()).toMatchObject({ soRequest: 0, soOpLe: 0 });
  });

  it("drain quá hạn ⇒ false; request vẫn chạy xong, bộ đếm sạch", async () => {
    const b = taoBarrier();
    const req = chayGocRieng(() =>
      routeQuaCua(async () => {
        await land("3");
        await b.cho();
        await prisma.setting.create({ data: { key: k("silver:3"), value: "s" } });
        return new Response("ok");
      }),
    );
    await b.daToi;
    batCo();
    expect(await choDrain(200)).toBe(false);
    expect(docBoDem().dangDrain).toBe(false);
    b.mo();
    expect((await req).status).toBe(200);
    expect(docBoDem()).toMatchObject({ soRequest: 0, soOpLe: 0, dangDrain: false });
  });

  it("40 request + 20 op lẻ song song, nửa ném ⇒ đếm về 0, không âm", async () => {
    const viec: Promise<unknown>[] = [];
    for (let i = 0; i < 40; i++) {
      viec.push(
        chayGocRieng(() =>
          routeQuaCua(async () => {
            await prisma.setting.create({ data: { key: k(`n${i}`), value: "x" } });
            if (i % 2) throw new Error("hỏng");
            return new Response("ok");
          }),
        ).catch(() => {}),
      );
    }
    for (let i = 0; i < 20; i++) {
      // op lẻ ném ở DB (trùng khoá chính) — đếm vẫn phải trả về.
      viec.push(chayGocRieng(() => prisma.$executeRaw`INSERT INTO "Setting" (key, value) VALUES (${k("dup")}, 'x')`).catch(() => {}));
    }
    await Promise.all(viec);
    expect(docBoDem()).toMatchObject({ soRequest: 0, soOpLe: 0 });
    expect(await choDrain(1)).toBe(true);
  });

  it("TTL cờ tự nhả ⇒ cửa mở lại", async () => {
    batCo();
    expect((await chayGocRieng(() => routeQuaCua(async () => new Response("ok")))).status).toBe(503);
    const goc = performance.now();
    vi.spyOn(performance, "now").mockReturnValue(goc + TTL_KHOA_PHUC_HOI_MS + 1);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await chayGocRieng(() =>
      routeQuaCua(async () => {
        await prisma.setting.create({ data: { key: k("ttl"), value: "x" } });
        return new Response("ok");
      }),
    );
    expect(res.status).toBe(200);
    expect(dangPhucHoi()).toBe(false);
  });
});

describe("route SÓT cửa — lưới phụ + lối miễn THẬT", () => {
  it("land → cờ → transform ném ⇒ backlog bật + SyncLog ERROR; gửi lại trang ⇒ landed rỗng, Silver không có", async () => {
    const b = taoBarrier();
    let idLog = "";
    // Mô phỏng route sót cửa: KHÔNG `routeQuaCua`, chỉ `withSyncLog` thật như các route ingest.
    // withSyncLog tạo RUNNING khi cờ CÒN tắt (op lẻ), rồi fn land → chờ → cờ bật → transform ném.
    const ingest = chayGocRieng(() =>
      withSyncLog("PANCAKE", async (_warnings, syncLogId) => {
        idLog = syncLogId;
        const landed = await land("4");
        await b.cho();
        try {
          await prisma.setting.upsert({ where: { key: k("silver:4") }, create: { key: k("silver:4"), value: "s" }, update: {} });
        } catch (e) {
          await markBronzeBacklog();
          throw e;
        }
        return { landed: landed.length };
      }),
    );
    await b.daToi;
    batCo(); // lượt phục hồi bắt đầu
    b.mo();
    const res = await ingest;
    expect(res.status).toBe(500);
    traCoNeuCon(); // lượt phục hồi bị huỷ (vd drain quá hạn) ⇒ cờ nhả, DB giữ nguyên

    expect(await hasBronzeBacklog()).toBe(true);
    const log = await doiChieu.syncLog.findUniqueOrThrow({ where: { id: idLog } });
    expect(log.status).toBe("ERROR");
    expect(log.error).toBe(LOI_DANG_PHUC_HOI);
    // n8n gửi lại đúng trang: trùng khoá ⇒ landed rỗng ⇒ transform theo trang không có gì làm.
    expect(await land("4")).toEqual([]);
    expect(await anhDuLieu()).not.toContain(`${k("silver:4")}=s`);
    await doiChieu.syncLog.delete({ where: { id: idLog } });
  });

  it("SyncLog RUNNING/OK KHÔNG phải lối miễn: cờ bật, ngoài cửa ⇒ withSyncLog bị chặn ngay câu ghi đầu", async () => {
    const truoc = await doiChieu.syncLog.count({ where: { kind: "PANCAKE" } });
    batCo();
    await expect(chayGocRieng(() => withSyncLog("PANCAKE", async () => ({ ok: 1 })))).rejects.toSatisfy(laLoiCongGhiDangKhoa);
    expect(await doiChieu.syncLog.count({ where: { kind: "PANCAKE" } })).toBe(truoc);
  });

  it("kết cục OK bị chặn khi cờ bật giữa chừng ⇒ dòng log thành ERROR (lối miễn), không phải OK", async () => {
    let idLog = "";
    const res = await chayGocRieng(() =>
      withSyncLog("PANCAKE", async (_w, syncLogId) => {
        idLog = syncLogId;
        batCo(); // cờ bật SAU khi RUNNING đã tạo, TRƯỚC câu ghi kết cục OK
        return { xong: 1 };
      }),
    );
    expect(res.status).toBe(500);
    const log = await doiChieu.syncLog.findUniqueOrThrow({ where: { id: idLog } });
    expect(log.status).toBe("ERROR");
    await doiChieu.syncLog.delete({ where: { id: idLog } });
  });
});
