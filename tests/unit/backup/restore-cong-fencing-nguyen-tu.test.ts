import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CỔNG FENCING PHẢI NGUYÊN TỬ — rẽ nhánh THẲNG trên `giaHanKhoaPhucHoi`, không phải
 * "`laChuKhoaPhucHoi` rồi `giaHanKhoaPhucHoi` bỏ qua kết quả".
 *
 * Mẫu tách đôi đã gây một lỗi thật: TTL hết đúng GIỮA hai lời gọi ⇒ câu kiểm trả `true`, câu gia hạn
 * trả `false` (bị bỏ qua), và lượt đã mất khoá vẫn đi tiếp phát lệnh phá huỷ.
 *
 * Suite này tái hiện đúng trạng thái đó mà KHÔNG phụ thuộc cách triển khai đồng hồ: ép thẳng
 * `laChuKhoaPhucHoi → true`, còn `giaHanKhoaPhucHoi` trả theo một DÃY kết quả để đặt điểm hỏng vào
 * lần lượt TỪNG chốt trong bốn chốt (`false` · `true,false` · `true,true,false` · …), cộng một ca
 * happy path cả bốn cùng qua. Ép `false` ngay lần gọi đầu thì chỉ khoá được chốt số 1 — ba chốt sau
 * vẫn có thể bị đổi ngược về mẫu cũ mà suite không hay biết.
 *
 * Code đúng dừng tại đúng chốt được đặt hỏng; code theo mẫu cũ đi tiếp và làm ca đó đỏ (đã kiểm
 * bằng cách đảo lần lượt từng chốt).
 *
 * Vì sao mock ở tầng module thay vì giả đồng hồ: test đếm số lần gọi `performance.now()` sẽ vỡ khi
 * ai đó refactor vô hại (thêm/bớt một lời gọi `dangPhucHoi`), trong khi cái cần khoá là HÀNH VI
 * "gia hạn thất bại ⇒ không có side effect kế tiếp".
 */
const gia = vi.hoisted(() => ({
  the: { mocMono: 0, batDauLuc: "2026-08-03T00:00:00.000Z" },
  /** Kết quả `giaHanKhoaPhucHoi` trả về theo THỨ TỰ chốt — hết dãy thì lặp lại giá trị cuối. */
  ketQuaGiaHan: [] as boolean[],
  soLanGiaHan: 0,
  /** Bật khi `runRestore` giả đi qua được callback, tức lệnh phá huỷ ĐÃ chạy. */
  daNap: false,
}));

vi.mock("@/lib/backup/khoa-bao-tri", async (importOriginal) => {
  const that = await importOriginal<typeof import("@/lib/backup/khoa-bao-tri")>();
  return {
    ...that,
    thuGiuKhoaPhucHoi: vi.fn(() => gia.the),
    traKhoaPhucHoi: vi.fn(),
    // Vẫn "còn giữ khoá" theo câu hỏi suông — đúng trạng thái mà mẫu cũ nhìn thấy rồi đi tiếp.
    laChuKhoaPhucHoi: vi.fn(() => true),
    // …nhưng gia hạn có thể thất bại. Trả theo dãy để đặt điểm hỏng vào ĐÚNG chốt thứ n.
    giaHanKhoaPhucHoi: vi.fn(() => {
      const i = gia.soLanGiaHan++;
      return gia.ketQuaGiaHan[i] ?? gia.ketQuaGiaHan[gia.ketQuaGiaHan.length - 1] ?? true;
    }),
  };
});

vi.mock("@/lib/session", () => ({
  getAuthenticatedUserId: vi.fn(async () => "test-user"),
  thuHoiMoiPhien: vi.fn(async () => undefined),
}));

vi.mock("@/lib/backup/thu-hoi-phien-co-han", () => ({
  thuHoiMoiPhienCoHan: vi.fn(async () => undefined),
}));

vi.mock("@/lib/ingest/sync-log", () => ({
  coLuotDangChay: vi.fn(async () => false),
}));

vi.mock("@/lib/backup/run-pg-dump", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backup/run-pg-dump")>()),
  runPgDump: vi.fn(async () => Buffer.from("PGDMP-ban-lui-gia")),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const that = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...that,
    default: that,
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    readdir: vi.fn(async () => [] as string[]),
  };
});

