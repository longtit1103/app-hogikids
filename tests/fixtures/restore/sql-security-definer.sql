-- Guard (j), biến thể lặng lẽ nhất: hàm SECURITY DEFINER nằm gọn TRONG schema đích nên
-- (a)/(b)/(e) đều cho qua, nhưng nó chạy với quyền của owner (sau DR là `supabase_admin`).
SET statement_timeout = 0;
CREATE FUNCTION app.leo_thang() RETURNS void AS $$
BEGIN
  EXECUTE 'GRANT ALL ON SCHEMA app TO PUBLIC';
END
$$ LANGUAGE plpgsql SECURITY DEFINER;
