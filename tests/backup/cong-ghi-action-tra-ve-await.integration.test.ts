/**
 * Action trả về lời gọi hàm con có transaction: `return await suaPhieu(...)` trong
 * `try { … } finally { cua.ra(); }`. Thiếu `await` thì `finally` chạy ngay khi hàm con chạm `await`
 * đầu tiên — cửa đóng, bộ đếm trả, trong khi transaction còn chạy ⇒ drain báo sạch và lượt phục hồi
 * chụp bản lùi TRƯỚC lúc lượt sửa COMMIT (bản lùi thiếu một lần sửa đã báo thành công).
 *
 * Hành vi đúng: drain CHƯA xong chừng nào transaction của hàm con còn treo; xong thì dữ liệu đã commit.
 * Barrier chèn ở `ghiNhatKy(tx, …)` — câu nằm GIỮA transaction của `suaPhieu`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { choDrain } from "@/lib/backup/cong-ghi-toan-cuc";
import { prisma } from "@/lib/prisma";

import { donFixtureNoPhaiTra, seedBronze, vn } from "../helpers/phieu-nhap-no-fixture";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";
import { batCo, chayGocRieng, daSettle, datLaiCongGhi, doiChieu, taoBarrier } from "./cong-ghi-helpers";

const { chan } = vi.hoisted(() => ({ chan: { cho: null as null | (() => Promise<void>) } }));

vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => {
  const { nguoiDungGia: gia } = await import("../helpers/nguoi-dung-gia");
  return {
    ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
    docNguoiDungPhien: vi.fn(async () => gia()),
  };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/nhat-ky/ghi-nhat-ky", async (goc) => {
  const that = await goc<typeof import("@/lib/nhat-ky/ghi-nhat-ky")>();
  return {
    ...that,
    ghiNhatKy: vi.fn(async (...a: Parameters<typeof that.ghiNhatKy>) => {
      const cho = chan.cho;
      if (cho) {
        chan.cho = null;
        await cho();
      }
      return that.ghiNhatKy(...a);
    }),
  };
});

const { ghiNhanPhieuVaoSoNo, danhDauHuyPhieu } = await import("@/lib/actions/phieu-nhap-no");

const P1 = { uuid: "uuid-tra-ve-await", displayId: 1, insertedAt: "2026-09-20T03:00:00", tongTien: 100_000_000 };

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  chan.cho = null;
  await truncateBusinessTables();
  await donFixtureNoPhaiTra();
  await seedBronze(P1, vn("2026-09-30T12:00:00"));
});

afterEach(() => {
  chan.cho = null;
  datLaiCongGhi();
});

afterAll(async () => {
  await truncateBusinessTables();
  await donFixtureNoPhaiTra();
  await doiChieu.$disconnect();
  await prisma.$disconnect();
});

describe("action trả về hàm con có transaction", () => {
  it("danhDauHuyPhieu treo giữa transaction ⇒ drain CHỜ tới khi COMMIT, không báo sạch sớm", async () => {
    const ghi = await ghiNhanPhieuVaoSoNo({ uuid: P1.uuid });
    if (!ghi.ok) throw new Error(ghi.error);
    const id = ghi.data.phieuNhapId;

    const b = taoBarrier();
    chan.cho = b.cho;
    const action = chayGocRieng(() => danhDauHuyPhieu({ phieuNhapId: id }));
    await b.daToi; // đang giữa transaction của `suaPhieu`, phiếu đã update nhưng chưa commit

    batCo();
    const drain = choDrain(30_000).then(async (ok) => ({
      ok,
      daHuyLucDrainXong: (await doiChieu.phieuNhapNo.findUniqueOrThrow({ where: { id } })).daHuy,
    }));
    expect(await daSettle(drain)).toBe(false);

    b.mo();
    expect(await action).toMatchObject({ ok: true });
    // Drain chỉ xong SAU commit ⇒ bản lùi chụp sau đó có lần huỷ này.
    expect(await drain).toEqual({ ok: true, daHuyLucDrainXong: true });
  });
});
