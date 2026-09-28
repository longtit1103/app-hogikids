import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FENCING — lượt phục hồi bị TTL bỏ rơi giữa chừng KHÔNG được đi tiếp.
 *
 * Thẻ phiên (đã có test riêng ở `khoa-bao-tri-ttl.test.ts`) chỉ ngăn lượt cũ XOÁ CỜ của lượt mới;
 * nó không ngăn lượt cũ CHẠY TIẾP. Đường hỏng đầy đủ: lượt A giành khoá → treo ở một bước không có
 * hạn (`coLuotDangChay()` là truy vấn Prisma, `runPgDump` là tiến trình con) → TTL tự nhả cờ → chủ
 * shop bấm phục hồi lại, lượt B giành cờ và bắt đầu drop + nạp → A chợt tỉnh và chạy nốt `pg_dump`
 * + `pg_restore` của nó. Hai lượt cùng phá một schema — đúng thảm hoạ khoá bảo trì sinh ra để chặn.
 *
 * Suite này tái hiện đúng kịch bản đó và chốt: A KHÔNG chạy thêm một lệnh pg client nào, và A trả
 * 409 với câu nói rõ nguyên nhân.
 *
 * `runPgDump` + `runRestore` là HAI CỬA DUY NHẤT ra pg client của route (`route.ts` không import gì
 * khác chạy `execFile`; các lời gọi còn lại là Prisma và đều đã bị mock ở đây), nên đếm 2 mock này
 * = 0 chính là "không có lệnh PostgreSQL nào chạy".
 *
 * Đồng hồ giả bằng cách chặn `performance.now()` — cờ đo tuổi bằng đồng hồ ĐƠN ĐIỆU nên
 * `vi.setSystemTime` vô tác dụng.
 */
vi.mock("@/lib/session", () => ({
  getAuthenticatedUserId: vi.fn(async () => "test-user"),
  thuHoiMoiPhien: vi.fn(async () => undefined),
}));

// Bước đẩy mốc phiên sau khi nạp — mock để không đụng DB, và để mô phỏng ca nó chạy lâu rồi mới về.
vi.mock("@/lib/backup/thu-hoi-phien-co-han", () => ({
  thuHoiMoiPhienCoHan: vi.fn(async () => undefined),
}));

// Cổng drain soi `SyncLog` — mock để không đụng DB, và để mô phỏng bước chờ KHÔNG CÓ HẠN.
vi.mock("@/lib/ingest/sync-log", () => ({
  coLuotDangChay: vi.fn(async () => false),
}));

// Bản lùi: KHÔNG mở kết nối Postgres. Phải giữ nguyên các export còn lại — `run-restore.ts` lấy
// `parsePgUrl` từ chính file này.
vi.mock("@/lib/backup/run-pg-dump", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backup/run-pg-dump")>()),
  runPgDump: vi.fn(async () => Buffer.from("PGDMP-ban-lui-gia")),
}));

// `/backups` là volume của container, không có trên máy chạy test — chặn đúng 3 hàm ghi.
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

// Chỉ thay `runRestore`; các guard thuần (detect/gunzipHead/assertNotArchive) giữ bản thật vì route
// gọi chúng TRƯỚC khi giành khoá.
vi.mock("@/lib/backup/run-restore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backup/run-restore")>()),
  runRestore: vi.fn(async () => ({ format: "custom" as const })),
}));

