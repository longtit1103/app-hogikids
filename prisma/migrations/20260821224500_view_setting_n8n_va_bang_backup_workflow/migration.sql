-- Phase 2 clone-and-go: (1) bảng backup workflow n8n trước khi provisioning PUT đè;
-- (2) view "SettingN8n" — kho khoá cho n8n, LOẠI 2 khoá hạ tầng; (3) chuyển quyền role
-- n8n_config_ro từ bảng gốc sang view; (4) seed n8nCredentialId cho prod (có điều kiện).

-- (1) Hiện vật khôi phục cho lượt "Cài / cập nhật workflows" (xem model trong schema.prisma).
CREATE TABLE "N8nWorkflowBackup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "N8nWorkflowBackup_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "N8nWorkflowBackup_name_createdAt_idx" ON "N8nWorkflowBackup"("name", "createdAt");

-- (2) View kho khoá cho n8n. EXCLUDE-list thay whitelist là CỐ Ý: thêm key nguồn dữ liệu mới
-- (chuyện xảy ra thường xuyên) không được đòi sửa migration — quên là workflow chết câm, đúng
-- lớp lỗi "khoá chưa được nạp" vừa gặp 21/08. Chỉ 2 khoá bị giấu:
--   n8nApiKey        — khoá quản trị n8n Public API: n8n đọc được chính nó = ai chiếm n8n tạo
--                      workflow tuỳ ý (chạy JS trên host), leo thang 2 chiều.
--   n8nDbRoPassword  — mật khẩu của CHÍNH role đang đọc view này.
-- Tên view phải khớp N8N_SETTING_VIEW (src/lib/n8n/role-doc-kho-khoa.ts) + restore.sh.
CREATE VIEW "SettingN8n" AS
  SELECT key, value FROM "Setting" WHERE key NOT IN ('n8nApiKey', 'n8nDbRoPassword');

-- (3) Chuyển quyền — CÓ ĐIỀU KIỆN role tồn tại (DB trắng của bản clone chạy migrate TRƯỚC khi
-- setup script tạo role ⇒ GRANT thẳng sẽ gãy cả lượt migrate).
-- ⚠️ REVOKE chỉ gỡ được grant do CHÍNH role chạy migration (hogikids) cấp; grant cấp bởi
-- supabase_admin (đường restore.sh cũ) phải gỡ thêm 1 lần bằng psql admin — bước này nằm trong
-- checklist rollout của plan (phase 5), và test quyền sau deploy sẽ lộ nếu quên.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'n8n_config_ro') THEN
    EXECUTE 'GRANT SELECT ON "SettingN8n" TO n8n_config_ro';
    EXECUTE 'REVOKE ALL ON "Setting" FROM n8n_config_ro';
  END IF;
END
$$;

-- (4) Credential Postgres hiện hành trên n8n prod — n8n Public API KHÔNG có endpoint liệt kê
-- credential nên provisioning neo bằng id lưu sẵn ở đây; bản clone (DB trắng) không nhận gì,
-- provisioning của họ sẽ POST credential mới rồi tự ghi id.
INSERT INTO "Setting" (key, value)
SELECT 'n8nCredentialId', 'id-credential-cua-instance-goc'
WHERE EXISTS (SELECT 1 FROM "RawPancakeOrder")
ON CONFLICT (key) DO NOTHING;
