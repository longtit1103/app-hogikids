import { z } from "zod";

import { chanRouteKhiDangPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { requireIngestSecret } from "@/lib/ingest/ingest-auth";
import { prisma } from "@/lib/prisma";

/**
 * POST /api/ingest/backup-log — HOST cron (`full-backup.sh`, phase 6) báo kết quả backup đêm.
 * Ghi thẳng 1 SyncLog kind BACKUP (KHÔNG qua withSyncLog — backup chạy ngoài app).
 * Một trong HAI nơi sinh SyncLog kind BACKUP: cron đêm (route này) và nút "Sao lưu ngay"
 * (`api/backup/route.ts`). Màn Cài đặt đọc dòng mới nhất qua `lib/backup/doc-trang-thai-sao-luu.ts`,
 * nên trạng thái sai thì phải soi cả hai nơi chứ không riêng route này.
 */
const backupLogSchema = z.object({
  status: z.enum(["OK", "ERROR"]),
  error: z.string().optional(),
  stats: z.object({ file: z.string(), sizeBytes: z.number(), drivePath: z.string() }).optional(),
});

export async function POST(req: Request): Promise<Response> {
  const unauthorized = requireIngestSecret(req);
  if (unauthorized) return unauthorized;

  // Dòng `SyncLog` ghi lúc này bị bản backup lùi mất dù sao. 503 để cron host (`full-backup.sh`)
  // thấy lỗi và ghi vào log của nó, thay vì nhận 200 rồi lượt sao lưu đêm mất dấu hoàn toàn.
  const dangPhucHoi = chanRouteKhiDangPhucHoi();
  if (dangPhucHoi) return dangPhucHoi;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const parsed = backupLogSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ ok: false, error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  const { status, error, stats } = parsed.data;
  await prisma.syncLog.create({
    data: { kind: "BACKUP", status, finishedAt: new Date(), stats, error },
  });
  return Response.json({ ok: true });
}
