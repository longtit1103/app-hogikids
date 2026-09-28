import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/session", () => ({
  getSession: async () => ({ userId: "test-user" }),
  getAuthenticatedUserId: async () => "test-user",
  // Route đẩy mốc phiên sau khi nạp xong — các case dưới đều return trước đó, chỉ cần export tồn tại.
  thuHoiMoiPhien: vi.fn(async () => undefined),
}));

// Chặn `pg_dump` THẬT: case "log treo quá lâu" cố ý đi QUA cổng drain, mà ngay sau đó route chụp
// bản lùi. Không chặn thì test mở kết nối tới DB test qua Tailscale và mất hàng chục giây — chậm,
// phụ thuộc mạng, và không kiểm thêm điều gì (cái cần chốt là cổng drain, không phải bản lùi).
// Ném lỗi ⇒ route trả 500 ngay tại bước bản lùi, tức đã đi qua cổng drain đúng như kỳ vọng.
vi.mock("@/lib/backup/run-pg-dump", () => ({
  runPgDump: vi.fn(async () => {
    throw new Error("pg_dump bị chặn trong test");
  }),
}));

import { POST } from "@/app/api/restore/route";
import { thuGiuKhoaPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { prisma } from "@/lib/prisma";
import { donKhoaPhucHoi } from "./helpers/khoa-bao-tri-reset";

/**
 * Nối dây khoá bảo trì vào `POST /api/restore`: lượt phục hồi thứ hai phải bị TỪ CHỐI, không được
 * xếp hàng chạy tiếp — hai lượt xen nhau sẽ ghi đè lúc schema đang bị drop/tạo lại (dữ liệu lai),
 * và bản lùi của lượt này có thể chụp đúng trạng thái dở dang của lượt kia.
 *
 * Test giành khoá TRỰC TIẾP thay vì bắn 2 request song song: kết quả tất định, và không cần chạy
 * `pg_dump`/`pg_restore` thật.
 */
function formCoFile(bytes: Buffer): FormData {
  const fd = new FormData();
  fd.set("file", new File([new Uint8Array(bytes)], "backup.dump"));
  return fd;
}

function req(fd: FormData): Request {
  return new Request("http://localhost/api/restore", { method: "POST", body: fd });
}

describe("POST /api/restore — khoá độc quyền", () => {
  afterEach(() => {
    donKhoaPhucHoi();
  });

  it("đang có lượt phục hồi khác → 409, KHÔNG đụng DB", async () => {
    expect(thuGiuKhoaPhucHoi()).not.toBeNull(); // giả lập lượt đang chạy

    const res = await POST(req(formCoFile(Buffer.from("PGDMP dữ liệu giả"))));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/lượt phục hồi khác/i);
  });

  it("khoá được TRẢ sau khi request xong (kể cả request lỗi) — không kẹt vĩnh viễn", async () => {
    // File rác → route trả 400 ở bước nhận diện định dạng, tức thoát SỚM khỏi vùng có khoá.
    const res = await POST(req(formCoFile(Buffer.from("khong-phai-backup"))));
    expect(res.status).toBe(400);

    // Nếu `finally` không trả khoá thì lượt sau sẽ nhận 409 mãi mãi.
    expect(thuGiuKhoaPhucHoi()).not.toBeNull();
  });
});

/**
 * DRAIN: khoá bảo trì chỉ chặn request MỚI. Một lượt ingest vào TRƯỚC đó vẫn đang ghi (land 1 trang
 * được cấp tới 60s) và sẽ ghi vào schema sắp bị thay sạch. Cổng này soi `SyncLog` RUNNING còn sống.
 */
describe("POST /api/restore — cổng chặn lượt đồng bộ đang chạy", () => {
  afterEach(async () => {
    await prisma.syncLog.deleteMany();
    donKhoaPhucHoi();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("đang có lượt đồng bộ chạy → 409, chưa đụng DB, và khoá được trả lại", async () => {
    await prisma.syncLog.deleteMany();
    await prisma.syncLog.create({ data: { kind: "PANCAKE", status: "RUNNING" } });

    const res = await POST(req(formCoFile(Buffer.from("PGDMP dữ liệu giả"))));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/lượt đồng bộ/i);
    // Cổng nằm TRONG khối try nên `finally` phải trả khoá — đặt ngoài thì app kẹt vĩnh viễn.
    expect(thuGiuKhoaPhucHoi()).not.toBeNull();
  });

  it("log RUNNING treo quá lâu KHÔNG khoá phục hồi vĩnh viễn", async () => {
    await prisma.syncLog.deleteMany();
    await prisma.syncLog.create({
      data: { kind: "PANCAKE", status: "RUNNING", startedAt: new Date(Date.now() - 20 * 60_000) },
    });

    const res = await POST(req(formCoFile(Buffer.from("PGDMP dữ liệu giả"))));

    // Cố ý assert NOT 409 chứ không assert 200: qua cổng này route đi tiếp vào pre-backup, mà
    // `runPgDump` đã bị mock ném lỗi ⇒ 500. Điều cần chốt là cổng drain KHÔNG chặn log đã quá cửa
    // sổ sống — 500 ở bước sau chính là bằng chứng nó đã đi qua.
    expect(res.status).not.toBe(409);
    expect(res.status).toBe(500);
  });
});
