import { format, subMonths, startOfMonth } from "date-fns";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Prisma } from "@prisma/client";

import { batLaiDinhKy, deleteExpense } from "@/lib/actions/expenses";
import { khoaThangDinhKy } from "@/lib/expenses/khoa-thang-dinh-ky";
import { prisma } from "@/lib/prisma";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * Khoá dòng mẫu định kỳ (`RecurringExpense … FOR UPDATE`) — kiểm bằng `FOR UPDATE NOWAIT` từ một kết
 * nối thứ ba thay vì đua giờ: NOWAIT lỗi ngay (SQLSTATE 55P03) khi dòng đang bị khoá, nên kết quả tất
 * định, không phụ thuộc lịch chạy.
 *  - "Bật lại" phải giữ khoá cả nhóm danh mục + kênh tới HẾT transaction (khoá rồi nhả ngay là hai mẫu
 *    trùng bật lại cùng lúc lại cùng chạy).
 *  - "Xoá và dừng lặp lại" phải khoá mẫu TRƯỚC khi chạm dòng `Expense` — cùng thứ tự với lượt sửa
 *    (mẫu → Expense); ngược thứ tự là hai tab sửa + xoá cùng một dòng khoá chéo nhau (deadlock).
 *  - "Bật lại" khoá cả nhóm theo thứ tự `id` (không theo thứ tự quét bảng), và SAU khi giành khoá mới so
 *    tháng chủ shop chọn với tháng này/tháng sau — chờ khoá vắt qua nửa đêm cuối tháng thì mốc vẫn đúng
 *    tháng đã chọn, hoặc bị từ chối "trang cũ"; không bao giờ dời sang tháng khác.
 */
// Ngữ cảnh người dùng giả (mặc định chủ shop) — action đi qua `congAction`, không có cookie trong vitest.
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => {
  const { nguoiDungGia } = await import("./helpers/nguoi-dung-gia");
  return {
    ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
    docNguoiDungPhien: vi.fn(async () => nguoiDungGia()),
  };
});
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const TIEN = 2_000_000;
const TU_THANG_NAY = { thangBatDau: format(startOfMonth(new Date()), "yyyy-MM") };
const thangTruoc = subMonths(startOfMonth(new Date()), 1);

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

/** `FOR UPDATE NOWAIT` autocommit trên một dòng: `true` = dòng đang bị transaction khác khoá. */
async function dangBiKhoa(bang: "RecurringExpense" | "Expense", id: string): Promise<boolean> {
  try {
    if (bang === "RecurringExpense") {
      await prisma.$queryRaw`SELECT id FROM "RecurringExpense" WHERE id = ${id} FOR UPDATE NOWAIT`;
    } else {
      await prisma.$queryRaw`SELECT id FROM "Expense" WHERE id = ${id} FOR UPDATE NOWAIT`;
    }
    return false;
  } catch (e) {
    const moTa = `${e instanceof Error ? e.message : ""} ${JSON.stringify(e)}`;
    if (/55P03|could not obtain lock/.test(moTa)) return true;
    throw e;
  }
}

/**
 * Chờ tới khi một kết nối khác đang ĐỨNG CHỜ khoá dòng trên `RecurringExpense` (`pg_stat_activity`,
 * `wait_event_type = 'Lock'`) — thay cho ngủ cố định: lượt bị chặn chắc chắn đã tới câu khoá.
 */
