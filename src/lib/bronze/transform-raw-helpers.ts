import type { UpsertStats } from "@/lib/ingest/pancake-upsert";
import { prisma } from "@/lib/prisma";

/** Cùng bộ đếm với upsert Silver — 1 kiểu, không nhân bản định nghĩa. */
export type TransformStats = UpsertStats;

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

/**
 * Lấy BẢN MỚI NHẤT của mỗi `externalId` trong 1 bảng Bronze (raw là append-only nhiều phiên bản
 * → transform luôn dùng bản `fetchedAt` mới nhất).
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
  // `fetchedAt` đi kèm payload: nhánh `orders` dùng nó làm SỐ PHIÊN BẢN cho phép ghi Silver, để hai
  // lượt transform song song không ghi ngược thứ tự (xem `Order.rawFetchedAt`).
  return prisma.$queryRawUnsafe<RawRow[]>(
    `
    SELECT DISTINCT ON ("shopId", "externalId") "id", "shopId", "externalId", payload, "fetchedAt"
    FROM "${table}"
    ${where}
    ORDER BY "shopId", "externalId", "fetchedAt" DESC, "id" DESC
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
