/**
 * VAI shop — cấu trúc CỐ ĐỊNH của hệ (3 shop Pancake: Kho Tổng = master tồn/giá vốn; Shopee +
 * TikTok = shop bán; cộng shop TikTok Shop Open API cho phí/đối soát). GIÁ TRỊ id thật nằm ở bảng
 * `Setting` (xem `@/lib/ket-noi/cau-hinh-shop`) — repo public cho người ngoài clone nên id không
 * được là hằng trong code. Registry này chỉ khai VAI; ai cần id thật thì resolve qua
 * `shopIdsChoVai()`/`layCauHinhShop()`.
 *
 * `tiktokShop` = shop id TikTok Shop OPEN API — hệ đánh số KHÁC HẲN id shop TikTok bên trong
 * Pancake; trộn nhầm sẽ làm dòng Bronze TikTok đội lốt dòng Pancake.
 * BẤT BIẾN #2: dữ liệu TikTok Shop CHỈ dùng cho phí / đối soát tiền thực nhận / hoa hồng aff —
 * TUYỆT ĐỐI KHÔNG lấy làm doanh thu (doanh thu chỉ từ Pancake, nếu không sẽ đếm 2 lần).
 */
export type VaiShop = "kho" | "shopee" | "tiktok" | "tiktokShop";
const ALL = ["kho", "shopee", "tiktok"] as const satisfies readonly VaiShop[];
const MARKETPLACES = ["shopee", "tiktok"] as const satisfies readonly VaiShop[];
const TIKTOK_SHOP = ["tiktokShop"] as const satisfies readonly VaiShop[];

export type BronzeStream =
  | "orders" | "products" | "products/variations" | "purchases"
  | "inventory_histories" | "transactions" | "marketplace/reverse_order" | "customers"
  | "tiktok/statements" | "tiktok/statement_transactions" | "tiktok/payments" | "tiktok/orders"
  | "tiktok/analytics_shop" | "tiktok/analytics_products" | "tiktok/analytics_videos"
  | "tiktok/analytics_lives" | "tiktok/affiliate_orders"
  | "tiktokbusiness/report" | "tiktokbusiness/invoice" | "tiktokbusiness/gmvmax_item"
  | "meta/report"
  | "shopee/wallet";

export type BronzeStreamDef = {
  table: string;
  /**
   * VAI shop hợp lệ cho stream — resolve ra id thật qua `shopIdsChoVai()` (cấu hình `Setting`).
   * `null` = KHÔNG chốt danh sách được (xem `tiktokbusiness/report`: advertiser do chủ shop tự
   * tạo, hôm nay 7 cái, mai có thể thêm) — lúc đó chỉ kiểm shopId theo SHAPE.
   */
  shops: readonly VaiShop[] | null;
  /**
   * Đường dẫn tới MẢNG record trong envelope của API. Mỗi nhà cung cấp lồng một kiểu:
   * Pancake `{success, data:[...]}` → ["data"]; TikTok `{code, message, data:{statements:[...]}}`
   * → ["data","statements"]. Hardcode envelope của một nhà cung cấp vào landRaw sẽ khiến nhà kia
   * land 0 dòng hoặc land nhầm object.
   */
  arrayPath: readonly string[];
  /**
   * Biểu thức SQL rút KHOÁ của một record (chạy trên `elem` jsonb). Mặc định `elem->>'id'`.
   * HẰNG SỐ TRONG CODE — không bao giờ lấy từ input (nội suy thẳng vào SQL).
   *
   * Cần khai riêng khi API KHÔNG trả `id`: báo cáo quảng cáo TikTok là
   * `{dimensions:{campaign_id, stat_time_day}, metrics:{...}}` — khoá tự nhiên là
   * (chiến dịch, ngày). Không có khoá thì không dedupe được, kéo lại là nhân bản dòng.
   */
  idExpr?: string;
  /**
   * Stream mà record KHÔNG mang trường ngày ⇒ ngày phải do người gọi bơm vào (`ngay`), và ngày đó
   * nằm TRONG khoá + TRONG hash. Không khai ⇒ route TỪ CHỐI `ngay` (400).
   *
   * Cần cho endpoint trả TỔNG CẢ CỬA SỔ (analytics TikTok Shop): record không có trường ngày nào
   * nên mọi cửa sổ rút ra khoá y hệt nhau ⇒ lượt hôm sau ĐÈ lượt hôm trước, chuỗi ngày biến mất mà
   * không một dòng log nào đỏ. Bật cờ này cho stream ĐANG CHẠY là ĐỔI khoá/hash của mọi dòng đã
   * land (Bronze append-only) — không bao giờ làm.
   */
  chapNhanNgay?: true;
};