async function choToiLuotDangChoKhoa(): Promise<void> {
  // `performance.now()` chứ không `Date.now()`: test mốc tháng giả Date (đứng yên) trong lúc gọi hàm này.
  const hetHan = performance.now() + 10_000;
  for (;;) {
    const [dong] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock' AND query LIKE '%"RecurringExpense"%FOR UPDATE%'`;
    if (dong.n > 0) return;
    if (performance.now() > hetHan) throw new Error("Hết 10s mà không thấy lượt nào đứng chờ khoá RecurringExpense");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Transaction riêng giữ `FOR UPDATE` trên một mẫu cho tới khi gọi `tha()`. */
async function giuKhoaMau(id: string): Promise<{ tha: () => void; xong: Promise<unknown> }> {
  const daGiu = hen();
  const choTha = hen();
  const xong = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "RecurringExpense" WHERE id = ${id} FOR UPDATE`;
      daGiu.xong();
      await choTha.p;
    },
    { timeout: 20_000 }
  );
  await daGiu.p;
  return { tha: choTha.xong, xong };
}

function hen() {
  let xong!: () => void;
  const p = new Promise<void>((r) => (xong = r));
  return { p, xong };
}

describe("batLaiDinhKy — khoá nhóm giữ tới hết transaction", () => {
  it("đang dừng ở bước compare-and-set ⇒ mẫu KHÁC cùng nhóm vẫn bị khoá (NOWAIT lỗi 55P03)", async () => {
    const [a, b] = await Promise.all(
      ["Mặt bằng", "Mặt bằng mới"].map((description) =>
        prisma.recurringExpense.create({
          data: { categoryId: "fixed", amount: TIEN, dayOfMonth: 1, description, active: false },
        })
      )
    );

    // Chèn một điểm dừng vào transaction THẬT của `batLaiDinhKy`, ngay trước `updateMany` (bước cuối,
    // chắc chắn sau lượt khoá nhóm) — để kết nối thứ ba soi khoá khi transaction còn mở.
    const toiDiemDung = hen();
    const choTha = hen();
    const goc = prisma.$transaction.bind(prisma) as (
      fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
      opts?: unknown
    ) => Promise<unknown>;
    const spy = vi.spyOn(prisma, "$transaction").mockImplementationOnce(((
      fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
      opts?: unknown
    ) =>
      goc(
        (tx) =>
          fn(
            new Proxy(tx, {
              get(t, k) {
                const v = Reflect.get(t, k);
                if (k !== "recurringExpense") return typeof v === "function" ? v.bind(t) : v;
                return new Proxy(v as object, {
                  get(d, q) {
                    const f = Reflect.get(d, q);
                    if (q !== "updateMany" || typeof f !== "function") return f;
                    return async (...args: unknown[]) => {
                      toiDiemDung.xong();
                      await choTha.p;
                      return f.apply(d, args);
                    };
                  },
                });
              },
            })
          ),
        { ...(opts as object), timeout: 20_000 }
      )) as never);

    const batA = batLaiDinhKy(a.id, TU_THANG_NAY);
    await toiDiemDung.p;
    let bKhoa: boolean;
    try {
      bKhoa = await dangBiKhoa("RecurringExpense", b.id);
    } finally {
      choTha.xong();
    }
    const res = await batA;
    spy.mockRestore();

    expect(bKhoa).toBe(true);
    expect(res.ok).toBe(true);
    expect(await dangBiKhoa("RecurringExpense", b.id)).toBe(false); // nhả khi transaction kết thúc
  });
});

describe("batLaiDinhKy — khoá nhóm theo thứ tự id", () => {
  it("mẫu id LỚN nằm TRƯỚC trên đĩa đang bị giữ ⇒ lượt bật lại đã khoá xong mẫu id nhỏ rồi mới chờ", async () => {
    // Thứ tự khoá cố định theo `id` là thứ khiến hai lượt khoá chung nhóm không bao giờ khoá chéo.
    // Để thứ tự đó LỘ RA được, dựng nhóm sao cho thứ tự vật lý (thứ tự quét bảng) NGƯỢC thứ tự id:
    // chèn mẫu id "z…" trước, "a…" sau. Khoá theo id ⇒ giành "a" rồi đứng chờ "z". Khoá theo thứ tự
    // quét ⇒ đứng chờ ngay ở "z", "a" còn trống.
    const lon = await prisma.recurringExpense.create({
      data: { id: "z-mau-id-lon", categoryId: "fixed", amount: TIEN, dayOfMonth: 1, description: "Mặt bằng", active: false },
    });
    const nho = await prisma.recurringExpense.create({
      data: { id: "a-mau-id-nho", categoryId: "fixed", amount: TIEN, dayOfMonth: 1, description: "Mặt bằng mới", active: false },
    });
    // Tiền đề của phép thử: thứ tự vật lý đúng là [lớn, nhỏ] — lệch thì test không còn phân biệt được.
    const vatLy = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "RecurringExpense" WHERE "categoryId" = 'fixed' ORDER BY ctid`;
    expect(vatLy.map((d) => d.id)).toEqual([lon.id, nho.id]);

    const giu = await giuKhoaMau(lon.id);
    const batLai = batLaiDinhKy(nho.id, TU_THANG_NAY);
    let nhoKhoa: boolean;
    try {
      await choToiLuotDangChoKhoa();
      nhoKhoa = await dangBiKhoa("RecurringExpense", nho.id);
    } finally {
      giu.tha();
    }
    await giu.xong;
    const res = await batLai;

    expect(nhoKhoa).toBe(true);
    expect(res.ok).toBe(true);
  });
});

