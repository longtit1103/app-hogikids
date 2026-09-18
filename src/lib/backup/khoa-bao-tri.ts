/**
 * KHOÁ BẢO TRÌ — chỉ cho MỘT lượt phục hồi DB chạy tại một thời điểm, và chặn mọi
 * đường GHI dữ liệu trong lúc schema đích đang bị xoá + nạp lại.
 *
 * Vì sao khoá nằm TRONG TIẾN TRÌNH chứ không phải trong DB: lượt phục hồi
 * `DROP SCHEMA … CASCADE` chính cái schema chứa mọi bảng của app, nên một dòng khoá
 * đặt trong DB sẽ tự bốc hơi giữa chừng — và lượt thứ hai đi đọc khoá đó sẽ gặp
 * "bảng không tồn tại" thay vì câu trả lời "đang bận". App chạy MỘT container, MỘT
 * tiến trình Node (`docker-compose.yml`: 1 service, không replica) nên mọi route
 * handler và server action dùng chung đúng ô nhớ này.
 *
 * ⚠️ RÀNG BUỘC: chạy nhiều bản sao app thì khoá này KHÔNG còn đủ — lúc đó phải đổi
 * sang khoá ngoài (advisory lock trên một DB khác, hoặc Redis).
 *
 * ⚠️ Vì sao cờ neo vào `globalThis` chứ không phải biến module: Next gói route handler
 * và server action thành những bundle RIÊNG, nên cùng một file có thể bị nạp thành
 * NHIỀU bản sao module trong cùng tiến trình. Lúc đó `/api/restore` bật cờ ở bản sao
 * này còn server action lại đọc cờ ở bản sao khác — mọi chốt chặn thành vô hiệu TRONG
 * IM LẶNG (test đơn vị không bắt được vì chúng nạp module một lần duy nhất). `globalThis`
 * là ô nhớ chắc chắn dùng chung, cùng lý do `src/lib/prisma.ts` neo PrismaClient vào đó.
 *
 * Vì sao phải có: pre-backup + `pg_restore` mất hàng chục giây. Trong cửa sổ đó
 * webhook Pancake vẫn bắn, n8n vẫn đẩy trang, chủ shop vẫn bấm được nút — ghi vào
 * một schema sắp bị drop là mất trắng dữ liệu vừa ghi, còn ghi vào lúc schema vừa
 * tạo lại nửa chừng thì lỗi khó đọc. Chặn ở cửa rẻ hơn nhiều so với đi dọn sau.
 *
 * ⚠️ CỜ CÓ HẠN (TTL) — LƯỚI CUỐI, không phải hạn hiệu năng. Đường trả cờ duy nhất là `finally`
 * của `POST /api/restore`; nếu một lệnh pg treo mà không ai bắn timeout thì `finally` không bao
 * giờ tới và cả app kẹt ở chế độ chỉ-đọc TRONG IM LẶNG: 10 workflow n8n nhận 503, sao lưu đêm 503,
 * mọi nút ghi tay lỗi, khoản chi định kỳ lặng lẽ không sinh — chỉ khởi động lại container mới gỡ.
 * Nên cờ lưu kèm mốc bật và tự hết hiệu lực sau `TTL_KHOA_PHUC_HOI_MS`.
 *
 * TTL phải LỚN HƠN tổng hạn của cả chuỗi lệnh pg trong một lượt phục hồi — xem
 * `han-chay-lenh-pg.ts`, nơi giữ CẢ CỤM ba lớp phanh và tính TTL từ tổng đó. Nhả cờ giữa một lượt
 * phục hồi ĐANG chạy thật là hỏng nặng hơn cờ kẹt (hai lượt cùng drop + nạp một schema), nên đừng
 * bao giờ hạ TTL xuống dưới tổng ấy.
 *
 * Mốc bật đo bằng `performance.now()` (đồng hồ ĐƠN ĐIỆU tính từ lúc tiến trình khởi động) chứ
 * không phải `Date.now()`: minipc đồng bộ NTP, một cú nhảy đồng hồ về phía trước sẽ khiến cờ hết
 * hạn SỚM ngay giữa lượt phục hồi thật.
 *
 * ⚠️ THẺ PHIÊN — cái giá bắt buộc phải trả khi có TTL. Hạn chỉ chặn được lệnh pg (`execFile` bắn
 * SIGTERM); phần việc còn lại trong cửa sổ giữ khoá KHÔNG có hạn nào: `coLuotDangChay()` và
 * `thuHoiMoiPhien()` là truy vấn Prisma, mà Prisma không đặt hạn truy vấn mặc định. Nên vẫn có
 * đường để một lượt treo QUÁ TTL rồi mới tỉnh dậy. Không có thẻ phiên thì kịch bản này mất dữ liệu:
 * lượt #1 treo → TTL nhả cờ → chủ shop bấm lại → lượt #2 giành cờ và bắt đầu drop schema → lượt #1
 * chợt tỉnh, chạy `finally`, xoá cờ CỦA LƯỢT #2 → mọi đường ghi mở lại ngay giữa lúc #2 đang nạp
 * schema, đúng cái thảm hoạ khoá này sinh ra để chặn. Vì vậy `thuGiuKhoaPhucHoi()` phát một THẺ và
 * `traKhoaPhucHoi(the)` chỉ xoá đúng thẻ của mình.
 *
 * ⚠️ FENCING — mảnh THỨ HAI, đừng gỡ vì tưởng thẻ phiên đã đủ. Thẻ chỉ ngăn lượt cũ XOÁ CỜ của lượt
 * mới; nó KHÔNG ngăn lượt cũ ĐI TIẾP. Cùng kịch bản trên nhưng nhìn từ phía lượt #1: nó tỉnh dậy
 * giữa đường, không ai hỏi lại "tôi còn giữ khoá không", nên nó chạy nốt `pg_dump` bản lùi rồi
 * `pg_restore` — hai lượt cùng drop + nạp một schema, đúng thảm hoạ cần chặn, chỉ khác là cờ vẫn
 * sạch sẽ. Nên MỌI đường phá huỷ (`POST /api/restore`) phải đi qua một chốt ngay sau mỗi bước chờ
 * không hạn và ngay trước mỗi lệnh ghi; mất quyền ⇒ dừng, KHÔNG chạy thêm một lệnh pg nào.
 *
 * MẪU ĐÚNG — rẽ nhánh THẲNG trên kết quả `giaHanKhoaPhucHoi(the)`:
 *
 *     if (!giaHanKhoaPhucHoi(the)) return traLoiMatKhoa("<bước vừa xong>");
 *
 * TUYỆT ĐỐI KHÔNG viết `if (!laChuKhoaPhucHoi(the)) …; giaHanKhoaPhucHoi(the);` — mẫu đó đã gây một
 * lỗi thật: TTL hết đúng GIỮA hai lời gọi thì câu kiểm trả `true`, câu gia hạn trả `false` (bị bỏ
 * qua), và lượt đã mất khoá vẫn đi tiếp phát lệnh phá huỷ.
 *
 * Tính nguyên tử KHÔNG đến từ "chỉ đọc đồng hồ một lần" — `giaHanKhoaPhucHoi` bên trong vẫn đọc
 * `performance.now()` hai lần (một lần để kiểm TTL, một lần để đặt mốc mới). Nó đến từ chỗ **cả
 * quãng kiểm-rồi-ghi nằm gọn trong một đoạn ĐỒNG BỘ, không có `await` nào chen vào**, nên vòng lặp
 * sự kiện không thể xen một lượt khác vào giữa. Tách thành hai lời gọi ở tầng người dùng thì quyết
 * định ("còn khoá") và hành động ("đẩy mốc") không còn dính nhau, và cái sai lọt qua đúng khe đó.
 * `laChuKhoaPhucHoi` chỉ dành cho HỎI SUÔNG sau khi mọi việc đã xong (không cần mở thêm cửa sổ TTL
 * nữa), ví dụ để chọn câu cảnh báo trả về.
 *
 * ⚠️ GIA HẠN (`giaHanKhoaPhucHoi`) — mảnh THỨ BA, để fencing không quay ra giết oan lượt đang tiến
 * triển thật. Quan hệ ba tầng: hạn lệnh (`han-chay-lenh-pg.ts`) chặn TỪNG lệnh pg treo → TTL là
 * lưới cuối chặn cả lượt treo → fencing bảo đảm lượt bị TTL bỏ rơi không đi tiếp. Gia hạn chỉ đẩy
 * mốc TTL, KHÔNG cấp lại cờ đã mất (mất rồi thì lượt đó phải chết hẳn).
 *
 * ⚠️ CHỈ gia hạn tại mốc một bước VỪA THẬT SỰ HOÀN THÀNH — tuyệt đối KHÔNG bằng nhịp tim
 * (`setInterval`) hay bất cứ thứ gì chạy nền: timer vẫn tích tắc trong khi lời gọi `await` treo cứng,
 * nên nhịp tim sẽ gia hạn vĩnh viễn cho đúng cái lượt đã chết = biến TTL thành vô hạn và app kẹt
 * chế độ chỉ-đọc tới lúc restart. Số mốc gia hạn là HỮU HẠN và nằm thẳng trong mạch code, nên tổng
 * thời gian giữ cờ tối đa vẫn có trần chứ không mở toang: **(số mốc gia hạn + 1) × TTL** — cửa sổ
 * đầu tính từ lúc giành cờ, mỗi mốc mở thêm một cửa sổ nữa. Hiện `POST /api/restore` có **4 mốc gia
 * hạn** (sau cổng drain, sau bản lùi, ở chốt `truocKhiPhaHuy` trong `runRestore`, và trước bước thu
 * hồi phiên) ⇒ trần = **5 × TTL**. Thêm mốc thì sửa luôn con số này: người vận hành đọc nó để quyết
 * chờ hay khởi động lại container.
 */

