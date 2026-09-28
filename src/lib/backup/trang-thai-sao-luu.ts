/**
 * Trạng thái "Sao lưu" hiển thị ở Cài đặt › Dữ liệu.
 *
 * MỘT nguồn sự thật duy nhất = dòng `SyncLog` kind BACKUP MỚI NHẤT — ghi bởi CẢ nút "Sao lưu ngay"
 * (`api/backup/route.ts`) LẪN cron đêm (`POST /api/ingest/backup-log`). Trước đây route tay còn ghi
 * riêng `Setting.lastBackupAt`, còn cron chỉ ghi `SyncLog`; hai nguồn trôi nhau khiến prod có 21 lượt
 * backup đêm OK liên tiếp (từ 12/07) mà màn hình vẫn kêu "Chưa sao lưu lần nào" (đo 01/08 — bảng
 * `Setting` không có key đó). Bỏ hẳn nguồn thứ hai, không còn gì để trôi.
 */

export type MucSaoLuu = "chua-co" | "ok" | "qua-han" | "loi";

export type TrangThaiSaoLuu = {
  muc: MucSaoLuu;
  /** Lúc lượt backup gần nhất XONG (thành công hoặc lỗi) — null khi chưa có dòng nào. */
  finishedAt: Date | null;
  /** Số giờ đã trôi qua kể từ `finishedAt` — null khi chưa có dòng nào. */
  gioTruoc: number | null;
  /** Dung lượng file (byte), đọc từ `SyncLog.stats.sizeBytes` — null khi không có/không đọc được. */
  fileSizeBytes: number | null;
  /** Nội dung lỗi, chỉ có khi `muc === "loi"`. */
  error: string | null;
};

/**
 * Quá ngần này giờ mà chưa có bản backup OK mới là BẤT THƯỜNG. Cron chạy 1 lần/đêm (4h VN) ⇒ 24h +
 * 12h biên trôi (giờ chạy xê dịch, container khởi động lại, lượt chạy lâu).
 *
 * Biên này CHỈ dung thứ ca cron KHÔNG BÁO GÌ (im lặng — không có dòng `SyncLog` mới nào). Lượt cron
 * có BÁO LỖI thì rơi vào nhánh `status === "ERROR"` ở `tinhTrangSaoLuu` và kêu NGAY, không chờ hết
 * 36h — nên đừng đọc con số này thành "chịu được 1 lượt lỗi".
 */
export const GIO_QUA_HAN_SAO_LUU = 36;

/**
 * Phần `SyncLog` cần để tính trạng thái — tách kiểu HẸP (không import type Prisma) để test dựng
 * object tay được, không phải seed DB.
 */
export type LogSaoLuuGanNhat = {
  status: string;
  finishedAt: Date | null;
  stats: unknown;
  error: string | null;
};

/** Đọc `sizeBytes` từ `stats` Json — không tin cấu trúc tuỳ ý, sai kiểu thì coi như không có. */
function docKichThuocFile(stats: unknown): number | null {
  if (!stats || typeof stats !== "object") return null;
  const sizeBytes = (stats as Record<string, unknown>).sizeBytes;
  return typeof sizeBytes === "number" ? sizeBytes : null;
}

/**
 * Suy ra trạng thái hiển thị từ dòng `SyncLog` kind BACKUP mới nhất (`null` = chưa từng backup).
 * Hàm THUẦN — không đụng Prisma/`Date.now()` ngoài tham số `bayGio` — để test không cần DB.
 */
export function tinhTrangSaoLuu(
  logGanNhat: LogSaoLuuGanNhat | null,
  bayGio: Date = new Date(),
): TrangThaiSaoLuu {
  if (!logGanNhat) {
    return { muc: "chua-co", finishedAt: null, gioTruoc: null, fileSizeBytes: null, error: null };
  }

  const fileSizeBytes = docKichThuocFile(logGanNhat.stats);
  const gioTruoc = logGanNhat.finishedAt
    ? (bayGio.getTime() - logGanNhat.finishedAt.getTime()) / 3_600_000
    : null;

  if (logGanNhat.status === "ERROR") {
    return { muc: "loi", finishedAt: logGanNhat.finishedAt, gioTruoc, fileSizeBytes, error: logGanNhat.error };
  }

  // status OK — cả 2 producer (route tay + backup-log) luôn ghi kèm `finishedAt` ngay lúc tạo, nên
  // thiếu nó là bất thường (vd RUNNING treo lạc vào kind BACKUP dù không đi qua `withSyncLog`).
  // Coi như "quá hạn" cho AN TOÀN, không tự nhận "ok" khi chưa chắc lượt đó đã xong.
  if (!logGanNhat.finishedAt || gioTruoc === null) {
    return { muc: "qua-han", finishedAt: logGanNhat.finishedAt, gioTruoc: null, fileSizeBytes, error: null };
  }

  return {
    muc: gioTruoc > GIO_QUA_HAN_SAO_LUU ? "qua-han" : "ok",
    finishedAt: logGanNhat.finishedAt,
    gioTruoc,
    fileSizeBytes,
    error: null,
  };
}

/**
 * Mức nào thì banner sticky TOÀN APP phải kêu về sao lưu (`ShellChrome`, prop `saoLuuCoVanDe`).
 *
 * Tách khỏi `layout.tsx` để test khoá được: viết thẳng điều kiện trong server component thì đổi nó
 * đi cả suite vẫn xanh — mà đây là quy tắc quyết định chủ shop CÓ được báo hay không.
 *
 * `"chua-co"` CỐ Ý không kêu: shop mới cài chưa chạy lượt nào sẽ dính banner đỏ mọi màn ngay từ
 * phút đầu, trong khi thẻ "Sao lưu" ở Cài đặt đã nói đúng ca đó. Hai mức còn lại thì kêu — `"loi"`
 * là lượt gần nhất hỏng thật, `"qua-han"` là quá `GIO_QUA_HAN_SAO_LUU` giờ không có bản mới (cron
 * chết câm), cả hai đều nghĩa là điểm phục hồi mới nhất KHÔNG còn đáng tin.
 */
export function saoLuuCanBaoDong(muc: MucSaoLuu): boolean {
  return muc === "loi" || muc === "qua-han";
}
