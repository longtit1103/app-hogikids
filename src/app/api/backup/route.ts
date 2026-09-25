import { format } from "date-fns";

import { chanRouteKhiDangPhucHoi, dangPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { giuKhoaViecNang, traKhoaViecNang } from "@/lib/backup/khoa-viec-nang";
import { runPgDump } from "@/lib/backup/run-pg-dump";
import { chanRequestKhacOrigin } from "@/lib/chan-request-khac-origin";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUserId } from "@/lib/session";

/** Tên việc nặng của nút "Sao lưu ngay" — hiện trong câu 409 khi một việc nặng khác đang chạy. */
const VIEC_SAO_LUU = "sao lưu dữ liệu (tải bản backup)";

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

  // Giành khoá việc nặng TRƯỚC `runPgDump()` — thiếu cổng này thì bấm liên tiếp (hoặc double-click)
  // xếp chồng nhiều `pg_dump` cùng lúc, mỗi lượt tốn tài nguyên như nhau. Dùng CHUNG khoá với
  // `/api/restore`/`rebuild-from-raw`/script ghi giá vốn — một lượt sao lưu tay đang chạy cũng phải
  // chặn được các việc nặng khác, không riêng chặn chính nó.
  //
  // BỌC try/catch: `giuKhoaViecNang` tự nó chạm DB (đọc/ghi bảng `Setting`) — DB down thì nó NÉM,
  // và câu ném đó đứng NGOÀI try/catch của thân route nếu không bọc riêng ⇒ lọt qua handler thành
  // lỗi chưa bắt, Next.js trả 500 HTML mặc định, phá hợp đồng JSDoc "luôn trả 500 JSON {error}".
  let luotGianh: Awaited<ReturnType<typeof giuKhoaViecNang>>;
  try {
    luotGianh = await giuKhoaViecNang(VIEC_SAO_LUU);
  } catch (err) {
    console.error("Không kiểm được khoá việc nặng trước lượt sao lưu:", err);
    return Response.json(
      { error: "Không kiểm được khoá việc nặng — cơ sở dữ liệu không phản hồi, thử lại sau." },
      { status: 503 },
    );
  }
  if (!luotGianh.the) {
    return Response.json(
      {
        error:
          `Đang có việc nặng "${luotGianh.dangGiu}" chạy — chờ xong rồi thử lại. ` +
          "(Nếu app vừa khởi động lại hoặc vừa nạp một bản backup thì đây có thể là khoá cũ còn " +
          "sót — nó tự hết hạn trong tối đa 5 phút.)",
      },
      { status: 409 },
    );
  }
  const theViec = luotGianh.the;

  // Giới hạn CỐ Ý không gia hạn: khoá sống 5' (`HAN_KHOA_MS`) nhưng `pg_dump` được phép chạy tới
  // 10' (`HAN_PG_DUMP_MS`, xem `run-pg-dump.ts`). Một lượt dump treo trong khe 5'–10' sẽ để khoá hết
  // hạn khi dump vẫn chạy ⇒ lượt phục hồi giành được khoá nhưng vẫn phải chờ `pg_dump` nhả khoá
  // đọc của nó (pg_restore có hạn riêng). Chấp nhận vì dump toàn bộ prod (~56 MiB) đo thật chạy
  // vài giây; và `pg_dump` có timeout riêng nên không bao giờ giữ khoá vô hạn.
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
    // KHÔNG đưa err.message thô vào response: `runPgDump` đã tự lọc stderr (hostname DB, role) ra
    // console server trước khi ném lên đây, nên message tới đây vốn đã an toàn để hiện nguyên văn —
    // vẫn log thêm một lần ở đây để có dấu vết đầy đủ ngay tại route.
    const message = err instanceof Error ? err.message : "Sao lưu thất bại";
    console.error("Sao lưu thất bại:", err);
    // Ghi cả lượt LỖI: bấm nút mà dump hỏng vẫn phải hiện "loi" ở màn Cài đặt, không được lặng
    // thinh coi như chưa có gì xảy ra (đúng thứ cảnh báo giả mà nguồn SyncLog này sinh ra để sửa).
    await ghiLogSaoLuu({ status: "ERROR", finishedAt: new Date(), error: message });
    return Response.json({ error: message }, { status: 500 });
  } finally {
    // Best-effort, giống `/api/restore`: dump hỏng giữa lượt phục hồi có thể đã đổi/xoá dòng khoá —
    // lỗi trả khoá TUYỆT ĐỐI không được che response gốc. Route KHÔNG stream (trả Buffer trọn vẹn ở
    // trên) nên không có cửa sổ "trả khoá trước khi body đã gửi hết" phải lo.
    try {
      await traKhoaViecNang(theViec);
    } catch (err) {
      console.error("Không trả được khoá việc nặng sau lượt sao lưu — tự hết hạn tối đa 5 phút.", err);
    }
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
