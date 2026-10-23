import { Prisma } from "@/generated/prisma/client";

/**
 * MỘT THỨ TỰ PHIÊN BẢN DUY NHẤT cho các dòng `RawPancakeOrder` của cùng một đơn (`shopId`, `externalId`).
 *
 * Bất biến: MỌI câu hỏi "bản nào là bản đứng đầu / bản nào là bản cũ" của đơn Pancake — chọn payload để
 * dựng Silver (`latestPayloads`, cả quét cả bảng lẫn theo từng đơn), sổ kết cục (`ket-cuc-silver.ts`:
 * đơn còn dở, đơn cần xem, đóng dấu bản cũ, khảo sát), guard land của webhook (`laSuKienCuHon`) — PHẢI
 * xếp bằng ĐÚNG mảnh SQL này. Hai thứ tự lệch nhau là hai chế độ hỏng đã gặp: đường dựng chọn bản A
 * trong khi sổ kết cục chờ dấu trên bản B ⇒ B không bao giờ được đóng dấu, đối soát đêm thử lại tới
 * `FAILED_RETRY_LIMIT` = báo "đơn kẹt" giả; hoặc ngược lại sổ kết cục nói "xong" theo bản A mà Silver
 * đang dựng nội dung cũ của B.
 *
 * Thứ tự: `mốc updated_at DESC NULLS LAST, fetchedAt DESC, id DESC`.
 *  - `updated_at` là mốc NỘI DUNG Pancake; `fetchedAt` chỉ là mốc LAND — trang API chụp TRƯỚC một sự kiện
 *    webhook mà POST tới SAU vẫn land muộn hơn, nên xếp theo `fetchedAt` thuần là nội dung cũ thắng.
 *  - Bằng mốc `updated_at` (Pancake có sửa phí lúc đối soát mà giữ nguyên mốc — đo 27/07) ⇒ bản land muộn
 *    thắng, đúng như guard `soThuTuCapNhatDon` trả `BANG` rồi rơi về luật mốc land.
 *  - Thiếu / sai khuôn `updated_at` ⇒ xếp SAU mọi dòng có mốc; giữa chúng vẫn luật `fetchedAt`.
 *  - `id DESC` cuối cùng: `fetchedAt` là TIMESTAMP(3), hai phiên bản land cùng mili-giây thì `DISTINCT ON`
 *    chọn tuỳ ý — tức số TIỀN của đơn phụ thuộc may rủi. Có `id` thì thứ tự là TOÀN PHẦN, xác định.
 *
 * CÁCH DÙNG — HAI mảnh đi CẶP, không tách:
 *   `FROM "RawPancakeOrder" ${noiMocPhienBanDon} WHERE … ORDER BY "shopId", "externalId", ${thuTuPhienBanDon}`
 * `noiMocPhienBanDon` đứng NGAY sau bảng (trước `WHERE`) và gắn mỗi dòng một cột `"pbDon"."moc"`;
 * `thuTuPhienBanDon` xếp theo cột đó. Quên mảnh nối thì câu SQL NÉM "missing FROM-clause entry" — hỏng
 * to ngay lượt chạy đầu, không âm thầm xếp sai.
 *
 * Guard `updated_at` trong `upsertOneOrder` vẫn GIỮ làm lưới an toàn cuối (Silver có bản để so).
 * Chỉ áp cho đơn Pancake; stream khác (sản phẩm, settlement, ví, ads) giữ luật `fetchedAt`.
 */

/** Bí danh của mảnh nối — cột duy nhất nó lộ ra là `moc`, không trùng tên cột nào của bảng Bronze. */
const BI_DANH = `"pbDon"`;

