import type { UpsertStats } from "@/lib/ingest/pancake-upsert";
import { prisma } from "@/lib/prisma";

/**
 * Cùng bộ đếm với upsert Silver — 1 kiểu, không nhân bản định nghĩa — cộng MỘT bộ đếm chỉ lượt dựng lại có.
 *
 * `skippedTruocM`: dòng chi tiêu ads ngày VN < mốc Nợ phải trả M mà lượt dựng lại CỐ Ý không ghi lại (xem
 * `transform-ads-expense.ts`). TÁCH khỏi `skipped` vì `skipped` là điều kiện HẠ CỜ backlog ("dòng kẹt, phải sửa
 * mapping"), còn đây là kết cục ĐÚNG — gộp vào thì sau ngày bật mọi lượt dựng lại đều giữ cờ dính vĩnh viễn (cùng
 * tinh thần `boQuaCoChuDich`). Không nằm trong `UpsertStats` vì đường ingest thường ngày không bao giờ cắt tại M.
 */
export type TransformStats = UpsertStats & { skippedTruocM: number };

export const empty = (): TransformStats => ({
  ordersUpserted: 0,
  productsUpserted: 0,
  variantsUpserted: 0,
  ordersSkippedMirror: 0,
  ordersSkippedStale: 0,
  ordersDiscardedGiuaChung: 0,
  skipped: 0,
  boQuaCoChuDich: 0,
  unknownStatusOrders: 0,
  settlementsUpserted: 0,
  adsUpserted: 0,
  paymentsUpserted: 0,
  shopeeUpserted: 0,
  adsExpensesUpserted: 0,
  skippedTruocM: 0,
});

export type TransformOptions = {
  /**
   * Giới hạn transform vào đúng entity vừa land ở trang này (`LandResult.landedIds`) — route LUÔN
   * truyền để chi phí mỗi trang là O(trang), không O(bảng). Bỏ trống ⇒ quét CẢ BẢNG = rebuild
   * (dựng lại Silver từ Bronze sau khi sửa mapping, không cần fetch lại Pancake).
   */
  externalIds?: string[];
  /**
   * Lọc raw `orders` theo đúng shop đang ingest → dùng index `[shopId, externalId, fetchedAt]`
   * (thay vì `externalId = ANY(...)` toàn bảng, seq scan lớn dần theo raw history) VÀ tránh
   * over-transform khi hai shop lỡ có `externalId` trùng. Route ingest LUÔN truyền; bỏ trống ⇒
   * quét mọi shop = rebuild (giữ nguyên hành vi dựng lại toàn bảng). CHỈ nhánh `orders` đọc field
   * này — `products`/`tiktok/*` neo shop cố định theo nghiệp vụ (vai kho / tiktokShop, id resolve
   * từ cấu hình `Setting` — xem cau-hinh-shop.ts).
   */
  shopId?: string;
  /**
   * Báo `externalId` của đơn CÓ trong Bronze nhưng BỊ LUẬT LOẠI khỏi Silver (mirror hoặc hỏng
   * shape). Rebuild dùng để phát hiện bản ghi "kẹt": đơn từng lọt vào Silver, nay luật loại, mà
   * transform chỉ upsert (không xoá) ⇒ nó vẫn nằm đó và đếm doanh thu 2 lần.
   * Luật loại nằm DUY NHẤT ở `transform-pancake-orders.ts` — người gọi không được tự suy lại.
   */
  onRejected?: (externalId: string) => void;
  /**
   * Đây là lượt DỰNG LẠI (nút "Dựng lại từ kho thô" / `scripts/rebuild-from-raw.ts`), không phải
   * một trang ingest thường ngày. CHỈ lượt này được dựng lại chi tiêu quảng cáo.
   *
   * Vì sao phải là cờ TƯỜNG MINH: mỗi trang báo cáo ads mà n8n land đều đi qua `/api/ingest/raw` và
   * cũng gọi hàm này. Nếu nhánh ads chạy luôn ở đó thì mỗi trang tự ghi `Expense` bằng tỉ lệ VAT
   * gộp theo THÁNG, rồi lượt `POST /api/ingest/ads` chính thức (VAT theo CỬA SỔ 7 ngày của n8n) mới
   * là số cuối. Đêm nào lượt POST đó hỏng — mạng chập, app restart lúc deploy — thì số tiền đã bị
   * ghi bằng thuật toán VAT KHÁC mà không ai biết; trước đây cùng kịch bản lỗi chỉ đơn giản là giữ
   * nguyên số cũ. Đường ghi chi tiêu ads thường ngày CHỈ ĐƯỢC là `/api/ingest/ads`.
   */
  rebuild?: boolean;
  /**
   * Mốc Nợ phải trả M (00:00 giờ VN, `docMocM`) cho nhánh chi tiêu ads của lượt dựng lại — chỉ đọc khi `rebuild`.
   * `null` = chưa bật (ghi đủ mọi ngày, y hành vi cũ). Bỏ trống (`undefined`) ⇒ nhánh ads TỰ đọc M một lần đầu
   * nhánh: quên truyền KHÔNG được thành "ghi lại cả ngày < M". Lượt dựng lại đọc M MỘT lần rồi truyền cho cả hai
   * nhánh Meta + TikTok để hai nhánh cắt cùng một mốc.
   */
  mocNoPhaiTra?: Date | null;
  /**
   * Lượt DỰNG LẠI TAY được quyền GHI ĐÈ mọi kết cục cũ, kể cả `DISCARDED` (chủ shop đã xoá Sổ) và
   * `FAILED_*` (đã dừng thử lại tự động) — vì chính chủ shop đang chủ động yêu cầu dựng lại.
   *
   * Đường ghi THƯỜNG NGÀY tuyệt đối không được đặt cờ này: nó vô hiệu hoá chốt CAS vốn để chặn
   * việc dựng lại đúng phần dữ liệu người ta vừa chủ ý xoá.
   */
  luotTayDuocGhiDe?: boolean;
  /**
   * Gọi ở các mốc tiến độ để CHỦ VIỆC gia hạn khoá và tự kiểm còn quyền ghi không (xem
   * `khoa-viec-nang.ts`). Ném ⇒ dừng ngay, phần đã ghi giữ nguyên. Lượt ingest thường ngày không
   * truyền — nó ngắn và không giữ khoá việc nặng nào.
   */
  checkpoint?: () => Promise<void>;
};

