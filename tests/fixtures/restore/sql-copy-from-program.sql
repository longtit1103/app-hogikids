-- Guard (i): COPY … FROM PROGRAM = chạy lệnh hệ điều hành dưới quyền server.
-- Không có ký tự `\` nào nên guard (g) (meta-command psql) KHÔNG bắt được;
-- TOC của bản .dump tương đương cũng hợp lệ (chỉ schema app) nên guard TOC cũng mù.
SET statement_timeout = 0;
CREATE TABLE app."Order" (id bigint NOT NULL, note text);
COPY app."Order" (id, note) FROM PROGRAM 'curl -s http://169.254.169.254/ | logger';
