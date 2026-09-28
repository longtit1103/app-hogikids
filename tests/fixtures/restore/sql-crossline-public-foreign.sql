-- Hand-crafted: động từ dòng trên, object schema NGOÀI đích (public) dòng dưới.
-- Guard (e) awk neo verb đầu dòng nên head không có `.` → bỏ lọt. Đích `app` phải TỪ CHỐI.
SET statement_timeout = 0;
CREATE TABLE
  public."Order" (id bigint NOT NULL);