import { TTL_KHOA_PHUC_HOI_MS } from "./han-chay-lenh-pg";

/**
 * Thẻ của MỘT lượt phục hồi — vừa là mốc tính TTL (`mocMono`) và mốc cho câu log đọc được
 * (`batDauLuc`), vừa là danh tính để `traKhoaPhucHoi()` / `laChuKhoaPhucHoi()` biết cờ đang giữ có
 * phải của mình không.
 *
 * So bằng ĐỊA CHỈ ĐỐI TƯỢNG (`===`), không so từng trường: mỗi lượt nhận đúng một đối tượng mới,
 * nên hai lượt không bao giờ nhầm nhau kể cả khi trùng mốc thời gian — và nhờ vậy `mocMono` đẩy lên
 * lúc gia hạn cũng không ảnh hưởng gì tới việc nhận dạng.
 *
 * `mocMono` = mốc TTL HIỆN HÀNH, không phải mốc bắt đầu lượt: `giaHanKhoaPhucHoi()` đẩy nó lên mỗi
 * khi lượt hoàn thành một bước dài. Muốn biết lượt bật lúc nào thì đọc `batDauLuc` (không đổi).
 * Với người gọi thẻ là BẤT BIẾN: họ chỉ cầm nó để chứng minh danh tính, mọi thay đổi mốc phải đi
 * qua `giaHanKhoaPhucHoi()` để còn bị kiểm quyền sở hữu.
 */
