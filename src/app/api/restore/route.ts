import { randomBytes } from "node:crypto";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { format } from "date-fns";

import {
  giaHanKhoaPhucHoi,
  laChuKhoaPhucHoi,
  LoiMatKhoaPhucHoi,
  thuGiuKhoaPhucHoi,
  traKhoaPhucHoi,
} from "@/lib/backup/khoa-bao-tri";
import {
  giaHanKhoa,
  giuKhoaViecNang,
  MatKhoaViecNang,
  type TheKhoa,
  traKhoaViecNang,
} from "@/lib/backup/khoa-viec-nang";
import { runPgDump } from "@/lib/backup/run-pg-dump";
import { assertNotArchive, detectRestoreFormat, gunzipHead, runRestore } from "@/lib/backup/run-restore";
import { thuHoiMoiPhienCoHan } from "@/lib/backup/thu-hoi-phien-co-han";
import { chanRequestKhacOrigin } from "@/lib/chan-request-khac-origin";
import { coLuotDangChay } from "@/lib/ingest/sync-log";
import { getAuthenticatedUserId } from "@/lib/session";

const BACKUP_DIR = "/backups";
const KEEP_PRE_RESTORE = 3;

/**
 * Câu cảnh báo cho ca "nạp xong rồi mới phát hiện mất khoá". Dùng chung 3 nhánh (mất trước khi thu
 * hồi phiên, mất sau khi thu hồi xong, mất khi thu hồi lỗi) — cùng một sự thật với người đọc: dữ
 * liệu đã bị thay, có thể có lượt khác chồng lên, và mốc phiên không đáng tin.
 */
const CANH_BAO_MAT_KHOA_SAU_NAP =
  "Đã nạp xong nhưng lượt phục hồi này chạy quá lâu nên khoá bảo trì đã tự nhả giữa chừng: " +
  "một lượt phục hồi khác có thể đã chạy chồng lên, và mốc thu hồi phiên CHƯA chắc được đẩy " +
  "(thiết bị khác có thể còn đăng nhập). Kiểm lại dữ liệu, khởi động lại container app rồi " +
  "đổi mật khẩu ngay.";

// Trần kích thước file upload phục hồi — chặn OOM từ phía nhận file
// (`bodySizeLimit` next.config chỉ áp cho Server Action, KHÔNG áp Route Handler).
// Backup .sql.gz/.dump thật hiện < vài MB; backup > 200MB thì nới có chủ đích
// (lưu ý Cloudflare tunnel cap ~100MB/request đứng trước).
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200MB

/**
 * Trần cho TOÀN BỘ thân request (phong bì multipart), kiểm trên `Content-Length` TRƯỚC `formData()`.
 *
 * Vì sao cần dù đã có `MAX_UPLOAD_BYTES`: cap kia đọc `file.size`, tức chỉ có số ĐO ĐƯỢC **sau khi**
 * `request.formData()` đã phân tích trọn thân request — mà đó chính là bước tốn RAM/đĩa. Cap sau
 * chặn được việc bung bytes vào RAM ở `arrayBuffer()`, KHÔNG chặn được việc nhận và parse phong bì.
 *
 * Cộng thêm 1MB cho phần khung multipart (boundary + header từng part): phong bì luôn LỚN HƠN file,
 * nên nếu kẹp đúng 200MB thì một file đúng 200MB hợp lệ sẽ bị từ chối oan.
 *
 * ⚠️ `Content-Length` có thể VẮNG (chunked) hoặc bịa — nên đây là lớp THỨ NHẤT, không thay thế
 * `MAX_UPLOAD_BYTES`. Thiếu header thì đi tiếp và để cap kia gác.
 */
const MAX_UPLOAD_ENVELOPE_BYTES = MAX_UPLOAD_BYTES + 1024 * 1024;

/**
 * Tên lượt phục hồi trong khoá việc nặng — hiện nguyên văn trong câu 409 của lượt xoá dữ liệu /
 * dựng lại / script khi chúng bị một lượt phục hồi đang chạy chặn lại.
 */
const VIEC_PHUC_HOI = "phục hồi dữ liệu từ bản sao lưu";

