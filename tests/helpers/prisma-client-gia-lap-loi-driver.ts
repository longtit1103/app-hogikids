import { PrismaPg } from "@prisma/adapter-pg";

// Đường dẫn TƯƠNG ĐỐI như `src/lib/tao-prisma-client.ts` — helper này cũng được nạp từ script `tsx`.
import { PrismaClient } from "../../src/generated/prisma/client";

/**
 * `PrismaClient` THẬT (runtime Prisma 7 + `@prisma/adapter-pg` thật) chạy trên một `pg.Pool` bị thay
 * `query`/`connect` bằng bản giả — KHÔNG mở socket nào. Dùng để lấy lỗi đúng HÌNH DẠNG runtime ném ra
 * (P2010 kèm `meta.driverAdapterError`, `DriverAdapterError` trần lúc COMMIT, `Error` trần của `pg`)
 * thay vì tự dựng tay một đối tượng lỗi đoán mò: adapter tự chạy `convertDriverError`, runtime tự bọc.
 *
 * Kịch bản trả lỗi theo câu SQL: `loiChoCau(sql)` trả `undefined` = câu chạy êm (kết quả rỗng).
 */
export type KichBanDriver = {
  /** Lỗi ném khi `pg` chạy câu `sql` (cả câu ngoài lẫn trong transaction, gồm BEGIN/COMMIT). */
  loiChoCau?: (sql: string) => unknown;
  /** Lỗi ném khi xin kết nối từ pool để mở transaction. */
  loiKhiMuonKetNoi?: unknown;
  /** Trễ (ms) trước khi pool trả kết nối cho transaction — để chạm hạn `maxWait`. */
  treMuonKetNoiMs?: number;
};

/** Kết quả rỗng đúng hình `pg.QueryResult` mà adapter đọc (`fields`, `rows`, `rowCount`). */
const KET_QUA_RONG = { command: "", fields: [], rows: [], rowCount: 0, oid: 0 };

/** Đích KHÔNG tồn tại — phòng hờ: kể cả khi bản giả để lọt một đường nào đó, `pg` cũng không nối được DB thật. */
const URL_KHONG_TOI_DAU = "postgresql://khong_ai:khong_co@127.0.0.1:1/khong_ton_tai";

class AdapterGiaLap extends PrismaPg {
  constructor(private readonly kichBan: KichBanDriver) {
    super({ connectionString: URL_KHONG_TOI_DAU });
  }

  override async connect() {
    const adapter = await super.connect();
    const pool = adapter.underlyingDriver();
    const { loiChoCau, loiKhiMuonKetNoi, treMuonKetNoiMs } = this.kichBan;

    const chay = async (cau: unknown) => {
      const sql = typeof cau === "string" ? cau : String((cau as { text?: unknown }).text ?? "");
      const loi = loiChoCau?.(sql);
      if (loi !== undefined) throw loi;
      return KET_QUA_RONG;
    };

    const ketNoiGia = {
      query: chay,
      on: () => ketNoiGia,
      removeListener: () => ketNoiGia,
      release: () => undefined,
    };

    // Thay trên CHÍNH đối tượng pool adapter đang giữ — adapter gọi `this.client.query/connect`.
    pool.query = chay as unknown as typeof pool.query;
    pool.connect = (async () => {
      if (treMuonKetNoiMs) await new Promise((r) => setTimeout(r, treMuonKetNoiMs));
      if (loiKhiMuonKetNoi !== undefined) throw loiKhiMuonKetNoi;
      return ketNoiGia;
    }) as unknown as typeof pool.connect;
    return adapter;
  }
}

export function taoPrismaClientGiaLap(kichBan: KichBanDriver): PrismaClient {
  return new PrismaClient({ adapter: new AdapterGiaLap(kichBan) });
}

/**
 * Lỗi Postgres đúng hình `pg` (`DatabaseError` của `pg-protocol`): adapter nhận diện lỗi driver qua
 * đúng bộ field này (`code`, `message`, `severity` là chuỗi) — thiếu `severity` là nó KHÔNG coi là
 * lỗi Postgres mà ném trả nguyên lỗi gốc.
 */
export function loiPostgres(code: string, message: string, severity = "ERROR"): Error {
  return Object.assign(new Error(message), { name: "error", code, severity, length: 0 });
}

/** Lỗi socket của Node đúng hình adapter nhận diện (`code` + `syscall` + `errno`). */
export function loiSocket(code: "ECONNRESET" | "ECONNREFUSED" | "ETIMEDOUT" | "ENOTFOUND"): Error {
  return Object.assign(new Error(`read ${code}`), { code, syscall: "read", errno: -54 });
}

/** Chạy `fn`, trả lỗi nó ném (ném nếu nó KHÔNG ném — test đang đo sai đường). */
export async function batLoi(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("Mong đợi một lỗi nhưng lời gọi chạy êm");
}