describe("batLaiDinhKy — chờ khoá vắt qua nửa đêm cuối tháng", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Hộp hiện lúc 31/10/2026 23:59:59 (giờ VN) — chủ shop chọn tháng `thangBatDau`; lượt bật lại đứng
   * chờ khoá mẫu, đồng hồ sang 01/11 00:00:01 rồi mới được nhả. CHỈ giả Date: giả luôn timer thì
   * Prisma/pool treo.
   */
  async function batLaiVatQuaNuaDem(thangBatDau: string) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 31, 23, 59, 59));
    const mau = await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: TIEN, dayOfMonth: 1, description: "Mặt bằng", active: false },
    });

    const giu = await giuKhoaMau(mau.id);
    const batLai = batLaiDinhKy(mau.id, { thangBatDau });
    try {
      await choToiLuotDangChoKhoa();
      vi.setSystemTime(new Date(2026, 10, 1, 0, 0, 1));
    } finally {
      giu.tha();
    }
    await giu.xong;
    const res = await batLai;
    const sau = await prisma.recurringExpense.findUniqueOrThrow({ where: { id: mau.id } });
    return { res, sau };
  }

  it("chọn tháng SAU (11/2026) ⇒ mốc đúng 01/11 — không nhảy sang 12/2026", async () => {
    const { res, sau } = await batLaiVatQuaNuaDem("2026-11");

    expect(res).toEqual({ ok: true, data: { tuThang: "11/2026" } });
    expect(sau.active).toBe(true);
    expect(sau.activeFrom?.getTime()).toBe(new Date(2026, 10, 1).getTime());
  });

  it("chọn tháng NÀY (10/2026) ⇒ lúc ghi đã là tháng 11 ⇒ TRANG_CU, mẫu giữ nguyên đã dừng", async () => {
    const { res, sau } = await batLaiVatQuaNuaDem("2026-10");

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("TRANG_CU");
    expect(sau.active).toBe(false);
    expect(sau.activeFrom).toBeNull();
  });
});

describe("deleteExpense stop_recurring — khoá mẫu TRƯỚC dòng Expense", () => {
  it("mẫu đang bị lượt khác giữ ⇒ lượt xoá CHỜ ở mẫu, CHƯA khoá dòng Expense; nhả ra thì xoá + dừng xong", async () => {
    const mau = await prisma.recurringExpense.create({
      data: { categoryId: "fixed", amount: TIEN, dayOfMonth: 1, description: "Mặt bằng", activeFrom: thangTruoc },
    });
    const dong = await prisma.expense.create({
      data: { date: thangTruoc, categoryId: "fixed", description: "Mặt bằng", amount: TIEN, source: "RECURRING", recurringId: mau.id, recurringMonth: khoaThangDinhKy(thangTruoc) },
    });

    // Mô phỏng lượt SỬA đang giữ khoá mẫu (đúng câu `updateExpense` chạy trước khi chạm `Expense`).
    const daGiu = hen();
    const choTha = hen();
    const luotSua = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "RecurringExpense" WHERE id = ${mau.id} FOR UPDATE`;
        daGiu.xong();
        await choTha.p;
      },
      { timeout: 20_000 }
    );
    await daGiu.p;

    const xoa = deleteExpense(dong.id, "stop_recurring");
    // Đủ để lượt xoá đi tới chỗ bị chặn. Khoá ngược thứ tự thì lúc này nó đã xoá (khoá) dòng Expense
    // và đang chờ mẫu — đúng một nửa vòng deadlock với lượt sửa.
    await new Promise((r) => setTimeout(r, 800));
    let expenseKhoa: boolean;
    try {
      expenseKhoa = await dangBiKhoa("Expense", dong.id);
    } finally {
      choTha.xong();
    }
    await luotSua;

    expect(expenseKhoa).toBe(false);
    expect(await xoa).toEqual({ ok: true, data: undefined });
    expect(await prisma.expense.count({ where: { id: dong.id } })).toBe(0);
    expect((await prisma.recurringExpense.findUniqueOrThrow({ where: { id: mau.id } })).active).toBe(false);
  });
});
