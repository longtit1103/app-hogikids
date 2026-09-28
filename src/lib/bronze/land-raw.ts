import type { Prisma, PrismaClient } from "@prisma/client";

import { shopIdsChoVai } from "@/lib/ket-noi/cau-hinh-shop";
import { prisma } from "@/lib/prisma";

import { BRONZE_STREAMS, isBronzeStream, type BronzeStream } from "./streams";

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
 *   - `tiktokbusiness/invoice`: bc_id Business Center (chuỗi số ≥6 chữ số).
 * Không phân biệt được bc_id với advertiser_id (đều là chuỗi số) — nhưng chặn được id SAI KIỂU (vd
 * `act_...` của Meta lọt vào stream TikTok, hoặc chuỗi rác) TRƯỚC khi nó nằm vĩnh viễn trong Bronze
 * (append-only, không sửa được) làm mọi đối soát join theo shopId về sau lệch.
 */
const OPEN_SHOP_SHAPE: Partial<Record<BronzeStream, { re: RegExp; moTa: string }>> = {
  "meta/report": { re: /^act_\d+$/, moTa: "ad account Meta dạng 'act_<số>'" },
  "tiktokbusiness/report": { re: /^\d{6,}$/, moTa: "advertiser_id TikTok Business (chuỗi ≥6 chữ số)" },
  "tiktokbusiness/invoice": { re: /^\d{6,}$/, moTa: "bc_id Business Center (chuỗi ≥6 chữ số)" },
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
 * Append-only: không UPDATE, không DELETE.
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
  ngay?: string
): Promise<LandResult> {
  if (!isBronzeStream(stream)) throw new Error(`Stream không hợp lệ: ${stream}`);
  // `table` + `arrayPath` + `idExpr` là hằng số trong code (registry), KHÔNG lấy từ input.
  const { table, arrayPath, shops, idExpr, chapNhanNgay } = BRONZE_STREAMS[stream];

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

  const inserted = await db.$queryRawUnsafe<{ externalId: string }[]>(
    `
    INSERT INTO "${table}" ("id", "shopId", "externalId", "payloadHash", "payload", "fetchedAt", "syncLogId")
    -- clock_timestamp() chứ KHÔNG phải now(): now() trả mốc MỞ transaction. Từ khi bước land nằm
    -- trong transaction có khoá tư vấn (khoa-land-don.ts), lượt phải XẾP HÀNG chờ khoá vẫn mang mốc
    -- BEGIN của nó — tức mốc TRƯỚC lượt đang giữ khoá — nên nó land SAU mà fetchedAt lại CŨ HƠN.
    -- Transform chọn bản fetchedAt mới nhất ⇒ khoá tuần tự hoá xong vẫn chọn nhầm bản cũ, đúng
    -- thứ mà khoá sinh ra để chặn. clock_timestamp() đọc đồng hồ NGAY LÚC INSERT nên phản ánh đúng
    -- thứ tự land mà khoá vừa thiết lập.
    SELECT gen_random_uuid()::text, $2, ${khoa}, md5(elem::text), elem, clock_timestamp(), $3
    FROM ${tuElemInsert}
    WHERE ${khoa} IS NOT NULL   -- không có khoá thì không dedupe được (cần externalId)
    ON CONFLICT ("shopId", "externalId", "payloadHash") DO NOTHING
    RETURNING "externalId"
    `,
    ...thamSoInsert
  );
  const landedIds = [...new Set(inserted.map((r) => r.externalId))];

  // Record thiếu khoá (nhưng KHÔNG phải cả trang — trường hợp đó đã throw ở trên) bị mệnh đề WHERE
  // bỏ qua: báo qua `skippedNoId` để route đẩy vào warnings, không nuốt lặng. Số đã đếm ở query gộp.
  const skippedNoId = total - withId;

  return { landed: inserted.length, skippedNoId, landedIds, seenIds: meta.seenIds ?? [] };
}
