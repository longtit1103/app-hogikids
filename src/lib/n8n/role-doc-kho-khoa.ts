/**
 * Role CHỈ-ĐỌC của n8n trên bảng kho khoá `Setting`.
 *
 * Tên phải khớp CHÍNH XÁC hằng cùng tên trong `deploy/restore.sh` và câu tạo role trong
 * `n8n/huong-dan-cai-dat-workflows.md`. Bash và TypeScript không dùng chung được một hằng, nên có
 * test đọc chéo 2 file: lệch chữ là đỏ ngay, không phải chờ tới lượt phục hồi thật mới biết.
 *
 * Đặt riêng một file để đúng MỘT định nghĩa phục vụ cả hai phía dùng nó: đường phục hồi
 * (`lib/backup/run-restore.ts` — cấp lại quyền sau khi restore xoá mất) và ô cảnh báo trên
 * `/cai-dat` (`lib/n8n/quyen-doc-kho-khoa.ts` — báo khi quyền đó đang thiếu).
 */
export const N8N_RO_ROLE = "n8n_config_ro";

/**
 * VIEW mà role trên được SELECT — KHÔNG phải bảng `Setting` gốc (đổi 2026-08-21, phase 2
 * clone-and-go): từ khi `Setting` chứa cả `n8nApiKey` (khoá quản trị CỦA CHÍNH n8n) và
 * `n8nDbRoPassword`, cấp SELECT toàn bảng nghĩa là ai chiếm được n8n có luôn khoá tạo/sửa
 * workflow trên chính nó (chạy JS tuỳ ý — leo thang 2 chiều).
 *
 * Từ 21/09/2026 view chuyển sang **allowlist** (`KEY_N8N_DUOC_DOC` bên dưới): nó chỉ trả đúng
 * các key workflow thật sự đọc, không còn "trả tất trừ vài cái".
 */
export const N8N_SETTING_VIEW = "SettingN8n";

/**
 * Các key n8n ĐƯỢC ĐỌC qua view trên — **allowlist, fail-closed** (đảo chiều 21/09/2026, đợt 2
 * audit bảo mật, mục H-06). Nguồn TS duy nhất, có test đọc chéo với chính SQL migration tạo view.
 *
 * Trước đây đây là danh sách ngược — các key BỊ GIẤU — nên mọi key khác MẶC ĐỊNH LỘ. Đo 21/09:
 * bảng `Setting` prod có 45 key, view phơi 43, trong đó có `metaAdsAccessToken`,
 * `tiktokShopRefreshToken`, `metaAdsAppSecret`, `n8nSyncNowSecret` — n8n không đọc key nào trong
 * số đó, nhưng ai chiếm được n8n thì có trọn kho token 4 nền tảng.
 *
 * Danh sách này KHÔNG phải phỏng đoán: nó là tập key trong mệnh đề `where key in (...)` của 11
 * workflow đang chạy trên n8n prod (đo qua Public API), khớp tuyệt đối 10 file `n8n/*.json`.
 *
 * ⚠️ **Thêm key mới mà quên cập nhật ở đây = workflow chết CÂM** (node lấy khoá trả thiếu dòng,
 * không có lỗi nào đỏ). Đó là cái giá của fail-closed, và nó được chặn bằng cổng thật:
 * `tests/unit/n8n/allowlist-kho-khoa-n8n.test.ts` soi mọi câu SQL trong `n8n/*.json` và bắt đỏ
 * ngay tại chỗ nếu có key nằm ngoài danh sách này. Sửa workflow thì sửa luôn danh sách này +
 * viết migration `CREATE OR REPLACE VIEW`, cả hai đều có test đọc chéo.
 */
export const KEY_N8N_DUOC_DOC = [
  // hạ tầng: n8n gọi ngược về app
  "n8nAppUrl",
  "n8nIngestSecret",
  // bearer RIÊNG cho 2 route kho token (`/api/ingest/*-token`) — tách khỏi `n8nIngestSecret`
  // 21/09/2026, mục M-02: một khoá vạn năng nghĩa là ai đọc được nó (mọi workflow, `ps aux` của
  // script chạy tay) đều GET được token OAuth 4 nền tảng ở dạng nguyên văn.
  "n8nTokenVaultSecret",
  // Pancake: 3 shop
  "pancakeApiKeyKho",
  "pancakeApiKeyShopee",
  "pancakeApiKeyTiktok",
  "pancakeShopIdKho",
  "pancakeShopIdShopee",
  "pancakeShopIdTiktok",
  // Meta Ads — token đi đường riêng qua /api/ingest/meta-token, KHÔNG qua view
  "metaAdsAccountId",
  "metaAdsManualDays",
  // TikTok Shop — token đi qua /api/ingest/tiktok-token
  "tiktokShopAppKey",
  "tiktokShopAppSecret",
  "tiktokShopCipher",
  "tiktokShopShopId",
  "tiktokShopManualDays",
  "tiktokShopAnalyticsManualDays",
  "tiktokShopAffiliateManualDays",
  // TikTok Business (Ads)
  "tiktokBusinessAppId",
  "tiktokBusinessAppSecret",
  "tiktokBusinessToken",
  "tiktokBusinessManualDays",
] as const;

/** Migration đảo view sang allowlist — test đọc chéo neo vào đúng file này. */
export const MIGRATION_VIEW_N8N_ALLOWLIST =
  "prisma/migrations/20260921130000_setting_n8n_view_allowlist/migration.sql";