export type ThePhienPhucHoi = { readonly mocMono: number; readonly batDauLuc: string };

const co = globalThis as unknown as {
  __phienPhucHoiDb?: ThePhienPhucHoi;
  __dangDungLaiKhoTho?: boolean;
};

/**
 * Thử giành quyền phục hồi. Trả THẺ PHIÊN = giành được; `null` = đã có lượt khác đang chạy.
 *
 * HAI NGHĨA VỤ của người cầm thẻ, thiếu cái nào cũng hỏng theo một kiểu riêng:
 *  1. `traKhoaPhucHoi(the)` trong `finally` — không có thì app kẹt chỉ-đọc tới hết TTL.
 *  2. Rẽ nhánh trên `giaHanKhoaPhucHoi(the)` sau mỗi bước chờ không hạn và ngay trước MỖI lệnh phá
 *     huỷ — giành được khoá lúc VÀO không có nghĩa là còn giữ lúc chạy tới lệnh nạp. Một lời gọi lo
 *     cả hai việc (kiểm + đẩy mốc); đừng tách thành kiểm-rồi-gia-hạn, xem khối FENCING đầu file.
 *
 * Đi qua `dangPhucHoi()` chứ không tự soi ô nhớ, để một cờ đã quá hạn không chặn lượt phục hồi mới.
 */
