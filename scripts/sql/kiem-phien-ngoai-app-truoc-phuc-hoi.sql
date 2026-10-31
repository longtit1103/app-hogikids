-- CHỈ ĐỌC. Liệt kê phiên của role app (`hogikids`) trên DB đích mà lượt "Phục hồi" trong app KHÔNG loại trừ được.
--
-- Vì sao cần: nút Phục hồi trong app chỉ thấy (a) tiến trình app trong container (cửa ghi + drain) và
-- (b) script CLI dựng client qua `taoPrismaClient` (khoá ghi chung, `application_name` tiền tố `hogikids-cli`).
-- `next dev` trên máy dev trỏ DB prod, Prisma Studio, client khác nối bằng role app đều là kết nối KHÁC,
-- không giữ khoá, không đi qua cờ trong RAM của container — nên phải nhìn thẳng `pg_stat_activity`.
--
-- Một dòng ở kết quả = một phiên role `hogikids` KHÔNG thuộc:
--   (a) pool app trong container  — nhận bằng `client_addr` = IP container (`-v app_ip=…`). KHÔNG nhận bằng
--       `application_name`: pool app không đặt tên riêng, và `next dev` ở máy dev chạy CÙNG singleton nên
--       nếu có tên cũng trùng tên pool app — tên không phân biệt được hai bên, địa chỉ thì được;
--   (b) phiên CLI                 — `application_name LIKE 'hogikids-cli%'` (đã có khoá chung + nút "Cắt phiên");
--   (c) phiên restore             — `application_name LIKE 'hogikids-restore%'`.
-- Cột `dang_ghi` = phiên đang giữ transaction đã ghi (`backend_xid` có giá trị). KHÔNG có `backend_xid` KHÔNG
-- có nghĩa phiên vô hại: Studio/`next dev` đang rảnh vẫn ghi được bất cứ lúc nào — tắt hẳn chúng trước.
-- Không in câu query đang chạy (có thể chứa dữ liệu).
--
-- Chạy (ssh, chỉ đọc; `app_ip` = IP container app, lấy bằng `docker inspect`; container đã dừng ⇒ `-v app_ip=dung`):
--   docker exec -i supabase-db psql -U supabase_admin -d postgres -X -v ON_ERROR_STOP=1 -v app_ip=<IP> \
--     < scripts/sql/kiem-phien-ngoai-app-truoc-phuc-hoi.sql
-- Đích khác `postgres` (DB nháp): đổi `-d`. Role app khác `hogikids`: thêm `-v app_role=<tên>`.

\if :{?app_ip}
\else
  \echo 'THIẾU -v app_ip=<IP container app> (hoặc -v app_ip=dung khi container đã dừng) — không chạy.'
  \quit
\endif
\if :{?app_role}
\else
  \set app_role hogikids
\endif

BEGIN TRANSACTION READ ONLY;

\echo '== Phiên role app NGOÀI pool container / CLI / restore (0 dòng = sạch) =='
SELECT a.pid,
       a.application_name,
       a.client_addr,
       a.backend_start,
       a.state,
       a.xact_start,
       (a.backend_xid IS NOT NULL) AS dang_ghi,
       count(*) OVER () AS tong_phien_ngoai_app,
       count(*) FILTER (WHERE a.backend_xid IS NOT NULL) OVER () AS tong_dang_ghi
  FROM pg_stat_activity a
 WHERE a.datname = current_database()
   AND a.usename = :'app_role'
   AND a.backend_type = 'client backend'
   AND a.pid <> pg_backend_pid()
   AND a.application_name NOT LIKE 'hogikids-cli%'
   AND a.application_name NOT LIKE 'hogikids-restore%'
   -- host(NULL) (kết nối unix socket) là NULL ⇒ IS DISTINCT FROM giữ dòng đó lại, không lọt lưới.
   AND host(a.client_addr) IS DISTINCT FROM :'app_ip'
 ORDER BY a.backend_start, a.pid;

ROLLBACK;
