import type { Prisma, PrismaClient } from "@/generated/prisma/client";

import { BC_ID_TIKTOK_HOP_LE } from "@/lib/bronze/khuon-bc-id-tiktok";
import { shopIdsChoVai } from "@/lib/ket-noi/cau-hinh-shop";
import { prisma } from "@/lib/prisma";

import { BRONZE_STREAMS, isBronzeStream, type BronzeStream } from "./streams";
import { BANG_LAN_THAY, mocLanThayCua } from "./transform-raw-helpers";

/**
 * Client Prisma thường HOẶC client trong `$transaction`. Người gọi truyền client
 * transaction khi bước land phải nằm CÙNG transaction với một khoá tư vấn (xem
 * `khoa-land-don.ts`) — đọc-để-quyết-định rồi mới ghi thì hai bước phải bất khả phân.
 */
type ClientBronze = PrismaClient | Prisma.TransactionClient;

/**
 * Với stream danh sách shop MỞ (`shops: null` trong registry) không có whitelist để chặn shopId.
 * Ép SHAPE của shopId theo TÊN STREAM — regex là HẰNG trong code, TUYỆT ĐỐI KHÔNG lấy từ input:
 *   - `meta/report`: ad account Meta dạng `act_<số>`.
 *   - `tiktokbusiness/report`: advertiser_id (chuỗi số ≥6 chữ số).
 *   - `tiktokbusiness/invoice` + `tiktokbusiness/cost`: bc_id Business Center (6–32 chữ số — `BC_ID_TIKTOK_HOP_LE`, khuôn
 *     dùng chung với bảng bền trạng thái BC và action đánh dấu "không dùng thẻ").
 * Không phân biệt được bc_id với advertiser_id (đều là chuỗi số) — nhưng chặn được id SAI KIỂU (vd
 * `act_...` của Meta lọt vào stream TikTok, hoặc chuỗi rác) TRƯỚC khi nó nằm vĩnh viễn trong Bronze
 * (append-only, không sửa được) làm mọi đối soát join theo shopId về sau lệch.
 */
const OPEN_SHOP_SHAPE: Partial<Record<BronzeStream, { re: RegExp; moTa: string }>> = {
  "meta/report": { re: /^act_\d+$/, moTa: "ad account Meta dạng 'act_<số>'" },
  "tiktokbusiness/report": { re: /^\d{6,}$/, moTa: "advertiser_id TikTok Business (chuỗi ≥6 chữ số)" },
  "tiktokbusiness/invoice": { re: BC_ID_TIKTOK_HOP_LE, moTa: "bc_id Business Center (chuỗi 6–32 chữ số)" },
  "tiktokbusiness/cost": { re: BC_ID_TIKTOK_HOP_LE, moTa: "bc_id Business Center (chuỗi 6–32 chữ số)" },
  "tiktokbusiness/gmvmax_item": { re: /^\d{6,}$/, moTa: "advertiser_id TikTok Business (chuỗi ≥6 chữ số)" },
};

/**
 * Cận DƯỚI hợp lý của `ngay`. App chỉ có dữ liệu từ 2026 (Bronze dựng 2026-07), nên mọi ngày trước
 * 2024 chắc chắn là lỗi tính toán ở người gọi chứ không phải backfill thật. Nới tới 2024 để còn chỗ
 * cho ca backfill lịch sử xa nếu sàn mở, mà vẫn chặn `1970-01-01` (epoch 0 — kết quả kinh điển của
 * một phép tính ngày hỏng).
 */
const NGAY_SOM_NHAT = "2024-01-01";

/**
 * Khoá ngày theo `Asia/Ho_Chi_Minh` (bất biến #3) — ĐỘC LẬP TZ của máy chạy, không dựa vào
 * `process.env.TZ`. `en-CA` cho ra đúng khuôn `YYYY-MM-DD` nên so sánh chuỗi = so sánh thời gian.
 */
const VN_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Cận TRÊN hợp lý của `ngay` = NGÀY MAI giờ VN. Cố ý KHÔNG lấy "hôm nay": người gọi (n8n) tính ngày
 * ở tiến trình khác, và một lượt chạy vắt qua nửa đêm có thể gửi ngày lệch một nhịp — chừa đúng một
 * ngày biên là đủ, không mở thêm.
 */
function ngayMaiGioVn(): string {
  return VN_DATE_FORMATTER.format(new Date(Date.now() + 86_400_000));
}

/**
 * `ngay` là NGÀY THẬT hay chỉ "đúng khuôn"? Regex `\d{4}-\d{2}-\d{2}` cho lọt `2026-02-31`,
 * `2026-13-45`, `2026-00-00` — và `_ngay` là TEXT nên Postgres không bao giờ cãi. Ngày bịa lọt vào
 * `externalId` là nằm VĨNH VIỄN (Bronze append-only, không sửa được), rồi reader gom chuỗi ngày sẽ
 * thấy một điểm không tồn tại giữa biểu đồ mà không có log nào đỏ.
 *
 * Kiểm bằng chính lịch: dựng `Date` ở UTC rồi ép ba thành phần phải QUAY VỀ y hệt — `Date.UTC` tự
 * cuộn tràn (31/02 → 03/03) nên chỉ cần so lại là bắt được. Cố ý KHÔNG dùng `new Date(s)` (parse
 * theo múi giờ máy) và KHÔNG hỏi Postgres `::date` (một vòng mạng cho việc thuần lịch).
 */
function ngayCoThatTrenLich(ngay: string): boolean {
  const [nam, thang, ngayTrongThang] = ngay.split("-").map(Number);
  const d = new Date(Date.UTC(nam, thang - 1, ngayTrongThang));
  return (
    d.getUTCFullYear() === nam && d.getUTCMonth() === thang - 1 && d.getUTCDate() === ngayTrongThang
  );
}

/**
 * Cửa sổ hợp lý của `chupLuc` (mốc nguồn CHỤP trang) so với đồng hồ: không quá 5' trong tương lai (n8n và app/Postgres
 * chung máy minipc — lệch đồng hồ chỉ vài giây), không cũ hơn 7 ngày (lượt kéo GET rồi POST ngay; mốc cũ cả tuần là
 * người gọi tính sai, mà mốc tương lai thì ghim bản đó lên đầu khoá mãi mãi trước mọi lượt chụp thật).
 */