/**
 * POST /api/restore — phục hồi DB từ file backup tải lên (multipart).
 *
 * TÍNH NĂNG NGUY HIỂM NHẤT app: sai thứ tự = DROP schema rồi mới fail nạp → xoá
 * đúng DB đang cần cứu. THỨ TỰ GUARD LÀ SỐNG-CÒN (C1):
 *   401 (không phiên) → cap size 200MB (413, chưa đọc bytes) → detect (chưa đụng
 *   DB) → (plain-gzip) gunzip HEAD bounded + assertNotArchive (chặn .tar.gz
 *   toàn-server TRƯỚC mọi DROP) → GIÀNH KHOÁ BẢO TRÌ (409 nếu bận) → GIÀNH KHOÁ
 *   VIỆC NẶNG (409 kèm tên việc nếu một writer chạy dài còn sống thật — xem (3b)) →
 *   DRAIN SyncLog: còn lượt đồng bộ đang chạy thì 409 (khoá chỉ chặn request MỚI,
 *   lượt vào trước vẫn đang ghi) → pre-restore backup (không có bản lùi thì KHÔNG
 *   restore) → runRestore.
 *
 * KHOÁ BẢO TRÌ giữ suốt pre-backup → phục hồi xong (xem `khoa-bao-tri.ts`): hai lượt
 * phục hồi chồng nhau sẽ xen vào đúng lúc schema bị drop/tạo lại (dữ liệu lai, hoặc
 * bản lùi của lượt này chụp trạng thái dở của lượt kia), và mọi đường ghi khác
 * (webhook, n8n, nút bấm) bị trả 503 trong cửa sổ đó thay vì ghi vào schema sắp mất.
 *
 * KIỂM QUYỀN SỞ HỮU XEN GIỮA (fencing) — giữ được khoá lúc VÀO không có nghĩa là còn giữ lúc chạy
 * tới lệnh nạp. Cờ có TTL, mà mấy bước chờ ở đây (`coLuotDangChay()` là truy vấn Prisma không hạn,
 * `runPgDump` là tiến trình con) đều có thể treo lâu hơn TTL; khi đó cờ tự nhả, chủ shop bấm lại và
 * một lượt MỚI vào drop + nạp schema. Lượt cũ tỉnh dậy mà cứ đi tiếp là hai lượt cùng phá một
 * schema. Nên sau MỖI bước chờ không hạn và ngay TRƯỚC mỗi lệnh phá huỷ đều đi qua MỘT cổng duy
 * nhất: `giaHanKhoaPhucHoi()` — nó tự kiểm quyền rồi mới đẩy mốc, nên vừa chặn lượt đã mất khoá
 * (`false` ⇒ 409, không thêm một lệnh pg nào) vừa giữ cho TTL khỏi nhả oan một lượt đang tiến
 * triển. ĐỪNG tách thành "kiểm rồi gia hạn": TTL hết giữa hai lời gọi là lọt.
 * `laChuKhoaPhucHoi()` chỉ dùng để HỎI SUÔNG sau khi mọi việc đã xong (không cần thêm cửa sổ nữa).
 *
 * Chạy trong container app (`postgresql-client-15`), nối `-h supabase-db` từ
 * DATABASE_URL. `/backups` là volume mount (`./backups` host) — bền qua rebuild.
 */
