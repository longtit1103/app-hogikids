-- Thêm khoá `tiktokBusinessHoaDonTuNgay` vào allowlist view kho khoá n8n.
--
-- Workflow `tiktok-business-nightly` đọc khoá này để KÉO BÙ hoá đơn TikTok: chủ shop/vận hành đặt
-- "YYYY-MM-DD" (giờ VN) rồi Chạy tay ⇒ mốc đầu cửa sổ hoá đơn lùi về ngày đó, lượt vẫn gửi dấu lượt
-- mang đúng phạm vi đã hỏi TikTok để cổng chốt sao kê thẻ nhận làm bằng chứng phủ ngày sao kê.
-- Không phải bí mật (chỉ là một ngày). Danh sách khớp `KEY_N8N_DUOC_DOC` trong
-- `src/lib/n8n/role-doc-kho-khoa.ts` (test đọc chéo) và `KEY_N8N_DUOC_DOC` trong `deploy/restore.sh`.
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
    'tiktokBusinessAppId', 'tiktokBusinessAppSecret', 'tiktokBusinessToken', 'tiktokBusinessManualDays',
    -- TikTok Business: kéo bù hoá đơn từ một ngày (khối dấu lượt hoá đơn)
    'tiktokBusinessHoaDonTuNgay'
  );

-- Đặt lại tường minh (xem migration 20260921130000 + 20260822011500): thiếu security_barrier thì
-- allowlist vẫn bị moi qua thông báo lỗi.
ALTER VIEW "SettingN8n" SET (security_barrier = true);