export function thuGiuKhoaPhucHoi(): ThePhienPhucHoi | null {
  if (dangPhucHoi()) return null;
  const the: ThePhienPhucHoi = { mocMono: performance.now(), batDauLuc: new Date().toISOString() };
  co.__phienPhucHoiDb = the;
  return the;
}

/**
 * Trả khoá. Gọi trong `finally` để lỗi giữa chừng không khoá app vĩnh viễn.
 *
 * CHỈ xoá khi cờ đang giữ ĐÚNG là thẻ của lượt này. Thẻ lệch = lượt cũ đã bị TTL nhả nay mới về,
 * trong khi một lượt MỚI đang giữ cờ và có thể đang drop + nạp schema — xoá lúc đó là mở toang mọi
 * đường ghi giữa lượt phục hồi thật (xem khối "THẺ PHIÊN" ở đầu file). Không xoá, chỉ kêu lên.
 */
export function traKhoaPhucHoi(the: ThePhienPhucHoi): void {
  const dangGiu = co.__phienPhucHoiDb;
  if (dangGiu !== undefined && dangGiu !== the) {
    console.error(
      `Lượt phục hồi cũ (bật lúc ${the.batDauLuc}) về muộn sau khi TTL đã nhả — KHÔNG đụng vào cờ ` +
        `của lượt đang chạy (bật lúc ${dangGiu.batDauLuc}). Kiểm log phía trên xem lượt cũ treo ở ` +
        `đâu, và kiểm dữ liệu xem hai lượt có chồng lên nhau không.`,
    );
    return;
  }
  co.__phienPhucHoiDb = undefined;
}

/**
 * Có lượt phục hồi đang chạy không.
 *
 * Quá TTL thì trả `false` VÀ xoá cờ — xoá để câu log dưới đây chỉ kêu MỘT LẦN (hàm này bị gọi ở 34
 * điểm ghi, kêu mỗi lượt là ngập log tới mức không ai đọc). Không bao giờ nhả im lặng: cờ quá hạn
 * nghĩa là một lượt phục hồi đã đi lạc mà không ai biết, dấu vết trong log container là manh mối
 * duy nhất còn lại.
 */
export function dangPhucHoi(): boolean {
  const phien = co.__phienPhucHoiDb;
  if (!phien) return false;

  const troiMs = performance.now() - phien.mocMono;
  if (troiMs <= TTL_KHOA_PHUC_HOI_MS) return true;

  co.__phienPhucHoiDb = undefined;
  console.error(
    `Khoá bảo trì phục hồi quá hạn ${Math.round(TTL_KHOA_PHUC_HOI_MS / 60_000)} phút (bật lúc ` +
      `${phien.batDauLuc}) — TỰ NHẢ để app ghi lại được. Lượt phục hồi đó đã không chạy tới bước ` +
      `trả khoá: kiểm log phía trên xem nó dừng ở đâu, và kiểm dữ liệu xem có nạp dở không.`,
  );
  return false;
}

