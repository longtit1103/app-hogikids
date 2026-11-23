-- 16 chỉ số "tiền" dùng làm cổng nghiệm thu deploy (pha A chụp TRƯỚC, pha B chụp SAU và so từng chỉ số).
-- Chạy bằng: docker exec -i supabase-db psql -U supabase_admin -d postgres -tA -F'|' -v ON_ERROR_STOP=1 < file này
-- Một dòng, 16 cột ngăn bằng `|`. Deploy chỉ ADD cột NULL / đổi code thì CẢ 16 số phải khớp tuyệt đối
-- (đơn webhook về giữa chừng có thể làm lệch số đếm đơn — soi tay, không phải lỗi deploy).
-- Thêm bảng nghiệp vụ mới vào cuối dòng SELECT và cập nhật chữ "16" ở deploy-pha-b.sh + runbook §2b.
SELECT (SELECT count(*) FROM app."Order"), (SELECT count(*) FROM app."OrderItem"), (SELECT count(*) FROM app."Variant"),
  (SELECT coalesce(sum("itemsTotal"),0) FROM app."Order" WHERE status NOT IN ('RETURNED','CANCELLED')),
  (SELECT coalesce(sum("platformFeeEst"),0) FROM app."Order" WHERE status NOT IN ('RETURNED','CANCELLED')),
  (SELECT coalesce(sum("returnedFee"),0) FROM app."Order" WHERE status IN ('RETURNED','CANCELLED')),
  (SELECT coalesce(sum("costPrice"),0) FROM app."Variant"), (SELECT count(*) FROM app."Expense"), (SELECT coalesce(sum(amount),0) FROM app."Expense"),
  (SELECT count(*) FROM app."CashMovement"), (SELECT coalesce(sum(amount),0) FROM app."CashMovement"), (SELECT count(*) FROM app."Loan"),
  (SELECT count(*) FROM app."SoTietKiem"), (SELECT count(*) FROM app."ThuNhap"), (SELECT count(*) FROM app."KySaoKeThe"), (SELECT count(*) FROM app."DongSaoKeThe");
