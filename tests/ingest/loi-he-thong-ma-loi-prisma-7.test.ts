import { describe, expect, it } from "vitest";

import { Prisma } from "@/generated/prisma/client";
import { laLoiHeThong } from "@/lib/ingest/loi-he-thong";

import {
  batLoi,
  loiPostgres,
  loiSocket,
  taoPrismaClientGiaLap,
} from "../helpers/prisma-client-gia-lap-loi-driver";

/**
 * `laLoiHeThong` trên lỗi đúng HÌNH DẠNG Prisma 7 ném ra — lấy từ runtime + adapter THẬT chạy trên
 * pool `pg` giả (không nối DB), không tự dựng tay đối tượng lỗi.
 *
 * Vì sao quan trọng: nhầm sự cố hạ tầng thành "dòng này hỏng" là lượt đối soát đêm đếm lượt thử và
 * sau vài đêm CHÔN VĨNH VIỄN đơn có tiền. Prisma 7 giấu nguyên nhân hạ tầng ở ba chỗ mà mã lỗi không
 * nói lên: P2010 của câu raw (hai câu ĐẦU của transaction ghi đơn là raw), `DriverAdapterError` trần
 * lúc COMMIT, và `Error` không mã của `pg`.
 */

const ketNoiBiNgat = () => loiPostgres("57P01", "terminating connection due to administrator command", "FATAL");

/** Chạy câu raw đúng kiểu đầu transaction ghi đơn (`pg_advisory_xact_lock`) khi `pg` ném `loi`. */
function loiCauRaw(loi: unknown) {
  const c = taoPrismaClientGiaLap({ loiChoCau: () => loi });
  return batLoi(() => c.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"don:shopee|X"}, 0))`);
}

/** Transaction chạy êm tới COMMIT thì `pg` ném `loi`. */
function loiLucCommit(loi: unknown) {
  const c = taoPrismaClientGiaLap({ loiChoCau: (sql) => (sql === "COMMIT" ? loi : undefined) });
  return batLoi(() =>
    c.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1`;
    }),
  );
}

describe("laLoiHeThong — câu raw lỗi hạ tầng (P2010 kèm nguyên nhân adapter)", () => {
  it.each([
    ["phiên bị thu hồi 57P01", ketNoiBiNgat()],
    ["hết slot kết nối 53300", loiPostgres("53300", "sorry, too many clients already", "FATAL")],
    ["hết hạn chờ khoá 55P03", loiPostgres("55P03", "canceling statement due to lock timeout")],
    ["hết giờ câu lệnh 57014", loiPostgres("57014", "canceling statement due to statement timeout")],
    ["deadlock 40P01", loiPostgres("40P01", "deadlock detected")],
    ["mất kết nối 08006", loiPostgres("08006", "connection failure", "FATAL")],
    ["lỗi nội bộ XX000", loiPostgres("XX000", "internal error")],
    ["thiếu quyền 42501", loiPostgres("42501", 'permission denied for table "Order"')],
    ["thiếu bảng 42P01", loiPostgres("42P01", 'relation "Order" does not exist')],
    ["socket đứt ECONNRESET", loiSocket("ECONNRESET")],
    ["không tới được DB ECONNREFUSED", loiSocket("ECONNREFUSED")],
  ])("%s ⇒ HỆ THỐNG", async (_ten, loiPg) => {
    const e = await loiCauRaw(loiPg);
    expect(e).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((e as Prisma.PrismaClientKnownRequestError).code).toBe("P2010");
    expect(laLoiHeThong(e)).toBe(true);
  });
});

describe("laLoiHeThong — COMMIT hỏng (`DriverAdapterError` trần)", () => {
  it.each([
    ["phiên bị thu hồi 57P01", ketNoiBiNgat()],
    ["xung đột serialize 40001", loiPostgres("40001", "could not serialize access due to concurrent update")],
    ["socket đứt ECONNRESET", loiSocket("ECONNRESET")],
  ])("%s ⇒ HỆ THỐNG", async (_ten, loiPg) => {
    const e = await loiLucCommit(loiPg);
    expect(e).not.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((e as Error).name).toBe("DriverAdapterError");
    expect(laLoiHeThong(e)).toBe(true);
  });

  it("vi phạm ràng buộc hoãn tới COMMIT (23505) vẫn là lỗi của DÒNG", async () => {
    const e = await loiLucCommit(loiPostgres("23505", 'duplicate key value violates unique constraint "Order_pancakeId_key"'));
    expect((e as Error).name).toBe("DriverAdapterError");
    expect(laLoiHeThong(e)).toBe(false);
  });
});

