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
 * workflow trên chính nó (chạy JS tuỳ ý — leo thang 2 chiều). View loại đúng 2 key đó, mọi
 * key nguồn dữ liệu khác vẫn đọc được như cũ.
 */
export const N8N_SETTING_VIEW = "SettingN8n";

/**
 * Các key bị GIẤU khỏi view trên — nguồn TS duy nhất, có test đọc chéo với chính SQL migration
 * tạo view (danh sách nằm trong một migration đã đóng băng; thêm key bí mật mới vào `Setting`
 * mà quên viết migration `CREATE OR REPLACE VIEW` thì key đó MẶC ĐỊNH LỘ cho n8n — test nhắc).
 */
export const KEY_AN_KHOI_N8N = ["n8nApiKey", "n8nDbRoPassword"] as const;