/**
 * `table` và `arrayPath` là hằng số trong code (KHÔNG bao giờ lấy từ input) → an toàn khi dùng
 * ở land-raw.ts. `shops` = shop THẬT SỰ có dữ liệu (Task 0 discovery).
 */
export const BRONZE_STREAMS: Record<BronzeStream, BronzeStreamDef> = {
  "orders": { table: "RawPancakeOrder", shops: ALL, arrayPath: ["data"] },
  "products": { table: "RawPancakeProduct", shops: ALL, arrayPath: ["data"] },
  "products/variations": { table: "RawPancakeVariation", shops: ALL, arrayPath: ["data"] },
  "purchases": { table: "RawPancakePurchase", shops: ["kho"], arrayPath: ["data"] },
  "inventory_histories": { table: "RawPancakeInventoryHistory", shops: ALL, arrayPath: ["data"] },
  "transactions": { table: "RawPancakeTransaction", shops: MARKETPLACES, arrayPath: ["data"] },
  "marketplace/reverse_order": { table: "RawPancakeReverseOrder", shops: MARKETPLACES, arrayPath: ["data"] },
  "customers": { table: "RawPancakeCustomer", shops: ALL, arrayPath: ["data"] },

  // TikTok Shop Open API — envelope {code, message, request_id, data:{<mảng>, next_page_token}}.
  "tiktok/statements": {
    table: "RawTiktokShopStatement", shops: TIKTOK_SHOP, arrayPath: ["data", "statements"],
  },
  /**
   * BẢN 202501, KHÔNG phải 202309 — chỉ bản này trả `type` (`ORDER` | `GMV_PAYMENT_FOR_TIKTOK_ADS` | …)
   * và mảng nằm ở `data.transactions` (bản 202309 dùng `data.statement_transactions`, KHÔNG có `type`).
   *
   * `type` là cách DUY NHẤT phân biệt tiền quảng cáo TikTok trừ vào số dư shop (GMV Pay) với tiền
   * đơn hàng: TikTok Ads gom chi tiêu tới NGƯỠNG mới trừ, mà ngưỡng THAY ĐỔI theo thời gian
   * (đo 15/05–16/06: một mức cố định mỗi lần, nhưng con số này không bền) ⇒ TUYỆT ĐỐI không nhận diện
   * bằng số tiền.
   */
  "tiktok/statement_transactions": {
    table: "RawTiktokShopTransaction", shops: TIKTOK_SHOP, arrayPath: ["data", "transactions"],
  },
  "tiktok/payments": {
    table: "RawTiktokShopPayment", shops: TIKTOK_SHOP, arrayPath: ["data", "payments"],
  },
  /**
   * CỐ Ý KHÔNG KÉO (RawTiktokShopOrder = 0 dòng là ĐÚNG, không phải chết thầm): `tiktokshop-nightly`
   * chỉ kéo statements + statement_transactions + payments (PHÍ/đối soát). Đơn TikTok Shop TUYỆT ĐỐI
   * KHÔNG lấy làm doanh thu (bất biến #2 — doanh thu chỉ từ Pancake). Định nghĩa giữ ở đây để nếu mai
   * cần đối soát cấp đơn thì có sẵn shape; hôm nay không workflow nào populate.
   */
  "tiktok/orders": {
    table: "RawTiktokShopOrder", shops: TIKTOK_SHOP, arrayPath: ["data", "orders"],
  },

  /**
   * TIKTOK SHOP ANALYTICS — chỉ số MARKETING do sàn tự nhận công (phễu · sản phẩm · video · live).
   * Workflow RIÊNG `tiktokshop-analytics-nightly` 02:30, SyncKind RIÊNG `TIKTOK_SHOP_ANALYTICS`.
   *
   * BẤT BIẾN #2: đây là SỐ THAM KHẢO. Không stream nào ở đây được chạm `pnl.ts`, không được dùng
   * sửa phí sàn, không đối chiếu "lệch" với đơn Pancake (hai định nghĩa khác nhau).
   */
  "tiktok/analytics_shop": {
    table: "RawTiktokShopAnalyticsShop", shops: TIKTOK_SHOP,
    arrayPath: ["data", "performance", "intervals"],
    // Record KHÔNG có `id`. Khoá tự nhiên là NGÀY: `granularity=1D` ⇒ mỗi interval đúng một ngày,
    // `start_date` là mốc mở của khoảng nửa mở [start_date, end_date).
    idExpr: `elem->>'start_date'`,
  },
  "tiktok/analytics_products": {
    table: "RawTiktokShopAnalyticsProduct", shops: TIKTOK_SHOP,
    arrayPath: ["data", "products"],
    idExpr: `(elem->>'_ngay') || ':' || (elem->>'id')`,
    chapNhanNgay: true,
  },
  "tiktok/analytics_videos": {
    table: "RawTiktokShopAnalyticsVideo", shops: TIKTOK_SHOP,
    arrayPath: ["data", "videos"],
    idExpr: `(elem->>'_ngay') || ':' || (elem->>'id')`,
    chapNhanNgay: true,
  },
  "tiktok/analytics_lives": {
    table: "RawTiktokShopAnalyticsLive", shops: TIKTOK_SHOP,
    // ⚠️ `data.live_stream_sessions`, KHÔNG phải `data.lives` (spec §4.4 đoán sai; đo thật P0).
    // Khai sai đường dẫn ⇒ land 0 dòng mà KHÔNG báo lỗi — đúng loại hỏng câm mà guard
    // `jsonb_typeof` sinh ra để chặn, nhưng guard chỉ bắt được khi đường dẫn KHÔNG PHẢI mảng.
    arrayPath: ["data", "live_stream_sessions"],
    idExpr: `elem->>'id'`,
  },

  /**
   * AFFILIATE (Seller) — đơn được quy công cho creator, cấp DÒNG SKU. Cùng workflow 02:30 +
   * SyncKind `TIKTOK_SHOP_ANALYTICS` với 4 stream analytics (route map tiền tố `tiktok/affiliate_`).
   *
   * Payload gốc lồng 2 tầng (`data.orders[].skus[]`) — WORKFLOW LÀM PHẲNG trước khi land: mỗi dòng
   * SKU một record, bơm 4 trường cấp đơn `_don_id`/`_create_time`/`_delivery_time`/`_ngay` (mã đơn
   * THẬT là `id`, KHÔNG phải `order_id` — spec đoán sai, đo 28/08). Land theo DÒNG SKU chứ không
   * theo đơn vì khoá Bronze append-only: đơn nhiều SKU vắt qua 2 trang sẽ làm trang sau ghi đè bản
   * `skus` THIẾU lên bản đủ — mất dòng, không log nào đỏ. `total_count` của TikTok cũng đếm DÒNG SKU
   * (đo: page_size 20 → 19 đơn / 20 dòng) nên cổng Σ == total_count so thẳng số dòng land.
   *
   * KHÔNG khai `chapNhanNgay`: guard của cờ đó đòi `_ngay` nằm TRONG idExpr — đúng cho 4 stream
   * analytics (record không có ngày, `_ngay` là mảnh khoá bắt buộc), còn ở đây khoá `_don_id:sku_id`
   * đã duy nhất toàn cục, `_ngay` chỉ là trường lọc kỳ do workflow bơm sẵn trong record. KHÔNG nới
   * guard — nó đang bảo vệ 2 stream đang chạy.
   *
   * BẤT BIẾN #2: đơn/GMV/hoa hồng ở đây là SỐ SÀN TỰ NHẬN CÔNG — không chạm `pnl.ts`, không trộn
   * với hoa hồng THẬT Pancake (`advanced_platform_fee.affiliate_commission` — khối P1).
   */
  "tiktok/affiliate_orders": {
    table: "RawTiktokShopAffiliateOrder", shops: TIKTOK_SHOP,
    arrayPath: ["data", "orders"],
    idExpr: `(elem->>'_don_id') || ':' || (elem->>'sku_id')`,
  },

  /**
   * TikTok BUSINESS (business-api.tiktok.com) — CHI TIÊU quảng cáo. API KHÁC HẲN TikTok Shop:
   * khác portal, khác token, khác envelope `{code, message, data:{list:[...], page_info}}`.
   *
   * BẤT BIẾN #2: CHỈ lấy chi tiêu. TUYỆT ĐỐI không lấy GMV/doanh thu từ đây (doanh thu chỉ từ Pancake).
   *
   * `shopId` của stream này = **advertiser_id** (không phải shop). Không chốt danh sách được:
   * chủ shop có 7 tài khoản quảng cáo và tự tạo thêm được. Workflow quét động mọi advertiser —
   * chốt cứng danh sách ở đây thì tài khoản mới bị CHẶN, mất chi phí quảng cáo.
   *
   * Dòng báo cáo KHÔNG có `id` ⇒ khoá tự dựng từ (loại report, campaign_id, ngày).
   *
   * PHẢI có "loại report" trong khoá: workflow kéo HAI loại chiến dịch land CHUNG stream này với cùng
   * advertiser_id — auction (endpoint `/report/integrated/get/`, metric `spend`) và GMV Max (endpoint
   * `/gmv_max/report/get/`, metric `cost`). Cùng một chiến dịch một ngày có thể xuất hiện ở CẢ HAI
   * loại nhưng là HAI dòng chi tiêu KHÁC nhau. Nếu khoá chỉ (campaign_id, ngày) thì hai dòng đó chung
   * `externalId` (khác payloadHash nên vẫn land đủ), nhưng `latestPayloads` dựng lại bằng
   * `DISTINCT ON (shopId, externalId)` sẽ chọn 1 vứt 1 ⇒ dựng lại chi phí từ Bronze THIẾU một loại.
   *
   * Phân biệt bằng CHÍNH payload: chỉ auction có `metrics.spend`, chỉ GMV Max có `metrics.cost` (mỗi
   * endpoint yêu cầu bộ metric riêng, cố định trong `keoReport` của n8n). Gắn tiền tố `auction:` cho
   * dòng có `metrics.spend`; GMV Max (và mọi dòng không có `spend`) giữ khoá TRẦN — cố ý không đổi
   * format của loại đang chạy trên prod để dòng GMV Max đã land không phải land lại. `spend` giá trị 0
   * vẫn có key nên `IS NOT NULL` bắt đúng loại (không dùng toán tử `?` jsonb để tránh nhập nhằng với
   * placeholder tham số). `campaign_id` NULL ⇒ cả biểu thức NULL ⇒ dòng bị bỏ + đếm vào skippedNoId.
   *
   * Kéo lại cùng loại + cùng ngày ⇒ trùng khoá + trùng hash ⇒ dedupe; TikTok chỉnh spend hồi tố ⇒
   * khác hash ⇒ land bản mới, giữ lịch sử.
   */
  "tiktokbusiness/report": {
    table: "RawTiktokBusinessReport",
    shops: null,
    arrayPath: ["data", "list"],
    idExpr:
      `(case when elem->'metrics'->>'spend' is not null then 'auction:' else '' end) || ` +
      `(elem->'dimensions'->>'campaign_id') || ':' || left(elem->'dimensions'->>'stat_time_day', 10)`,
  },

  /**
   * HOÁ ĐƠN quảng cáo (Business Center) — số TIỀN THẬT TikTok thu, GỒM VAT.
   *
   * Vì sao cần: `cost` trong report là số CHƯA THUẾ. Hoá đơn: `subtotal` + `tax_amount` (10%) = `amount`.
   * Ba nguồn nối liền nhau — đã kiểm chứng trên hoá đơn thật:
   *   report cost (chưa VAT) → hoá đơn amount = cost × 1,1 (gồm VAT) → statement TikTok Shop
   *   trừ đúng số đó vào số dư (GMV_PAYMENT_FOR_TIKTOK_ADS).
   * ⇒ Chi phí vào P&L phải là số GỒM VAT (hộ kinh doanh không khấu trừ được VAT đầu vào).
   *
   * `shopId` = bc_id (Business Center). `externalId` = transaction_id.
   */
  "tiktokbusiness/invoice": {
    table: "RawTiktokBusinessInvoice",
    shops: null,
    arrayPath: ["data", "transaction_list"],
    // Hoá đơn KHÔNG có field `id` — khoá là `transaction_id`. Quên khai `idExpr` thì mặc định
    // `elem->>'id'` = NULL ⇒ land 0 dòng mà KHÔNG báo lỗi (chỉ đếm vào skippedNoId).
    idExpr: `elem->>'transaction_id'`,
  },

  /**
   * TIKTOK BUSINESS — GMV Max cấp ITEM (sản phẩm/SPU). BẢNG RIÊNG, xem docblock model Prisma:
   * land chung `tiktokbusiness/report` là sinh khoá trùng dòng campaign-level.
   * `item_group_id` = `Product.code` (đo 50/50 trên prod) ⇒ tên SP lấy từ danh mục app.
   * Số ở đây CHỈ để xem "sản phẩm nào ngốn tiền"; chi phí vào P&L vẫn là cấp campaign (breakdown
   * thiếu 0,60% — 825đ/137.180đ).
   */
  "tiktokbusiness/gmvmax_item": {
    table: "RawTiktokBusinessGmvMaxItem",
    shops: null, // advertiser_id, danh sách MỞ như `tiktokbusiness/report`
    arrayPath: ["data", "list"],
    idExpr:
      `(elem->'dimensions'->>'campaign_id') || ':' || (elem->'dimensions'->>'item_group_id') || ':' || ` +
      `left(elem->'dimensions'->>'stat_time_day', 10)`,
  },

  /**
   * META (Facebook) Marketing API — CHI TIÊU quảng cáo. Envelope `{data:[...], paging:{...}}`.
   *
   * BẤT BIẾN #2: CHỈ lấy `spend`. TUYỆT ĐỐI không lấy conversion value / purchase_roas làm doanh thu.
   *
   * `shopId` = ad account id (`act_...`). Dòng insights không có `id` ⇒ khoá = (campaign, ngày).
   *
   * ⚠️ VAT: `spend` của Meta là số CHƯA THUẾ (giống TikTok). Nhưng Meta KHÔNG có API trả hoá đơn có
   * thuế cho tài khoản trả THẺ (shop đang trả bằng Mastercard) ⇒ phải nhân hệ số VAT cấu hình tay.
   * Chưa chốt được 5% hay 10% ⇒ workflow DỪNG nếu có chi tiêu mà chưa khai hệ số (không ghi số sai).
   */
  "meta/report": {
    table: "RawMetaAdsReport",
    shops: null,
    arrayPath: ["data"],
    idExpr: `(elem->>'campaign_id') || ':' || (elem->>'date_start')`,
  },

  /**
   * SHOPEE — file ví "Transaction Report" (my_balance_transaction) tải TAY (Shopee KHÔNG có API).
   * Import qua UI, KHÔNG qua n8n. Server action tự bọc envelope `{data:[...dòng ví...]}` → ["data"].
   * `shopId` = shop Pancake Shopee (vai `shopee`). CHỈ dòng tiền "đã về" (đối soát) — ĐỘC LẬP P&L/doanh thu (bất biến #2).
   *
   * Dòng ví KHÔNG có `id` ⇒ khoá tổng hợp `txnTime|type|orderCode|amount` (bốn thành phần nội tại
   * giao dịch, BẤT BIẾN qua re-export). KHÔNG dùng `runningBalance` làm khoá: điều chỉnh back-date
   * dịch số dư mọi dòng sau nó ⇒ khoá đổi ⇒ land lại ⇒ đếm 2 lần.
   * `coalesce(orderCode,'-')`: dòng Rút Tiền không có mã đơn (NULL) — NULL-concat làm cả biểu thức
   * NULL ⇒ dòng bị bỏ + đếm skippedNoId. Ép '-' để giữ dòng.
   */
  "shopee/wallet": {
    table: "RawShopeeWalletTxn",
    shops: ["shopee"],
    arrayPath: ["data"],
    idExpr:
      `(elem->>'txnTime')||'|'||(elem->>'type')||'|'||coalesce(elem->>'orderCode','-')||'|'||(elem->>'amount')`,
  },
};

export function isBronzeStream(s: string): s is BronzeStream {
  return Object.hasOwn(BRONZE_STREAMS, s);
}
