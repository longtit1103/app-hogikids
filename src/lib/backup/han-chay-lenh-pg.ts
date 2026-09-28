/**
 * PHANH CHO ĐƯỜNG SAO LƯU / PHỤC HỒI — hạn chạy của từng lệnh pg client, phanh ở tầng DB, và TTL
 * của cờ khoá bảo trì. Ba lớp này GOM MỘT CHỖ vì chúng chỉ đúng khi giữ đúng THỨ TỰ với nhau; sửa
 * lẻ một con số ở file khác là phá cả cụm.
 *
 * THỨ TỰ BẮT BUỘC (lớp trong chặt hơn lớp ngoài, để lớp ngoài luôn kịp chạy `finally` mà dọn):
 *
 *   lock_timeout  <  statement_timeout  <  hạn lệnh (execFile `timeout`)  <<  TTL cờ khoá
 *
 * Vì sao theo thứ tự đó:
 *  - Chờ khoá quá hạn phải báo đúng "chờ khoá" (thông điệp dễ hiểu nhất, chỉ thẳng thủ phạm) chứ
 *    không bị nuốt thành "câu lệnh quá hạn" hay "lệnh bị dừng".
 *  - Hạn lệnh phải là lớp NGOÀI CÙNG của một lượt chạy: nó bắn SIGTERM, tiến trình con chết, lời
 *    gọi `await` bật lỗi ra, `finally` của route mới trả được khoá.
 *  - TTL phải LỚN HƠN TỔNG hạn của cả chuỗi lệnh. Cờ tự nhả giữa một lượt phục hồi ĐANG chạy thật
 *    còn nguy hiểm hơn cờ kẹt: lúc đó lượt thứ hai giành được khoá và hai lượt cùng drop + nạp một
 *    schema. Nên TTL là LƯỚI CUỐI, không phải hạn hiệu năng.
 *
 * ⚠️ HAI LỚP TRONG CHỈ CÓ Ở `psql -c` — xem `pgOptionsPhanh()` ở cuối file. Với `pg_dump`,
 * `pg_restore` và `psql -f <dump>` thì phanh DUY NHẤT là hạn `execFile`; thứ tự trên vẫn đúng ở chỗ
 * nào có đủ ba lớp, nhưng đừng đọc nó thành "mọi lệnh đều có ba lớp".
 *
 * CĂN CỨ SỐ ĐO (prod 01/08/2026): dump `-Fc` schema `app` = 22,9 MB, lượt sao lưu đêm xong trong
 * vài chục giây. ⚠️ ĐO LẠI 23/09/2026: **56,6 MiB** (59.338.339 B) — gấp 2,6 lần sau chưa đầy 2
 * tháng, nên đừng dùng con số 22,9 MB làm cơ sở cho bất kỳ hằng mới nào; đo lại trước khi chốt.
 * Cùng lượt đo: bung ra SQL phẳng = 621,4 MiB (327.155 dòng, 45 khối COPY) trong 1,45 s.
 *
 * Mọi hạn dưới đây đặt rộng gấp nhiều lần số đo — chúng chống TREO VĨNH VIỄN, không
 * bóp hiệu năng. Cũng đo cùng ngày: `statement_timeout`, `lock_timeout`,
 * `idle_in_transaction_session_timeout` trên prod đều = 0 và role app không có `rolconfig` ⇒ nếu
 * app không tự đặt thì KHÔNG có phanh nào ở tầng DB, một truy vấn đọc dài hay một session dev để
 * `BEGIN;` mở là đủ khiến `pg_restore --clean` chờ khoá vô hạn.
 */

/**
 * `lock_timeout` cho các câu `psql -c` một dòng của app — nặng ký nhất là `DROP SCHEMA … CASCADE`,
 * nó cần ACCESS EXCLUSIVE trên cả schema. Chờ quá ngần này nghĩa là có kẻ đang giữ khoá lâu bất
 * thường (truy vấn báo cáo dài, hoặc session dev quên `COMMIT`) — báo lỗi rõ tốt hơn treo, và lỗi
 * đó lan ra TRƯỚC KHI có gì bị xoá. Hạn tính CHO TỪNG lần giành khoá, nên tổng thời gian vẫn do hạn
 * lệnh ở dưới chặn.
 *
 * KHÔNG áp được cho `pg_dump`/`pg_restore`/`psql -f <dump>` — xem `pgOptionsPhanh()`.
 */