/**
 * Mốc `updated_at` của payload đơn dưới dạng `timestamptz`, tính trên chuỗi thô `u` — CÙNG luật với
 * `parseVnDate` (đường guard ở `thu-tu-cap-nhat-don.ts`) để hai nơi không bao giờ bất đồng "bản nào mới hơn":
 *  - So theo THỜI ĐIỂM, không so chuỗi: separator `T`/khoảng trắng, độ dài phần lẻ giây và đuôi múi giờ
 *    khác nhau giữa API và webhook. Naive = giờ UTC (bất biến #3, `docs/tu-dien-du-lieu-bronze.md`)
 *    ⇒ `AT TIME ZONE 'UTC'`, KHÔNG dựa `TimeZone` của phiên DB. Có `Z`/offset ⇒ theo offset.
 *  - Cắt phần lẻ giây về mili-giây (V8 cắt, không làm tròn) ⇒ hai bản lệch dưới 1ms là BẰNG, rơi về
 *    luật `fetchedAt` — đúng như `soThuTuCapNhatDon` trả `BANG`.
 *  - Thiếu hoặc sai khuôn ⇒ NULL (xếp SAU). Ép kiểu thẳng sẽ NÉM và làm hỏng CẢ câu vì một dòng rác,
 *    nên phải lọc khuôn bằng regex rồi kiểm ngày có thật trong tháng ("2026-02-31") — lồng CASE vì
 *    Postgres không hứa thứ tự đánh giá `AND`, chỉ CASE mới chắn được phép ép kiểu.
 *  - Lệch CÓ CHỦ ĐÍCH so với `parseVnDate` (regex SQL chặt hơn, không có dữ liệu thật nào rơi vào):
 *    năm 0001–0999 (và 0000) ⇒ SQL ra NULL trong khi JS đọc được; offset giờ ±15..±99 (vd `+15:00`) ⇒
 *    SQL ra NULL trong khi JS nhận. Ngoài hai dải đó, khớp `parseVnDate` tới mili-giây.
 * Regex chỉ dùng lớp ký tự (`[.]`, `[0-9]`) để khỏi phải thoát `\` qua hai tầng chuỗi TS + SQL; dấu
 * `\` DUY NHẤT là `\\1` (tham chiếu nhóm của `regexp_replace`, ra SQL thành `'\1'`).
 */
const mocCapNhatDonSql = (u: string): string => `
  CASE WHEN ${u} ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])([T ]([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9]([.][0-9]+)?)?([zZ]|[+-](0[0-9]|1[0-4]):?[0-5][0-9])?)?$' THEN
    CASE WHEN substr(${u}, 9, 2)::int <= extract(day from
           make_date(substr(${u}, 1, 4)::int, substr(${u}, 6, 2)::int, 1)
           + interval '1 month' - interval '1 day') THEN
      CASE WHEN ${u} ~ '[T ][0-9:.]+([zZ]|[+-][0-9]{2}:?[0-9]{2})$'
        THEN regexp_replace(${u}, '([.][0-9]{3})[0-9]+', '\\1')::timestamptz
        ELSE regexp_replace(${u}, '([.][0-9]{3})[0-9]+', '\\1')::timestamp AT TIME ZONE 'UTC'
      END
    END
  END`;

/**
 * Mảnh NỐI: rút `payload->>'updated_at'` đúng MỘT lần mỗi dòng rồi tính mốc trên chuỗi đã rút.
 *
 * Vì sao phải tách ra chứ không nhúng biểu thức thẳng vào `ORDER BY`: biểu thức mốc đọc chuỗi 6 lần,
 * và mỗi lần `payload->>…` Postgres lại detoast NGUYÊN payload (~10KB) — đo 10.000 dòng: 274ms so với
 * 21ms của thứ tự `fetchedAt`, buffer hit ~240k so với ~130. `OFFSET 0` là hàng rào CỐ Ý: không có nó
 * planner kéo phẳng subquery rồi thế lại biểu thức `payload->>…` vào từng chỗ dùng — quay về 6 lần đọc.
 * `payload` không kèm bí danh bảng ⇒ chỉ dùng khi câu có đúng một bảng mang cột `payload`.
 */
export const NOI_MOC_PHIEN_BAN_DON_SQL = `CROSS JOIN LATERAL (
    SELECT ${mocCapNhatDonSql(`s.u`)} AS moc
    FROM (SELECT payload->>'updated_at' AS u OFFSET 0) s
  ) ${BI_DANH}`;

/**
 * Các khoá `ORDER BY` của thứ tự phiên bản (bản ĐỨNG ĐẦU trước) — dạng chuỗi cho `$queryRawUnsafe`.
 * Ghép sau khoá nhóm: `ORDER BY "shopId", "externalId", ${THU_TU_PHIEN_BAN_DON_SQL}` cho `DISTINCT ON`,
 * hoặc đứng một mình trong `row_number() OVER (ORDER BY …)`. BẮT BUỘC đi cùng `NOI_MOC_PHIEN_BAN_DON_SQL`.
 */
export const THU_TU_PHIEN_BAN_DON_SQL = `${BI_DANH}.moc DESC NULLS LAST, "fetchedAt" DESC, "id" DESC`;

/** Hai mảnh trên ở dạng `Prisma.Sql` để nhúng vào `$queryRaw`/`$executeRaw` dạng tagged template. */
export const noiMocPhienBanDon: Prisma.Sql = Prisma.raw(NOI_MOC_PHIEN_BAN_DON_SQL);
export const thuTuPhienBanDon: Prisma.Sql = Prisma.raw(THU_TU_PHIEN_BAN_DON_SQL);