// `runRestore` giả PHẢI diễn đúng hợp đồng: AWAIT `truocKhiPhaHuy` ngay trước khi (giả vờ) nạp —
// hook nay async (route gia hạn cả khoá việc nặng trong DB tại chốt này). Mock nuốt callback thì
// chốt thứ 3 không bao giờ được chạy; gọi mà không await thì lỗi hook thành rejection mồ côi và
// bước nạp giả vẫn chạy — cùng một kiểu mất chốt.
vi.mock("@/lib/backup/run-restore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backup/run-restore")>()),
  runRestore: vi.fn(async (_buf: Buffer, opts?: { truocKhiPhaHuy?: () => void | Promise<void> }) => {
    await opts?.truocKhiPhaHuy?.();
    gia.daNap = true;
    return { format: "custom" as const };
  }),
}));

import { POST } from "@/app/api/restore/route";
import { giaHanKhoaPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { runPgDump } from "@/lib/backup/run-pg-dump";
import { runRestore } from "@/lib/backup/run-restore";
import { thuHoiMoiPhienCoHan } from "@/lib/backup/thu-hoi-phien-co-han";

function yeuCauPhucHoi(): Request {
  const fd = new FormData();
  fd.append("file", new File([Buffer.from("PGDMP\x01noi-dung-gia")], "backup.dump"));
  return new Request("http://localhost/api/restore", { method: "POST", body: fd });
}

beforeEach(() => {
  // Xoá LỊCH SỬ gọi (giữ nguyên implementation ép sẵn ở các `vi.mock` trên) — không có bước này thì
  // ca sau cộng dồn số lần gọi của ca trước.
  vi.clearAllMocks();
  gia.soLanGiaHan = 0;
  gia.daNap = false;
  gia.ketQuaGiaHan = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Bốn chốt theo thứ tự chạy. Mỗi ca đặt điểm hỏng vào ĐÚNG một chốt (dãy `true…true, false`) rồi
 * khẳng định mọi side effect SAU chốt đó không xảy ra — phủ được cả bốn, thay vì chỉ chốt đầu.
 */
const CHOT = [
  { thu: 1, ten: "sau cổng drain (trước bản lùi)" },
  { thu: 2, ten: "sau khi chụp bản lùi (trước runRestore)" },
  { thu: 3, ten: "trong runRestore, ngay trước lệnh phá huỷ" },
  { thu: 4, ten: "sau khi nạp, trước bước thu hồi phiên" },
] as const;

/** Dãy kết quả: `n-1` chốt đầu qua được, chốt thứ `n` thất bại. */
function hongTaiChot(n: number): boolean[] {
  return [...Array(n - 1).fill(true), false];
}

describe("POST /api/restore — gia hạn thất bại thì DỪNG ngay, dù câu hỏi suông vẫn nói còn khoá", () => {
  it.each(CHOT)("chốt $thu ($ten) thất bại → không side effect nào phía sau chạy", async ({ thu }) => {
    gia.ketQuaGiaHan = hongTaiChot(thu);

    const res = await POST(yeuCauPhucHoi());

    // Ba chốt đầu nằm TRƯỚC lệnh phá huỷ ⇒ dữ liệu còn nguyên ⇒ 409. Chốt 4 nằm SAU khi nạp xong ⇒
    // trả `ok` kèm cảnh báo, vì nói "bận, chưa làm gì" lúc đó là nói dối theo hướng nguy hiểm nhất.
    if (thu <= 3) {
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/quá lâu/i);
    } else {
      expect(res.status).toBe(200);
      expect((await res.json()).canhBao).toMatch(/khoá bảo trì đã tự nhả/i);
    }

    // Cổng phải được gọi ĐÚNG `thu` lần: chốt hỏng cắt mạch, không chốt nào sau đó chạy.
    expect(giaHanKhoaPhucHoi).toHaveBeenCalledTimes(thu);

    // Và từng side effect nằm sau chốt hỏng đều không được xảy ra.
    if (thu <= 1) expect(runPgDump).not.toHaveBeenCalled();
    if (thu <= 2) expect(runRestore).not.toHaveBeenCalled();
    if (thu <= 3) expect(gia.daNap).toBe(false); // callback ném ⇒ lệnh phá huỷ không chạy
    expect(thuHoiMoiPhienCoHan).not.toHaveBeenCalled(); // đúng cho cả 4 chốt
  });

  it("cả bốn chốt qua được (đường bình thường) → nạp xong, thu hồi phiên chạy, không cảnh báo", async () => {
    gia.ketQuaGiaHan = [true, true, true, true];

    const res = await POST(yeuCauPhucHoi());

    expect(res.status).toBe(200);
    expect((await res.json()).canhBao).toBeUndefined();
    expect(giaHanKhoaPhucHoi).toHaveBeenCalledTimes(4); // đủ 4 chốt, không thừa không thiếu
    expect(gia.daNap).toBe(true);
    expect(thuHoiMoiPhienCoHan).toHaveBeenCalledTimes(1);
  });
});