const CHUP_LUC_TUONG_LAI_TOI_DA_PHUT = 5;
const CHUP_LUC_CU_TOI_DA_NGAY = 7;

/**
 * ISO 8601 BẮT BUỘC có múi giờ (`Z` hoặc `±HH:MM`) — chuỗi không múi giờ thì `Date.parse` hiểu theo giờ máy, đúng loại
 * lệch 7h mà bất biến múi giờ cấm. Nhóm: ngày · giờ · phút · giây · giờ lệch · phút lệch.
 */
const KHUON_CHUP_LUC =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

export type KetQuaDocChupLuc = { ok: true; chupLuc: Date | undefined } | { ok: false; loi: string };

/**
 * Đọc trường `chupLuc` của thân `/api/ingest/raw` (THUẦN, không đụng DB): vắng mặt ⇒ `undefined` (luật cũ); có mặt thì
 * phải là chuỗi ISO 8601 có múi giờ, đúng lịch (V8 cuộn `2026-02-31` sang tháng 3 và nhận giờ `24` — phải tự soi từng
 * thành phần), nằm trong cửa sổ hợp lý theo đồng hồ app. Cửa sổ theo đồng hồ Postgres soi lại ở `kiemCuaSoChupLuc`.
 */
export function docChupLuc(giaTri: unknown, bayGioMs: number = Date.now()): KetQuaDocChupLuc {
  if (giaTri === undefined) return { ok: true, chupLuc: undefined };
  const sai = (lyDo: string): KetQuaDocChupLuc => ({
    ok: false,
    loi: `chupLuc ${lyDo} — cần ISO 8601 CÓ múi giờ (vd new Date().toISOString()), là lúc BẮT ĐẦU GET trang này`,
  });
  if (typeof giaTri !== "string") return sai("phải là chuỗi");
  const m = KHUON_CHUP_LUC.exec(giaTri);
  if (!m) return sai(`sai khuôn ("${giaTri.slice(0, 40)}")`);
  const [, ngay, gio, phut, giay, gioLech, phutLech] = m;
  if (
    !ngayCoThatTrenLich(ngay) ||
    Number(gio) > 23 ||
    Number(phut) > 59 ||
    Number(giay ?? 0) > 59 ||
    Number(gioLech ?? 0) > 14 ||
    Number(phutLech ?? 0) > 59
  ) {
    return sai(`không phải thời điểm có thật ("${giaTri}")`);
  }
  const ms = Date.parse(giaTri);
  if (!Number.isFinite(ms)) return sai(`không parse được ("${giaTri}")`);
  if (ms > bayGioMs + CHUP_LUC_TUONG_LAI_TOI_DA_PHUT * 60_000) {
    return sai(`ở tương lai quá ${CHUP_LUC_TUONG_LAI_TOI_DA_PHUT}' so đồng hồ app ("${giaTri}")`);
  }
  if (ms < bayGioMs - CHUP_LUC_CU_TOI_DA_NGAY * 86_400_000) {
    return sai(`cũ hơn ${CHUP_LUC_CU_TOI_DA_NGAY} ngày ("${giaTri}")`);
  }
  return { ok: true, chupLuc: new Date(ms) };
}

/**
 * Soi cửa sổ của `chupLuc` theo ĐỒNG HỒ POSTGRES (`clock_timestamp()`) — chính đồng hồ ghi `fetchedAt`/`lanThayCuoi`/
 * `mocChup` lúc thiếu `chupLuc`, tức đồng hồ mà mốc này sẽ bị so cùng. Trả câu lỗi, hoặc `null` khi hợp lệ.
 * Route gọi TRƯỚC khi mở SyncLog (để trả 400), `landRaw` gọi lại cho người gọi khác (script).
 */
export async function kiemCuaSoChupLuc(chupLuc: Date, db: ClientBronze = prisma): Promise<string | null> {
  if (Number.isNaN(chupLuc.getTime())) return "chupLuc không phải thời điểm hợp lệ";
  const [r] = await db.$queryRawUnsafe<{ tuongLai: boolean; quaCu: boolean }[]>(
    `SELECT ($1::timestamptz > clock_timestamp() + interval '${CHUP_LUC_TUONG_LAI_TOI_DA_PHUT} minutes') AS "tuongLai",
            ($1::timestamptz < clock_timestamp() - interval '${CHUP_LUC_CU_TOI_DA_NGAY} days') AS "quaCu"`,
    chupLuc.toISOString(),
  );
  if (r.tuongLai) {
    return `chupLuc ${chupLuc.toISOString()} ở tương lai quá ${CHUP_LUC_TUONG_LAI_TOI_DA_PHUT}' so đồng hồ DB — mốc tương lai ghim bản đó lên đầu khoá trước mọi lượt chụp thật`;
  }
  if (r.quaCu) {
    return `chupLuc ${chupLuc.toISOString()} cũ hơn ${CHUP_LUC_CU_TOI_DA_NGAY} ngày so đồng hồ DB — người gọi tính sai mốc chụp`;
  }
  return null;
}

/**
 * Trang của stream TIỀN (`laStreamTien`) có record thiếu khoá ⇒ cả trang bị từ chối, KHÔNG dòng nào
 * vào Bronze. Lớp lỗi riêng để `/api/ingest/raw` nhận ra và ghi SyncLog ERROR mà vẫn trả HTTP 200
 * (5xx làm n8n thử lại rồi dừng hẳn các trang sau). Người gọi khác (import ví Shopee, script) không bắt
 * riêng ⇒ lỗi nổi lên như mọi lỗi land khác — không đường nào land được một phần trong im lặng.
 */
export class LoiThieuKhoaStreamTien extends Error {
  constructor(
    public readonly stream: BronzeStream,
    public readonly soThieuKhoa: number,
    public readonly tong: number
  ) {
    super(
      `${soThieuKhoa} record thiếu khoá trong trang ${tong} record của stream tiền "${stream}" — TỪ CHỐI cả ` +
        `trang, không land dòng nào: record thiếu khoá không vào được kho thô nên dựng lại cũng không cứu, land ` +
        `phần còn lại là mất tiền mà không ai thấy. Kiểm hợp đồng API của nguồn này; lượt kéo lại sẽ land đủ khi sửa.`
    );
    this.name = "LoiThieuKhoaStreamTien";
  }
}

