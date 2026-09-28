import type { SyncKind } from "@prisma/client";

import { prisma } from "@/lib/prisma";

const STALE_MS = 15 * 60_000; // RUNNING treo > 15' = app crash giữa ingest
const MAX_WARNINGS = 50; // trần warning ghi vào stats — 1 trang lỗi shape hàng loạt sẽ phình SyncLog.stats

/** Giữ tối đa MAX_WARNINGS dòng + 1 dòng tóm tắt phần bị cắt (đủ để chẩn đoán, không phình bảng). */
function capWarnings(warnings: string[]): string[] {
  if (warnings.length <= MAX_WARNINGS) return warnings;
  return [...warnings.slice(0, MAX_WARNINGS), `... và ${warnings.length - MAX_WARNINGS} cảnh báo khác`];
}

/**
 * Có lượt nào đang RUNNING và CÒN SỐNG không. `kind` bỏ trống = soi MỌI kind.
 *
 * Cửa sổ tuổi là PHẦN BÙ của `STALE_MS`: quá mốc đó `withSyncLog` chuyển log thành ERROR (xem bước
 * CLEANUP dưới), nên một log treo do app restart KHÔNG được khoá đường ghi vĩnh viễn. Dùng chung cho
 * mọi đường muốn hỏi "có ai đang ghi không" — kể cả tiến trình NGOÀI app (script CLI), vì đây là dấu
 * hiệu nằm trong DB chứ không phải cờ trong RAM.
 *
 * Chặn `startedAt` theo cửa sổ cũng để câu này đi index `[kind, startedAt]` KHI có `kind`, thay vì
 * quét cả bảng (`SyncLog` đẻ 1 dòng/trang ingest). Bỏ trống `kind` thì index đó không dùng được —
 * chấp nhận có chủ đích: đường gọi kiểu đó là thao tác TAY hiếm, 1 câu/lượt, không nằm trên đường
 * ingest nóng.
 */
export async function coLuotDangChay(kind?: SyncKind): Promise<boolean> {
  const dangChay = await prisma.syncLog.findFirst({
    where: {
      ...(kind ? { kind } : {}),
      status: "RUNNING",
      startedAt: { gte: new Date(Date.now() - STALE_MS) },
    },
    select: { id: true },
  });
  return dangChay !== null;
}

/**
 * Bọc 1 lần ingest bằng SyncLog:
 *  (1) CLEANUP: mọi log cùng kind RUNNING treo > 15' → ERROR (app crash/restart) — để nút "Đồng bộ ngay"
 *      không kẹt disabled vĩnh viễn.
 *  (2) tạo log RUNNING → chạy `fn(warnings, syncLogId)` → OK + stats={...result, warnings} / catch → ERROR + trả 500.
 *  (3) `fn` trả kèm `loiSauKhiGhi` (chuỗi) ⇒ dữ liệu ĐÃ ghi xong nhưng lượt này có phần bị bỏ cần người
 *      xem: log ERROR (bật banner đồng bộ) mà HTTP vẫn 200. Không ném để trả 500 được — n8n THỬ LẠI khi
 *      5xx rồi ném, mọi chunk phía sau không được gửi nữa. Còn OK + cảnh báo thì không ai thấy: n8n chỉ
 *      đọc `rowsUpserted`, badge /cai-dat xanh, banner chỉ bật với ERROR.
 *
 * `syncLogId` truyền xuống để ingest gắn lineage (Bronze `syncLogId`: dòng raw này đến từ lần sync nào).
 */
export async function withSyncLog(
  kind: SyncKind,
  fn: (warnings: string[], syncLogId: string) => Promise<Record<string, unknown>>,
): Promise<Response> {
  await prisma.syncLog.updateMany({
    where: { kind, status: "RUNNING", startedAt: { lt: new Date(Date.now() - STALE_MS) } },
    data: { status: "ERROR", finishedAt: new Date(), error: "treo do app restart" },
  });

  const log = await prisma.syncLog.create({ data: { kind, status: "RUNNING" } });
  const warnings: string[] = [];
  try {
    const { loiSauKhiGhi, ...result } = await fn(warnings, log.id);
    const stats = { ...result, warnings: capWarnings(warnings) };
    const loi = typeof loiSauKhiGhi === "string" && loiSauKhiGhi ? loiSauKhiGhi : null;
    await prisma.syncLog.update({
      where: { id: log.id },
      data: loi
        ? { status: "ERROR", finishedAt: new Date(), error: loi, stats }
        : { status: "OK", finishedAt: new Date(), stats },
    });
    return Response.json(loi ? { ok: true, stats, loiSauKhiGhi: loi } : { ok: true, stats });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // GIỮ warnings đã thu được, đừng vứt. Chúng là thứ nói ĐƠN NÀO hỏng và vì sao — mà lượt hỏng
    // mới đúng là lượt cần chẩn đoán nhất. Trước đây nhánh này chỉ ghi `error`, nên một thông báo
    // kiểu "xem cảnh báo trong cùng lượt này" trỏ tới chỗ không tồn tại.
    const stats = warnings.length ? { warnings: capWarnings(warnings) } : undefined;
    await prisma.syncLog.update({
      where: { id: log.id },
      data: { status: "ERROR", finishedAt: new Date(), error, ...(stats ? { stats } : {}) },
    });
    return Response.json({ ok: false, error, ...(stats ? { stats } : {}) }, { status: 500 });
  }
}
