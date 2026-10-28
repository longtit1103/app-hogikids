/**
 * Trạng thái "Sao lưu" hiển thị ở Cài đặt › Dữ liệu.
 *
 * MỘT nguồn sự thật duy nhất = các dòng `SyncLog` kind BACKUP — ghi bởi nút "Sao lưu ngay"
 * (`api/backup/route.ts`) và hai script host (`POST /api/ingest/backup-log`). Trước đây route tay còn
 * ghi riêng `Setting.lastBackupAt`, còn cron chỉ ghi `SyncLog`; hai nguồn trôi nhau khiến prod có 21
 * lượt backup đêm OK liên tiếp (từ 12/07) mà màn hình vẫn kêu "Chưa sao lưu lần nào" (đo 01/08 —
 * bảng `Setting` không có key đó). Bỏ hẳn nguồn thứ hai, không còn gì để trôi.
 *
 * TRẠNG THÁI TÍNH THEO TỪNG ARTIFACT, không theo "dòng mới nhất bất kể loại": hai artifact BẮT BUỘC
 * (dump schema app đẩy Drive 2 lượt/ngày · tarball toàn server đẩy Drive mỗi đêm) + bản tải tay (không
 * lên Drive). Nếu gộp chung một dòng mới nhất thì dump app OK 13:00 che mất lỗi tarball 04:05, và khi
 * cron tarball chết hẳn mà dump app vẫn chạy thì cảnh báo quá hạn không bao giờ xuất hiện — trong khi
 * dump app KHÔNG chứa volume n8n, khoá mã hoá credential, cấu hình Supabase cần cho phục hồi toàn máy.
 * Bản tải tay không được xoá lỗi/quá hạn của hai artifact kia.
 */

export type MucSaoLuu = "chua-co" | "ok" | "qua-han" | "loi";

/**
 * Nhãn artifact do script/route gắn vào body `backup-log` (lưu ở `SyncLog.stats.artifact`).
 * `APP_DUMP_REMOTE` = dump schema `app` đã mã hoá lên Drive · `FULL_SERVER_REMOTE` = tarball toàn server
 * mã hoá lên Drive · `MANUAL_DOWNLOAD` = nút "Sao lưu ngay" (tải về máy, không lên Drive).
 */
export const ARTIFACT_SAO_LUU = ["APP_DUMP_REMOTE", "FULL_SERVER_REMOTE", "MANUAL_DOWNLOAD"] as const;
export type ArtifactSaoLuu = (typeof ARTIFACT_SAO_LUU)[number];

/** Trạng thái của MỘT artifact (cùng 5 trường mà trước đây cả khối dùng chung). */
export type TrangThaiMotArtifact = {
  muc: MucSaoLuu;
  /** Lúc lượt backup gần nhất của artifact XONG (thành công hoặc lỗi) — null khi chưa có dòng nào. */
  finishedAt: Date | null;
  /** Số giờ đã trôi qua kể từ `finishedAt` — null khi chưa có dòng nào. */
  gioTruoc: number | null;
  /** Dung lượng file (byte), đọc từ `SyncLog.stats.sizeBytes` — null khi không có/không đọc được. */
  fileSizeBytes: number | null;
  /** Nội dung lỗi, chỉ có khi `muc === "loi"`. */
  error: string | null;
};

/**
 * Trạng thái hiển thị. NĂM trường đầu (`muc`…`error`) là của artifact BẮT BUỘC XẤU NHẤT — banner toàn
 * app (`saoLuuCanBaoDong(muc)`) chỉ cần đọc `muc`. `thuCong` KHÔNG tham gia mức tổng.
 */
export type TrangThaiSaoLuu = TrangThaiMotArtifact & {
  appDump: TrangThaiMotArtifact;
  fullServer: TrangThaiMotArtifact;
  thuCong: TrangThaiMotArtifact;
};

/**
 * Quá ngần này giờ mà chưa có bản backup OK mới là BẤT THƯỜNG — áp cho CẢ HAI artifact bắt buộc: cả
 * tarball (`full-backup.sh`) lẫn dump app chạy cron hằng đêm (4h VN; `0 4 * * *`, runbook), dump app
 * còn thêm lượt 13:00. 24h + 12h biên trôi (giờ chạy xê dịch, container khởi động lại, lượt chạy lâu).
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

/** Danh sách log đã xếp vào 3 ô — mỗi ô giữ log MỚI NHẤT của artifact đó (hoặc `null`). */
export type LogsTheoArtifact = {
  appDump: LogSaoLuuGanNhat | null;
  fullServer: LogSaoLuuGanNhat | null;
  manual: LogSaoLuuGanNhat | null;
};

const MAU_DUMP_APP_CU = /hogikids-\d{8}-\d{4}\.dump\.age$/;

function docObject(stats: unknown): Record<string, unknown> | null {
  return stats && typeof stats === "object" && !Array.isArray(stats) ? (stats as Record<string, unknown>) : null;
}