import { POST } from "@/app/api/restore/route";
import { TTL_KHOA_PHUC_HOI_MS } from "@/lib/backup/han-chay-lenh-pg";
import { dangPhucHoi, thuGiuKhoaPhucHoi, type ThePhienPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { runPgDump } from "@/lib/backup/run-pg-dump";
import { runRestore } from "@/lib/backup/run-restore";
import { thuHoiMoiPhienCoHan } from "@/lib/backup/thu-hoi-phien-co-han";
import { coLuotDangChay } from "@/lib/ingest/sync-log";
import { getAuthenticatedUserId } from "@/lib/session";
import { donKhoaPhucHoi } from "../../helpers/khoa-bao-tri-reset";

/** Request multipart mang một file `.dump` hợp lệ ở mức magic (`PGDMP`). */
function yeuCauPhucHoi(): Request {
  const fd = new FormData();
  fd.append("file", new File([Buffer.from("PGDMP\x01noi-dung-gia")], "backup.dump"));
  return new Request("http://localhost/api/restore", { method: "POST", body: fd });
}

let dongHoMs = 10_000;

/** Đẩy đồng hồ đơn điệu — dùng để mô phỏng một bước treo lâu. */
function troiQua(ms: number): void {
  dongHoMs += ms;
}

/** Chủ shop sốt ruột bấm phục hồi lại: lượt B giành cờ sau khi TTL đã nhả cờ của lượt A. */
function luotBGianhCo(): ThePhienPhucHoi {
  const theB = thuGiuKhoaPhucHoi();
  expect(theB).not.toBeNull(); // TTL phải đã nhả cờ của A, nếu không kịch bản dựng sai
  return theB!;
}

beforeEach(() => {
  donKhoaPhucHoi();
  dongHoMs = 10_000;
  vi.spyOn(performance, "now").mockImplementation(() => dongHoMs);
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Dựng lại hành vi mặc định cho MỌI mock ở đầu mỗi ca — không dựa vào việc `restoreAllMocks()`
  // có đụng tới `vi.fn()` hay không (hành vi này đã đổi giữa các đời vitest).
  vi.mocked(getAuthenticatedUserId).mockReset().mockResolvedValue("test-user");
  vi.mocked(thuHoiMoiPhienCoHan).mockReset().mockResolvedValue(undefined);
  vi.mocked(coLuotDangChay).mockReset().mockResolvedValue(false);
  vi.mocked(runPgDump).mockReset().mockResolvedValue(Buffer.from("PGDMP-ban-lui-gia"));
  vi.mocked(runRestore).mockReset().mockResolvedValue({ format: "custom" });
});

afterEach(() => {
  vi.restoreAllMocks();
  donKhoaPhucHoi();
});

describe("POST /api/restore — mất khoá giữa chừng thì DỪNG, không chạy lệnh pg nào", () => {
  it("treo ở bước dò lượt đồng bộ quá TTL, lượt khác đã chiếm khoá → 409 và KHÔNG chạm pg", async () => {
    // Lượt A vào bình thường, rồi treo cứng ở cổng drain lâu hơn TTL. Trong lúc đó chủ shop bấm lại
    // và lượt B giành được cờ. A tỉnh dậy ngay sau đó.
    vi.mocked(coLuotDangChay).mockImplementation(async () => {
      troiQua(TTL_KHOA_PHUC_HOI_MS + 1);
      luotBGianhCo();
      return false;
    });

    const res = await POST(yeuCauPhucHoi());

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/quá lâu/i);
    // Điều kiện sống-còn: A không được chạy MỘT lệnh PostgreSQL nào nữa.
    expect(runPgDump).not.toHaveBeenCalled();
    expect(runRestore).not.toHaveBeenCalled();
    // Và A không được cướp cờ của B (B đang drop + nạp schema).
    expect(dangPhucHoi()).toBe(true);
  });

  it("treo ở bước chụp bản lùi quá TTL → dừng NGAY TRƯỚC `runRestore`, không drop + nạp chồng", async () => {
    vi.mocked(runPgDump).mockImplementation(async () => {
      troiQua(TTL_KHOA_PHUC_HOI_MS + 1);
      luotBGianhCo();
      return Buffer.from("PGDMP-ban-lui-gia");
    });

    const res = await POST(yeuCauPhucHoi());

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/quá lâu/i);
    expect(runPgDump).toHaveBeenCalledTimes(1); // bản lùi chỉ ĐỌC, chạy lúc còn giữ khoá — chấp nhận
    expect(runRestore).not.toHaveBeenCalled(); // lệnh phá huỷ thì tuyệt đối không
    expect(dangPhucHoi()).toBe(true); // cờ của B còn nguyên
  });

  it("mất khoá SAU khi nạp xong → vẫn báo ok nhưng cảnh báo, và KHÔNG ghi thêm (bỏ thu hồi phiên)", async () => {
    // Đây là ca duy nhất không trả 409: dữ liệu đã bị thay thật, nói "bận, chưa làm gì" là nói dối
    // theo hướng khiến chủ shop bấm phục hồi thêm lần nữa.
    vi.mocked(runRestore).mockImplementation(async () => {
      troiQua(TTL_KHOA_PHUC_HOI_MS + 1);
      luotBGianhCo();
      return { format: "custom" };
    });

    const res = await POST(yeuCauPhucHoi());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; canhBao?: string };
    expect(body.ok).toBe(true);
    expect(body.canhBao).toMatch(/khoá bảo trì đã tự nhả/i);
    expect(body.canhBao).toMatch(/thu hồi phiên/i);
    expect(thuHoiMoiPhienCoHan).not.toHaveBeenCalled(); // không ghi vào schema lượt B đang thay
    expect(dangPhucHoi()).toBe(true);
  });

  it("treo trong lúc CHUẨN BỊ FILE (bên trong runRestore) → 409, chốt cuối chặn trước lệnh phá huỷ", async () => {
    // Chốt (4b) của route KHÔNG đủ: giữa nó và lệnh phá huỷ đầu tiên còn `writeFile`, `gunzipAsync`,
    // `pg_restore -l` — mấy bước file/zlib này không có hạn ở tầng Node. Ở đây mock `runRestore`
    // diễn đúng hợp đồng thật: treo trong lúc chuẩn bị, RỒI mới gọi `truocKhiPhaHuy` ngay trước khi
    // định nạp. Callback phải ném ⇒ không lệnh phá huỷ nào chạy.
    let daNap = false;
    vi.mocked(runRestore).mockImplementation(async (_buf, opts) => {
      troiQua(TTL_KHOA_PHUC_HOI_MS + 1); // ghi file tạm / bung nén treo lâu hơn TTL
      luotBGianhCo();
      await opts?.truocKhiPhaHuy?.(); // hook nay async — ném LoiMatKhoaPhucHoi ⇒ dòng dưới không bao giờ chạy
      daNap = true;
      return { format: "custom" };
    });

    const res = await POST(yeuCauPhucHoi());

    expect(res.status).toBe(409); // KHÔNG phải 500: chưa đụng dữ liệu nên đừng xui đi lùi bản backup
    expect((await res.json()).error).toMatch(/quá lâu/i);
    expect(daNap).toBe(false);
    expect(thuHoiMoiPhienCoHan).not.toHaveBeenCalled();
    expect(dangPhucHoi()).toBe(true); // cờ của B còn nguyên
  });

  it("thu hồi phiên chạy xong nhưng khoá đã sang lượt khác GIỮA LÚC CHỜ → vẫn cảnh báo", async () => {
    // TOCTOU: câu kiểm trước `await` chỉ nói về thời điểm TRƯỚC. Bản thân lời gọi có thể lâu, và khi
    // quay lại thì mốc phiên ta vừa đẩy đã nằm trên schema của lượt khác.
    vi.mocked(thuHoiMoiPhienCoHan).mockImplementation(async () => {
      troiQua(TTL_KHOA_PHUC_HOI_MS + 1);
      luotBGianhCo();
    });

    const res = await POST(yeuCauPhucHoi());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; canhBao?: string };
    expect(body.canhBao).toMatch(/khoá bảo trì đã tự nhả/i);
  });

  it("thu hồi phiên LỖI mà khoá vẫn còn → cảnh báo đúng loại (không đổ cho mất khoá)", async () => {
    vi.mocked(thuHoiMoiPhienCoHan).mockRejectedValue(new Error("statement timeout"));

    const res = await POST(yeuCauPhucHoi());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { canhBao?: string };
    expect(body.canhBao).toMatch(/KHÔNG đẩy được mốc thu hồi phiên/i);
    expect(body.canhBao).not.toMatch(/khoá bảo trì đã tự nhả/i);
  });

  it("thu hồi phiên LỖI *và* đã mất khoá → báo mất khoá, không báo mỗi 'chưa đẩy được mốc'", async () => {
    // Nhánh reject cũng phải hỏi lại quyền sở hữu: treo lâu rồi mới ném thì lúc đó khoá có thể đã
    // sang lượt khác, mà câu "chỉ chưa đẩy được mốc phiên" giấu mất chuyện nghiêm trọng hơn nhiều —
    // dữ liệu vừa nạp có thể đã bị lượt kia đè.
    vi.mocked(thuHoiMoiPhienCoHan).mockImplementation(async () => {
      troiQua(TTL_KHOA_PHUC_HOI_MS + 1);
      luotBGianhCo();
      throw new Error("statement timeout");
    });

    const res = await POST(yeuCauPhucHoi());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { canhBao?: string };
    expect(body.canhBao).toMatch(/khoá bảo trì đã tự nhả/i);
    expect(body.canhBao).toMatch(/chạy chồng/i);
  });

  it("lượt chạy CHẬM nhưng vẫn tiến triển KHÔNG bị chặn oan — mỗi bước xong là gia hạn", async () => {
    // Hai bước dài, mỗi bước sát TTL: tổng vượt xa TTL nhưng không bước nào tự treo quá hạn. Không
    // có gia hạn thì fencing sẽ giết đúng một lượt phục hồi hợp lệ.
    vi.mocked(coLuotDangChay).mockImplementation(async () => {
      troiQua(TTL_KHOA_PHUC_HOI_MS - 1_000);
      return false;
    });
    vi.mocked(runPgDump).mockImplementation(async () => {
      troiQua(TTL_KHOA_PHUC_HOI_MS - 1_000);
      return Buffer.from("PGDMP-ban-lui-gia");
    });

    const res = await POST(yeuCauPhucHoi());

    expect(res.status).toBe(200);
    expect(runRestore).toHaveBeenCalledTimes(1);
    expect(thuHoiMoiPhienCoHan).toHaveBeenCalledTimes(1);
    expect(dangPhucHoi()).toBe(false); // `finally` trả khoá như thường
  });

  it("đường bình thường (không treo) vẫn nạp và thu hồi phiên như cũ", async () => {
    const res = await POST(yeuCauPhucHoi());

    expect(res.status).toBe(200);
    expect((await res.json()).canhBao).toBeUndefined();
    expect(runRestore).toHaveBeenCalledTimes(1);
    expect(thuHoiMoiPhienCoHan).toHaveBeenCalledTimes(1);
    expect(dangPhucHoi()).toBe(false);
  });
});
