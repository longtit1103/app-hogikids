-- Guard (j): câu lệnh ĐẶC QUYỀN. Dump schema-scoped (`pg_dump -n app`) không bao giờ phát ra;
-- chúng chỉ có trong dump full-DB hoặc file chế tác. Ở đường bash, file này chạy bằng
-- `psql -U supabase_admin` (superuser THẬT) nên mọi câu dưới đây đều thành công.
SET statement_timeout = 0;
CREATE TABLE app."Order" (id bigint NOT NULL);
ALTER ROLE hogikids WITH SUPERUSER;
