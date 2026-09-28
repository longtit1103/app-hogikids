-- Đợt 2 audit bảo mật (H-06): ĐẢO CHIỀU view kho khoá của n8n từ FAIL-OPEN sang FAIL-CLOSED.
--
-- Trước: `key NOT IN ('n8nApiKey','n8nDbRoPassword')` — allowlist các key BỊ GIẤU, nghĩa là mọi
-- key khác MẶC ĐỊNH LỘ. Thêm một bí mật mới vào `Setting` mà quên viết migration là nó lộ ngay
-- cho n8n; chỗ duy nhất nhắc là một test, mà test nhắc là quy trình chứ không phải cổng chặn.
-- Số đo 21/09: bảng `Setting` prod có 45 key, view cũ phơi 43 — trong đó có `metaAdsAccessToken`,
-- `metaAdsAppSecret`, `tiktokShopAccessToken`, `tiktokShopRefreshToken`, `n8nSyncNowSecret`.
-- Chiếm được n8n là có trọn kho token 4 nền tảng, trong khi n8n KHÔNG đọc một key nào trong số đó.
--
-- Nay: allowlist các key ĐƯỢC ĐỌC. Danh sách dưới đây KHÔNG phải phỏng đoán — nó là tập hợp mọi
-- key xuất hiện trong mệnh đề `where key in (...)` của 11 workflow ĐANG CHẠY trên n8n prod (đo
-- 21/09 qua Public API, đường nội bộ 127.0.0.1:5678), và khớp tuyệt đối với 10 file `n8n/*.json`
-- trong repo. Đúng 21 key, cộng `n8nTokenVaultSecret` mà đợt này thêm vào (M-02) ⇒ 22.
--
-- Nỗi lo chính đáng của quyết định cũ ("quên key mới ⇒ workflow chết CÂM") nay có cổng chặn thật:
-- `tests/unit/n8n/allowlist-kho-khoa-n8n.test.ts` đọc mọi câu SQL trong `n8n/*.json` và bắt đỏ
-- nếu có key nằm ngoài allowlist. Quên là test đỏ tại chỗ, không phải chờ workflow chết lúc 2h sáng.
--
-- Tên view + danh sách key phải khớp `src/lib/n8n/role-doc-kho-khoa.ts` (có test đọc chéo).
CREATE OR REPLACE VIEW "SettingN8n" AS
  SELECT key, value FROM "Setting" WHERE key IN (
    -- hạ tầng: n8n gọi ngược về app
    'n8nAppUrl', 'n8nIngestSecret',
    -- bearer riêng cho 2 route kho token (M-02) — n8n cần đọc, app cấp qua env TOKEN_VAULT_SECRET
    'n8nTokenVaultSecret',
    -- Pancake: 3 shop
    'pancakeApiKeyKho', 'pancakeApiKeyShopee', 'pancakeApiKeyTiktok',
    'pancakeShopIdKho', 'pancakeShopIdShopee', 'pancakeShopIdTiktok',
    -- Meta Ads (token đi đường riêng qua /api/ingest/meta-token, KHÔNG qua view)
    'metaAdsAccountId', 'metaAdsManualDays',
    -- TikTok Shop (token đi qua /api/ingest/tiktok-token)
    'tiktokShopAppKey', 'tiktokShopAppSecret', 'tiktokShopCipher', 'tiktokShopShopId',
    'tiktokShopManualDays', 'tiktokShopAnalyticsManualDays', 'tiktokShopAffiliateManualDays',
    -- TikTok Business (Ads)
    'tiktokBusinessAppId', 'tiktokBusinessAppSecret', 'tiktokBusinessToken', 'tiktokBusinessManualDays'
  );

-- `CREATE OR REPLACE VIEW` giữ nguyên reloptions, nhưng đặt lại tường minh để lượt dựng từ đầu
-- (DB trắng chạy tuần tự các migration) không phụ thuộc thứ tự: thiếu security_barrier thì kẻ chạy
-- SQL bằng chính role n8n_config_ro có thể đặt một qual rẻ chạy TRƯỚC mệnh đề lọc của view để moi
-- giá trị key bị giấu qua thông báo lỗi (xem migration 20260822011500).
ALTER VIEW "SettingN8n" SET (security_barrier = true);