/** type TikTok Shop cho khoản trừ tiền quảng cáo (bất biến #2 — nhận diện DUY NHẤT bằng type). */
const TIKTOK_ADS_TYPE = "GMV_PAYMENT_FOR_TIKTOK_ADS";

/** Chấm mốc mỗi bao nhiêu dòng trong một vòng ghi. */
export const CHAM_MOC_MOI = 25;
/**
 * Chấm mốc tiến độ TRONG một vòng ghi: gọi checkpoint ở dòng ĐẦU (i=0, TRƯỚC lượt ghi đầu tiên) và
 * cứ mỗi `CHAM_MOC_MOI` dòng. Mọi nhánh có vòng ghi PHẢI gọi cái này — chấm ở i=0 để bắt được cả ca
 * câu SELECT nạp dữ liệu treo lâu hơn hạn rồi mới trả về (lô đầu chưa ghi mà khoá đã mất).
 */
export async function chamMoc(
  checkpoint: (() => Promise<void>) | undefined,
  i: number,
): Promise<void> {
  if (checkpoint && i % CHAM_MOC_MOI === 0) await checkpoint();
}

export type RawRow = {
  /**
   * `id` của CHÍNH dòng Bronze thắng cuộc. Cần để đóng dấu kết cục lên đúng phiên bản đã dựng nên
   * bản Silver này — đóng theo `externalId` là sai: một đơn có nhiều phiên bản, dấu phải dính vào
   * dòng đã thật sự được xử lý (`RawPancakeOrder.silverOutcome`).
   */
  id: string;
  shopId: string;
  externalId: string;
  payload: unknown;
  fetchedAt?: Date;
};

export type LatestFilter = {
  shopId?: string;
  /**
   * Chỉ lấy đúng các entity vừa land ở TRANG NÀY (`LandResult.landedIds`).
   * `undefined` = quét CẢ BẢNG — đường rebuild (dựng lại Silver từ Bronze sau khi sửa mapping).
   * Mảng RỖNG = không có gì mới land → 0 dòng (KHÔNG rơi về quét cả bảng).
   */
  externalIds?: string[];
};

/** `updated_at` thô của payload đơn Pancake (TEXT — rút trong Postgres). */
const UPDATED_AT = `(payload->>'updated_at')`;

