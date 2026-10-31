/**
 * Seam "restore khô" của `POST /api/restore` (chỉ bản build e2e cổng ghi — `docRestoreKhoE2e`): đi ĐÚNG
 * chuỗi khoá thật (lease → X → cờ → drain → cổng SyncLog → fencing) rồi dừng trước bản lùi; và TẮT hẳn
 * khi thiếu một trong hai điều kiện (`E2E_CONG_GHI=1` + request đã được module chỉ-test đăng ký).
 *
 * Mock đúng các cửa ra ngoài như `cong-ghi-restore-thu-tu.test.ts`: `runPgDump`/`runRestore`/`kiemDumCoM1`
 * (để thấy chúng KHÔNG chạy), cổng quyền (chủ shop giả), thu hồi phiên, cổng SyncLog, nhật ký. Cửa, bộ
 * đếm, drain, khoá X THẬT trên DB test, lease việc nặng thật.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/session", () => ({
  thuHoiMoiPhienMoiNguoi: vi.fn(async () => undefined),
}));
vi.mock("@/lib/quyen/nguoi-dung-phien", async (importActual) => {
  const that = await importActual<typeof import("@/lib/quyen/nguoi-dung-phien")>();
  const { nguoiDungGia } = await import("../helpers/nguoi-dung-gia");
  return { ...that, docNguoiDungPhien: vi.fn(async () => nguoiDungGia()) };
});
vi.mock("@/lib/backup/thu-hoi-phien-co-han", () => ({
  thuHoiMoiPhienCoHan: vi.fn(async () => undefined),
}));
vi.mock("@/lib/ingest/sync-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ingest/sync-log")>()),
  coLuotDangChay: vi.fn(async () => false),
}));
vi.mock("@/lib/backup/run-pg-dump", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backup/run-pg-dump")>()),
  runPgDump: vi.fn(async () => Buffer.from("PGDMP-ban-lui-gia")),
}));
vi.mock("@/lib/backup/run-restore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backup/run-restore")>()),
  kiemDumCoM1: vi.fn(async () => undefined),
  runRestore: vi.fn(async () => ({ format: "custom" as const })),
}));
vi.mock("@/lib/nhat-ky/ghi-nhat-ky", async (importOriginal) => {
  const that = await importOriginal<typeof import("@/lib/nhat-ky/ghi-nhat-ky")>();
  return { ...that, ghiNhatKy: vi.fn(async () => undefined), ghiNhatKyLoi: vi.fn(async () => undefined) };
});

import { POST } from "@/app/api/restore/route";
import { docBoDem, vaoCuaGhi } from "@/lib/backup/cong-ghi-toan-cuc";
import {
  choBarrierE2e,
  dangKyRestoreKhoE2e,
  HAN_CHO_BARRIER_MS,
  soDangChoBarrierE2e,
  thaBarrierE2e,
} from "@/lib/backup/cong-ghi-e2e-chi-test";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { SO_KHOA_GHI_CHUNG } from "@/lib/backup/khoa-chung-cli";
import { runPgDump } from "@/lib/backup/run-pg-dump";
import { kiemDumCoM1, runRestore } from "@/lib/backup/run-restore";
import { ghiNhatKy, ghiNhatKyLoi } from "@/lib/nhat-ky/ghi-nhat-ky";
import { prisma } from "@/lib/prisma";

import { anhDuLieu, chayGocRieng, choDen, datLaiCongGhi, daSettle, doiChieu, donDuLieu, k, taoBarrier } from "./cong-ghi-helpers";

/** Request KHÔNG có thân (restore khô không đọc file) — lối thật gặp nó thì dừng ở bước đọc file (400). */
const yeuCauRong = (): Request => new Request("http://localhost/api/e2e-cong-ghi?lam=restore-kho", { method: "POST" });

async function soPhienGiuX(): Promise<number> {
  const r = await doiChieu.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_locks
     WHERE locktype = 'advisory' AND classid = 0 AND objid = ${SO_KHOA_GHI_CHUNG} AND objsubid = 1
       AND mode = 'ExclusiveLock' AND granted
       AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
  return r[0].n;
}