export const HAN_CHO_KHOA_MS = 30_000;

/**
 * `statement_timeout` CHỈ áp cho mấy câu lệnh một dòng (hỏi quyền, GRANT, DROP SCHEMA). TUYỆT ĐỐI
 * KHÔNG áp cho lệnh nạp: một `COPY` bảng đơn hàng hay một `CREATE INDEX` hợp lệ chạy lâu hơn thế
 * nhiều, đặt vào là tự giết đúng lượt phục hồi mình đang cần. (Thực tế lệnh nạp cũng KHÔNG nhận
 * được `statement_timeout` từ `PGOPTIONS` — nhưng ý định vẫn phải ghi đúng.)
 */
export const HAN_CAU_LENH_NHANH_MS = 60_000;

/** Hạn lệnh cho nhóm câu một dòng + đọc mục lục dump. Lớn hơn `statement_timeout` để phanh tầng DB kịp báo trước. */
export const HAN_LENH_NHANH_MS = 120_000;

/** Hạn lệnh cho `pg_dump` (sao lưu đêm + bản lùi trước phục hồi). ~20× lượt đo vài chục giây. */
export const HAN_PG_DUMP_MS = 10 * 60_000;

/** Hạn lệnh cho bước NẠP (`pg_restore` / `psql -f`). Nạp chậm hơn dump vì dựng lại index + kiểm FK. */
export const HAN_NAP_PHUC_HOI_MS = 20 * 60_000;

/**
 * Tổng hạn TỐI ĐA của chuỗi lệnh trong một lượt phục hồi, tính theo nhánh dài nhất (plain-gzip):
 * `pg_dump` bản lùi → hỏi quyền tạo schema → dọn schema → nạp `psql -f` → cấp lại quyền n8n.
 * Nhánh custom ngắn hơn (đọc mục lục → nạp → cấp lại quyền) nên vẫn nằm trong hạn này.
 */
export const TONG_HAN_LENH_TOI_DA_MS =
  HAN_PG_DUMP_MS + HAN_NAP_PHUC_HOI_MS + 3 * HAN_LENH_NHANH_MS;

/**
 * `statement_timeout` cho câu đẩy mốc thu hồi phiên chạy SAU khi nạp xong. Prisma KHÔNG có hạn
 * truy vấn mặc định, mà đây là chỗ duy nhất còn lại giữa lệnh nạp và lúc trả khoá — treo ở đây thì
 * lượt phục hồi giữ cờ tới hết TTL rồi mới nhả.
 *
 * Phải NGẮN HƠN NHIỀU so với phần TTL còn lại tại thời điểm đó: khoá vừa được gia hạn ngay trước
 * bước nạp, nên khi tới đây còn ít nhất `TTL − HAN_NAP_PHUC_HOI_MS − HAN_LENH_NHANH_MS` (≈24 phút).
 * Một `upsert` đúng một dòng chạy trong vài mili giây, nên 30s đã là rộng gấp hàng nghìn lần.
 *
 * ⚠️ Hạn này ĐỨNG NGOÀI chuỗi `lock_timeout < statement_timeout < hạn lệnh` ở đầu file — đừng xếp
 * nó vào đó rồi "sửa cho đồng bộ". Chuỗi kia nói về lệnh pg client chạy qua `execFile`; đây là câu
 * Prisma trên kết nối của app, không có `lock_timeout` và không có tiến trình con nào để giết.
 */
export const HAN_THU_HOI_PHIEN_MS = 30_000;

/**
 * Biên cho phần việc KHÔNG phải lệnh pg nhưng vẫn nằm trong cửa sổ giữ khoá: bung nén file
 * `.sql.gz`, ghi file tạm, dọn bớt bản lùi, đẩy mốc thu hồi phiên.
 *
 * ⚠️ ĐÂY LÀ BIÊN CỘNG VÀO TTL, KHÔNG PHẢI TIMEOUT. Không có gì bắt `writeFile`/`gunzipAsync` dừng
 * sau 10 phút — chúng có thể treo lâu hơn thế. Thứ thật sự chặn chúng gây hại là FENCING: mọi bước
 * ngoài-lệnh đều nằm TRƯỚC chốt cuối trong `runRestore` (`truocKhiPhaHuy`), nên treo quá TTL thì
 * lượt đó bị chặn ngay tại chốt chứ không đi tiếp được. Riêng bước cuối (đẩy mốc phiên) nằm SAU
 * lệnh nạp nên không fence trước được — nó có hạn riêng ở `HAN_THU_HOI_PHIEN_MS`.
 */