/**
 * Lượt cầm thẻ này CÓ CÒN là chủ khoá không — tức cờ đang giữ ĐÚNG là thẻ đó VÀ chưa quá TTL.
 *
 * ⚠️ ĐÂY KHÔNG PHẢI CỔNG FENCING — đừng gọi nó trước một lệnh phá huỷ. Cổng là
 * `giaHanKhoaPhucHoi` (xem khối "FENCING" đầu file): dùng hàm này rồi gia hạn ở câu sau chính là
 * mẫu đã gây lỗi thật. Chỗ dùng ĐÚNG của nó là HỎI SUÔNG khi mọi việc đã xong và không còn lệnh
 * nào phía sau — ví dụ chọn câu cảnh báo trả về sau khi bước thu hồi phiên kết thúc.
 *
 * Trả `false` nghĩa là lượt này đã treo quá TTL và bị bỏ rơi — có thể một lượt khác đang drop + nạp
 * schema ngay lúc này.
 *
 * Đi qua `dangPhucHoi()` chứ không tự so ô nhớ: cần cả phần kiểm TTL lẫn câu log "quá hạn — TỰ NHẢ"
 * của nó. Ca cờ trống (TTL đã nhả, chưa ai giành lại) cũng trả `false` một cách CỐ Ý: lúc đó mọi
 * đường ghi khác đã mở lại rồi, đi tiếp mà drop schema là xoá đúng dữ liệu đang được ghi vào.
 */
export function laChuKhoaPhucHoi(the: ThePhienPhucHoi): boolean {
  return dangPhucHoi() && co.__phienPhucHoiDb === the;
}

/**
 * Lượt phục hồi phát hiện mình đã MẤT khoá tại một chốt fencing — ném ra để cắt mạch ngay tại đó.
 *
 * Có lớp riêng (thay vì `Error` thường) vì hệ quả khác hẳn mọi lỗi phục hồi khác: mọi đường NÉM lỗi
 * này đều nằm TRƯỚC lệnh phá huỷ đầu tiên, nên gặp nó là **dữ liệu chưa bị đụng tới** ⇒ route trả
 * 409 "đã dừng, chưa thay đổi gì" thay vì 500 kèm lời khuyên đi lùi về bản `pre-restore-*.dump`.
 * Bảo người ta lùi bản backup trong khi chưa mất gì là đổi một lần thử lại vô hại lấy một lần mất
 * dữ liệu thật.
 *
 * KHÔNG phải mọi chốt fencing đều ném lỗi này: chốt cuối (trước bước thu hồi phiên) chạy SAU khi
 * nạp xong, mất khoá ở đó thì dữ liệu ĐÃ bị thay — nó trả `ok` kèm cảnh báo chứ tuyệt đối không
 * ném/409, vì nói "chưa làm gì" lúc ấy sẽ khiến chủ shop bấm phục hồi thêm lần nữa. Thêm chốt mới
 * ở đâu thì cân đúng chỗ đó: trước phá huỷ ⇒ ném; sau phá huỷ ⇒ cảnh báo.
 */
export class LoiMatKhoaPhucHoi extends Error {
  constructor(public readonly buoc: string) {
    super(`Lượt phục hồi đã mất khoá bảo trì ở bước "${buoc}" — dừng trước khi đụng vào dữ liệu.`);
    this.name = "LoiMatKhoaPhucHoi";
  }
}

/**
 * Đẩy mốc TTL của lượt đang giữ khoá. `true` = đã gia hạn; `false` = thẻ này không còn là chủ khoá
 * (và lúc đó KHÔNG đụng gì vào cờ — không hồi sinh cờ đã nhả, không cướp cờ của lượt khác).
 *
 * Chỉ gọi tại mốc một bước dài VỪA HOÀN THÀNH, không bao giờ theo nhịp tim — lý do ở khối "GIA HẠN"
 * đầu file.
 */