/** Action giữ cửa: ghi lần 1 → chờ barrier → ghi lần 2. */
function actionGiuCua(b: ReturnType<typeof taoBarrier>) {
  return chayGocRieng(async () => {
    const cua = vaoCuaGhi();
    if (!cua.ok) return cua.loi;
    try {
      await prisma.setting.create({ data: { key: k("kho:1"), value: "x" } });
      await b.cho();
      await prisma.setting.create({ data: { key: k("kho:2"), value: "x" } });
      return { ok: true as const, xongLuc: Date.now() };
    } finally {
      cua.ra();
    }
  });
}

beforeEach(async () => {
  await donDuLieu();
  vi.stubEnv("E2E_CONG_GHI", "1");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(runPgDump).mockClear();
  vi.mocked(runRestore).mockClear();
  vi.mocked(kiemDumCoM1).mockClear();
  vi.mocked(ghiNhatKy).mockClear();
  vi.mocked(ghiNhatKyLoi).mockClear();
});
afterEach(() => {
  datLaiCongGhi();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await donDuLieu();
  await doiChieu.$disconnect();
});

describe("POST /api/restore — seam restore khô (chỉ bản build e2e)", () => {
  it("đã đăng ký + E2E_CONG_GHI=1 ⇒ đi trọn chuỗi khoá rồi dừng: 200, KHÔNG đọc file/bản lùi/nạp, không nhật ký; nhả cờ + X", async () => {
    const req = yeuCauRong();
    dangKyRestoreKhoE2e(req, 5_000);
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, khoE2e: "da-drain", boDem: { soRequest: 0, dangPhucHoi: true } });
    expect(kiemDumCoM1).not.toHaveBeenCalled();
    expect(runPgDump).not.toHaveBeenCalled();
    expect(runRestore).not.toHaveBeenCalled();
    expect(ghiNhatKy).not.toHaveBeenCalled();
    expect(ghiNhatKyLoi).not.toHaveBeenCalled();
    expect(dangPhucHoi()).toBe(false);
    expect(await soPhienGiuX()).toBe(0);
    // Lease việc nặng đã trả: lượt khô kế tiếp giành lại được ngay.
    const lai = yeuCauRong();
    dangKyRestoreKhoE2e(lai, 5_000);
    expect((await POST(lai)).status).toBe(200);
  });

  it("thiếu E2E_CONG_GHI=1 (dù request đã đăng ký) ⇒ seam tắt: lối thật, dừng ở bước đọc file 400, chưa giành khoá", async () => {
    const req = yeuCauRong();
    dangKyRestoreKhoE2e(req, 5_000);
    vi.stubEnv("E2E_CONG_GHI", "");
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(dangPhucHoi()).toBe(false);
    expect(ghiNhatKyLoi).toHaveBeenCalledTimes(1); // lối thật ghi nhật ký LOI như mọi lượt bị từ chối
  });

  it("E2E_CONG_GHI=1 nhưng request KHÔNG được đăng ký (cùng URL, object khác) ⇒ seam tắt: 400", async () => {
    dangKyRestoreKhoE2e(yeuCauRong(), 5_000);
    const res = await POST(yeuCauRong());
    expect(res.status).toBe(400);
    expect(kiemDumCoM1).not.toHaveBeenCalled();
  });

  it("request ĐÃ đăng ký mà hạn drain lạ ⇒ 400 cứng, KHÔNG rơi về lối thật dù request mang file hợp lệ", async () => {
    dangKyRestoreKhoE2e(yeuCauRong(), 5_000); // dựng bảng đăng ký (đường hợp lệ duy nhất)
    const bang = (globalThis as unknown as Record<symbol, WeakMap<Request, { hanDrainMs: unknown }> | undefined>)[
      Symbol.for("hogikids.e2eCongGhi.restoreKho")
    ];
    expect(bang).toBeDefined();
    for (const hanLa of [0, 1.5, 120_001, "5000", undefined]) {
      const fd = new FormData();
      fd.append("file", new File([Buffer.from("PGDMP\x01noi-dung-gia")], "backup.dump"));
      const req = new Request("http://localhost/api/e2e-cong-ghi?lam=restore-kho", { method: "POST", body: fd });
      bang!.set(req, { hanDrainMs: hanLa });
      const res = await POST(req);
      expect(res.status, String(hanLa)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/hạn drain/);
    }
    // Lối thật với file này sẽ gọi kiemDumCoM1 rồi giành khoá + chụp bản lùi — không bước nào được chạy.
    expect(kiemDumCoM1).not.toHaveBeenCalled();
    expect(runPgDump).not.toHaveBeenCalled();
    expect(ghiNhatKyLoi).not.toHaveBeenCalled();
    expect(dangPhucHoi()).toBe(false);
  });

  it("barrier chỉ-test có hạn: action đứng chờ quá HAN_CHO_BARRIER_MS ⇒ ném, không giữ cửa vô hạn", async () => {
    vi.useFakeTimers();
    try {
      let xong = false;
      const loi = choBarrierE2e().then(
        () => ((xong = true), null),
        (e: unknown) => ((xong = true), e),
      );
      expect(soDangChoBarrierE2e()).toBe(1);
      await vi.advanceTimersByTimeAsync(HAN_CHO_BARRIER_MS - 1);
      expect(xong, "chưa tới hạn thì vẫn chờ").toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await loi).toBeInstanceOf(Error);
      expect(soDangChoBarrierE2e()).toBe(0);
    } finally {
      thaBarrierE2e();
      vi.useRealTimers();
    }
  });

  it("đăng ký từ chối khi thiếu biến / hạn drain lạ", () => {
    expect(() => dangKyRestoreKhoE2e(yeuCauRong(), 0)).toThrow(RangeError);
    expect(() => dangKyRestoreKhoE2e(yeuCauRong(), 1.5)).toThrow(RangeError);
    expect(() => dangKyRestoreKhoE2e(yeuCauRong(), 120_001)).toThrow(RangeError);
    vi.stubEnv("E2E_CONG_GHI", "");
    expect(() => dangKyRestoreKhoE2e(yeuCauRong(), 5_000)).toThrow(/E2E_CONG_GHI=1/);
  });

  it("action vào trước cờ ⇒ restore khô CHỜ nó ghi xong; action mới bị từ chối trong lúc chờ", async () => {
    const b = taoBarrier();
    const action = actionGiuCua(b);
    await b.daToi;

    const req = yeuCauRong();
    dangKyRestoreKhoE2e(req, 10_000);
    const phucHoi = POST(req);
    await choDen(() => docBoDem().dangDrain);
    expect(dangPhucHoi()).toBe(true);
    expect(await daSettle(phucHoi)).toBe(false);
    expect(
      await chayGocRieng(async () => {
        const cua = vaoCuaGhi();
        if (!cua.ok) return cua.loi;
        cua.ra();
        return { ok: true as const };
      }),
    ).toEqual({ ok: false, error: LOI_DANG_PHUC_HOI });

    b.mo();
    const kqAction = await action;
    const res = await phucHoi;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { luc: number };
    expect(kqAction).toMatchObject({ ok: true });
    expect(body.luc).toBeGreaterThanOrEqual((kqAction as { xongLuc: number }).xongLuc);
    expect(await anhDuLieu()).toEqual([`${k("kho:1")}=x`, `${k("kho:2")}=x`]);
    expect(dangPhucHoi()).toBe(false);
  });

  it("hạn drain ngắn khi action còn giữ cửa ⇒ 409 'chưa đổi gì', cờ + X nhả, action vẫn ghi xong", async () => {
    const b = taoBarrier();
    const action = actionGiuCua(b);
    await b.daToi;

    const req = yeuCauRong();
    dangKyRestoreKhoE2e(req, 50);
    const res = await POST(req);
    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: string };
    expect(error).toMatch(/Còn 1 lượt ghi trong app/);
    expect(error).toMatch(/còn nguyên/);
    expect(runPgDump).not.toHaveBeenCalled();
    expect(dangPhucHoi()).toBe(false);
    expect(await soPhienGiuX()).toBe(0);
    expect(docBoDem().soRequest).toBe(1);

    b.mo();
    expect(await action).toMatchObject({ ok: true });
    expect(await anhDuLieu()).toEqual([`${k("kho:1")}=x`, `${k("kho:2")}=x`]);
  });
});
