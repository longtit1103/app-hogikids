-- CA ÂM cho guard (i) — PHẢI ĐƯỢC CHẤP NHẬN.
-- Chữ "program" xuất hiện ở 3 chỗ VÔ HẠI mà một dump thật hoàn toàn có thể có:
--   1. tên CỘT (`program`) — DB nào có mục marketing cũng dễ đặt tên này;
--   2. DỮ LIỆU bên trong khối COPY (text tab-phân-tách);
--   3. literal nháy đơn và comment.
-- Từ chối oan ở đây = chủ shop mất đường phục hồi đúng lúc cần nhất.
SET statement_timeout = 0;
CREATE TABLE app."Campaign" (id bigint NOT NULL, program text, note text);
INSERT INTO app."Campaign" (id, program, note) VALUES (1, 'affiliate program', 'copy from program list');
COPY app."Campaign" (id, program, note) FROM stdin;
2	loyalty program	nhap tu program cu
3	\N	copy to program ghi chu
\.
ALTER TABLE app."Campaign" ADD COLUMN extra text;
