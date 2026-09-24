-- LỆCH SONG SINH đo được 22/09/2026, bản TS từng MÙ còn bản bash thì bắt được.
-- `stripSqlComments` KHÔNG theo dõi dollar-quote ⇒ dấu `/*` đặt trong thân `$$…$$` mở comment và
-- nuốt mọi câu tới `*/`. Bản soi của guard (i)/(j) khi đó chỉ còn `SELECT $$   $$;`, trong khi
-- psql coi `$$ /* $$` là CHUỖI nên vẫn chạy trọn 2 câu ở giữa.
SELECT $$ /* $$;
COPY (SELECT 1) TO PROGRAM 'touch /tmp/PWNED';
CREATE ROLE ke_gian SUPERUSER LOGIN;
SELECT $$ */ $$;
