import { describe, expect, it, vi } from "vitest";

/**
 * Bước đẩy mốc thu hồi phiên trên đường phục hồi phải chạy CÓ HẠN, và hạn đó phải đặt ở TẦNG DB.
 *
 * Vì sao đáng khoá bằng test: đây là phần duy nhất còn lại giữa lệnh phá huỷ cuối cùng và lúc
 * `finally` trả khoá bảo trì — không fence trước được (dữ liệu đã bị thay rồi). Prisma KHÔNG có hạn
 * truy vấn mặc định, nên thiếu `SET LOCAL statement_timeout` là một kết nối nửa chết ở đúng chỗ này
 * giữ cờ tới hết TTL, cả app kẹt chỉ-đọc vì một câu `upsert` một dòng.
 *
 * Hai thứ dễ hỏng âm thầm mà mắt thường không thấy, nên phải chốt:
 *  1. `SET LOCAL` và `upsert` phải nằm TRONG CÙNG một transaction (cùng một connection) — tách ra
 *     là `SET LOCAL` rơi vào connection khác của pool và không phanh gì cả.
 *  2. `SET LOCAL` phải chạy TRƯỚC `upsert`, không phải sau.
 */
const gia = vi.hoisted(() => {
  const nhatKy: string[] = [];
  const txGia = {
    $executeRawUnsafe: vi.fn(async (sql: string) => {
      nhatKy.push(`SET: ${sql}`);
      return 0;
    }),
  };
  return { nhatKy, txGia };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(
      async (cb: (tx: typeof gia.txGia) => Promise<void>, opts: { timeout?: number; maxWait?: number }) => {
        gia.nhatKy.push(`MO TRANSACTION timeout=${opts?.timeout} maxWait=${opts?.maxWait}`);
        await cb(gia.txGia);
      },
    ),
  },
}));

vi.mock("@/lib/session", () => ({
  thuHoiMoiPhien: vi.fn(async (db: unknown) => {
    gia.nhatKy.push(db === gia.txGia ? "UPSERT mốc phiên (đúng tx)" : "UPSERT mốc phiên (SAI client)");
  }),
}));

import { HAN_THU_HOI_PHIEN_MS } from "@/lib/backup/han-chay-lenh-pg";
import { thuHoiMoiPhienCoHan } from "@/lib/backup/thu-hoi-phien-co-han";

describe("thuHoiMoiPhienCoHan", () => {
  it("đặt statement_timeout ở tầng DB rồi mới upsert, trong CÙNG một transaction", async () => {
    await thuHoiMoiPhienCoHan();

    expect(gia.nhatKy).toEqual([
      `MO TRANSACTION timeout=${HAN_THU_HOI_PHIEN_MS} maxWait=${HAN_THU_HOI_PHIEN_MS}`,
      `SET: SET LOCAL statement_timeout = ${HAN_THU_HOI_PHIEN_MS}`,
      "UPSERT mốc phiên (đúng tx)", // nhận `tx`, KHÔNG phải `prisma` toàn cục
    ]);
  });

  it("lỗi trong transaction lan ra ngoài, không bị nuốt", async () => {
    gia.nhatKy.length = 0;
    const loi = new Error("canceling statement due to statement timeout");
    vi.mocked(gia.txGia.$executeRawUnsafe).mockRejectedValueOnce(loi);

    // Người gọi (route phục hồi) cần thấy lỗi để chuyển sang nhánh cảnh báo, không được im lặng.
    await expect(thuHoiMoiPhienCoHan()).rejects.toBe(loi);
  });
});
