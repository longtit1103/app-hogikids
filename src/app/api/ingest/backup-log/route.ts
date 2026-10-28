import { z } from "zod";

import { chanRouteKhiDangPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { ARTIFACT_SAO_LUU } from "@/lib/backup/trang-thai-sao-luu";
import { docBodyCoTran } from "@/lib/ingest/doc-body-co-tran";
import { requireIngestSecret } from "@/lib/ingest/ingest-auth";
import { prisma } from "@/lib/prisma";

/**
 * POST /api/ingest/backup-log — HOST cron (`full-backup.sh`, phase 6) báo kết quả backup đêm.
 * Ghi thẳng 1 SyncLog kind BACKUP (KHÔNG qua withSyncLog — backup chạy ngoài app).
 * Một trong HAI nơi sinh SyncLog kind BACKUP: cron đêm (route này) và nút "Sao lưu ngay"
 * (`api/backup/route.ts`). Màn Cài đặt đọc dòng mới nhất qua `lib/backup/doc-trang-thai-sao-luu.ts`,
 * nên trạng thái sai thì phải soi cả hai nơi chứ không riêng route này.
 *
 * `artifact` nằm ở MỨC TRÊN CÙNG của body, KHÔNG trong `stats`: lượt ERROR của script không có
 * file/sizeBytes/drivePath nên không thể mang `stats` đủ ba trường — đặt nhãn trong `stats` thì POST
 * lỗi bị 400 và `curl` của script nuốt mất, đúng lỗi "tarball hỏng mà Cài đặt vẫn xanh". Nhãn được
 * lưu vào `SyncLog.stats.artifact` (cột Json sẵn có, không migration); `stats` và `artifact` cùng
 * vắng ⇒ `stats` null như trước.
 */
const backupLogSchema = z.object({
  status: z.enum(["OK", "ERROR"]),
  error: z.string().max(2000).optional(),
  artifact: z.enum(ARTIFACT_SAO_LUU).optional(),
  stats: z.object({ file: z.string(), sizeBytes: z.number(), drivePath: z.string() }).optional(),
});

/** Trần thân request — body hợp lệ chỉ vài trăm byte; 16 KB đủ rộng mà không để ai nhét MB vào đây. */
const TRAN_BODY_BYTE = 16 * 1024;

export async function POST(req: Request): Promise<Response> {
  const unauthorized = requireIngestSecret(req);
  if (unauthorized) return unauthorized;

  // Dòng `SyncLog` ghi lúc này bị bản backup lùi mất dù sao. 503 để cron host (`full-backup.sh`)
  // thấy lỗi và ghi vào log của nó, thay vì nhận 200 rồi lượt sao lưu đêm mất dấu hoàn toàn.
  const dangPhucHoi = chanRouteKhiDangPhucHoi();
  if (dangPhucHoi) return dangPhucHoi;

  // Đọc thân có trần TRƯỚC khi parse. Lỗi đọc luồng (client ngắt giữa chừng) rơi về nhánh 400 như
  // `req.json()` cũ.
  const doc = await docBodyCoTran(req, TRAN_BODY_BYTE).catch(() => null);
  if (doc === null) {
    return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (!doc.ok) {
    return Response.json(
      { ok: false, error: `body ${doc.bytes} byte vượt trần ${TRAN_BODY_BYTE} byte` },
      { status: 413 },
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(doc.text);
  } catch {
    return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const parsed = backupLogSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ ok: false, error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  const { status, error, artifact, stats } = parsed.data;
  const statsLuu = artifact || stats ? { ...stats, ...(artifact ? { artifact } : {}) } : undefined;
  await prisma.syncLog.create({
    data: { kind: "BACKUP", status, finishedAt: new Date(), stats: statsLuu, error },
  });
  return Response.json({ ok: true });
}