describe("laLoiHeThong — `Error` không mã của `pg`/`pg-pool` (adapter để lọt nguyên dạng)", () => {
  it.each([
    "Connection terminated unexpectedly",
    "Connection terminated due to connection timeout",
    "Client has encountered a connection error and is not queryable",
  ])("câu lệnh ném %j ⇒ HỆ THỐNG (cả câu raw lẫn câu ORM)", async (thongDiep) => {
    const c = taoPrismaClientGiaLap({ loiChoCau: () => new Error(thongDiep) });
    const raw = await batLoi(() => c.$queryRaw`SELECT 1`);
    const orm = await batLoi(() => c.channel.findFirst());
    for (const e of [raw, orm]) {
      expect(e).not.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((e as Error).message).toBe(thongDiep);
      expect(laLoiHeThong(e)).toBe(true);
    }
  });

  it("pool hết hạn chờ kết nối khi mở transaction ⇒ HỆ THỐNG", async () => {
    const c = taoPrismaClientGiaLap({ loiKhiMuonKetNoi: new Error("timeout exceeded when trying to connect") });
    const e = await batLoi(() => c.$transaction(async () => 1));
    expect((e as Error).message).toBe("timeout exceeded when trying to connect");
    expect(laLoiHeThong(e)).toBe(true);
  });

  it("COMMIT gặp kết nối đứt không mã ⇒ HỆ THỐNG", async () => {
    const e = await loiLucCommit(new Error("Connection terminated unexpectedly"));
    expect(laLoiHeThong(e)).toBe(true);
  });

  it("Error bất kỳ không phải lỗi kết nối vẫn là lỗi của DÒNG", () => {
    expect(laLoiHeThong(new Error("Không tìm thấy variant cho SKU X"))).toBe(false);
  });
});

describe("laLoiHeThong — transaction quá hạn (P2028)", () => {
  it("không mở được transaction trong `maxWait` ⇒ HỆ THỐNG", async () => {
    const c = taoPrismaClientGiaLap({ treMuonKetNoiMs: 300 });
    const e = await batLoi(() => c.$transaction(async () => 1, { maxWait: 20 }));
    expect((e as Prisma.PrismaClientKnownRequestError).code).toBe("P2028");
    expect(laLoiHeThong(e)).toBe(true);
  });
});

describe("laLoiHeThong — lỗi THẬT của dòng giữ nguyên là lỗi dòng", () => {
  it.each([
    ["trùng khoá 23505", loiPostgres("23505", 'duplicate key value violates unique constraint "Order_pancakeId_key"')],
    ["vi phạm CHECK 23514", loiPostgres("23514", 'new row for relation "Order" violates check constraint "c"')],
    ["giá trị sai kiểu 22P02", loiPostgres("22P02", 'invalid input syntax for type integer: "abc"')],
    ["chia cho 0 (22012, kind postgres)", loiPostgres("22012", "division by zero")],
    ["tràn số 22003", loiPostgres("22003", "integer out of range")],
  ])("câu raw %s ⇒ lỗi DÒNG", async (_ten, loiPg) => {
    const e = await loiCauRaw(loiPg);
    expect((e as Prisma.PrismaClientKnownRequestError).code).toBe("P2010");
    expect(laLoiHeThong(e)).toBe(false);
  });

  it("câu ORM trùng khoá (P2002) ⇒ lỗi DÒNG", async () => {
    const c = taoPrismaClientGiaLap({
      loiChoCau: () =>
        Object.assign(loiPostgres("23505", 'duplicate key value violates unique constraint "Channel_pkey"'), {
          constraint: "Channel_pkey",
        }),
    });
    const e = await batLoi(() => c.channel.updateMany({ data: { name: "x" } }));
    expect((e as Prisma.PrismaClientKnownRequestError).code).toBe("P2002");
    expect(laLoiHeThong(e)).toBe(false);
  });
});

describe("laLoiHeThong — mã câu ORM giữ nguyên phán quyết cũ", () => {
  it.each([
    ["socket đứt ⇒ P1017", loiSocket("ECONNRESET"), "P1017"],
    ["khoá ngoại (kênh chưa seed) ⇒ P2003", loiPostgres("23503", 'insert or update on table "Order" violates foreign key constraint'), "P2003"],
    ["phiên bị thu hồi ⇒ P2039", ketNoiBiNgat(), "P2039"],
    // Prisma 6 ném nhóm SQLSTATE không mã riêng dưới dạng UnknownRequestError (hệ thống) — giữ nguyên.
    ["CHECK trên câu ORM ⇒ P2039", loiPostgres("23514", 'new row for relation "Order" violates check constraint "c"'), "P2039"],
  ])("%s ⇒ HỆ THỐNG", async (_ten, loiPg, ma) => {
    const c = taoPrismaClientGiaLap({ loiChoCau: () => loiPg });
    const e = await batLoi(() => c.channel.updateMany({ data: { name: "x" } }));
    expect((e as Prisma.PrismaClientKnownRequestError).code).toBe(ma);
    expect(laLoiHeThong(e)).toBe(true);
  });

  it("UnknownRequestError vẫn là lỗi HỆ THỐNG", () => {
    expect(laLoiHeThong(new Prisma.PrismaClientUnknownRequestError("x", { clientVersion: "7.10.0" }))).toBe(true);
  });
});
