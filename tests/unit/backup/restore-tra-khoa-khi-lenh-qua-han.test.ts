import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Đường TRẢ khoá bảo trì là `finally` của `POST /api/restore` — DUY NHẤT một chỗ. Suite này chốt
 * rằng nó chạy kể cả khi lệnh pg bị dừng vì QUÁ HẠN (nhánh lỗi mới), và kể cả khi route trả sớm
 * từ bên trong `try` (bản lùi hỏng). Sót đường nào là cờ kẹt: 10 workflow n8n nhận 503, sao lưu đêm
 * 503, mọi nút ghi tay lỗi — và không có banner nào báo.
 *
 * Không chạy pg thật: cái cần kiểm là dây nối khoá ↔ `finally`, không phải hành vi của pg_restore.
 */
vi.mock("@/lib/session", () => ({
  getAuthenticatedUserId: vi.fn(async () => "test-user"),
  thuHoiMoiPhien: vi.fn(async () => undefined),
}));

// Bước đẩy mốc phiên sau khi nạp — route gọi hàm này chứ không gọi thẳng `thuHoiMoiPhien`. Thiếu
// mock ở đây là ca "nạp thành công" mở `prisma.$transaction` THẬT lên DB test (đo được: suite từ
// 142ms lên 8s khi DB không tới được), trong khi suite này tuyên bố không chạm pg thật.
vi.mock("@/lib/backup/thu-hoi-phien-co-han", () => ({
  thuHoiMoiPhienCoHan: vi.fn(async () => undefined),
}));

// Cổng drain soi `SyncLog` — cho thông để test không đụng DB.
vi.mock("@/lib/ingest/sync-log", () => ({
  coLuotDangChay: vi.fn(async () => false),
}));

// Bản lùi: trả buffer giả, KHÔNG mở kết nối Postgres. Phải giữ nguyên các export còn lại —
// `run-restore.ts` lấy `parsePgUrl` từ chính file này.
vi.mock("@/lib/backup/run-pg-dump", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backup/run-pg-dump")>()),
  runPgDump: vi.fn(async () => Buffer.from("PGDMP-ban-lui-gia")),
}));

// Thư mục `/backups` là volume của container, không có trên máy chạy test — chặn đúng 3 hàm ghi,
// phần còn lại của `node:fs/promises` giữ nguyên bản thật.
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

// Chỉ thay `runRestore`; các guard thuần (detect/gunzipHead/assertNotArchive) giữ bản thật vì
// route gọi chúng TRƯỚC khi giành khoá.
vi.mock("@/lib/backup/run-restore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backup/run-restore")>()),
  runRestore: vi.fn(),
}));

import { POST } from "@/app/api/restore/route";
import { dangPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { runPgDump } from "@/lib/backup/run-pg-dump";
import { runRestore } from "@/lib/backup/run-restore";
import { donKhoaPhucHoi } from "../../helpers/khoa-bao-tri-reset";

/** Request multipart mang một file `.dump` hợp lệ ở mức magic (`PGDMP`). */
function yeuCauPhucHoi(): Request {
  const fd = new FormData();
  fd.append("file", new File([Buffer.from("PGDMP\x01noi-dung-gia")], "backup.dump"));
  return new Request("http://localhost/api/restore", { method: "POST", body: fd });
}

beforeEach(() => {
  donKhoaPhucHoi();
  vi.mocked(runPgDump).mockResolvedValue(Buffer.from("PGDMP-ban-lui-gia"));
  vi.mocked(runRestore).mockReset();
});

afterEach(() => {
  donKhoaPhucHoi();
});

describe("khoá bảo trì được trả trong finally", () => {
  it("lệnh nạp QUÁ HẠN → 500 nói rõ 'quá hạn', và khoá được trả (app không kẹt chỉ-đọc)", async () => {
    vi.mocked(runRestore).mockRejectedValue(
      new Error("pg_restore quá hạn 1200s và đã bị dừng — DB không phản hồi hoặc có phiên khác giữ khoá"),
    );

    const res = await POST(yeuCauPhucHoi());

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("quá hạn");
    // Câu báo vẫn phải chỉ đường bản lùi — quá hạn giữa chừng là ca dễ nạp dở nhất.
    expect(body.error).toContain("pre-restore-");
    expect(dangPhucHoi()).toBe(false);
  });

  it("nạp xong bình thường → khoá cũng được trả", async () => {
    vi.mocked(runRestore).mockResolvedValue({ format: "custom" });

    const res = await POST(yeuCauPhucHoi());

    expect(res.status).toBe(200);
    expect(dangPhucHoi()).toBe(false);
  });

  it("bản lùi hỏng → route `return` SỚM từ trong `try`, vẫn phải đi qua `finally`", async () => {
    vi.mocked(runPgDump).mockRejectedValue(new Error("pg_dump quá hạn 600s và đã bị dừng"));

    const res = await POST(yeuCauPhucHoi());

    expect(res.status).toBe(500);
    expect(vi.mocked(runRestore)).not.toHaveBeenCalled(); // chưa có bản lùi thì KHÔNG nạp
    expect(dangPhucHoi()).toBe(false);
  });

  it("khoá được trả sạch nên lượt phục hồi kế tiếp vào được ngay, không phải chờ TTL", async () => {
    vi.mocked(runRestore).mockRejectedValue(new Error("pg_restore quá hạn 1200s và đã bị dừng"));
    await POST(yeuCauPhucHoi());

    vi.mocked(runRestore).mockResolvedValue({ format: "custom" });
    const res = await POST(yeuCauPhucHoi());

    expect(res.status).toBe(200);
  });
});
