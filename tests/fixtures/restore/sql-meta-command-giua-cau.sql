-- Hand-crafted: meta-command nằm GIỮA câu (không ở đầu dòng) — biến thể guard neo-đầu-dòng
-- bỏ lọt ca này. `\g | sh` đổ kết quả câu lệnh vào shell. Đích `app` phải TỪ CHỐI.
SET statement_timeout = 0;
SELECT 1 \g | sh -c 'id'