export async function POST(request: Request): Promise<Response> {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Next KHÔNG tự so Origin/Host cho Route Handler (chỉ cho Server Action) — route phá huỷ nhất
  // của app phải tự gác. Xem lý do đầy đủ ở `chanRequestKhacOrigin`.
  const khacOrigin = chanRequestKhacOrigin(request);
  if (khacOrigin) return khacOrigin;

  // Chặn theo `Content-Length` TRƯỚC khi chạm thân request — xem `MAX_UPLOAD_ENVELOPE_BYTES`.
  const khaiDoDai = Number(request.headers.get("content-length"));
  if (Number.isFinite(khaiDoDai) && khaiDoDai > MAX_UPLOAD_ENVELOPE_BYTES) {
    return Response.json(
      { error: "File backup quá lớn (tối đa 200MB) — từ chối phục hồi." },
      { status: 413 },
    );
  }

  // Đọc file tải lên → Buffer.
  let fileBuf: Buffer;
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "Thiếu file backup." }, { status: 400 });
    }
    // Cap size TRƯỚC khi arrayBuffer() bung bytes vào RAM (SEC-H1).
    if (file.size > MAX_UPLOAD_BYTES) {
      return Response.json(
        { error: "File backup quá lớn (tối đa 200MB) — từ chối phục hồi." },
        { status: 413 },
      );
    }
    fileBuf = Buffer.from(await file.arrayBuffer());
  } catch {
    return Response.json({ error: "Không đọc được file tải lên." }, { status: 400 });
  }

  // (1) Nhận diện định dạng — CHƯA đụng DB. Không hợp lệ → 400.
  const head = fileBuf.subarray(0, 512);
  const fmt = detectRestoreFormat(head);
  if (fmt === null) {
    return Response.json(
      { error: "File backup không hợp lệ (chỉ nhận .dump hoặc .sql.gz)" },
      { status: 400 },
    );
  }

  // (2) plain-gzip: gunzip HEAD bounded (gunzipHead — KHÔNG bung cả file vào
  // RAM, chống gzip-bomb SEC-H1) + assertNotArchive để chặn .tar.gz
  // backup-toàn-server (magic gzip giống .sql.gz) TRƯỚC KHI bất kỳ DROP nào đụng
  // DB. TAR / không-SQL → 400, DB NGUYÊN VẸN.
  if (fmt === "plain-gzip") {
    try {
      assertNotArchive(gunzipHead(fileBuf));
    } catch (err) {
      const message = err instanceof Error ? err.message : "File backup không hợp lệ.";
      return Response.json({ error: message }, { status: 400 });
    }
  }

  // (3) KHOÁ BẢO TRÌ — giành TRƯỚC pre-backup. Giành sau sẽ để hai lượt cùng chụp
  // bản lùi rồi cùng nạp. Lượt thứ hai nhận 409 (xung đột trạng thái) chứ không xếp
  // hàng: phục hồi là thao tác tay, chờ mù hàng chục giây rồi mới biết là tệ hơn.
  //
  // Giữ THẺ PHIÊN để `finally` chỉ trả đúng cờ của lượt này: nếu lượt này treo quá TTL rồi mới
  // tỉnh, cờ lúc đó có thể đã thuộc về một lượt phục hồi khác đang chạy dở (xem `khoa-bao-tri.ts`).
  const thePhien = thuGiuKhoaPhucHoi();
  if (!thePhien) {
    return Response.json(
      { error: "Đang có một lượt phục hồi khác chạy — chờ xong rồi thử lại." },
      { status: 409 },
    );
  }

  // Thẻ khoá việc nặng của lượt này — gán TRONG try (sau khi giành thắng), đọc ở finally để trả
  // best-effort. Để `null` khi giành trượt: finally tuyệt đối không đụng khoá của việc khác.
  let khoaViec: TheKhoa | null = null;

  try {
    // (3b) DRAIN LỚP 1 — GIÀNH KHOÁ VIỆC NẶNG. Cổng SyncLog ở (3b') đoán sống/chết bằng TUỔI
    // (RUNNING > 15' coi như app chết), nên một lượt "dựng lại từ kho thô" chạy quá 15' trở nên VÔ
    // HÌNH đúng lúc nó vẫn đang ghi — rebuild đã đo 492s/476 đơn, dữ liệu lớn dần là vượt trần, và
    // lúc đó bản lùi pre-restore sẽ chụp đúng trạng thái dựng dở rồi DROP schema đè lên nó. Cả 3
    // việc nặng giữ khoá này TƯƠI bằng checkpoint tiến độ thật (mỗi 25 dòng ghi, hạn 5' —
    // `khoa-viec-nang.ts`), nên "giành trượt" = việc đó CÒN SỐNG THẬT chứ không phải đoán tuổi; việc
    // đã chết thì khoá hết hạn ≤5' và restore giành thắng — DR còn nhanh hơn chờ cửa sổ 15'.
    //
    // ⚠️ Khoá nằm trong chính `app."Setting"` mà lượt phục hồi sẽ thay sạch ⇒ với lượt phục hồi nó
    // CHỈ là cổng chặn TRƯỚC vùng phá huỷ, KHÔNG phải hàng rào xuyên suốt: sau khi chuỗi phá huỷ
    // bắt đầu thì không gia hạn/không fence bằng nó nữa, và trả khoá ở finally là best-effort.
    // Giới hạn ghi nhận (chưa vá): script CLI khởi động GIỮA lúc phục hồi, sau khi schema đã bị
    // thay — chặn thật cần khoá sống NGOÀI schema app (advisory lock), để dành khi cần.
    const luotGianh = await giuKhoaViecNang(VIEC_PHUC_HOI);
    if (luotGianh.the) khoaViec = luotGianh.the;

    // (3b') DRAIN LỚP 2 — cổng SyncLog, giữ nguyên cho các lượt ingest NGẮN không cầm khoá việc
    // nặng: khoá bảo trì ở trên chỉ chặn request MỚI; một lượt ingest vào TRƯỚC đó vẫn đang ghi
    // (land 1 trang được cấp tới 60s). Phải giành khoá RỒI mới soi: soi trước thì giữa lúc soi và
    // lúc giành, một lượt mới vẫn kịp bắt đầu và kết luận "không còn ai ghi" thành vô nghĩa.
    // Gọi KHÔNG truyền kind = soi mọi luồng: lượt phục hồi thay sạch schema nên ads, TikTok Shop và
    // lượt dựng lại tay đều đang ghi vào schema sắp mất, không riêng lượt kéo đơn.
    // Từ chối sớm chứ không xếp hàng — cùng lý do như cổng 409 ở trên, và để không đốt một suất
    // trong 3 bản lùi `pre-restore-*.dump` cho một request rốt cuộc không phục hồi gì.
    // HẠN CHẾ ĐÃ BIẾT: cổng này chỉ thấy writer đi qua `withSyncLog`. Writer nhập tay (nút bấm,
    // import file) không ghi `SyncLog` — chúng bị chặn bằng `dangPhucHoi()` ở từng server action,
    // và người đang bấm phục hồi chính là chủ shop nên không tự bấm chồng lên mình.
    // Trượt lease thì khỏi soi — đằng nào cũng 409, không tốn thêm một câu quét SyncLog không index.
    const conLuotDangGhi = luotGianh.the ? await coLuotDangChay() : false;

    // (3c) FENCING sau các bước chờ KHÔNG CÓ HẠN ở trên (hai câu Prisma). Hỏi quyền sở hữu TRƯỚC KHI
    // đọc kết quả drain: nếu lượt này vừa treo quá TTL thì nguyên nhân dừng thật sự là "mất khoá",
    // nói "đang có lượt đồng bộ" là chỉ sai hướng điều tra.
    //
    // MỘT cổng duy nhất: `giaHanKhoaPhucHoi` tự kiểm quyền rồi mới đẩy mốc, nên nó vừa là câu hỏi
    // vừa là câu trả lời. Tách thành "kiểm rồi gia hạn, bỏ qua kết quả gia hạn" là tự mở lại đúng
    // khe TOCTOU mình đang bịt: TTL có thể hết GIỮA hai lời gọi ⇒ kiểm trả `true`, gia hạn trả
    // `false`, và lượt này đi tiếp với một cái cờ đã thuộc về người khác.
    if (!giaHanKhoaPhucHoi(thePhien)) return traLoiMatKhoa("dò lượt đồng bộ đang chạy");

    if (!luotGianh.the) {
      return Response.json(
        {
          error:
            `Đang có việc nặng "${luotGianh.dangGiu}" chạy — nó vẫn đang ghi vào đúng schema sắp ` +
            "bị thay. Chờ xong rồi phục hồi lại. (Nếu app vừa khởi động lại hoặc vừa nạp một bản " +
            "backup thì đây có thể là khoá cũ còn sót — nó tự hết hạn trong tối đa 5 phút.)",
        },
        { status: 409 },
      );
    }
    // Từ đây thẻ chắc chắn có — cầm bản non-null để gia hạn ở các mốc dưới.
    const theViec = luotGianh.the;

    if (conLuotDangGhi) {
      return Response.json(
        { error: "Đang có lượt đồng bộ chạy — chờ xong rồi phục hồi lại." },
        { status: 409 },
      );
    }

    // (3d) Gia hạn lease việc nặng sau bước chờ drain — cùng kỷ luật mốc-tiến-độ như (3c) nhưng cho
    // khoá trong DB (`giaHanKhoa` kiểm quyền + đẩy hạn trong MỘT câu ghi nguyên tử). Trượt = lease
    // hết hạn giữa chừng và một việc nặng đã giành mất, tức nó ĐANG GHI — dừng ngay.
    if (!(await giaHanKhoaViecNangAnToan(theViec))) {
      return traLoiMatKhoaViecNang("dò lượt đồng bộ đang chạy");
    }

    // (4) Pre-restore backup: chụp DB hiện tại TRƯỚC khi phục hồi. Lỗi → 500,
    // KHÔNG restore (không phá khi chưa có bản lùi).
    try {
      const preRestore = await runPgDump();
      await mkdir(BACKUP_DIR, { recursive: true });
      // Giây + hậu tố ngẫu nhiên: mốc giây một mình KHÔNG đủ tách hai lượt phục hồi
      // (khoá bảo trì cho phép lượt sau chạy ngay khi lượt trước xong, vẫn có thể rơi
      // vào cùng giây) — trùng tên là ghi đè mất đúng điểm rollback vừa tạo. Tên vẫn
      // giữ tiền tố thời gian nên sort lexicographic vẫn ra thứ tự thời gian.
      const preName = `pre-restore-${format(new Date(), "yyyyMMdd-HHmmss")}-${randomBytes(3).toString("hex")}.dump`;
      await writeFile(join(BACKUP_DIR, preName), preRestore);
      await prunePreRestoreBackups();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Không tạo được bản lùi trước khi phục hồi.";
      return Response.json(
        { error: `Không tạo được bản sao lưu trước phục hồi — đã hủy phục hồi: ${message}` },
        { status: 500 },
      );
    }

    // (4b) FENCING lần 2 — ngay sau khi chụp bản lùi (bước dài nhất trước lệnh phá huỷ: `pg_dump`
    // được cấp tới 10 phút, cộng ghi file + dọn bản cũ). Cùng một cổng nguyên tử như (3c). Kèm gia
    // hạn lease việc nặng: `pg_dump` dài hơn hạn khoá 5' là chuyện BÌNH THƯỜNG — hạn qua đi mà chưa
    // ai giành thì `giaHanKhoa` vẫn thắng (token còn nguyên); chỉ khi một việc nặng ĐÃ giành trong
    // lúc đó thì trượt, và lúc ấy nó đang ghi thật — dừng trước khi phá huỷ.
    if (!giaHanKhoaPhucHoi(thePhien)) return traLoiMatKhoa("chụp bản lùi trước phục hồi");
    if (!(await giaHanKhoaViecNangAnToan(theViec))) {
      return traLoiMatKhoaViecNang("chụp bản lùi trước phục hồi");
    }

    // (5) Phục hồi thật. runRestore lặp lại detect + assertNotArchive nội bộ (an
    // toàn 2 lớp) nhưng lúc này head đã được xác thực.
    try {
      // FENCING lần 3, đặt SÂU BÊN TRONG `runRestore` — chốt (4b) ở trên KHÔNG đủ: giữa nó và lệnh
      // phá huỷ đầu tiên còn `writeFile`, `gunzipAsync`, `pg_restore -l`, mà mấy bước file/zlib đó
      // không có hạn ở tầng Node. Treo đủ lâu là TTL nhả cờ, lượt khác giành khoá, rồi lượt này
      // tỉnh dậy vẫn drop + nạp chồng lên. Callback chạy ngay trước lệnh phá huỷ đầu tiên; ném ở đó
      // là an toàn vì tới lúc ấy chưa có gì trong DB bị đụng. Sau chốt thì KHÔNG fence nữa — nửa
      // chuỗi phá huỷ bị bỏ dở còn tệ hơn chạy trọn.
      const { format: restoredFormat } = await runRestore(fileBuf, {
        truocKhiPhaHuy: async () => {
          // THỨ TỰ SỐNG-CÒN: câu chờ DB đứng TRƯỚC, cổng đồng bộ đứng CUỐI. `giaHanKhoa` là một
          // câu ghi Prisma KHÔNG có hạn (statement_timeout prod = 0) — một phiên khác giữ dòng
          // khoá là nó chờ vô hạn. Để nó SAU cổng khoá bảo trì là tự chèn một bước chờ không hạn
          // vào đúng khe giữa chốt fencing cuối và lệnh phá huỷ: chờ quá TTL thì cờ bảo trì tự
          // nhả, mọi đường ghi mở lại, rồi câu chờ xong xuôi và ta DROP schema lên đúng dữ liệu
          // đang được ghi. Cổng đồng bộ (micro giây, không thể bị xen) đứng cuối thì cú treo đó
          // bị chính nó bắt: mất cờ ⇒ ném ⇒ 409, chưa phá gì.
          //
          // Đây cũng là chốt CUỐI CÙNG lease việc nặng còn tác dụng: sau lệnh phá huỷ đầu tiên,
          // bảng `Setting` chứa khoá bị thay sạch nên không fence bằng nó nữa (xem (3b)). Mất
          // lease ở đây = một việc nặng đang ghi, drop lên nó là đúng thảm hoạ cổng này chặn.
          if (!(await giaHanKhoaViecNangAnToan(theViec))) throw new MatKhoaViecNang(VIEC_PHUC_HOI);
          // Cổng nguyên tử — xem (3c). Ở đây khe TOCTOU nguy hiểm nhất: lọt qua là drop + nạp thật.
          if (!giaHanKhoaPhucHoi(thePhien)) throw new LoiMatKhoaPhucHoi("chuẩn bị file để nạp");
        },
      });

      // Phục hồi nạp lại CẢ dòng `sessionEpoch` đời backup ⇒ mốc phiên bị LÙI, nên cookie cấp trong
      // khoảng thời gian đó lại khớp mốc và vào được. Đẩy mốc lên hiện tại để mọi thiết bị phải đăng
      // nhập lại. Đây KHÔNG phải vá bảo mật: `User.passwordHash` cũng bị lùi nên mật khẩu đời backup
      // sống lại — chủ shop phải tự đổi mật khẩu, xem cảnh báo ở modal phục hồi.
      //
      // Lỗi ở bước này KHÔNG được biến lượt phục hồi thành công thành 500 (dữ liệu đã nạp xong rồi;
      // Prisma còn có thể đang giữ plan cũ của các bảng vừa bị drop/tạo lại). Trả kèm cảnh báo.
      //
      // FENCING lần 4, và từ đây CỐ Ý KHÔNG trả 409 nữa: bước nạp đã chạy xong, dữ liệu đã bị thay —
      // trả 409 ("bận, chưa làm gì") là nói dối theo hướng nguy hiểm nhất, chủ shop sẽ bấm phục hồi
      // lại lần nữa. Mất khoá ở đây thì bỏ luôn `thuHoiMoiPhien()`: nó là một câu GHI, mà mất khoá
      // nghĩa là có thể một lượt khác đang drop + nạp chính schema đó — ghi thêm vào là đúng kiểu
      // xen kẽ khoá này sinh ra để chặn. Trả `ok` kèm cảnh báo nói thẳng cả hai chuyện: phiên chưa
      // thu hồi, VÀ dữ liệu vừa nạp có thể đã bị lượt khác đè.
      //
      // GIA HẠN (không chỉ kiểm) trước khi bắt đầu: giữa lệnh nạp và đây còn `unlink` file tạm và
      // bước cấp lại quyền n8n, mà bản thân lời gọi dưới đây có thể tốn tới `maxWait + timeout`.
      // Chỉ kiểm suông thì lượt này được phép khởi động một câu GHI khi lease chỉ còn vài mili
      // giây — nó hết hạn giữa chừng, lượt B giành cờ và bắt đầu drop, còn ta thì đang upsert vào
      // schema của họ. Cổng nguyên tử + mốc mới cho ta trọn một cửa sổ TTL để làm nốt.
      //
      // Kiểm khoá LẦN NỮA SAU khi bước thu hồi phiên trả về (cả nhánh chạy được lẫn nhánh lỗi):
      // câu kiểm phía trên chỉ nói về thời điểm TRƯỚC `await`, mà chính lời gọi đó có thể treo lâu
      // rồi mới xong — lúc quay lại, khoá có thể đã sang lượt khác và mốc phiên ta vừa đẩy đè lên
      // schema của họ. `HAN_THU_HOI_PHIEN_MS` cắt ngắn cửa sổ đó, nhưng ĐỪNG đọc thành "không thể
      // treo": `statement_timeout` chỉ cứu được khi server còn trả lời, socket nửa chết thì vẫn
      // phải chờ tới TTL. Vì thế câu kiểm này mới là chốt, không phải cái hạn kia.
      let canhBao: string | undefined;
      if (!giaHanKhoaPhucHoi(thePhien)) {
        console.error(
          "Lượt phục hồi nạp xong nhưng đã MẤT khoá bảo trì trước bước thu hồi phiên — nó treo quá " +
            "TTL giữa chừng nên cờ tự nhả và có thể đã sang lượt khác. Bỏ qua thu hồi phiên để không " +
            "ghi vào schema mà lượt kia đang thay. Kiểm log phía trên xem treo ở đâu.",
        );
        canhBao = CANH_BAO_MAT_KHOA_SAU_NAP;
      } else {
        try {
          await thuHoiMoiPhienCoHan();
          if (!laChuKhoaPhucHoi(thePhien)) canhBao = CANH_BAO_MAT_KHOA_SAU_NAP;
        } catch {
          canhBao = laChuKhoaPhucHoi(thePhien)
            ? "Đã phục hồi xong nhưng KHÔNG đẩy được mốc thu hồi phiên — thiết bị khác có thể còn đăng nhập. " +
              "Khởi động lại container app rồi đổi mật khẩu ngay."
            : CANH_BAO_MAT_KHOA_SAU_NAP;
        }
      }

      return Response.json({ ok: true, format: restoredFormat, canhBao });
    } catch (err) {
      // Mất khoá ở một chốt fencing BÊN TRONG `runRestore` = đã dừng TRƯỚC lệnh phá huỷ đầu tiên
      // ⇒ dữ liệu còn nguyên, trả 409 như hai chốt kia. Rơi vào nhánh 500 bên dưới là xui chủ shop
      // đi lùi về `pre-restore-*.dump` trong khi chẳng mất gì. Lease việc nặng cùng ngữ nghĩa: chốt
      // duy nhất ném nó nằm trước lệnh phá huỷ đầu tiên.
      if (err instanceof LoiMatKhoaPhucHoi) return traLoiMatKhoa(err.buoc);
      if (err instanceof MatKhoaViecNang) return traLoiMatKhoaViecNang("chuẩn bị file để nạp");

      const message = err instanceof Error ? err.message : "Phục hồi thất bại.";
      return Response.json(
        {
          error: `Phục hồi thất bại: ${message}. Dùng bản lùi pre-restore-*.dump hoặc chạy deploy/restore.sh (xem hướng dẫn deploy).`,
        },
        { status: 500 },
      );
    }
  } finally {
    // Trả cờ bảo trì (RAM, đồng bộ) TRƯỚC MỌI I/O: bước trả lease dưới đây là một câu ghi DB có
    // thể TREO (không chỉ ném) — để nó đứng trước thì một cú treo giữ cả app ở chế độ chỉ-đọc tới
    // hết TTL 46' và response không bao giờ về tay chủ shop. Cờ RAM trả xong thì cú treo (nếu có)
    // chỉ còn kéo dài response, app đã ghi lại được, và lease tự hết hạn sau tối đa 5'.
    traKhoaPhucHoi(thePhien);
    if (khoaViec) {
      // Best-effort: restore chết giữa vùng phá huỷ thì bảng `Setting` có thể không tồn tại lúc
      // này — lỗi trả khoá TUYỆT ĐỐI không được che response gốc (nhất là 500 của chính lượt nạp).
      // `traKhoaViecNang` chỉ xoá đúng token của mình nên không giật khoá việc khác. Lưu ý dòng
      // khoá trong FILE BACKUP vừa nạp thì KHÔNG chắc đã quá hạn: backup chụp giữa một việc nặng
      // (kể cả bản `pre-restore-*.dump` do chính route này tạo — nó chụp SAU khi ta giành lease)
      // mang dòng khoá còn hạn tối đa 5'. Chấp nhận: khoá ma đó tự hết hạn ≤5' và lần giành sau
      // thắng nó — câu 409 đã nói rõ để chủ shop khỏi hoang mang.
      try {
        await traKhoaViecNang(khoaViec);
      } catch (err) {
        console.error(
          "Không trả được khoá việc nặng sau lượt phục hồi (bảng Setting có thể chưa dựng lại). " +
            "Khoá tự hết hạn sau tối đa 5 phút — không cần xử lý tay.",
          err,
        );
      }
    }
  }
}

