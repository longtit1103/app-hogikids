-- security_barrier cho view kho khoá của n8n (review 22/08): view thường bị Postgres inline và
-- xếp qual theo chi phí — kẻ chạy SQL bằng chính role n8n_config_ro (đúng threat model của view)
-- có thể đặt một qual rẻ chạy TRƯỚC mệnh đề `key NOT IN (...)` để moi giá trị 2 key bị giấu qua
-- thông báo lỗi (vd `WHERE value::int > 0` → "invalid input syntax ... <giá trị n8nApiKey>").
-- security_barrier ép mệnh đề của view chạy trước mọi qual người gọi đưa vào.
ALTER VIEW "SettingN8n" SET (security_barrier = true);
