-- Hand-crafted: meta-command psql chạy shell. psql thực thi `\!` khi nạp file bằng -f/stdin
-- và KHÔNG có cờ nào tắt được. Đích `app` phải TỪ CHỐI.
SET statement_timeout = 0;
\! id
CREATE TABLE app."Order" (id bigint NOT NULL);