/**
 * Câu trả lời khi lượt này KHÔNG còn giữ khoá bảo trì giữa chừng (fencing bắt được).
 *
 * 409 vì đúng nghĩa "xung đột trạng thái", cùng mã với hai cổng bận ở trên nên UI đã xử lý sẵn
 * (`restore-dialog.tsx` hiện thẳng câu này, không gợi ý đi lùi về bản `pre-restore-*.dump` — đúng,
 * vì mọi điểm gọi hàm này đều nằm TRƯỚC lệnh nạp nên dữ liệu còn nguyên).
 *
 * Câu chữ nói rõ nguyên nhân là LƯỢT NÀY TREO chứ không phải người dùng bấm sai — chủ shop chỉ bấm
 * một nút, đổ lỗi mơ hồ sẽ khiến họ bấm lại liên tục. `buoc` chỉ vào log để biết treo ở đâu.
 */
/**
 * Gia hạn lease việc nặng, LỖI DB CŨNG COI LÀ MẤT. `giaHanKhoa` là câu ghi Prisma nên ngoài trả
 * `false` nó còn có thể NÉM (đứt kết nối, bảng đang bị khoá...). Mọi điểm gọi đều đứng TRƯỚC lệnh
 * phá huỷ, nên "không biết còn giữ hay không" phải xử y như "đã mất": dừng sạch với 409
 * dữ-liệu-còn-nguyên. Để lỗi thoát ra ngoài là thành 500 mù — đúng kiểu response xui chủ shop đi
 * lùi bản `pre-restore-*.dump` trong khi chưa mất gì.
 */
