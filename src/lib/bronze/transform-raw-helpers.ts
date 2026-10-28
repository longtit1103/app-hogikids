import type { UpsertStats } from "@/lib/ingest/pancake-upsert";
import { prisma } from "@/lib/prisma";

import { NOI_MOC_PHIEN_BAN_DON_SQL, THU_TU_PHIEN_BAN_DON_SQL } from "./thu-tu-phien-ban-don";

/**
 * Cùng bộ đếm với upsert Silver — 1 kiểu, không nhân bản định nghĩa — cộng MỘT bộ đếm chỉ lượt dựng lại có.
 *
 * `skippedTruocM`: dòng chi tiêu ads ngày VN < mốc Nợ phải trả M mà lượt dựng lại CỐ Ý không ghi lại (xem
 * `transform-ads-expense.ts`). TÁCH khỏi `skipped` vì `skipped` là điều kiện HẠ CỜ backlog ("dòng kẹt, phải sửa
 * mapping"), còn đây là kết cục ĐÚNG — gộp vào thì sau ngày bật mọi lượt dựng lại đều giữ cờ dính vĩnh viễn (cùng
 * tinh thần `boQuaCoChuDich`). Không nằm trong `UpsertStats` vì đường ingest thường ngày không bao giờ cắt tại M.
 *
 * `hoaDonAdsUpserted`: số hoá đơn quảng cáo TikTok đã ghi Silver `TiktokAdsHoaDon`. Nằm ở đây chứ không ở
 * `UpsertStats` vì không cổng đối soát "đã land vs đã hạch toán" nào soi stream này (danh sách advertiser/BC mở —
 * `coTheDoiSoat` loại mọi stream `shops: null`).
 *
 * `tinDungAdsUpserted`: số dòng (advertiser × ngày) đã ghi Silver `TiktokAdsTinDung` — cùng lý do nằm ngoài `UpsertStats`.
 */
export type TransformStats = UpsertStats & {
  skippedTruocM: number;
  hoaDonAdsUpserted: number;
  tinDungAdsUpserted: number;
};

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
  hoaDonAdsUpserted: 0,
  tinDungAdsUpserted: 0,
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
   * quét mọi shop = rebuild (giữ nguyên hành vi dựng lại toàn bảng). CHỈ nhánh `orders`, hoá đơn
   * quảng cáo TikTok (`tiktokbusiness/invoice`) và ảnh chụp chi phí TikTok (`tiktokbusiness/cost`) — hai nhánh
   * sau shopId = bc_id — đọc field này — `products`/`tiktok/*`
   * neo shop cố định theo nghiệp vụ (vai kho / tiktokShop, id resolve từ cấu hình `Setting` — xem
   * cau-hinh-shop.ts).
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
  /**
   * CHỈ nhánh `products`: lúc API ĐI NHÌN Pancake của lượt kéo products gần nhất (lượt vá tồn đêm
   * `/api/ingest/resync-products` truyền mốc SyncLog). Có ⇒ mỗi biến thể chỉ bị ghi `stock` khi
   * webhook chưa ghi gì mới hơn `max(fetchedAt của dòng Bronze, mốc này)` — xem `upsertOneProduct`.
   * Bỏ trống ⇒ ghi tồn vô điều kiện như cũ (trang ingest thường ngày, lượt dựng lại).
   *
   * Vì sao không dùng riêng `fetchedAt`: Bronze dedupe theo hash nên `fetchedAt` chỉ nhích khi
   * payload ĐỔI — sản phẩm yên ả có dòng Bronze già nhiều giờ/ngày dù API vừa xác nhận lại đúng nội
   * dung đó. Lấy `fetchedAt` thuần thì mọi mốc webhook sau ảnh già (kể cả sự kiện trùng
   * `remain_quantity`) thắng API mãi, lượt vá đêm mất quyền sửa tồn. Mốc SyncLog cho biết lần API
   * nhìn gần nhất; `fetchedAt` giữ cho ca dòng vừa land muộn hơn mốc đó.
   */
  mocApiTonKho?: Date;
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
 * NGOẠI LỆ — đơn Pancake (`RawPancakeOrder`), MỌI đường (quét cả bảng lẫn theo từng đơn `externalIds`):
 * xếp bằng MỘT thứ tự phiên bản duy nhất `THU_TU_PHIEN_BAN_DON_SQL` (`updated_at` Pancake trước,
 * `fetchedAt` sau — `thu-tu-phien-ban-don.ts`), CÙNG thứ tự mà sổ kết cục (`ket-cuc-silver.ts`) dùng
 * để nói bản nào là bản đứng đầu, bản nào là bản cũ. Lý do: `fetchedAt` là mốc LAND, không phải mốc
 * NỘI DUNG — trang API chụp trước một sự kiện webhook mà POST sau vẫn land muộn hơn. Khi Silver chưa
 * có đơn (DR, hoặc transform của bản mới từng hỏng) thì guard `updated_at` ở `upsertOneOrder` không
 * có bản nào để so ⇒ chọn theo `fetchedAt` là dựng nội dung cũ. Bản nằm dưới bản đứng đầu được đóng
 * dấu `SUPERSEDED` ngay khi bản đứng đầu có kết cục (`dongDauKetCuc`), nên đối soát đêm không bao
 * giờ thử lại nó.
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
  // Đơn Pancake xếp theo thứ tự phiên bản dùng chung với sổ kết cục — xem ghi chú hàm.
  const laDonPancake = table === "RawPancakeOrder";
  const noiMoc = laDonPancake ? NOI_MOC_PHIEN_BAN_DON_SQL : "";
  const thuTu = laDonPancake ? THU_TU_PHIEN_BAN_DON_SQL : `"fetchedAt" DESC, "id" DESC`;
  // `fetchedAt` đi kèm payload: nhánh `orders` dùng nó làm SỐ PHIÊN BẢN cho phép ghi Silver, để hai
  // lượt transform song song không ghi ngược thứ tự (xem `Order.rawFetchedAt`).
  return prisma.$queryRawUnsafe<RawRow[]>(
    `
    SELECT DISTINCT ON ("shopId", "externalId") "id", "shopId", "externalId", payload, "fetchedAt"
    FROM "${table}" ${noiMoc}
    ${where}
    ORDER BY "shopId", "externalId", ${thuTu}
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
