# Ghi chú shape TikTok Shop Analytics + GMV Max item-level (Task 1 — phase 2)

Khuôn theo `tests/fixtures/pancake/ghi-chu-shape-thuc-te.md`. Nguồn số liệu: probe P0 thật, KHÔNG bịa.

## 0. Nguồn + phạm vi che PII

- **Nguồn**: probe P0 25/08/2026 00:12–00:30, **12/15 request chỉ-đọc** (không refresh token, không ghi DB) —
  báo cáo đầy đủ `plans/reports/p0-probe-260825-0012-tiktok-shop-analytics-scope-report.md`. Shop id
  TikTok Shop Open API: `7494544063361551019` (đọc từ `Setting.tiktokShopShopId`).
- Bản lưu bền (đã che PII) của probe: `plans/260825-0005-marketing-tiktok-hieu-qua-kenh/p0-samples/tiktok-shop/`
  (analytics) và `.../tiktok-ads/` (GMV Max item-level).
- **Gột PII**: bỏ `request_id`; `creator.user_name`/`nick_name`/`username` → `creator_<n>`; `open_id` →
  `openid_creator_<n>`; `title` → `tieu_de_<n>`; `hash_tags` → `hashtag_<n>`. **Giữ NGUYÊN** mọi số liệu,
  product id, video id, live session id, campaign id, item_group_id. Sample nguồn P0 đã che sẵn theo đúng
  quy tắc này — kiểm lại lần nữa khi build fixture: không phát hiện PII sót lại.

## 1. Đã cắt RECORD (KHÔNG cắt trường)

| Fixture | Nguồn | Record thật | Giữ lại | Ghi chú |
|---|---|---|---|---|
| `shop-performance.json` | `01-shop-performance-202509.json` | 23 ngày | 3 (15/08, 19/08, 20/08) | chọn đúng 3 ngày phủ đủ ca bắt buộc — xem bảng §3 |
| `shop-products.json` | `02-shop-products-performance-202605.json` | 20 SP (`total_count=148`) | 3 SP | chọn đủ 8/8 khối · 3/8 khối · 5/8 khối — xem §3 |
| `shop-videos.json` | `03-shop-videos-performance-202605.json` | 20 video (`total_count=600`) | 3 video | gồm record `id:"0"` |
| `shop-lives.json` | `04-shop-lives-performance-202509.json` (record) + `10-shop-lives-pagesize100.json` (envelope) | 20 phiên (`total_count=60`) | 3 phiên | xem §4 vụ trộn nguồn envelope |
| `ngay-rong.json` | checkpoint P2 `m1-03-ngay-mai-26-08.json` (25/08 15:13) | — (envelope rỗng, nguyên vẹn) | — | thêm 2026-08-25 cho Task 5 — xem §11 |
| `loi-105005.json` | `05-affiliate-orders-search-202410.json` | — (envelope lỗi, nguyên vẹn) | — | copy y nguyên |
| `loi-36009004.json` | `11-shop-videos-pagesize200.json` | — (envelope lỗi, nguyên vẹn) | — | copy y nguyên |
| `tests/fixtures/tiktokbusiness/gmvmax-item.json` | `tiktok-ads/S2-khoa-day-du.json` | 281 dòng (`total_number=281`) | 3 dòng | 2 item_group × ngày, khoá ĐẦY ĐỦ |

**Checkpoint controller (bắt buộc, ghi trong `plan.md` P2):** fixture chỉ được **CẮT SỐ RECORD**, TUYỆT ĐỐI
**KHÔNG cắt trường** bên trong khối `*_performance` — mỗi record giữ lại copy **y nguyên** mọi key từ
payload thật (bản plan P0 trước đó có cắt trường, lần này KHÔNG). `total_count`/`next_page_token`/
`page_info.total_number` giữ nguyên giá trị THẬT của trang 1 — **cố ý KHÁC** Σ record giữ lại trong fixture,
để nhớ envelope có các trường đó.

## 2. Bảng tên trường THẬT theo từng khối nguồn (8 khối, `shop_products.performance`)

Xác nhận **8 khối** (không phải 7 như spec cũ dự đoán), và khối là **TUỲ CÓ** (thiếu = 0, KHÔNG phải lỗi/null).
Đo trên toàn bộ 20 SP thật: `total_performance` 20/20 · `shop_tab_performance` 20/20 ·
`seller_product_card_performance` 20/20 · `affiliate_total_performance` 13/20 · `seller_video_performance`
3/20 · `affiliate_video_performance` 3/20 · `seller_live_performance` 2/20 · `affiliate_live_performance` 1/20.

