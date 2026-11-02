import { Prisma } from "@/generated/prisma/client";
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
 *
 * `hoaDonAdsSkippedStale` / `tinDungAdsSkippedStale`: bản KHÔNG ghi vì Silver đang giữ bản dựng từ dòng kho thô MỚI
 * HƠN (chốt `nguonFetchedAt`) — kết cục ĐÚNG, tách khỏi `skipped`. Ở đây (không ở `UpsertStats`) cùng lý do hai bộ đếm
 * `*Upserted` của chúng: không cổng đối soát nào soi hai stream này. Ba bộ đếm stale của sao kê / khoản ads trừ ví /
 * lệnh rút nằm trong `UpsertStats` vì `demDaHachToan` đọc chúng.
 */
export type TransformStats = UpsertStats & {
  skippedTruocM: number;
  hoaDonAdsUpserted: number;
  tinDungAdsUpserted: number;
  hoaDonAdsSkippedStale: number;
  tinDungAdsSkippedStale: number;
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
  settlementsSkippedStale: 0,
  adsSkippedStale: 0,
  paymentsSkippedStale: 0,
  hoaDonAdsSkippedStale: 0,
  tinDungAdsSkippedStale: 0,
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
   *
   * CỐ Ý vẫn là `fetchedAt` (không phải mốc phiên bản có lần thấy `lanThayCuoi`) dù `RawPancakeProduct` thuộc
   * `BANG_LAN_THAY`: lần thấy lại luôn xảy ra TRONG một lượt kéo products, nên `lanThayCuoi` chỉ muộn hơn mốc SyncLog của
   * lượt đó vài giây. Dùng nó thì ảnh API thắng webhook trong vài giây đó; giữ `fetchedAt` thì webhook thắng — hướng
   * an toàn cho tồn kho (số webhook là sự kiện thật, lượt vá đêm sau tự khẳng định lại).
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

/**
 * MỐC PHIÊN BẢN kho thô — MỘT định nghĩa cho cả hai câu hỏi "bản nào đứng đầu" (chọn payload dựng Silver, màn đọc
 * thẳng Bronze) và "Silver đang giữ bản mới hơn chưa" (chốt CAS `nguonFetchedAt` của Silver TikTok).
 *
 * Bảng trong `BANG_LAN_THAY` có cột `lanThayCuoi` mà `landRaw` ghi khi nguồn trả LẠI đúng một nội dung đã có (A→B→A:
 * hash trùng nên không chèn dòng, `fetchedAt` của A vẫn là lần land ĐẦU), và cột `mocChup` = lúc nguồn CHỤP lần thấy
 * mới nhất (`chupLuc` n8n gửi theo trang). Thiếu `chupLuc`: khoá thuần di sản giữ NULL (mốc = lúc land, luật cũ); khoá
 * đã có mốc thì bản mới chèn ngay DƯỚI bản đầu (mốc lớn nhất − 1 ms) và thấy lại không ghi — không vượt được bản đầu
 * (`landRaw`). Mốc = `COALESCE("mocChup","lanThayCuoi","fetchedAt")`: so mốc CHỤP chứ không phải mốc LAND, nên trang
 * của lượt chụp trước về trễ không đẩy bản cũ lên đầu; dòng có trước cột `mocChup` (NULL) rơi về luật cũ.
 * Hai câu hỏi PHẢI dùng chung mốc này: xếp bản đầu theo lần thấy mà CAS lại so `fetchedAt` trần thì A quay lại đứng
 * đầu Bronze nhưng bị CAS từ chối trước B — Silver giữ B, lỗi A→B→A sống lại đúng ở bảng tiền.
 *
 * Danh sách = bảng KHÔNG có mốc nội dung trong payload mà có người đọc bản đầu: sản phẩm Pancake (Silver sản phẩm +
 * đề xuất giá vốn ⇒ COGS), báo cáo ads Meta / TikTok Business (dựng lại `Expense` + màn /marketing). CỐ Ý NGOÀI:
 *  - đơn Pancake: thứ tự riêng theo `updated_at` (`thu-tu-phien-ban-don.ts`);
 *  - TỒN KHO không có bảng kho thô riêng cùng khuôn: tồn API nằm trong payload sản phẩm (đã thuộc danh sách qua
 *    `RawPancakeProduct`), còn webhook ghi thẳng `Variant.stock` với guard thứ tự riêng (`stockUpdatedAt`);
 *  - stream tiền TikTok (sao kê / giao dịch / lệnh rút / hoá đơn / ảnh chụp chi phí): nội dung tiến một chiều (trạng
 *    thái thanh toán), ảnh chụp chi phí băm cả `request_id` nên mỗi lần kéo là một dòng mới; giao dịch TikTok Shop còn
 *    có người đọc ngoài lượt dựng (đối soát tiền về) — thêm bảng vào đây phải đi kèm migration + sửa MỌI bộ đọc (lưới
 *    `tests/bronze/luoi-thu-tu-phien-ban-bronze.test.ts`). Với các bảng này mốc = `fetchedAt` — CAS vẫn đúng nghĩa.
 */
export const BANG_LAN_THAY: ReadonlySet<string> = new Set([
  "RawPancakeProduct",
  "RawMetaAdsReport",
  "RawTiktokBusinessReport",
]);

/**
 * Các cột tạo nên mốc phiên bản, theo thứ tự ưu tiên của `COALESCE` — MỘT chỗ khai cho cả bản có bí danh lẫn không.
 * `mocChup` đứng TRƯỚC `lanThayCuoi`: lần thấy lại luôn ghi cả hai, nên mốc chụp nguồn quyết; dòng chỉ có `lanThayCuoi`
 * (ghi trước khi có cột `mocChup`) hoặc chỉ có `fetchedAt` giữ thứ tự cũ.
 */
const COT_MOC_PHIEN_BAN = ["mocChup", "lanThayCuoi", "fetchedAt"] as const;

/**
 * Mốc phiên bản của bảng có cột lần thấy, kèm bí danh bảng `biDanh` (hằng trong code) — cho câu có nhiều bảng cùng mang
 * các cột này (`landRaw` so dòng với các phiên bản khác của chính nó).
 */
export function mocLanThayCua(biDanh: string): string {
  return `COALESCE(${COT_MOC_PHIEN_BAN.map((c) => `${biDanh}."${c}"`).join(", ")})`;
}

/** Mốc phiên bản của bảng có cột lần thấy. Không kèm bí danh bảng ⇒ chỉ dùng khi câu có đúng một bảng mang các cột này. */
export const MOC_PHIEN_BAN_SQL = `COALESCE(${COT_MOC_PHIEN_BAN.map((c) => `"${c}"`).join(", ")})`;

/** Mốc phiên bản của `table` (hằng registry, KHÔNG lấy từ input) dạng mảnh SQL, không bí danh. */
export function mocPhienBanSql(table: string): string {
  return BANG_LAN_THAY.has(table) ? MOC_PHIEN_BAN_SQL : `"fetchedAt"`;
}

/**
 * Khoá `ORDER BY` của thứ tự phiên bản (bản ĐỨNG ĐẦU trước) — ghép sau khoá nhóm cho `DISTINCT ON`. `"id" DESC` chốt
 * cuối: mốc là TIMESTAMP(3), hai phiên bản trùng mili-giây thì `DISTINCT ON` chọn tuỳ ý (số tiền theo may rủi).
 * KHÔNG dùng cho đơn Pancake (`THU_TU_PHIEN_BAN_DON_SQL`).
 */
export function thuTuPhienBanSql(table: string): string {
  return `${mocPhienBanSql(table)} DESC, "id" DESC`;
}

/** Bản `Prisma.Sql` của `thuTuPhienBanSql` cho `$queryRaw` dạng tagged template. */
export function thuTuPhienBan(table: string): Prisma.Sql {
  return Prisma.raw(thuTuPhienBanSql(table));
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
  /**
   * Mốc phiên bản của dòng (`mocPhienBanSql`) — giá trị ghi vào `nguonFetchedAt` của Silver TikTok để chốt CAS. KHÁC
   * `fetchedAt` ở bảng có cột lần thấy (A→B→A); đơn Pancake vẫn dùng `fetchedAt` làm mốc land (`Order.rawFetchedAt`).
   */
  mocPhienBan: Date;
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
 * Bảng khác: thứ tự phiên bản chung `thuTuPhienBanSql` (mốc = lần thấy cuối nếu bảng có cột đó, không thì
 * `fetchedAt` — xem `BANG_LAN_THAY`).
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
  const thuTu = laDonPancake ? THU_TU_PHIEN_BAN_DON_SQL : thuTuPhienBanSql(table);
  // `fetchedAt` đi kèm payload: nhánh `orders` dùng nó làm SỐ PHIÊN BẢN cho phép ghi Silver, để hai
  // lượt transform song song không ghi ngược thứ tự (xem `Order.rawFetchedAt`). `mocPhienBan` là số
  // phiên bản của nhánh Silver TikTok (`nguonFetchedAt`).
  return prisma.$queryRawUnsafe<RawRow[]>(
    `
    SELECT DISTINCT ON ("shopId", "externalId") "id", "shopId", "externalId", payload, "fetchedAt",
      ${mocPhienBanSql(table)} AS "mocPhienBan"
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
 * ổn định giữa các version). Trả kèm `mocPhienBan` của bản latest cho chốt CAS `TiktokAdsSettlement.nguonFetchedAt`.
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
    SELECT DISTINCT ON ("shopId", "externalId") "id", "shopId", "externalId", payload,
      ${mocPhienBanSql("RawTiktokShopTransaction")} AS "mocPhienBan"
    FROM "RawTiktokShopTransaction"
    WHERE "shopId" = $1
      AND "externalId" IN (
        SELECT "externalId" FROM "RawTiktokShopTransaction"
        WHERE "shopId" = $1 AND payload->>'type' = $2
      )
      ${extra}
    ORDER BY "shopId", "externalId", ${thuTuPhienBanSql("RawTiktokShopTransaction")}
    `,
    ...params,
  );
}