/**
 * Mốc `updated_at` của payload đơn dưới dạng `timestamptz` — CÙNG luật với `parseVnDate` (đường guard
 * ở `thu-tu-cap-nhat-don.ts`) để hai nơi không bao giờ bất đồng "bản nào mới hơn":
 *  - So theo THỜI ĐIỂM, không so chuỗi: separator `T`/khoảng trắng, độ dài phần lẻ giây và đuôi múi giờ
 *    khác nhau giữa API và webhook. Naive = giờ UTC (bất biến #3, `docs/tu-dien-du-lieu-bronze.md`)
 *    ⇒ `AT TIME ZONE 'UTC'`, KHÔNG dựa `TimeZone` của phiên DB.
 *  - Cắt phần lẻ giây về mili-giây (V8 cắt, không làm tròn) ⇒ hai bản lệch dưới 1ms là BẰNG, rơi về
 *    luật `fetchedAt` — đúng như `soThuTuCapNhatDon` trả `BANG`.
 *  - Thiếu hoặc sai khuôn ⇒ NULL (xếp SAU). Ép kiểu thẳng sẽ NÉM và làm hỏng CẢ câu dựng lại vì một
 *    dòng rác, nên phải lọc khuôn bằng regex rồi kiểm ngày có thật trong tháng ("2026-02-31") — lồng
 *    CASE vì Postgres không hứa thứ tự đánh giá `AND`, chỉ CASE mới chắn được phép ép kiểu. Lệch DUY
 *    NHẤT so với `parseVnDate`: năm 0000 thành NULL (`make_date` không nhận năm 0) — không có dữ liệu thật.
 * Regex chỉ dùng lớp ký tự (`[.]`, `[0-9]`) để khỏi phải thoát `\` qua hai tầng chuỗi TS + SQL; dấu
 * `\` DUY NHẤT là `\\1` (tham chiếu nhóm của `regexp_replace`, ra SQL thành `'\1'`).
 */
const MOC_CAP_NHAT_DON_SQL = `
  CASE WHEN ${UPDATED_AT} ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])([T ]([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9]([.][0-9]+)?)?([zZ]|[+-](0[0-9]|1[0-4]):?[0-5][0-9])?)?$' THEN
    CASE WHEN substr(${UPDATED_AT}, 9, 2)::int <= extract(day from
           make_date(substr(${UPDATED_AT}, 1, 4)::int, substr(${UPDATED_AT}, 6, 2)::int, 1)
           + interval '1 month' - interval '1 day') THEN
      CASE WHEN ${UPDATED_AT} ~ '[T ][0-9:.]+([zZ]|[+-][0-9]{2}:?[0-9]{2})$'
        THEN regexp_replace(${UPDATED_AT}, '([.][0-9]{3})[0-9]+', '\\1')::timestamptz
        ELSE regexp_replace(${UPDATED_AT}, '([.][0-9]{3})[0-9]+', '\\1')::timestamp AT TIME ZONE 'UTC'
      END
    END
  END`;

/**
 * Lấy BẢN MỚI NHẤT của mỗi `externalId` trong 1 bảng Bronze (raw là append-only nhiều phiên bản
 * → transform luôn dùng bản `fetchedAt` mới nhất).
 *
 * NGOẠI LỆ — đơn Pancake khi QUÉT CẢ BẢNG (dựng lại từ kho thô: `rebuild-from-raw`, nút "Dựng lại",
 * DR với Silver rỗng): xếp theo (`updated_at` Pancake mới nhất, rồi `fetchedAt` mới nhất). Lý do:
 * `fetchedAt` là mốc LAND, không phải mốc NỘI DUNG — trang API chụp trước một sự kiện webhook mà POST
 * sau vẫn land muộn hơn. Khi Silver rỗng thì guard `updated_at` ở `upsertOneOrder` không có bản nào để
 * so ⇒ bản cũ được dựng và KHÔNG tự lành (lượt API kế tiếp trùng hash, không land lại). Dòng thiếu/sai
 * khuôn `updated_at` xếp SAU mọi dòng có mốc; giữa chúng vẫn là luật `fetchedAt` như cũ.
 *
 * Đường theo TỪNG ĐƠN (`externalIds` có mặt — ingest từng trang, webhook, đối soát đêm, backfill
 * LEGACY) CỐ Ý GIỮ luật `fetchedAt`: các câu "bản mới nhất" của sổ kết cục (`ket-cuc-silver.ts`)
 * định nghĩa bản mới nhất theo `fetchedAt`, và đường này phải đóng dấu ĐÚNG dòng đó. Nếu ở đây chọn
 * bản `updated_at` lớn hơn thì dòng trang cũ land sau (bản mới nhất theo `fetchedAt`) không bao giờ
 * được đóng dấu ⇒ đối soát đêm thử lại nó mãi tới `FAILED_RETRY_LIMIT` = báo động giả. Ở đường này
 * Silver đã có bản để so nên guard ở upsert chặn được trang cũ (đóng dấu `SUPERSEDED`).
 *
 * Tiebreaker `"id" DESC`: `fetchedAt` là TIMESTAMP(3) — 2 phiên bản cùng entity land trong CÙNG
 * mili-giây thì `DISTINCT ON` chọn bản tuỳ ý, tức số TIỀN của đơn phụ thuộc may rủi. Thêm `id`
 * vào ORDER BY để "bản thắng" luôn xác định.
 *
 * ⚠️ BẤT BIẾN int64 — đọc `payload` qua Prisma (`Json`) CHÍNH LÀ `JSON.parse`:
 * số > Number.MAX_SAFE_INTEGER sẽ bị làm tròn (461168615117802872 → …900).
 * AN TOÀN cho `orders`/`products` vì `id` 2 stream này là CHUỖI JSON (`"2607097NVDA6N5"`, uuid)
 * và đã verify KHÔNG có số ≥16 chữ số trong payload.
 * Stream nào cần khoá int64 chính xác (vd `inventory_histories.id`) thì PHẢI rút bằng SQL
 * `payload->>'id'` (trả TEXT), KHÔNG được `row.payload.id`.
 * Cột `externalId` (TEXT, do Postgres rút lúc land) luôn lossless → SELECT sẵn ở đây.
 */