| Khối | Trường (đầy đủ, không cắt) |
|---|---|
| `seller_video_performance` / `seller_live_performance` / `seller_product_card_performance` | `add_cart_count, add_cart_rate, add_cart_users, aov, attributed_gmv, attributed_orders, attributed_sku_orders, attributed_sold_items, click_order_rate, ctr, estimated_customers, product_clicks, product_impressions, unique_atc_rate, unique_click_order_rate, unique_clicks, unique_ctr, unique_product_impressions` (+ `new_video_count` chỉ ở `seller_video`, `new_live_count` chỉ ở `seller_live`) |
| `affiliate_total_performance` | như trên + `avg_daily_creator_posted_content` |
| `affiliate_video_performance` | `add_cart_count, add_cart_rate, atc_users, attributed_video_gmv, click_order_rate, ctr, new_video_count, product_clicks, product_impressions, unique_atc_rate, unique_click_order_rate, unique_clicks, unique_ctr, unique_product_impressions` — **KHÔNG có `orders`**, dùng `atc_users` thay `add_cart_users` |
| `affiliate_live_performance` | `add_cart_count, add_cart_rate, atc_users, click_order_rate, ctr, live_attributed_gmv, new_live_count, product_clicks, product_impressions, unique_atc_rate, unique_click_order_rate, unique_clicks, unique_ctr, unique_product_impressions` — **KHÔNG có `orders`** |
| `total_performance` | `add_cart_count, add_cart_rate, add_cart_users, aov, click_order_rate, ctr, estimated_customers, gmv, gmv_incl_tax, gross_merchandise_value, items_sold, orders, product_clicks, product_impressions, refund_customers, refunded_items, refunds, shipping_fees, sku_orders, tax, unique_atc_rate, unique_click_order_rate, unique_clicks, unique_ctr, unique_product_impressions` — **KHÔNG có `attributed_*`**, dùng `gmv`/`orders` (xác nhận đúng A5/A13 — spec cũ dự đoán `attributed_gmv`/`attributed_orders` cho khối `total` là SAI, đã sửa từ trước Task 1) |
| `shop_tab_performance` | bộ tên RIÊNG, đủ 8 trường: `estimated_shop_tab_customers, shop_tab_ctor_sku, shop_tab_ctr, shop_tab_gmv, shop_tab_product_clicks, shop_tab_product_impressions, shop_tab_sold_items, unique_shop_tab_product_clicks` — **không có "đơn"** |

## 3. Bảng "ca bắt buộc → file nào phủ"

| Ca bắt buộc (brief) | File | Bằng chứng |
|---|---|---|
| ≥1 SP thiếu khối nguồn | `shop-products.json` | SP `1729557518640450219` chỉ có 3/8 khối (`seller_product_card`, `shop_tab`, `total`) — thiếu 5/8, KHÔNG phải 2/8 như minh hoạ cũ trong brief (xem §5 lệch) |
| ≥1 ngày `sales.gross_revenue` vắng | `shop-performance.json` | ngày `2026-08-20`/`2026-08-21` KHÔNG có key `gross_revenue` (đúng thật — chỉ 5/23 ngày trong sample gốc có key này) |
| Tiền `{amount,currency}` cả 2 định dạng | `shop-performance.json` (`"220000.00"`) · `shop-lives.json` (`"0"`, không thập phân) | `sales.gmv.overall.amount = "220000.00"`; `sales_performance.gmv.amount = "0"` |
| Tỉ lệ `"0.00%"` (live) lẫn `"0.0827"`-style | `shop-lives.json` (`click_to_order_rate: "0.00%"`) · `shop-products.json` (`add_cart_rate: "0.0829"`, `ctr: "0.0725"`) | — |
| Live không có `interaction_performance` | `shop-lives.json` | cả 3 record, và toàn bộ 20/20 record thật trong `04-shop-lives-performance-202509.json` đều KHÔNG có khối này (A4: shop chưa tự live) |
| Video record `id: "0"` | `shop-videos.json` | record thứ 3, thiếu cả `duration/title/username/video_post_time/hash_tags` |
| `next_page_token` có/rỗng | `shop-products.json`/`shop-videos.json` (`"cGFnZV9udW1iZXI9MQ=="`) · `shop-lives.json` (`""`) | xem §4 |
| `total_count` | mọi file `shop-*.json` | giữ giá trị THẬT trang 1 (148/600/60), KHÔNG chỉnh khớp 3 record giữ lại |

## 4. `shop-lives.json` — trộn 2 nguồn thật (ghi rõ vì khác quy ước các file khác)