export type LandResult = {
  /** Số dòng THỰC SỰ ghi vào Bronze (đã trừ bản trùng hash). */
  landed: number;
  /** Số record bị bỏ vì thiếu `id` — route đẩy vào `warnings`, KHÔNG im lặng. */
  skippedNoId: number;
  /**
   * `externalId` của các dòng THỰC SỰ chèn ở lần gọi này (lấy bằng `RETURNING`; dòng trùng hash
   * đi nhánh `DO NOTHING` nên KHÔNG trả về). Transform dùng để chỉ dựng lại đúng entity của TRANG
   * NÀY — không quét lại toàn bảng mỗi trang (import 60 ngày sẽ thành chi phí bậc 2 → n8n timeout).
   * Entity trùng hash không transform lại là ĐÚNG **khi lượt transform trước đã chạy xong** —
   * xem `seenIds` cho ca nó KHÔNG chạy xong.
   */
  landedIds: string[];
  /**
   * MỌI `externalId` nhìn thấy trong trang, kể cả record trùng hash nên không land lại.
   *
   * Đây là đường tự chữa: tiến trình chết giữa "Bronze đã commit" và "Silver ghi xong"
   * thì lượt n8n gửi lại đúng trang đó có `landedIds` RỖNG (nội dung y hệt) ⇒ nếu chỉ nhìn
   * `landedIds` thì transform không có gì để làm, HTTP 200 sạch trơn, còn đơn thì kẹt vĩnh viễn.
   * Người gọi dùng `seenIds` để hỏi lại Bronze xem trong số đó có dòng nào CHƯA đóng dấu kết cục
   * không, và dựng lại đúng những dòng đó.
   */
  seenIds: string[];
  /**
   * `externalId` mà nguồn trả LẠI đúng một nội dung ĐÃ CÓ nhưng KHÔNG đứng đầu (A→B→A: lần A thứ hai trùng hash nên
   * không vào `landedIds`, mà bản đứng đầu đang là B). `landRaw` vừa ghi lần thấy (`mocChup` + `lanThayCuoi`) cho dòng
   * A ⇒ A thành bản đầu; người gọi phải dựng lại ĐÚNG các khoá này (không cả trang). Trang mang `chupLuc` cũ hơn bản đầu
   * (trang trễ của lượt chụp trước), hoặc trang thiếu `chupLuc` trên khoá đã có mốc chụp, KHÔNG ghi ⇒ khoá không vào
   * đây; ghi mốc cho bản ĐANG đứng đầu cũng không (thứ tự không đổi). Chỉ bảng trong `BANG_LAN_THAY`; bảng khác luôn
   * rỗng. Không giao với `landedIds` (khoá vừa có bản mới chèn thì không ghi lần thấy cho bản cũ).
   */
  reseenIds: string[];
  /**
   * Số khoá mà trang KHÔNG kèm `chupLuc` thật sự bị chặn vượt bản đầu — chỉ đếm khoá ĐÃ có dòng mang `mocChup`: lần thấy
   * lại bản không đứng đầu bị bỏ, hoặc bản mới chèn ngay DƯỚI bản đầu (`mocChupKhiThieuChupLuc`). Nguồn đang báo nội
   * dung khác bản đầu mà kho thô giữ bản đầu cũ ⇒ Silver (sản phẩm/giá vốn, chi phí ads) đứng ở bản cũ tới lượt có
   * `chupLuc`. Route báo ĐỎ khi > 0. Trang có `chupLuc`, khoá thuần di sản, bảng ngoài `BANG_LAN_THAY` ⇒ luôn 0.
   */
  soKhoaKetDuoiDau: number;
};

/**
 * Land raw NGUYÊN BẢN vào Bronze.
 *
 * BẤT BIẾN: JS TUYỆT ĐỐI KHÔNG `JSON.parse` payload. Pancake trả int64 vượt
 * Number.MAX_SAFE_INTEGER (vd inventory_histories.id = 461168615117802872) →
 * JS parse làm tròn thành …900, hỏng khoá. Nên:
 *   - `responseText` đi thẳng vào Postgres dưới dạng TEXT,
 *   - Postgres cast `::jsonb` (jsonb lưu số dạng numeric → không mất chính xác),
 *   - `jsonb_array_elements` bung mảng, `elem->>'id'` rút khoá dạng TEXT,
 *   - `md5(elem::text)` băm trên jsonb ĐÃ CHUẨN HOÁ (key sort) → hash ổn định.
 *
 * Dedupe bằng ON CONFLICT trên @@unique([shopId, externalId, payloadHash]):
 * nội dung không đổi → không ghi; nội dung đổi → ghi bản mới (giữ lịch sử).
 * Append-only cho NỘI DUNG: không sửa payload/hash/fetchedAt, không DELETE. Ngoại lệ duy nhất là hai cột
 * metadata `lanThayCuoi` + `mocChup` của bảng `BANG_LAN_THAY` (câu thứ hai, xem `ghiLanThayLai`).
 *
 * Mảng record nằm ở đâu trong envelope là TUỲ NHÀ CUNG CẤP (`arrayPath` trong registry):
 * Pancake `{success, data:[…]}`; TikTok Shop `{code, message, data:{statements:[…]}}`. Đường dẫn
 * đi vào SQL qua toán tử `#>` với THAM SỐ text[] (không nội suy chuỗi), và giá trị luôn lấy từ
 * registry hằng số — client KHÔNG được chọn đường dẫn.
 *
 * GUARD trước INSERT: khi envelope KHÔNG có mảng ở đúng đường dẫn (vd Pancake trả lỗi
 * `{"success":false,"message":"..."}` do hết hạn key / rate-limit, hay TikTok trả `code != 0`),
 * Postgres coi `(…) #> path` là NULL → `jsonb_array_elements(NULL)` cho 0 dòng và KHÔNG throw
 * ⇒ landRaw sẽ trả {landed:0} = THÀNH CÔNG GIẢ, cả một trang dữ liệu biến mất
 * không một tiếng động. Nên phải kiểm `jsonb_typeof` và throw, nêu rõ đường dẫn nào không phải mảng.
 */
