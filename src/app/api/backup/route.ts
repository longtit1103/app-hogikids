import { format } from "date-fns";

import { chanRouteKhiDangPhucHoi, dangPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { runPgDump } from "@/lib/backup/run-pg-dump";
import { chanRequestKhacOrigin } from "@/lib/chan-request-khac-origin";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUserId } from "@/lib/session";

/**
 * POST /api/backup — tải bản pg_dump `-Fc` (custom-format) của schema app.
 *
 * POST (không phải GET) vì route CÓ side-effect (chạy pg_dump tốn tài nguyên +
 * ghi SyncLog kind BACKUP); GET còn kích được cross-site qua thẻ <a>/<img>
 * (cookie sameSite=lax vẫn gửi cho GET top-level, POST thì không).
 *
 * Guard bằng `getAuthenticatedUserId()` (KHÔNG `requireUser()`: nó `redirect()` — sai cho
 * route API; ở đây không có phiên → trả 401 JSON). Thành công → ghi 1 dòng SyncLog
 * kind BACKUP status OK (CÙNG nguồn với cron đêm `api/ingest/backup-log`, xem
 * `lib/backup/trang-thai-sao-luu.ts` — màn Cài đặt chỉ đọc SyncLog, không còn đọc
 * `Setting.lastBackupAt`) rồi trả Buffer dump kèm `Content-Disposition` attachment
 * (tên `hogikids-{yyyyMMdd-HHmm}.dump`, giờ VN vì container TZ=Asia/Ho_Chi_Minh).
 * pg_dump throw (thiếu binary/DB down) → ghi SyncLog status ERROR rồi trả 500 JSON
 * `{error}` — KHÔNG bao giờ trả file rỗng âm thầm (bản backup hỏng nguy hiểm), và
 * KHÔNG được để lượt lỗi này biến mất khỏi nguồn trạng thái duy nhất.
 */
export async function POST(request: Request): Promise<Response> {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Lớp thứ hai sau cookie `sameSite=lax`: cửa sổ "Lax-allowing-unsafe" 2 phút của Chrome vẫn gửi
  // cookie kèm POST top-level cross-site ⇒ trang lạ ép được máy chủ chạy pg_dump. Xem lý do đầy
  // đủ ở `chanRequestKhacOrigin`.
  const khacOrigin = chanRequestKhacOrigin(request);
  if (khacOrigin) return khacOrigin;

  // Lý do KHÔNG phải dòng SyncLog bên dưới, mà là chính FILE trả về: bấm nút lúc
  // `pg_restore --clean` đã drop được một nửa object thì `pg_dump` vẫn CHẠY XONG trên phần schema
  // còn lại và trả một file đúng tên, đúng giờ, THIẾU dữ liệu — một bản sao lưu sai nằm chờ ngày
  // được nạp. Ngược chiều: pg_dump giữ ACCESS SHARE trên mọi bảng, xung đột ACCESS EXCLUSIVE mà
  // DROP cần ⇒ hai bên chặn nhau và lượt phục hồi treo.
  // Tên biến KHÔNG trùng `dangPhucHoi` đã import: `ghiLogSaoLuu` bên dưới gọi lại đúng hàm đó, che
  // nó bằng một `Response | null` ở đây chỉ tổ gây đọc nhầm.
  const chanPhucHoi = chanRouteKhiDangPhucHoi();
  if (chanPhucHoi) return chanPhucHoi;

  try {
    const dump = await runPgDump();
    const finishedAt = new Date();
    const filename = `hogikids-${format(finishedAt, "yyyyMMdd-HHmm")}.dump`;

    // Nguồn trạng thái DUY NHẤT cho `lib/backup/trang-thai-sao-luu.ts` (màn Cài đặt) — CÙNG kind
    // BACKUP với cron đêm `api/ingest/backup-log`, không tạo nguồn thứ hai để rồi trôi nhau như
    // `Setting.lastBackupAt` cũ (đã bỏ). Không có `drivePath` — bản tay không đẩy Google Drive.
    await ghiLogSaoLuu({ status: "OK", finishedAt, stats: { file: filename, sizeBytes: dump.length } });

    // Buffer (node) không khớp BodyInit của DOM lib → bọc Uint8Array-view.
    return new Response(new Uint8Array(dump), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store", // dump chứa TOÀN BỘ dữ liệu — không để browser/CDN cache
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sao lưu thất bại";
    // Ghi cả lượt LỖI: bấm nút mà dump hỏng vẫn phải hiện "loi" ở màn Cài đặt, không được lặng
    // thinh coi như chưa có gì xảy ra (đúng thứ cảnh báo giả mà nguồn SyncLog này sinh ra để sửa).
    await ghiLogSaoLuu({ status: "ERROR", finishedAt: new Date(), error: message });
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * Ghi 1 dòng SyncLog kind BACKUP, nuốt lỗi ghi (best-effort): DB đã down tới mức `pg_dump` hỏng thì
 * việc ghi log khả năng cũng hỏng theo — không để lượt ghi log thứ hai này ném lỗi che mất JSON
 * `{error}` gốc mà người bấm nút đang chờ.
 *
 * KIỂM KHOÁ BẢO TRÌ LẦN HAI (cả nhánh OK lẫn nhánh lỗi): guard đầu route chạy TRƯỚC `runPgDump()` —
 * một lệnh kéo dài hàng chục giây. `POST /api/restore` giành khoá rồi mới chụp bản lùi, nên cửa sổ
 * "dump tay đang chạy thì lượt phục hồi bắt đầu" là có thật; ghi tiếp lúc đó là INSERT vào schema
 * sắp bị drop + nạp lại, đúng thứ mà khoá bảo trì sinh ra để chặn. Bỏ qua dòng log còn hơn ghi vào
 * giữa lượt phục hồi: bản dump vẫn trả về cho người bấm nút, chỉ là màn Cài đặt không thấy dấu vết.
 */
async function ghiLogSaoLuu(data: {
  status: "OK" | "ERROR";
  finishedAt: Date;
  stats?: { file: string; sizeBytes: number };
  error?: string;
}): Promise<void> {
  if (dangPhucHoi()) return;

  try {
    await prisma.syncLog.create({ data: { kind: "BACKUP", ...data } });
  } catch (err) {
    console.error("Ghi SyncLog kind BACKUP thất bại:", err);
  }
}