3 record (title/username đã che) lấy từ `04-shop-lives-performance-202509.json` — file này có
`next_page_token = "cGFnZV9udW1iZXI9MQ=="` (còn trang, vì gọi với `page_size=20`, 60 phiên > 20/trang).
Brief đòi ca `next_page_token` RỖNG cho fixture này (ca đã có rồi ở `shop-products`/`shop-videos`). Trang
cuối thật **có tồn tại**: probe `10-shop-lives-pagesize100.json` gọi lại đúng 60 phiên với `page_size=100`
→ `next_page_token = ""`, `total_count = 60` KHÔNG đổi (cùng dữ liệu, chỉ khác `page_size`). Fixture lấy
`next_page_token = ""` từ nguồn thật này (không bịa) — record vẫn dùng bản đã che PII đúng chuẩn từ file 04
(file 10 tự nó có 1 title chưa che ở 2 record mẫu của nó, KHÔNG dùng).

Mốc giờ VN của 3 phiên giữ lại (tính từ `start_time`/`end_time` epoch giây, verify bằng script):
**01/08 12:48:19 → 14:56:58 (7.719s)** · **06/08 13:13:33 → 13:13:36 (3s, ca biên "bấm nhầm")** ·
**07/08 19:38:16 → 20:31:13 (3.177s)**.

## 5. Lệch so với brief (sample thật thắng)

1. **Số liệu minh hoạ trong brief là VÍ DỤ cũ, không phải payload chép nguyên** — brief tự nói vậy
   ("mọi con số/id chép nguyên từ sample P0"), nhưng vài chỗ minh hoạ không khớp 100% con số thật:
   - SP `1729557518640450219` (ca "thiếu khối"): brief minh hoạ chỉ 2 khối (`total_performance`,
     `shop_tab_performance`); **thật có 3 khối** — thêm `seller_product_card_performance`. Đã dùng số
     thật (3/8, không phải 2/8).
   - Field bên trong mỗi khối `*_performance`: brief minh hoạ liệt kê rút gọn (7-11 trường/khối); **thật
     đủ 14-25 trường/khối** (bảng §2). Checkpoint controller đã chốt: **giữ nguyên xi**, không cắt như
     brief minh hoạ — đây là điểm SỬA so với 1 bản plan P0 trước (không phải so với brief hiện tại, brief
     hiện tại đã ghi đúng ý "không cắt trường" ở phần mở đầu).
   - `gmvmax-item.json` → `page_info`: brief minh hoạ `{total_number: 3, total_page: 1}` (khớp đúng 3
     record giữ lại); **thật là `{total_number: 281, total_page: 6}`** (trang 1 của tập đầy đủ 281 dòng
     item×ngày). Theo đúng quy ước "giữ tổng THẬT, cố ý khác Σ record giữ lại" áp dụng nhất quán ở mọi
     fixture khác (§1) — đã dùng số thật, KHÔNG dùng số minh hoạ của brief.
2. **`shop-lives.json` next_page_token**: xem §4 — brief muốn rỗng nhưng nguồn record gốc (file 04,
   `page_size=20`) có next_page_token thật KHÔNG rỗng; giải quyết bằng cách lấy envelope rỗng từ probe
   `page_size=100` (file 10) — vẫn là dữ liệu thật, không bịa.

## 6. `latest_available_date` theo từng endpoint (KHÔNG dùng chung 1 mốc)

| Endpoint | `latest_available_date` |
|---|---|
| `shop/performance` (202509) | `2026-08-23` |
| `shop_videos/performance` (202605) | `2026-08-23` |
| `shop_lives/performance` (202509) | `2026-08-23` |
| `shop_products/performance` (202605) | `2026-08-22` — **chậm hơn 1 ngày** so với 3 endpoint kia |
| `product/products/search` (202502, danh bạ) | không có trường này (endpoint catalog, không phải analytics) |

## 7. Mảng live = `data.live_stream_sessions` (KHÔNG phải `data.lives`)

Spec cũ dự đoán `arrayPath: ["data","lives"]` — SAI, khai vậy sẽ land 0 dòng mà KHÔNG báo lỗi. Thật là
`data.live_stream_sessions` (xác nhận trong `shop-lives.json`, key `data.live_stream_sessions`).

## 8. Ba đẳng thức đã kiểm trên payload thật (nền cho reader tính lại tỉ lệ khi cộng nhiều ngày)

`ctr = product_clicks / product_impressions` · `add_cart_rate = add_cart_count / product_clicks` ·
`click_order_rate = attributed_orders (hoặc orders ở khối total) / product_clicks`. Kiểm trên record
`1733583824365520555` (`shop-products.json`, `total_performance`): `374/5156 = 0,07254 ≈ 0,0725` ✔ ·
`31/374 = 0,08289 ≈ 0,0829` ✔ · `1/374 = 0,00267 ≈ 0,0027` ✔ (verify lại bằng Python khi build fixture,
khớp cả 3).