export async function landRaw(
  stream: BronzeStream,
  shopId: string,
  responseText: string,
  syncLogId?: string,
  db: ClientBronze = prisma,
  /**
   * Danh sách shop id ĐÃ resolve cho whitelist của stream. Khi `db` là TransactionClient (đường
   * `orders` giữ khoá tư vấn) người gọi PHẢI resolve TRƯỚC khi mở transaction rồi truyền vào —
   * để bước land không tự query bảng `Setting` bằng kết nối THỨ HAI trong lúc transaction đang
   * giữ khoá (pool cạn là mọi đường ingest cùng nghẽn). Bỏ trống ⇒ tự resolve (cache 60s).
   */
  shopIdsHopLe?: readonly string[],
  /**
   * "YYYY-MM-DD" (giờ VN, người gọi tính sẵn) — CHỈ stream khai `chapNhanNgay`. Gắn vào record
   * TRƯỚC khi rút khoá và trước khi băm ⇒ ngày nằm TRONG `externalId` VÀ TRONG `payloadHash`.
   */
  ngay?: string,
  /**
   * Mốc nguồn CHỤP trang (lúc người gọi BẮT ĐẦU GET trang này) — CHỈ có tác dụng với bảng `BANG_LAN_THAY` (bảng khác
   * bỏ qua, để n8n gửi đồng loạt mà không cần biết bảng nào). Ghi vào `mocChup` khi chèn / thấy lại (cả bản đang đứng
   * đầu), và lần thấy lại chỉ được đưa bản cũ lên đầu khi `chupLuc` ≥ mốc phiên bản của bản đang đứng đầu. Bỏ trống ⇒
   * khoá đã có mốc chụp thì trang này không vượt được bản đầu; khoá thuần di sản thì mốc = lúc land (luật cũ).
   */
  chupLuc?: Date
): Promise<LandResult> {
  if (!isBronzeStream(stream)) throw new Error(`Stream không hợp lệ: ${stream}`);
  // `table` + `arrayPath` + `idExpr` là hằng số trong code (registry), KHÔNG lấy từ input.
  const { table, arrayPath, shops, idExpr, chapNhanNgay, laStreamTien } = BRONZE_STREAMS[stream];
  const coLanThay = BANG_LAN_THAY.has(table);
  // Mốc chụp chỉ sống ở bảng có cột lần thấy. Soi cửa sổ theo đồng hồ DB TRƯỚC mọi câu ghi: mốc tương lai nằm trong
  // `mocChup` là ghim bản đó lên đầu khoá trước mọi lượt chụp thật về sau.
  if (coLanThay && chupLuc !== undefined) {
    const loi = await kiemCuaSoChupLuc(chupLuc, db);
    if (loi !== null) throw new Error(`Stream "${stream}": ${loi}. Không land trang này.`);
  }
  const chupLucIso = coLanThay && chupLuc !== undefined ? chupLuc.toISOString() : null;

  // `ngay` — CỘNG THÊM cho stream mà record không mang trường ngày (analytics products/videos).
  // Kiểm Ở ĐÂY chứ không chỉ ở route: webhook và script cũng gọi landRaw, và một lần land nhầm
  // khoá là nằm VĨNH VIỄN trong Bronze (append-only) — sửa được thì đã không cần guard.
  if (ngay !== undefined) {
    if (!chapNhanNgay) {
      throw new Error(
        `Stream "${stream}" không nhận 'ngay' — chỉ stream khai chapNhanNgay mới được bơm ngày vào khoá. ` +
          `Thêm 'ngay' cho stream đang chạy là ĐỔI khoá/hash của mọi dòng đã land.`
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ngay)) {
      throw new Error(`'ngay' phải đúng khuôn YYYY-MM-DD (nhận "${ngay}") — giờ VN, tính sẵn ở người gọi.`);
    }
    if (!ngayCoThatTrenLich(ngay)) {
      throw new Error(
        `'ngay' = "${ngay}" không phải ngày có thật trên lịch — khuôn YYYY-MM-DD vẫn cho lọt 2026-02-31 / ` +
          `2026-13-45, mà '_ngay' là TEXT nên Postgres không cãi. Ngày bịa vào khoá là nằm vĩnh viễn (Bronze append-only).`
      );
    }
    // CỬA SỔ HỢP LÝ. Ngày có thật trên lịch vẫn có thể vô nghĩa: `2126-08-19` và `1970-01-01` đi qua
    // cả regex khuôn LẪN phép kiểm lịch. Bronze append-only ⇒ một điểm MA nằm vĩnh viễn giữa chuỗi
    // ngày, và reader gom theo `_ngay` sẽ vẽ nó ra mà không một dòng log nào đỏ.
    const canTren = ngayMaiGioVn();
    if (ngay < NGAY_SOM_NHAT || ngay > canTren) {
      throw new Error(
        `'ngay' = "${ngay}" nằm ngoài cửa sổ hợp lý [${NGAY_SOM_NHAT} … ${canTren}] (cận trên = ngày mai giờ VN) — ` +
          `nhiều khả năng người gọi tính sai ngày. Bronze append-only: điểm ma trong chuỗi ngày là nằm vĩnh viễn.`
      );
    }
    // Cờ `chapNhanNgay` chỉ merge `_ngay` vào PAYLOAD (đủ để hash khác nhau) — KHOÁ vẫn do `idExpr`
    // quyết. Khai cờ mà quên nhét `_ngay` vào `idExpr` thì mỗi ngày vẫn land đủ dòng (hash khác) mà
    // `externalId` TRÙNG NHAU qua mọi ngày ⇒ reader kiểu `latestPayloads`
    // (`DISTINCT ON (shopId, externalId)`) sập cả chuỗi ngày về ĐÚNG MỘT điểm — không một dòng log
    // nào đỏ. Nổ ngay tại cửa land, trước khi có dòng nào nằm vĩnh viễn trong Bronze.
    if (idExpr === undefined || !idExpr.includes("_ngay")) {
      throw new Error(
        `Stream "${stream}" khai chapNhanNgay nhưng idExpr (${idExpr ?? "mặc định elem->>'id'"}) KHÔNG chứa ` +
          `'_ngay' ⇒ khoá giống hệt nhau ở mọi ngày, chuỗi ngày sập về 1 điểm khi đọc bằng DISTINCT ON. ` +
          `Sửa registry: idExpr phải ghép \`(elem->>'_ngay')\`.`
      );
    }
  } else if (chapNhanNgay) {
    throw new Error(
      `Stream "${stream}" khai chapNhanNgay nhưng thiếu 'ngay'. Record của endpoint này là TỔNG cả cửa sổ ` +
        `và KHÔNG có trường ngày ⇒ không có 'ngay' thì mọi lượt kéo đè lên nhau, chuỗi ngày biến mất lặng lẽ.`
    );
  }

  // shopId PHẢI thuộc whitelist của chính stream đó (vai trong registry → id thật từ cấu hình
  // `Setting`). Có HAI hệ đánh số shop (Pancake vs TikTok Shop Open API) và tên gọi trùng nhau
  // ("TikTok") → điền nhầm CONFIG.shopId trong n8n là chuyện dễ xảy ra. Bronze là append-only:
  // một lần backfill nhầm shopId sẽ nằm vĩnh viễn trên DB prod, không báo lỗi, SyncLog vẫn OK,
  // mọi đối soát join theo shopId sau này lệch. Chặn NGAY tại cửa.
  //
  // `shops: null` = stream có danh sách MỞ (advertiser/bc do chủ shop tự tạo) → không whitelist được;
  // KHÔNG để "không rỗng" là guard duy nhất mà ép SHAPE theo tên stream (xem OPEN_SHOP_SHAPE).
  if (shops !== null) {
    const hopLe = shopIdsHopLe ?? (await shopIdsChoVai(shops));
    if (!hopLe.includes(shopId)) {
      throw new Error(
        `shopId "${shopId}" không hợp lệ cho stream "${stream}" (chỉ nhận: ${hopLe.join(", ")}) — ` +
          `kiểm tra CONFIG.shopId trong n8n / shop ID ở /cai-dat: id shop Pancake KHÁC id shop TikTok Shop Open API.`
      );
    }
  } else {
    if (!shopId.trim()) {
      throw new Error(`shopId rỗng cho stream "${stream}" — cần advertiser_id/bc_id để biết chi tiêu của tài khoản nào.`);
    }
    const shape = OPEN_SHOP_SHAPE[stream];
    if (shape && !shape.re.test(shopId)) {
      throw new Error(
        `shopId "${shopId}" sai định dạng cho stream "${stream}" — cần ${shape.moTa}. ` +
          `Bronze append-only: id sai kiểu (vd nhầm act_... của Meta với id số TikTok) land là nằm vĩnh viễn.`
      );
    }
  }

  // Khoá của record. Mặc định `elem->>'id'`; stream nào API không trả `id` thì tự khai (báo cáo ads).
  const khoa = idExpr ?? `elem->>'id'`;
  const path = [...arrayPath];
  const shownPath = arrayPath.join(".");

  // Gắn `_ngay` vào record NGAY KHI bung mảng — trước `${khoa}` và trước `md5(elem::text)` — nên
  // ngày nằm trong CẢ khoá lẫn hash, và phần SQL bên dưới không phải biết gì về `ngay`.
  // Tham số BIND ($3/$5), TUYỆT ĐỐI không nội suy chuỗi: `jsonb_build_object` nhận GIÁ TRỊ.
  // Nhánh KHÔNG có `ngay` giữ NGUYÊN VĂN câu SQL cũ (không bọc subselect, không thêm tham số) —
  // cách rẻ nhất để bảo đảm khoá/hash của mọi stream đang chạy không đổi một bit.
  const chieuElemMeta = ngay === undefined ? `elem` : `elem || jsonb_build_object('_ngay', $3::text) AS elem`;
  const thamSoMeta: unknown[] = ngay === undefined ? [responseText, path] : [responseText, path, ngay];
  const tuElemInsert =
    ngay === undefined
      ? `jsonb_array_elements(($1::jsonb) #> $4::text[]) AS elem`
      : `(
      SELECT elem || jsonb_build_object('_ngay', $5::text) AS elem
      FROM jsonb_array_elements(($1::jsonb) #> $4::text[]) AS elem
    ) AS e`;
  const thamSoInsert: unknown[] =
    ngay === undefined
      ? [responseText, shopId, syncLogId ?? null, path]
      : [responseText, shopId, syncLogId ?? null, path, ngay];

  // KHÔNG IM LẶNG. MỘT query (parse payload 1 LẦN nhờ CTE MATERIALIZED, thay vì cast ::jsonb 3 lần)
  // làm CẢ HAI việc TRƯỚC insert:
  //   - `kind`: envelope có mảng ở đúng đường dẫn không? Thiếu → kêu to, không land trang rỗng giả.
  //   - `total`/`withId`: đếm record và record rút được khoá, để bắt lỗi "mảng có dữ liệu mà rút
  //     được 0 khoá" (nhà cung cấp đổi tên field khoá) — throw TRƯỚC insert, không trả landed:0 êm ru.
  // CASE ... '[]' để khi KHÔNG phải mảng thì jsonb_array_elements không ném lỗi Postgres thô; JS kiểm
  // `kind` ngay sau đó rồi mới quyết định (giữ đúng thông báo lỗi guard cũ).
  const [meta] = await db.$queryRawUnsafe<
    { kind: string | null; total: bigint; withId: bigint; seenIds: string[] | null }[]
  >(
    `
    WITH src AS MATERIALIZED (SELECT ($1::jsonb) #> $2::text[] AS arr),
    elems AS (
      SELECT ${chieuElemMeta}
      FROM src, jsonb_array_elements(
        CASE WHEN jsonb_typeof(src.arr) = 'array' THEN src.arr ELSE '[]'::jsonb END
      ) AS elem
    )
    SELECT
      (SELECT jsonb_typeof(arr) FROM src) AS kind,
      (SELECT count(*) FROM elems) AS total,
      (SELECT count(${khoa}) FROM elems) AS "withId",
      -- MỌI khoá nhìn thấy trong trang, kể cả record KHÔNG land vì trùng payloadHash. Đây là thứ
      -- làm lượt gửi lại tự chữa được sau một cú chết giữa chừng: landedIds khi đó RỖNG (nội dung
      -- y hệt nên không land lại), nên nếu chỉ có nó thì transform không có gì để làm và trang đó
      -- im lặng trả 200 trong khi đơn vẫn kẹt ở Bronze. Đọc lại CHÍNH CTE elems đã bung sẵn ở
      -- trên — payload chỉ cast ::jsonb một lần, đo thật trên prod: +0,2 ms cho trang 100 đơn.
      (SELECT array_agg(DISTINCT ${khoa}) FROM elems WHERE ${khoa} IS NOT NULL) AS "seenIds"
    `,
    ...thamSoMeta
  );

  if (meta.kind !== "array") {
    throw new Error(
      `Envelope stream "${stream}" không có mảng tại '${shownPath}' (jsonb_typeof=${meta.kind ?? "null"}) — ` +
        `nhiều khả năng API trả lỗi (hết hạn key / token / rate-limit). Không land trang này.`
    );
  }

  const total = Number(meta.total);
  const withId = Number(meta.withId);

  // Mảng CÓ record nhưng rút được 0 khoá = hợp đồng API đã trôi (nhà cung cấp đổi tên field khoá:
  // campaign_id / date_start / transaction_id…). Guard `jsonb_typeof` KHÔNG bắt (mảng vẫn là mảng) và
  // WHERE ... IS NOT NULL bên dưới sẽ loại HẾT ⇒ landed:0, HTTP 200, SyncLog OK = mất cả trang trong
  // im lặng. Phải THROW, không land trang này.
  if (total > 0 && withId === 0) {
    throw new Error(
      `Stream "${stream}": mảng có ${total} record nhưng rút được 0 khoá (idExpr: ${khoa}) — ` +
        `hợp đồng API đã trôi (nhiều khả năng nhà cung cấp đổi tên field khoá). Không land trang này.`
    );
  }

  // Stream TIỀN có MỘT PHẦN record thiếu khoá: từ chối cả trang TRƯỚC insert (xem `laStreamTien`).
  // Stream khác giữ hành vi land phần còn lại + đếm `skippedNoId` (route đẩy vào warnings/stats).
  if (laStreamTien && withId < total) {
    throw new LoiThieuKhoaStreamTien(stream, total - withId, total);
  }

  // Bảng có cột lần thấy: thêm `mocChup` = mốc chụp của trang. Bản MỚI mà chụp CŨ hơn bản đang đứng đầu (trang trễ của
  // lượt chụp trước) tự đứng sau. Thiếu `chupLuc` thì tuỳ khoá (`mocChupKhiThieuChupLuc`). Bảng khác giữ NGUYÊN VĂN câu cũ.
  const cotMocChup = coLanThay ? `, "mocChup"` : "";
  let giaTriMocChup = "";
  if (coLanThay) {
    // Chỉ đẩy tham số khi câu dùng nó: tham số không được tham chiếu thì Postgres không suy được kiểu.
    if (chupLucIso === null) {
      giaTriMocChup = `, ${mocChupKhiThieuChupLuc(table, khoa)}`;
    } else {
      thamSoInsert.push(chupLucIso);
      giaTriMocChup = `, $${thamSoInsert.length}::timestamptz`;
    }
  }

  // Trang thiếu `chupLuc` của bảng lần thấy: dòng chèn mang `mocChup` khác NULL CHỈ khi khoá đã có mốc chụp (mảnh
  // `mocChupKhiThieuChupLuc` trả NULL cho khoá thuần di sản) ⇒ chính là bản mới bị đặt dưới bản đầu.
  const traDuoiDau = coLanThay && chupLucIso === null ? `, ("mocChup" IS NOT NULL) AS "duoiDau"` : "";
  const inserted = await db.$queryRawUnsafe<{ externalId: string; duoiDau?: boolean }[]>(
    `
    INSERT INTO "${table}" ("id", "shopId", "externalId", "payloadHash", "payload", "fetchedAt", "syncLogId"${cotMocChup})
    -- clock_timestamp() chứ KHÔNG phải now(): now() trả mốc MỞ transaction. Từ khi bước land nằm
    -- trong transaction có khoá tư vấn (khoa-land-don.ts), lượt phải XẾP HÀNG chờ khoá vẫn mang mốc
    -- BEGIN của nó — tức mốc TRƯỚC lượt đang giữ khoá — nên nó land SAU mà fetchedAt lại CŨ HƠN.
    -- Transform chọn bản fetchedAt mới nhất ⇒ khoá tuần tự hoá xong vẫn chọn nhầm bản cũ, đúng
    -- thứ mà khoá sinh ra để chặn. clock_timestamp() đọc đồng hồ NGAY LÚC INSERT nên phản ánh đúng
    -- thứ tự land mà khoá vừa thiết lập.
    SELECT gen_random_uuid()::text, $2, ${khoa}, md5(elem::text), elem, clock_timestamp(), $3${giaTriMocChup}
    FROM ${tuElemInsert}
    WHERE ${khoa} IS NOT NULL   -- không có khoá thì không dedupe được (cần externalId)
    ON CONFLICT ("shopId", "externalId", "payloadHash") DO NOTHING
    RETURNING "externalId"${traDuoiDau}
    `,
    ...thamSoInsert
  );
  const landedIds = [...new Set(inserted.map((r) => r.externalId))];

  const lanThay = coLanThay
    ? await ghiLanThayLai(db, table, khoa, responseText, shopId, landedIds, path, ngay, chupLucIso)
    : { reseenIds: [], chanIds: [] };
  const reseenIds = lanThay.reseenIds;
  // Hai tập không giao nhau (`ghiLanThayLai` bỏ khoá vừa chèn) — vẫn gộp qua Set cho chắc nghĩa "số KHOÁ".
  const soKhoaKetDuoiDau = new Set([
    ...inserted.filter((r) => r.duoiDau === true).map((r) => r.externalId),
    ...lanThay.chanIds,
  ]).size;

  // Record thiếu khoá (nhưng KHÔNG phải cả trang — trường hợp đó đã throw ở trên) bị mệnh đề WHERE
  // bỏ qua: báo qua `skippedNoId` để route đẩy vào warnings, không nuốt lặng. Số đã đếm ở query gộp.
  const skippedNoId = total - withId;

  return {
    landed: inserted.length,
    skippedNoId,
    landedIds,
    seenIds: meta.seenIds ?? [],
    reseenIds,
    soKhoaKetDuoiDau,
  };
}

