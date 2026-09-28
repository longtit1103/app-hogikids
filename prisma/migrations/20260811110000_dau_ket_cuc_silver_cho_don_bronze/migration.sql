-- Bronze commit trong một transaction, transform ghi Silver ở transaction khác. Tiến trình
-- chết cứng (OOM / restart container lúc deploy) ở giữa thì đơn nằm lại Bronze VĨNH VIỄN mà không
-- một cờ nào bật: lượt n8n gửi lại đúng trang đó trùng `payloadHash` ⇒ không land lại ⇒ transform
-- nhận danh sách rỗng ⇒ HTTP 200 sạch trơn. Đo thật: land 128ms còn transform 6133ms cho một
-- trang 50 đơn, tức ~98% thời gian xử lý nằm SAU thời điểm Bronze đã bền vững.
--
-- Ba cột metadata ghi KẾT CỤC của từng dòng — payload gốc KHÔNG BAO GIỜ bị sửa, đúng khuôn đã
-- dùng cho `processedAs`/`processedNote` của hộp thư webhook:
--   `silverOutcome`     : APPLIED | EXCLUDED_MIRROR | SUPERSEDED | FAILED_SHAPE | LEGACY.
--                         NULL = chưa hoàn tất HOẶC gặp lỗi chưa phân loại được ⇒ ĐƯỢC RETRY
--                         tự động ở lượt đối soát đêm. Đây là trạng thái MẶC ĐỊNH của dòng mới:
--                         hỏng thì hỏng CÓ TIẾNG, không hỏng im.
--   `silverProcessedAt` : lúc đóng dấu kết cục (NULL khi chưa đóng).
--   `silverNote`        : lý do cho ca cần người xem — hiển thị ở /cai-dat.
--
-- Vì sao `FAILED_SHAPE` tách riêng khỏi NULL: payload Bronze bất biến nên map hỏng là lỗi TẤT
-- ĐỊNH — đêm nào retry cũng hỏng y hệt. Gộp vào NULL thì dòng đó nằm mãi trong nhóm "phải retry",
-- cảnh báo đỏ dính vĩnh viễn rồi bị bỏ qua (đúng chế độ hỏng mà bộ đếm `boQuaCoChuDich` từng sinh
-- ra để tránh). Lỗi ghi DB / mạng thì NGƯỢC LẠI — tự lành được, nên phải ở NULL để còn thử tiếp.
--
-- DEFAULT tạm 'LEGACY' rồi BỎ NGAY: mọi dòng ĐANG CÓ nhận nhãn "có trước migration, chờ phân
-- loại" (không được coi là đã hạch toán — chưa ai kiểm), còn dòng land SAU migration nhận NULL.
-- Cột nullable không DEFAULT là thao tác chỉ-đổi-metadata trên Postgres 11+ (đo prod: 1293 dòng /
-- 9 MB, PG 15.8) nên khoá ACCESS EXCLUSIVE chỉ giữ vài mili-giây.
--
-- CỐ Ý KHÔNG thêm index: lượt đối soát phải lấy bản mới nhất theo (shopId, externalId) bằng
-- DISTINCT ON — câu đó quét cả bảng dù có index trên `silverOutcome` hay không, nên index chỉ
-- tốn chỗ ghi mà không đổi kế hoạch truy vấn. Thêm khi nào bảng đủ lớn để đo được khác biệt.

-- AlterTable
ALTER TABLE "RawPancakeOrder" ADD COLUMN "silverOutcome" TEXT DEFAULT 'LEGACY';
ALTER TABLE "RawPancakeOrder" ADD COLUMN "silverProcessedAt" TIMESTAMP(3);
ALTER TABLE "RawPancakeOrder" ADD COLUMN "silverNote" TEXT;

ALTER TABLE "RawPancakeOrder" ALTER COLUMN "silverOutcome" DROP DEFAULT;