## 9. GMV Max item-level (`tests/fixtures/tiktokbusiness/gmvmax-item.json`)

Nguồn: `tiktok-ads/S2-khoa-day-du.json` — request dùng dimension khoá đầy đủ
`["campaign_id","item_group_id","stat_time_day"]` + metric đầy đủ
`["cost","orders","cost_per_order","gross_revenue","roi"]`. 3 dòng giữ lại nối được với `shop-products.json`
qua `item_group_id` (= product id TikTok): `1729557518640450219` (2 ngày 15/08, 16/08) và
`1729557551540701867` (1 ngày 14/08) — cả hai đều là SP "thiếu khối" trong fixture products, nên test có
thể đối chiếu chéo 2 nguồn trên cùng 3 product/item id.

**Cấp item luôn kèm `metrics.currency`** (xác nhận: cả 3 record fixture đều có `currency: "VND"`) — cấp
campaign (vd `R8-campaign+item_group.json` không lồng `stat_time_day`) trong probe gốc cũng có `currency`
khi request rõ metric `cost`; nhưng theo báo cáo P0 tiktok-ads (Phụ lục các dimension), dấu hiệu phân biệt
đáng tin cậy hơn giữa "dòng item" và "dòng campaign tổng" là sự CÓ MẶT của `item_group_id` trong
`dimensions`, không phải riêng `currency`. `roi` là **chuỗi 2 số lẻ** (`"0.00"`); `cost`/`cost_per_order`
là **chuỗi số nguyên** (không thập phân, khác tiền VND của TikTok Shop analytics).

## 11. `ngay-rong.json` — trang 0 record: sàn BỎ HẲN khoá mảng (thêm 2026-08-25, Task 5)

Đo thật ở checkpoint P2 (25/08 15:13, `shop_products/performance` hỏi ngày 26/08 — quá mốc sẵn sàng
`2026-08-22` bốn ngày): sàn trả `code=0`, `message: "Success"`, `total_count: 0` và **KHÔNG có khoá
`data.products`** (đo 2/2 endpoint). Gột PII theo quy ước §0 — envelope rỗng không có trường PII nào,
chỉ bỏ `request_id`.

**Vì sao fixture này tồn tại:** `landRaw` (`src/lib/bronze/land-raw.ts`) THROW khi không thấy mảng ở
`arrayPath`, với thông điệp *"nhiều khả năng API trả lỗi (hết hạn key / token / rate-limit)"* — **TRÙNG**
cơ chế `tiktokshop-analytics-nightly` dùng để bắt lỗi scope `105005` / tham số `36009004`. Land một ngày
ế vào là nightly đỏ với lý do SAI và người đọc log đi sai hướng cả đêm. Vì vậy workflow có cổng
`total_count === 0 ⇒ KHÔNG land` đặt **TRƯỚC** lời gọi `land`, và fixture này là lời khai khoá cổng đó
(`tests/ingest/workflow-tiktokshop-analytics-nightly.test.ts`, gồm cả ca ĐỘT BIẾN: xoá cổng khỏi bản sao
nguồn thì `land` bị gọi và nổ).

⚠️ **Đừng "sửa" fixture cho có `"products": []`.** Sàn KHÔNG trả mảng rỗng — nó bỏ hẳn khoá. Thêm mảng
rỗng vào là biến fixture thành phantom guard: test xanh trong khi đường thật vẫn vỡ.

## 10. Chưa đo (giữ nguyên từ P0, không phải việc của Task 1)

1. Độ phủ `shop_products` (`total_count=148`, chỉ SP có lượt xem trong kỳ) so với danh bạ toàn bộ SP đang
   bán (`product/products/search`, `total_count=162`) — 14 SP chênh lệch chưa xác định là "không SP nào bị
   bỏ analytics" hay "SP mới/ngừng bán" — cần kéo hết cả hai (~4 request) để đối chiếu id.
2. ~~`shop_products` trả gì cho ngày **vượt** `latest_available_date`~~ — **ĐÃ ĐO ở checkpoint P2
   (25/08)**, và kết quả NGƯỢC với phỏng đoán: vượt mốc **1–3 ngày** sàn trả `code=0` kèm **số DỞ DANG**
   (25/08: 51 SP, Σ impressions 1.530 thật, Σ GMV 0) — nguy hiểm hơn rỗng vì trông y như ngày ế thật;
   vượt xa hơn (26/08) thì `total_count=0` và **mất hẳn khoá mảng** (§11). Luật "không bao giờ hỏi ngày
   vượt mốc" GIỮ NGUYÊN, nhưng lý do là *số dở dang*, không phải *rỗng*.
