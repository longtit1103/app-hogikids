import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

// INGEST_SECRET phải set TRƯỚC khi gọi handler (requireIngestSecret đọc process.env lúc chạy).
const SECRET = "test-ingest-secret";
process.env.INGEST_SECRET = SECRET;

import { POST as backupLogPost } from "@/app/api/ingest/backup-log/route";
import { chonLogTheoArtifact, tinhTrangSaoLuu } from "@/lib/backup/trang-thai-sao-luu";
import { docTrangThaiSaoLuu } from "@/lib/backup/doc-trang-thai-sao-luu";
import { prisma } from "@/lib/prisma";
import { donKhoaPhucHoi } from "../helpers/khoa-bao-tri-reset";

/**
 * `backup-log` nhận NHÃN artifact ở MỨC TRÊN CÙNG của body (không nằm trong `stats`): lượt ERROR của
 * script không có file/sizeBytes/drivePath nên không thể đặt nhãn trong `stats` (zod sẽ trả 400 và
 * `curl` của script nuốt mất lỗi). Dòng SyncLog lưu nhãn vào `stats.artifact`.
 */

const URL = "http://t/api/ingest/backup-log";
const req = (body: unknown, tho?: string) =>
  new Request(URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
    body: tho ?? JSON.stringify(body),
  });

const logMoiNhat = () => prisma.syncLog.findFirst({ where: { kind: "BACKUP" }, orderBy: { startedAt: "desc" } });

beforeEach(async () => {
  await prisma.syncLog.deleteMany({ where: { kind: "BACKUP" } });
});
afterEach(() => {
  donKhoaPhucHoi();
});
afterAll(async () => {
  await prisma.syncLog.deleteMany({ where: { kind: "BACKUP" } });
  await prisma.$disconnect();
});

describe("POST /api/ingest/backup-log — nhãn artifact", () => {
  it("ERROR có artifact nhưng KHÔNG có stats → 200, nhãn lưu vào stats.artifact", async () => {
    const res = await backupLogPost(
      req({ status: "ERROR", artifact: "FULL_SERVER_REMOTE", error: "full-backup.sh: thieu khoa cong khai" }),
    );
    expect(res.status).toBe(200);
    const log = await logMoiNhat();
    expect(log!.status).toBe("ERROR");
    expect(log!.error).toBe("full-backup.sh: thieu khoa cong khai");
    expect((log!.stats as { artifact?: string }).artifact).toBe("FULL_SERVER_REMOTE");
  });

  it("OK có artifact + stats → stats giữ file/sizeBytes/drivePath và thêm artifact", async () => {
    const res = await backupLogPost(
      req({
        status: "OK",
        artifact: "APP_DUMP_REMOTE",
        stats: { file: "hogikids-20260727-1300.dump.age", sizeBytes: 123, drivePath: "cloud:backups/x" },
      }),
    );
    expect(res.status).toBe(200);
    const stats = (await logMoiNhat())!.stats as Record<string, unknown>;
    expect(stats).toMatchObject({ artifact: "APP_DUMP_REMOTE", file: "hogikids-20260727-1300.dump.age", sizeBytes: 123 });
  });

  it("body cũ (không artifact, không stats) vẫn 200 — script chưa được chép lên host không bị từ chối", async () => {
    expect((await backupLogPost(req({ status: "ERROR", error: "disk full" }))).status).toBe(200);
    expect((await logMoiNhat())!.stats).toBeNull();
  });

  it("artifact lạ → 400, không ghi dòng nào", async () => {
    const res = await backupLogPost(req({ status: "OK", artifact: "KHAC" }));
    expect(res.status).toBe(400);
    expect(await prisma.syncLog.count({ where: { kind: "BACKUP" } })).toBe(0);
  });

  it("`error` dài quá 2000 ký tự → 400", async () => {
    const res = await backupLogPost(req({ status: "ERROR", error: "x".repeat(2001) }));
    expect(res.status).toBe(400);
  });

  it("body vượt trần 16 KB → 413, không ghi dòng nào", async () => {
    const res = await backupLogPost(req({ status: "ERROR", error: "x".repeat(20_000) }));
    expect(res.status).toBe(413);
    expect(await prisma.syncLog.count({ where: { kind: "BACKUP" } })).toBe(0);
  });

  it("JSON hỏng → 400", async () => {
    const res = await backupLogPost(req(null, "{khong-phai-json"));
    expect(res.status).toBe(400);
  });
});

describe("docTrangThaiSaoLuu — đọc theo artifact từ SyncLog thật", () => {
  const gioTruoc = (g: number) => new Date(Date.now() - g * 3_600_000);

  it("full ERROR 9 giờ trước + dump app OK 1 giờ trước ⇒ tổng ĐỎ dù dòng mới nhất là OK", async () => {
    await prisma.syncLog.createMany({
      data: [
        {
          kind: "BACKUP",
          status: "ERROR",
          startedAt: gioTruoc(9),
          finishedAt: gioTruoc(9),
          error: "full-backup.sh: buoc tarball/ma hoa/upload that bai",
          stats: { artifact: "FULL_SERVER_REMOTE" },
        },
        {
          kind: "BACKUP",
          status: "OK",
          startedAt: gioTruoc(1),
          finishedAt: gioTruoc(1),
          stats: { artifact: "APP_DUMP_REMOTE", file: "a.dump.age", sizeBytes: 10, drivePath: "gdrive:b/a.dump.age" },
        },
      ],
    });
    const tt = await docTrangThaiSaoLuu();
    expect(tt.muc).toBe("loi");
    expect(tt.fullServer.muc).toBe("loi");
    expect(tt.appDump.muc).toBe("ok");
  });

  it("log cũ ERROR không stats/không tiền tố đẩy xuống dưới 60 dòng OK vẫn được tìm thấy (cửa sổ mở rộng)", async () => {
    // 70 dòng dump app OK mới hơn + 1 dòng FULL OK rất cũ nằm ngoài 30 dòng gần nhất.
    const dongApp = Array.from({ length: 70 }, (_, i) => ({
      kind: "BACKUP" as const,
      status: "OK" as const,
      startedAt: gioTruoc(1 + i * 0.01),
      finishedAt: gioTruoc(1 + i * 0.01),
      stats: { artifact: "APP_DUMP_REMOTE" },
    }));
    await prisma.syncLog.createMany({
      data: [
        ...dongApp,
        {
          kind: "BACKUP",
          status: "OK",
          startedAt: gioTruoc(100),
          finishedAt: gioTruoc(100),
          stats: { artifact: "FULL_SERVER_REMOTE", file: "f.age", sizeBytes: 1, drivePath: "gdrive:f/f.age" },
        },
      ],
    });
    const tt = await docTrangThaiSaoLuu();
    // FULL có log nhưng cũ 100 giờ ⇒ qua-han (KHÔNG phải chua-co — chua-co sẽ làm im banner).
    expect(tt.fullServer.muc).toBe("qua-han");
    expect(tt.muc).toBe("qua-han");
  });

  it("hàm thuần cho cùng kết quả với đường đọc DB", async () => {
    expect(tinhTrangSaoLuu(chonLogTheoArtifact([]), new Date()).muc).toBe("chua-co");
    expect((await docTrangThaiSaoLuu()).muc).toBe("chua-co");
  });
});