/**
 * `mocChup` của bản MỚI chèn từ trang KHÔNG kèm `chupLuc` (mảnh SQL trong câu INSERT, `$2` = shopId, `elem` = phần tử
 * trang). Không biết nguồn chụp lúc nào, chỉ biết lúc land — mà lúc land luôn muộn hơn lúc GET thật, nên lấy nó làm mốc
 * là cho trang thiếu mốc vượt mọi bản chụp trước nó (kể cả bản chụp SAU nó nhưng POST trước).
 *
 *  - Khoá ĐÃ có dòng mang `mocChup` (đã có lượt chụp chứng minh mốc): đặt ngay dưới bản đang đứng đầu = mốc phiên bản
 *    lớn nhất của khoá (`mocLanThayCua`) trừ 1 ms ⇒ bản mới KHÔNG lên đầu, tất định (nhỏ hơn hẳn, không trông vào
 *    `id`). Lượt có `chupLuc` kế sau thấy lại nó thì đưa nó lên đầu như mọi bản không đứng đầu — CHỈ khi có lượt đó:
 *    workflow bị lùi / cài dở thì không có, và khoá ra khỏi cửa sổ kéo (ads 7 ngày) là kẹt hẳn. Vì vậy khoá rơi nhánh
 *    này được đếm vào `soKhoaKetDuoiDau` để route báo ĐỎ.
 *  - Khoá thuần di sản (không dòng nào mang `mocChup` — trước khi cài workflow gửi `chupLuc`): NULL ⇒ mốc = `fetchedAt`
 *    = lúc land, luật cũ (bản mới lên đầu). Giai đoạn chuyển tiếp: app chạy trước, workflow nhập sau — không đứng hình.
 *
 * Trang mang ≥ 2 nội dung mới khác nhau cho cùng một khoá: cùng mốc, `id` quyết thứ tự giữa CHÚNG — đều dưới bản đầu.
 */