export async function latestPayloads(
  table: string,
  filter: LatestFilter,
): Promise<RawRow[]> {
  // `table` là hằng số registry (KHÔNG lấy từ input) → an toàn nội suy; giá trị lọc đi qua tham số.
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filter.shopId !== undefined) {
    params.push(filter.shopId);
    conds.push(`"shopId" = $${params.length}`);
  }
  if (filter.externalIds !== undefined) {
    if (filter.externalIds.length === 0) return [];
    params.push(filter.externalIds);
    conds.push(`"externalId" = ANY($${params.length}::text[])`);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  // Chỉ đơn Pancake + quét cả bảng mới xếp theo `updated_at` trước — xem ghi chú hàm.
  const theoMocNoiDung = table === "RawPancakeOrder" && filter.externalIds === undefined;
  const khoaMocNoiDung = theoMocNoiDung ? `${MOC_CAP_NHAT_DON_SQL} DESC NULLS LAST, ` : "";
  // `fetchedAt` đi kèm payload: nhánh `orders` dùng nó làm SỐ PHIÊN BẢN cho phép ghi Silver, để hai
  // lượt transform song song không ghi ngược thứ tự (xem `Order.rawFetchedAt`).
  return prisma.$queryRawUnsafe<RawRow[]>(
    `
    SELECT DISTINCT ON ("shopId", "externalId") "id", "shopId", "externalId", payload, "fetchedAt"
    FROM "${table}"
    ${where}
    ORDER BY "shopId", "externalId", ${khoaMocNoiDung}"fetchedAt" DESC, "id" DESC
    `,
    ...params,
  );
}

/**
 * [C2] Lấy bản payload MỚI NHẤT của mỗi txn ads — nhận diện ads = externalId có
 * BẤT KỲ version nào `type=GMV_PAYMENT_FOR_TIKTOK_ADS`. TikTok re-fetch có thể
 * RỚT field `type` ở bản mới nhất; nếu lọc `type` trên payload latest (như
 * `latestPayloads`) sẽ bỏ sót khoản đó → hụt tiền + trôi giảm dần mỗi đêm.
 * Subquery kiểm mọi version nên bắt được, mà VẪN chỉ dùng `type` (bất biến #2 —
 * KHÔNG nhận diện bằng số tiền). Payload amount/date lấy từ bản latest (số tiền
 * ổn định giữa các version).
 */
export async function latestAdsPayloads(filter: {
  shopId: string;
  externalIds?: string[];
}): Promise<RawRow[]> {
  const params: unknown[] = [filter.shopId, TIKTOK_ADS_TYPE];
  let extra = "";
  if (filter.externalIds !== undefined) {
    if (filter.externalIds.length === 0) return [];
    params.push(filter.externalIds);
    extra = `AND "externalId" = ANY($${params.length}::text[])`;
  }
  return prisma.$queryRawUnsafe<RawRow[]>(
    `
    SELECT DISTINCT ON ("shopId", "externalId") "shopId", "externalId", payload
    FROM "RawTiktokShopTransaction"
    WHERE "shopId" = $1
      AND "externalId" IN (
        SELECT "externalId" FROM "RawTiktokShopTransaction"
        WHERE "shopId" = $1 AND payload->>'type' = $2
      )
      ${extra}
    ORDER BY "shopId", "externalId", "fetchedAt" DESC, "id" DESC
    `,
    ...params,
  );
}
