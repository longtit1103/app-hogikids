-- Hand-crafted: động từ dòng trên, qualifier schema HỆ THỐNG dòng dưới.
-- Guard (b) grep line-based bỏ lọt vì verb và `auth.` khác dòng. Đích `app` phải TỪ CHỐI.
SET statement_timeout = 0;
TRUNCATE
  auth.users;
