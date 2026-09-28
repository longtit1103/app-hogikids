-- MỐC NGUỒN cho đơn: `fetchedAt` của dòng kho thô đã dựng nên bản Silver này.
--
-- Vì sao cần: bước dựng Silver cố ý nằm NGOÀI khoá land (giữ khoá suốt cả bước upsert thì mọi
-- webhook sau phải xếp hàng chờ). Hệ quả: hai lượt dựng Silver của CÙNG một đơn có thể ghi ngược
-- thứ tự — lượt đọc bản mới bị hệ điều hành cho ngủ, lượt đọc bản cũ ghi sau và thắng. Cột này là
-- SỐ PHIÊN BẢN để phép ghi tự từ chối bản cũ.
--
-- Additive + nullable ⇒ KHÔNG đụng một dòng dữ liệu nào đang có. Đơn cũ mang NULL và được coi là
-- "chưa biết phiên bản" nên lượt ghi kế tiếp vẫn đè bình thường (tự lành dần).
ALTER TABLE "Order" ADD COLUMN "rawFetchedAt" TIMESTAMP(3);
