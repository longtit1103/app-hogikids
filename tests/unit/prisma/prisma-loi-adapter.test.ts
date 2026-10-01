import { describe, expect, it } from "vitest";

import { Prisma } from "@/generated/prisma/client";
import { laLoiTrungDongDinhKyThang } from "@/lib/expenses/khoa-thang-dinh-ky";
import {
  laLoiKetNoiPgTho,
  laNguyenNhanHeThong,
  laXungDotGhi,
  nguyenNhanAdapter,
  rangBuocTrungKhoa,
} from "@/lib/prisma-loi-adapter";

import {
  batLoi,
  loiPostgres,
  loiSocket,
  taoPrismaClientGiaLap,
} from "../../helpers/prisma-client-gia-lap-loi-driver";

/**
 * Bộ đọc lỗi Prisma 7 dùng chung (phân loại hạ tầng/dữ liệu + nhận diện xung đột ghi để chạy lại).
 * Lỗi lấy từ runtime + adapter THẬT trên pool `pg` giả (không nối DB) — đúng hình dạng app nhận được.
 */

function loiLucCommit(loi: unknown, isolationLevel?: "Serializable") {
  const c = taoPrismaClientGiaLap({ loiChoCau: (sql) => (sql === "COMMIT" ? loi : undefined) });
  return batLoi(() =>
    c.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT 1`;
      },
      isolationLevel ? { isolationLevel } : undefined,
    ),
  );
}

describe("laXungDotGhi — transaction bị cuộn trọn vì xung đột ghi, chạy lại an toàn", () => {
  it("40001 nổ lúc COMMIT của Serializable (ca thường gặp) ⇒ `DriverAdapterError` trần ⇒ CÓ", async () => {
    const e = await loiLucCommit(loiPostgres("40001", "could not serialize access due to read/write dependencies"), "Serializable");
    expect((e as Error).name).toBe("DriverAdapterError");
    expect(e).not.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(laXungDotGhi(e)).toBe(true);
  });

  it("deadlock trên câu ORM trong transaction ⇒ P2034 ⇒ CÓ", async () => {
    const c = taoPrismaClientGiaLap({
      loiChoCau: (sql) => (sql.startsWith("UPDATE") ? loiPostgres("40P01", "deadlock detected") : undefined),
    });
    const e = await batLoi(() =>
      c.$transaction(async (tx) => {
        await tx.channel.updateMany({ data: { name: "x" } });
      }),
    );
    expect((e as Prisma.PrismaClientKnownRequestError).code).toBe("P2034");
    expect(laXungDotGhi(e)).toBe(true);
  });

  it("deadlock trên câu raw (`SELECT … FOR UPDATE` giành khoá) ⇒ P2010 ⇒ CÓ", async () => {
    const c = taoPrismaClientGiaLap({ loiChoCau: () => loiPostgres("40P01", "deadlock detected") });
    const e = await batLoi(() => c.$queryRaw`SELECT 1 FROM "Loan" WHERE id = ${"x"} FOR UPDATE`);
    expect((e as Prisma.PrismaClientKnownRequestError).code).toBe("P2010");
    expect(laXungDotGhi(e)).toBe(true);
  });

  it.each([
    // Mất kết nối lúc COMMIT: không biết đã commit hay chưa — chạy lại có thể ghi đôi.
    ["socket đứt lúc COMMIT", loiSocket("ECONNRESET")],
    ["phiên bị thu hồi lúc COMMIT", loiPostgres("57P01", "terminating connection", "FATAL")],
    ["kết nối đứt không mã lúc COMMIT", new Error("Connection terminated unexpectedly")],
    ["trùng khoá hoãn tới COMMIT", loiPostgres("23505", "duplicate key value violates unique constraint")],
  ])("%s ⇒ KHÔNG", async (_ten, loi) => {
    expect(laXungDotGhi(await loiLucCommit(loi))).toBe(false);
  });

  it("các giá trị không phải lỗi Prisma ⇒ KHÔNG", () => {
    expect(laXungDotGhi(null)).toBe(false);
    expect(laXungDotGhi("P2034")).toBe(false);
    expect(laXungDotGhi(new Error("x"))).toBe(false);
    expect(
      laXungDotGhi(new Prisma.PrismaClientKnownRequestError("x", { code: "P2002", clientVersion: "7.10.0" })),
    ).toBe(false);
  });
});

describe("nguyenNhanAdapter — lấy nguyên nhân ở cả lỗi trần lẫn lỗi đã bọc", () => {
  it("P2010 câu raw ⇒ nguyên nhân trong meta.driverAdapterError", async () => {
    const c = taoPrismaClientGiaLap({ loiChoCau: () => loiPostgres("57P01", "terminating connection", "FATAL") });
    const e = await batLoi(() => c.$executeRaw`SELECT 1`);
    expect(nguyenNhanAdapter(e)).toMatchObject({ kind: "postgres", originalCode: "57P01" });
  });

  it("COMMIT ⇒ nguyên nhân ở `.cause` của lỗi trần", async () => {
    const e = await loiLucCommit(loiSocket("ECONNRESET"));
    expect(nguyenNhanAdapter(e)).toMatchObject({ kind: "ConnectionClosed" });
  });

  it("lỗi không đi qua adapter ⇒ undefined", () => {
    expect(nguyenNhanAdapter(new Error("Connection terminated unexpectedly"))).toBeUndefined();
    expect(
      nguyenNhanAdapter(new Prisma.PrismaClientKnownRequestError("x", { code: "P2028", clientVersion: "7.10.0" })),
    ).toBeUndefined();
    // Error có `cause` nhưng không mang tên DriverAdapterError: không nhận bừa.
    expect(nguyenNhanAdapter(new Error("x", { cause: { kind: "ConnectionClosed" } }))).toBeUndefined();
  });
});

describe("laNguyenNhanHeThong — bảng kind + lớp SQLSTATE", () => {
  it.each(["ConnectionClosed", "DatabaseNotReachable", "SocketTimeout", "TooManyConnections", "TransactionWriteConflict", "TableDoesNotExist", "ForeignKeyConstraintViolation"])(
    "kind %s ⇒ HỆ THỐNG",
    (kind) => {
      expect(laNguyenNhanHeThong({ kind })).toBe(true);
    },
  );

  it.each(["UniqueConstraintViolation", "NullConstraintViolation", "InvalidInputValue", "ValueOutOfRange", "LengthMismatch"])(
    "kind %s ⇒ lỗi DÒNG",
    (kind) => {
      expect(laNguyenNhanHeThong({ kind })).toBe(false);
    },
  );

  it.each([
    ["08006", true],
    ["40001", true],
    ["53100", true],
    ["55P03", true],
    ["57014", true],
    ["58030", true],
    ["XX000", true],
    ["42501", true],
    ["23514", false],
    ["22012", false],
    ["42601", false],
  ])("kind postgres, SQLSTATE %s ⇒ hệ thống = %s", (ma, ky) => {
    expect(laNguyenNhanHeThong({ kind: "postgres", code: ma })).toBe(ky);
    expect(laNguyenNhanHeThong({ kind: "postgres", originalCode: ma })).toBe(ky);
  });

  it("kind postgres không có SQLSTATE ⇒ lỗi DÒNG", () => {
    expect(laNguyenNhanHeThong({ kind: "postgres" })).toBe(false);
  });
});

describe("laLoiKetNoiPgTho — Error không mã của pg / lỗi socket Node thô", () => {
  it.each([
    "Connection terminated",
    "Connection terminated unexpectedly",
    "Connection terminated due to connection timeout",
    "Client has encountered a connection error and is not queryable",
    "Client was closed and is not queryable",
    "timeout exceeded when trying to connect",
    "timeout expired",
    "Query read timeout",
    "Cannot use a pool after calling end on the pool",
  ])("%j ⇒ CÓ", (thongDiep) => {
    expect(laLoiKetNoiPgTho(new Error(thongDiep))).toBe(true);
  });

  it("mã mạng Node adapter không dịch (EPIPE, EHOSTUNREACH) ⇒ CÓ", () => {
    expect(laLoiKetNoiPgTho(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).toBe(true);
    expect(laLoiKetNoiPgTho(Object.assign(new Error("connect EHOSTUNREACH"), { code: "EHOSTUNREACH" }))).toBe(true);
  });

  it("thông điệp khác / không phải Error ⇒ KHÔNG", () => {
    expect(laLoiKetNoiPgTho(new Error("Không tìm thấy variant"))).toBe(false);
    expect(laLoiKetNoiPgTho(new Error("the timeout expired while parsing"))).toBe(false);
    expect(laLoiKetNoiPgTho("Connection terminated")).toBe(false);
  });
});

describe("rangBuocTrungKhoa + laLoiTrungDongDinhKyThang — Prisma 7 không còn `meta.target`", () => {
  const loiTrung = (constraint: string | undefined, detail?: string) =>
    Object.assign(loiPostgres("23505", `duplicate key value violates unique constraint "${constraint ?? "?"}"`), {
      ...(constraint ? { constraint } : {}),
      ...(detail ? { detail } : {}),
    });
  const loiCauOrm = (loi: Error) =>
    batLoi(() => taoPrismaClientGiaLap({ loiChoCau: () => loi }).expense.updateMany({ data: { description: "x" } }));

  it("câu ORM trùng index định kỳ ⇒ P2002, đọc được tên index, nhận ra va chạm 1 dòng/mẫu/tháng", async () => {
    const e = await loiCauOrm(loiTrung("Expense_recurringId_recurringMonth_key"));
    expect((e as Prisma.PrismaClientKnownRequestError).code).toBe("P2002");
    expect(rangBuocTrungKhoa(e)).toEqual({ index: "Expense_recurringId_recurringMonth_key" });
    expect(laLoiTrungDongDinhKyThang(e)).toBe(true);
  });

  it("không có tên ràng buộc ⇒ đọc cột từ DETAIL, vẫn nhận ra va chạm định kỳ", async () => {
    const e = await loiCauOrm(loiTrung(undefined, "Key (recurringId, recurringMonth)=(a, 2026-10) already exists."));
    expect(rangBuocTrungKhoa(e)).toEqual({ fields: ["recurringId", "recurringMonth"] });
    expect(laLoiTrungDongDinhKyThang(e)).toBe(true);
  });

  it("trùng khoá ràng buộc KHÁC (refId) ⇒ không phải va chạm định kỳ", async () => {
    const e = await loiCauOrm(loiTrung("Expense_refId_key"));
    expect(rangBuocTrungKhoa(e)).toEqual({ index: "Expense_refId_key" });
    expect(laLoiTrungDongDinhKyThang(e)).toBe(false);
  });

  it("lỗi không phải trùng khoá ⇒ undefined", async () => {
    const e = await loiCauOrm(loiPostgres("40P01", "deadlock detected"));
    expect(rangBuocTrungKhoa(e)).toBeUndefined();
    expect(laLoiTrungDongDinhKyThang(e)).toBe(false);
  });
});