export const BIEN_NGOAI_LENH_MS = 10 * 60_000;

/**
 * TTL của cờ khoá phục hồi. TÍNH RA chứ không gõ tay, để ai nới một hạn ở trên thì TTL tự nới
 * theo — quan hệ `TTL > tổng hạn lệnh` không thể vô tình bị phá bằng cách sửa đúng một con số.
 */
export const TTL_KHOA_PHUC_HOI_MS = TONG_HAN_LENH_TOI_DA_MS + BIEN_NGOAI_LENH_MS;

/**
 * Chuỗi `PGOPTIONS` đặt phanh ở tầng DB. libpq đọc biến môi trường này lúc mở kết nối và áp như
 * `SET` cho cả phiên.
 *
 * ⚠️ CHỈ CÓ TÁC DỤNG VỚI `psql -c "<câu ngắn>"`. `pg_dump`, `pg_restore` và `psql -f <file dump>`
 * đều TỰ TAY gỡ phanh ngay sau khi nối, nên với chúng đây là NO-OP — phanh duy nhất còn lại là hạn
 * `execFile` ở tầng Node. Đừng tin lại lần nữa; đừng "sửa" bằng cách nhét thêm `-c "SET …"`.
 *
 * ĐO THẬT trên prod 01/08/2026 (`psql`/`pg_dump`/`pg_restore` 18.3 → server 15), tất cả chỉ-đọc:
 *  - `PGOPTIONS='-c statement_timeout=5' psql "$URL" -Atc "select pg_sleep(1)"`
 *      → `ERROR: canceling statement due to statement timeout` ⇒ câu ngắn CÓ nhận phanh.
 *  - `PGOPTIONS='-c statement_timeout=5' pg_dump "$URL" -s -n app -Fc -f /dev/null`
 *      → exit 0, chạy trọn vẹn ⇒ `pg_dump` KHÔNG nhận phanh.
 *  - `pg_dump "$URL" -s -n app -Fp` và `pg_restore -f - <dump -Fc>` đều mở đầu bằng
 *      `SET statement_timeout = 0; SET lock_timeout = 0;` (dòng 10-11) ⇒ đó là cách chúng gỡ:
 *      `pg_dump` gỡ trên phiên của nó, `pg_restore` chạy đúng mấy câu ấy lên DB đích, còn
 *      `psql -f dump.sql` thì gặp chúng ở ngay đầu file trước mọi thứ khác.
 *
 * Muốn chặn `pg_dump` chờ khoá vô hạn thì knob ĐÚNG là cờ riêng của nó, `--lock-wait-timeout`
 * (`pg_restore` không có cờ tương đương). Chưa dùng: hạn `execFile` đã chặn treo, mà đặt thêm thì
 * một lượt sao lưu đêm hợp lệ gặp khoá nhất thời sẽ hỏng thay vì chờ.
 *
 * Bỏ trống `hanCauLenhMs` = KHÔNG đặt `statement_timeout` (dùng cho lệnh nạp, xem hằng ở trên).
 */
export function pgOptionsPhanh(hanCauLenhMs?: number): string {
  const phan = [`-c lock_timeout=${HAN_CHO_KHOA_MS}`];
  if (hanCauLenhMs !== undefined) phan.push(`-c statement_timeout=${hanCauLenhMs}`);
  return phan.join(" ");
}

/**
 * Lỗi này có phải do `execFile` tự giết tiến trình con vì QUÁ HẠN không?
 *
 * `execFile` với option `timeout` bắn `SIGTERM` rồi trả lỗi có `killed = true`, `code = null` —
 * không trùng nhánh `ENOENT` (thiếu binary) nên nhánh xử lý lỗi cũ vẫn chạy, chỉ là ra một câu báo
 * mơ hồ. Cần tách ra để nói thẳng "quá hạn".
 *
 * Loại trừ ca vượt `maxBuffer`: Node cũng giết tiến trình con trong ca đó (`killed = true`) nhưng
 * đấy là lỗi "output quá to", nói "quá hạn" là chỉ sai hướng điều tra.
 */
export function laLoiQuaHan(err: unknown): boolean {
  const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null | undefined;
  if (!e || e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return false;
  return e.killed === true;
}

/** Đổi ms sang giây cho câu báo lỗi người đọc hiểu được. */
export function giay(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}