async function giaHanKhoaViecNangAnToan(the: TheKhoa): Promise<boolean> {
  try {
    return await giaHanKhoa(the);
  } catch (err) {
    console.error(
      "Không kiểm được khoá việc nặng (lỗi DB) — coi như đã mất để dừng lượt phục hồi an toàn.",
      err,
    );
    return false;
  }
}

/**
 * Câu trả lời khi lease VIỆC NẶNG của lượt phục hồi không giữ được nữa: một việc nặng khác giành
 * mất (lượt này đứng im quá hạn 5' ở một bước chờ — kể cả script CLI ngoài tiến trình app cũng
 * giành được), hoặc không kiểm được vì lỗi DB. Mọi điểm gọi đều nằm TRƯỚC lệnh phá huỷ đầu tiên ⇒
 * dữ liệu còn nguyên ⇒ 409 cùng triết lý với `traLoiMatKhoa`. Nhường bên kia chạy tiếp là ĐÚNG:
 * bên nào commit khoá trước bên đó thắng, bên thua dừng khi chưa phá gì.
 */
function traLoiMatKhoaViecNang(buoc: string): Response {
  console.error(
    `Lượt phục hồi KHÔNG GIỮ ĐƯỢC khoá việc nặng ở bước "${buoc}" — hoặc nó đứng quá hạn khoá 5' ` +
      `và một việc nặng khác đã giành được, hoặc câu kiểm khoá lỗi. ĐÃ DỪNG trước mọi lệnh phá huỷ ` +
      `(không có gì bị xoá). Kiểm log phía trên xem bước đó treo/lỗi vì sao.`,
  );
  return Response.json(
    {
      error:
        "Không giữ được khoá việc nặng (một việc khác đã giành trong lúc lượt phục hồi đứng quá " +
        "lâu, hoặc lỗi kết nối) — đã DỪNG trước khi thay đổi bất cứ thứ gì, dữ liệu hiện tại còn " +
        "nguyên. Chờ việc đang chạy xong rồi thử lại.",
    },
    { status: 409 },
  );
}