function mocChupKhiThieuChupLuc(table: string, khoa: string): string {
  return `(
      SELECT max(${mocLanThayCua("o")}) - interval '1 millisecond'
      FROM "${table}" o
      WHERE o."shopId" = $2 AND o."externalId" = ${khoa}
      HAVING bool_or(o."mocChup" IS NOT NULL)
    )`;
}

/**
 * Câu THỨ HAI (sau INSERT … DO NOTHING) cho bảng `BANG_LAN_THAY`: ghi LẦN THẤY (`lanThayCuoi` = lúc land, `mocChup` =
 * `GREATEST(mocChup, chupLuc)`) cho dòng mà trang TRÙNG hash. Hai loại dòng được ghi:
 *
 *  1. Bản KHÔNG đứng đầu (A→B→A) ⇒ ghi xong nó thành bản đầu; khoá trả về để người gọi dựng lại đúng các khoá đó.
 *     - CÓ `chupLuc`: chỉ khi không phiên bản nào của khoá mang mốc MỚI HƠN `chupLuc` (tức `chupLuc` ≥ mốc bản đầu).
 *       Trang của lượt chụp TRƯỚC về TRỄ (hai lượt chồng nhau — "Đồng bộ ngay" đè lượt đêm) mang bản cũ B trong khi bản
 *       chụp SAU C đã đứng đầu ⇒ bỏ qua, C giữ đầu. So mốc CHỤP chứ không phải mốc LAND: mốc land của trang trễ luôn mới
 *       nhất nên không phân biệt được.
 *     - THIẾU `chupLuc` (script, workflow chưa cài lại): khoá đã có dòng mang `mocChup` ⇒ KHÔNG ghi — lúc land luôn muộn
 *       hơn lúc GET thật, ghi thì trang thiếu mốc vượt cả bản chụp SAU nó; bản đó lên đầu ở lượt có `chupLuc` kế tiếp.
 *       Khoá thuần di sản (không dòng nào mang `mocChup`) ⇒ luật cũ: chỉ ghi `lanThayCuoi` (`mocChup` giữ NULL, khoá vẫn
 *       là di sản), mốc = `COALESCE(NULL, lanThayCuoi, …)` = lúc land ⇒ lên đầu.
 *  2. Bản ĐANG đứng đầu, CHỈ khi có `chupLuc` mới hơn hẳn mốc phiên bản của nó ⇒ đẩy mốc bản đầu lên lần chụp mới nhất.
 *     Thiếu bước này thì nguồn đổi C (chụp T1) → B (T2) → C (T3) với trang B về trễ: C thấy lại ở T3 mà mốc vẫn T1 ⇒ B
 *     (T2 > T1) lên đầu dù nguồn đang ở C. Thứ tự không đổi (mốc bản đầu chỉ tăng) ⇒ khoá KHÔNG vào danh sách trả về.
 *     Lượt đêm thường ghi lại gần như mọi bản đầu của trang (mỗi đêm một lần chụp mới) — chi phí đã đo ở docs §4a.
 *
 *  - "Đứng đầu" so bằng ĐÚNG mốc phiên bản chung (`mocLanThayCua`, rồi `id`) trên ảnh TRƯỚC câu ghi (CTE đọc cùng
 *    snapshot với câu UPDATE).
 *  - MỖI KHOÁ MỘT ỨNG VIÊN: phần tử ĐỨNG SAU CÙNG của khoá đó trong trang (thứ tự mảng nguồn trả). Trang mang ≥ 2 phiên
 *    bản ĐÃ CÓ của cùng khoá mà ghi lần thấy cho tất cả thì `clock_timestamp()` từng dòng quyết bản đầu theo thứ tự
 *    Postgres tình cờ cập nhật — đầu bảng đổi qua đổi lại mỗi lượt. Chọn theo thứ tự trong trang thì xác định.
 *  - Bỏ khoá vừa có bản MỚI chèn (`landedIds`): bản mới tự xếp theo mốc của nó; trang lẫn cả bản cũ lẫn bản mới cùng
 *    khoá thì không có nghĩa "cũ/mới" để chọn khác.
 *  - Trang có hai phần tử GIỐNG HỆT ⇒ một ứng viên; UPDATE … FROM nối theo `id` nên không dòng nào bị đụng hai lần
 *    (không có lỗi cardinality 21000 như ON CONFLICT DO UPDATE).
 *  - `GREATEST`: hai lượt cùng ghi MỘT dòng (đã qua phép so trước khi lượt kia commit) thì mốc không lùi; `GREATEST` bỏ
 *    qua NULL nên thiếu `chupLuc` giữ nguyên `mocChup`.
 *  - `clock_timestamp()` cùng lý do với cột `fetchedAt` ở câu INSERT (mốc lúc ghi, không phải lúc mở transaction).
 *  - Payload/hash/`fetchedAt` không bị chạm — `landedIds` giữ nguyên nghĩa "dòng THỰC SỰ chèn".
 *
 * Trả `reseenIds` (khoá vừa đổi bản đầu) và `chanIds`: khoá mà trang THIẾU `chupLuc` mang bản không đứng đầu nhưng bị
 * chặn ghi vì khoá đã có mốc chụp (nhánh 1, vế thiếu `chupLuc`) — cùng CTE `ung_vien` nên cùng ảnh chụp với câu ghi; có
 * `chupLuc` thì luôn rỗng (trang trễ bị bỏ là đúng luật, không phải dữ liệu kẹt).
 *
 * Kịch bản ghim ở `tests/bronze/land-raw-trang-cu-den-muon.test.ts`.
 *
 * Tham số: $1 text thô · $2 shopId · $3 landedIds · $4 path · [$5 ngay] · chupLuc (ISO hoặc NULL, vị trí cuối) — cùng
 * vị trí $1/$4/$5 với câu INSERT; nguồn phần tử dựng lại Y HỆT câu INSERT (cùng gắn `_ngay`) để khoá + hash trùng từng
 * byte, chỉ thêm số thứ tự.
 */