export function giaHanKhoaPhucHoi(the: ThePhienPhucHoi): boolean {
  if (!laChuKhoaPhucHoi(the)) return false;
  // Ghi đè `readonly` bằng cast ở ĐÚNG MỘT CHỖ (sau khi đã kiểm quyền sở hữu): thẻ phải bất biến
  // với người gọi, nhưng mốc TTL thì bắt buộc đẩy được. An toàn vì danh tính so bằng địa chỉ đối
  // tượng, không dính gì tới mốc.
  (the as { mocMono: number }).mocMono = performance.now();
  return true;
}

/**
 * Cờ cho lượt "Dựng lại từ kho thô" — cùng cơ chế trong-tiến-trình, nhưng phạm vi HẸP hơn nhiều:
 * chỉ để lượt import file chi phí ads không chạy chồng lên nó.
 *
 * Vì sao không dùng `SyncLog` RUNNING làm căn cứ như chính nút dựng lại: log của lượt dựng lại và
 * log của lượt đồng bộ đơn hàng ban đêm dùng CHUNG `kind = "PANCAKE"`, nên soi log sẽ chặn oan cả
 * những đêm chỉ đơn thuần kéo đơn — trong khi đường kéo đơn không ghi một dòng chi phí nào.
 *
 * Vì sao cần chặn: lượt dựng lại ghi `Expense` source=ADS_API dựa trên ẢNH CHỤP sổ đọc một lần từ
 * đầu (nó ghi hàng chục nghìn dòng nên không thể nằm trong một transaction giữ khoá suốt). Một lượt
 * import ghi đè commit giữa chừng sẽ không được ảnh chụp đó nhìn thấy ⇒ lượt dựng lại tạo lại dòng
 * ADS_API cho đúng ngày chủ shop vừa thay bằng số của mình = chi phí ngày đó đếm 2 lần.
 *
 * CỜ NÀY CỐ Ý KHÔNG CÓ TTL (khác cờ phục hồi ở trên) — đừng "đồng bộ hoá" mà thêm vào:
 *  - Thiệt hại khi kẹt là NHỎ và NHÌN THẤY ĐƯỢC: chỉ chặn import file ads và một lượt dựng lại
 *    khác, cả hai đều là nút bấm tay và đều hiện câu báo ngay trên màn hình.
 *  - Lượt dựng lại chạy bao lâu thì KHÔNG đoán được (hàng chục nghìn dòng, tuỳ khối lượng kho thô),
 *    nên mọi TTL đặt ra đều có ngày bị vượt — và lúc đó cờ nhả giữa chừng sẽ thả đúng lượt import
 *    mà nó sinh ra để chặn, tức là mở lại lỗi chi phí đếm 2 lần.
 */
export function thuGiuKhoaDungLai(): boolean {
  if (co.__dangDungLaiKhoTho) return false;
  co.__dangDungLaiKhoTho = true;
  return true;
}

/** Trả cờ dựng lại. Gọi trong `finally`. */
export function traKhoaDungLai(): void {
  co.__dangDungLaiKhoTho = false;
}

/** Có lượt dựng lại từ kho thô đang chạy không. */
export function dangDungLaiTuKhoTho(): boolean {
  return co.__dangDungLaiKhoTho === true;
}

/** Câu báo dùng chung cho mọi đường ghi bị chặn — nói rõ việc cần làm là CHỜ. */
export const LOI_DANG_PHUC_HOI =
  "Đang phục hồi dữ liệu từ bản sao lưu — mọi thao tác ghi tạm dừng, thử lại sau khi phục hồi xong.";

/**
 * Chốt chặn cho ROUTE HANDLER: trả sẵn `Response` 503 nếu đang phục hồi, `null` nếu
 * đường thông. 503 + `Retry-After` là mã đúng nghĩa "tạm thời bận" — n8n hiểu là thử
 * lại sau chứ không phải hỏng hợp đồng (khác 4xx).
 */
export function chanRouteKhiDangPhucHoi(): Response | null {
  if (!dangPhucHoi()) return null;
  return Response.json(
    { ok: false, error: LOI_DANG_PHUC_HOI },
    { status: 503, headers: { "Retry-After": "60" } }
  );
}