function traLoiMatKhoa(buoc: string): Response {
  console.error(
    `Lượt phục hồi MẤT khoá bảo trì ở bước "${buoc}" — nó treo quá TTL nên cờ đã tự nhả, và có thể ` +
      `một lượt phục hồi khác đang giữ. ĐÃ DỪNG trước mọi lệnh pg tiếp theo (không có gì bị xoá). ` +
      `Kiểm log phía trên xem bước đó treo vì sao.`,
  );
  return Response.json(
    {
      error:
        "Lượt phục hồi này chạy quá lâu nên khoá bảo trì đã tự nhả và có thể đã sang lượt khác — " +
        "đã DỪNG trước khi thay đổi bất cứ thứ gì, dữ liệu hiện tại còn nguyên. Chờ lượt đang chạy " +
        "xong rồi thử lại.",
    },
    { status: 409 },
  );
}

/** Giữ ~KEEP_PRE_RESTORE bản `pre-restore-*.dump` mới nhất, xoá phần cũ hơn. */
async function prunePreRestoreBackups(): Promise<void> {
  try {
    const names = (await readdir(BACKUP_DIR))
      .filter((n) => n.startsWith("pre-restore-") && n.endsWith(".dump"))
      .sort(); // tên yyyyMMdd-HHmmss sort lexicographic = theo thời gian.
    const stale = names.slice(0, Math.max(0, names.length - KEEP_PRE_RESTORE));
    await Promise.all(stale.map((n) => unlink(join(BACKUP_DIR, n)).catch(() => {})));
  } catch {
    // Prune lỗi không được chặn phục hồi — bỏ qua.
  }
}