async function ghiLanThayLai(
  db: ClientBronze,
  table: string,
  khoa: string,
  responseText: string,
  shopId: string,
  landedIds: string[],
  path: string[],
  ngay: string | undefined,
  chupLucIso: string | null,
): Promise<{ reseenIds: string[]; chanIds: string[] }> {
  const nguonCoThuTu =
    ngay === undefined
      ? `jsonb_array_elements(($1::jsonb) #> $4::text[]) WITH ORDINALITY AS x(elem, thu_tu)`
      : `(
      SELECT x.elem || jsonb_build_object('_ngay', $5::text) AS elem, x.thu_tu
      FROM jsonb_array_elements(($1::jsonb) #> $4::text[]) WITH ORDINALITY AS x(elem, thu_tu)
    ) AS e`;
  const thamSo: unknown[] =
    ngay === undefined ? [responseText, shopId, landedIds, path] : [responseText, shopId, landedIds, path, ngay];
  thamSo.push(chupLucIso);
  // Mốc chụp của trang, ép kiểu tường minh (NULL trần không suy được kiểu tham số).
  const chup = `$${thamSo.length}::timestamptz`;
  // Hai nhánh câu khác nhau theo việc có mốc chụp hay không (JS chọn — mỗi trang chỉ chạy đúng một nhánh).
  const dieuKienGhi =
    chupLucIso === null
      ? `-- Thiếu mốc chụp: chỉ bản không đứng đầu của khoá thuần di sản (không dòng nào mang mocChup).
        u.khong_dau AND NOT EXISTS (
          SELECT 1 FROM "${table}" d
          WHERE d."shopId" = u."shopId" AND d."externalId" = u."externalId" AND d."mocChup" IS NOT NULL
        )`
      : `-- Bản không đứng đầu: không phiên bản nào của khoá mang mốc MỚI HƠN lần chụp này (trang trễ rơi ở đây).
        (u.khong_dau AND NOT EXISTS (
          SELECT 1 FROM "${table}" d
          WHERE d."shopId" = u."shopId" AND d."externalId" = u."externalId"
            AND ${mocLanThayCua("d")} > ${chup}
        ))
        -- Bản đứng đầu: lần chụp mới hơn hẳn mốc của nó ⇒ đẩy mốc lên (thứ tự không đổi).
        OR (NOT u.khong_dau AND ${chup} > u.moc)`;
  // Phần bù của vế thiếu mốc chụp: bản không đứng đầu của khoá ĐÃ có mốc chụp ⇒ nguồn đang báo nội dung khác bản đầu
  // mà trang này không được đưa nó lên — dữ liệu kẹt dưới bản đầu. Có mốc chụp thì không đếm gì.
  const dieuKienChan =
    chupLucIso === null
      ? `u.khong_dau AND EXISTS (
          SELECT 1 FROM "${table}" d
          WHERE d."shopId" = u."shopId" AND d."externalId" = u."externalId" AND d."mocChup" IS NOT NULL
        )`
      : `false`;
  const rows = await db.$queryRawUnsafe<{ externalId: string; lenDau: boolean; biChan: boolean }[]>(
    `
    WITH trang AS (
      SELECT DISTINCT ON (p.k) p.k, p.h
      FROM (
        SELECT ${khoa} AS k, md5(elem::text) AS h, thu_tu
        FROM ${nguonCoThuTu}
        WHERE ${khoa} IS NOT NULL
      ) p
      ORDER BY p.k, p.thu_tu DESC
    ),
    ung_vien AS (
      SELECT r."id", r."shopId", r."externalId", ${mocLanThayCua("r")} AS moc,
        EXISTS (
          SELECT 1 FROM "${table}" o
          WHERE o."shopId" = r."shopId" AND o."externalId" = r."externalId" AND o."id" <> r."id"
            AND (${mocLanThayCua("o")}, o."id") > (${mocLanThayCua("r")}, r."id")
        ) AS khong_dau
      FROM trang
      JOIN "${table}" r ON r."shopId" = $2 AND r."externalId" = trang.k AND r."payloadHash" = trang.h
      WHERE NOT (trang.k = ANY($3::text[]))
    ),
    thay_lai AS (
      SELECT u."id", u.khong_dau AS len_dau
      FROM ung_vien u
      WHERE ${dieuKienGhi}
    ),
    -- Đọc đồng hồ MỘT lần cho cả câu.
    bay_gio AS (SELECT clock_timestamp() AS luc),
    ghi AS (
      UPDATE "${table}" t
      SET "mocChup" = GREATEST(t."mocChup", ${chup}),
          "lanThayCuoi" = bay_gio.luc
      FROM thay_lai, bay_gio
      WHERE t."id" = thay_lai."id"
      RETURNING t."externalId", thay_lai.len_dau AS "lenDau"
    )
    SELECT "externalId", "lenDau", false AS "biChan" FROM ghi
    UNION ALL
    -- Khoá bị chặn: đọc lại ung_vien (cùng ảnh chụp với câu ghi), không chạm dòng nào.
    SELECT u."externalId", false, true FROM ung_vien u WHERE ${dieuKienChan}
    `,
    ...thamSo,
  );
  // Chỉ khoá vừa đổi bản đầu; ghi mốc cho bản đang đứng đầu không đổi thứ tự nên không cần dựng lại.
  return {
    reseenIds: [...new Set(rows.filter((r) => r.lenDau).map((r) => r.externalId))],
    chanIds: [...new Set(rows.filter((r) => r.biChan).map((r) => r.externalId))],
  };
}