/**
 * Xếp một dòng log vào artifact. `null` = KHÔNG XÁC ĐỊNH ĐƯỢC NGUỒN.
 *
 * Thứ tự tin cậy: ① nhãn `stats.artifact` (script/route mới gắn) → ② log CŨ: `drivePath`/`file` có
 * dạng `hogikids-YYYYMMDD-HHMM.dump.age` ⇒ dump app; tiền tố `error` `full-backup.sh:` ⇒ tarball,
 * `backup-app-dump.sh:` ⇒ dump app; có `file` mà không `drivePath` ⇒ bản tải tay.
 *
 * Log ERROR không rõ nguồn KHÔNG ĐƯỢC rơi vào "tải tay": script cũ trên host (chưa được chép bản mới)
 * gửi ERROR không stats; xếp nó vào ô không-bắt-buộc là chính lỗi che lỗi mà cả khối này sinh ra để
 * chặn. Chọn log ở `chonLogTheoArtifact` áp ERROR không rõ nguồn cho CẢ HAI artifact bắt buộc.
 */
export function phanLoaiArtifact(log: LogSaoLuuGanNhat): ArtifactSaoLuu | null {
  const stats = docObject(log.stats);
  const nhan = stats?.artifact;
  if (typeof nhan === "string" && (ARTIFACT_SAO_LUU as readonly string[]).includes(nhan)) {
    return nhan as ArtifactSaoLuu;
  }

  const drivePath = typeof stats?.drivePath === "string" ? stats.drivePath : null;
  const file = typeof stats?.file === "string" ? stats.file : null;
  if ((drivePath && MAU_DUMP_APP_CU.test(drivePath)) || (file && MAU_DUMP_APP_CU.test(file))) {
    return "APP_DUMP_REMOTE";
  }

  const loi = log.error ?? "";
  if (loi.startsWith("full-backup.sh:")) return "FULL_SERVER_REMOTE";
  if (loi.startsWith("backup-app-dump.sh:")) return "APP_DUMP_REMOTE";

  if (file && !drivePath) return "MANUAL_DOWNLOAD";
  return null;
}

/**
 * Chọn log MỚI NHẤT của từng artifact từ danh sách đã sắp MỚI NHẤT TRƯỚC (hàm thuần).
 *
 * ERROR không rõ nguồn (`phanLoaiArtifact === null`) là ứng viên của CẢ HAI artifact bắt buộc
 * (fail-closed): không biết nó hỏng tarball hay dump app thì coi như hỏng cả hai cho tới khi mỗi bên
 * có một log MỚI HƠN. OK không rõ nguồn bị bỏ qua — không thể nhận bừa là bản đã lên Drive.
 */
export function chonLogTheoArtifact(logsMoiNhatTruoc: readonly LogSaoLuuGanNhat[]): LogsTheoArtifact {
  const kq: LogsTheoArtifact = { appDump: null, fullServer: null, manual: null };
  for (const log of logsMoiNhatTruoc) {
    const loai = phanLoaiArtifact(log);
    const khongRoLoi = loai === null && log.status === "ERROR";
    if (!kq.appDump && (loai === "APP_DUMP_REMOTE" || khongRoLoi)) kq.appDump = log;
    if (!kq.fullServer && (loai === "FULL_SERVER_REMOTE" || khongRoLoi)) kq.fullServer = log;
    if (!kq.manual && loai === "MANUAL_DOWNLOAD") kq.manual = log;
    if (kq.appDump && kq.fullServer && kq.manual) break;
  }
  return kq;
}

/** Đọc `sizeBytes` từ `stats` Json — không tin cấu trúc tuỳ ý, sai kiểu thì coi như không có. */
function docKichThuocFile(stats: unknown): number | null {
  if (!stats || typeof stats !== "object") return null;
  const sizeBytes = (stats as Record<string, unknown>).sizeBytes;
  return typeof sizeBytes === "number" ? sizeBytes : null;
}

/**
 * Suy ra trạng thái của MỘT artifact từ log mới nhất của nó (`null` = chưa từng chạy).
 * Hàm THUẦN — không đụng Prisma/`Date.now()` ngoài tham số `bayGio` — để test không cần DB.
 */
export function tinhTrangMotArtifact(
  logGanNhat: LogSaoLuuGanNhat | null,
  bayGio: Date = new Date(),
): TrangThaiMotArtifact {
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

/** Xếp hạng độ xấu để chọn artifact tệ nhất: lỗi > quá hạn > chưa có > ổn. */
const DO_XAU: Record<MucSaoLuu, number> = { ok: 0, "chua-co": 1, "qua-han": 2, loi: 3 };

/**
 * Trạng thái tổng từ log mới nhất của TỪNG artifact. Mức tổng = XẤU NHẤT của hai artifact bắt buộc
 * (dump app, tarball toàn server); bản tải tay chỉ hiện riêng, không kéo mức tổng lên hay xuống.
 *
 * `"chua-co"` của MỘT artifact khi artifact kia ổn vẫn cho tổng `"chua-co"` (banner im, giống shop mới
 * cài) — đừng đọc thành "đã ổn": hai dòng chi tiết nói rõ artifact nào thiếu. Một artifact đã TỪNG có
 * log mà cũ quá 36h thì là `"qua-han"` và kêu banner.
 */
export function tinhTrangSaoLuu(logs: LogsTheoArtifact, bayGio: Date = new Date()): TrangThaiSaoLuu {
  const appDump = tinhTrangMotArtifact(logs.appDump, bayGio);
  const fullServer = tinhTrangMotArtifact(logs.fullServer, bayGio);
  const thuCong = tinhTrangMotArtifact(logs.manual, bayGio);
  const xauNhat = DO_XAU[appDump.muc] > DO_XAU[fullServer.muc] ? appDump : fullServer;
  return { ...xauNhat, appDump, fullServer, thuCong };
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
