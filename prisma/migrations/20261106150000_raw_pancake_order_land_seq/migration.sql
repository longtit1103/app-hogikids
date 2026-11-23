-- Số thứ tự LAND đơn điệu cho phiên bản đơn Pancake: "RawPancakeOrder"."landSeq" + dấu phiên bản đã áp dụng
-- "Order"."rawLandSeq".
--
-- Lỗi được vá: thứ tự phiên bản đơn là `mốc updated_at DESC NULLS LAST, "fetchedAt" DESC, "id" DESC`. "fetchedAt" là
-- TIMESTAMP(3) — hai lượt land cùng đơn trùng mili-giây thì "id" (`gen_random_uuid()`) phân xử ⇒ khoảng một nửa số ca
-- bản land TRƯỚC thắng. "landSeq" lấy từ sequence, cấp ngay lúc INSERT dưới khoá land đơn ⇒ bản land sau luôn có số
-- lớn hơn; thứ tự mới chèn `"landSeq" DESC` trước `"id" DESC`.
--
-- VIẾT TAY, KHÔNG dùng câu Prisma tự sinh (`ADD COLUMN "landSeq" BIGSERIAL NOT NULL`): BIGSERIAL điền dòng cũ theo thứ
-- tự QUÉT VẬT LÝ của bảng, có thể lật bản thắng trong nhóm trùng "fetchedAt". Ở đây dòng cũ được đánh số theo ĐÚNG thứ
-- tự hiện hành `("fetchedAt", "id")` ⇒ trong mọi nhóm trùng mốc, id lớn ⇒ số lớn ⇒ bản đang thắng VẪN thắng. Đây là
-- QUY ƯỚC giữ hiện trạng, không khẳng định đó là thứ tự land thật của các dòng cũ.
-- Trạng thái cuối trùng hình dạng Prisma sinh cho `BigInt @default(autoincrement())` (bigint + DEFAULT nextval +
-- sequence OWNED BY cột) ⇒ `prisma migrate diff` sau migration này rỗng.
--
-- "Order"."rawLandSeq" chỉ được điền khi đơn khớp ĐÚNG MỘT dòng kho thô (`externalId` = `pancakeId`, `shopId` =
-- `raw->>'shop_id'`, `fetchedAt` = `rawFetchedAt`); không khớp dòng nào (đơn không mốc nguồn, mốc lệch) ⇒ NULL ⇒ CAS ghi
-- Silver rơi về luật cũ (chỉ so `rawFetchedAt`) cho tới lượt ghi kế tiếp điền số. Đơn bù từ bản sao kho
-- (`backfilledFromMirror`, `scripts/bu-don-shopee-tu-don-kho.ts`) mang `pancakeId` = `externalId` của dòng mirror
-- `AF…`, `raw.shop_id` = shop kho, `rawFetchedAt` = `fetchedAt` dòng mirror ⇒ KHỚP dòng mirror đã dựng nên nó ⇒ được
-- điền số của dòng đó (đúng cặp mốc).
-- MƠ HỒ (đơn khớp ≥ 2 dòng cùng mốc tới mili-giây): KHÔNG đoán bản nào ⇒ migration RAISE EXCEPTION, cả transaction
-- cuộn lại (không cột, không sequence). Snapshot prod 06/11: 0. Đếm trước/sau bằng bước kiểm CHỈ-ĐỌC
-- `scripts/dem-khop-moc-land-don-pancake.ts` (NOTICE không tới tai ai — `prisma migrate deploy` không in).
--
-- Một transaction: ALTER TABLE giữ ACCESS EXCLUSIVE trên hai bảng suốt lượt đánh số ⇒ deploy trong cửa sổ KHÔNG land,
-- KHÔNG có ảnh cũ ghi trên schema mới. Kiểm trước/sau, tìm lỗi gốc khi thất bại, lối `resolve --rolled-back`: runbook
-- `deploy/huong-dan-trien-khai-minipc.md` mục ③a-6.
-- Chỉ THÊM cột + sequence; P&L, quỹ, payload, kết cục không đổi.

-- KIỂM SỚM đơn MƠ HỒ, TRƯỚC `BEGIN;` — chỉ để người chạy THẤY nguyên nhân (cùng cơ chế M1
-- `20260930170000_tai_khoan_phu_phan_quyen`): Prisma gửi cả file trong một lượt simple Query; lỗi TRƯỚC `BEGIN;` tường
-- minh huỷ transaction ngầm của lượt gửi, kết nối sạch, Prisma in đúng câu RAISE. Lỗi SAU `BEGIN;` thì Prisma chỉ in
-- "current transaction is aborted" (lỗi thật nằm ở log server). Chốt THẬT là khối trong transaction ở cuối file.
DO $$
DECLARE mo_ho bigint;
BEGIN
  SELECT count(*) INTO mo_ho FROM (
    SELECT o."id" FROM "Order" o
    JOIN "RawPancakeOrder" r
      ON r."externalId" = o."pancakeId" AND r."shopId" = o.raw->>'shop_id' AND r."fetchedAt" = o."rawFetchedAt"
    GROUP BY o."id" HAVING count(*) > 1
  ) t;
  IF mo_ho > 0 THEN
    RAISE EXCEPTION 'landSeq: % đơn Silver khớp >= 2 dòng kho thô cùng mốc land (mơ hồ) — dừng, không đoán bản. Liệt kê: npx tsx scripts/dem-khop-moc-land-don-pancake.ts', mo_ho;
  END IF;
END $$;

BEGIN;

-- Chờ khoá tối đa 5 giây cho MỖI câu cần khoá (chỉ trong transaction này). Lý do: ALTER TABLE xin ACCESS EXCLUSIVE; một
-- phiên đang đọc/ghi một trong hai bảng (trang /cai-dat đối chiếu kho, lượt transform giữ `FOR UPDATE` trên `Order`)
-- làm câu ALTER CHỜ — và trong lúc chờ, MỌI câu khác chạm bảng xếp hàng SAU nó (app đứng hình), hoặc hai bên khoá
-- chéo nhau. 5 giây đủ dài để các câu ngắn thường ngày xong, đủ ngắn để hỏng nhanh thay vì treo app: hết hạn ⇒ lỗi
-- `lock_timeout`, cả migration cuộn lại, `_prisma_migrations` ghi lượt thất bại ⇒ dọn nguồn giữ khoá, `prisma migrate
-- resolve --rolled-back 20261106150000_raw_pancake_order_land_seq` rồi deploy lại.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Order" ADD COLUMN "rawLandSeq" BIGINT;
ALTER TABLE "RawPancakeOrder" ADD COLUMN "landSeq" BIGINT;

-- Sequence OWNED BY cột phải CÙNG OWNER với bảng ("sequence must have same owner as table it is linked to"). Role chạy
-- migration không nhất thiết là owner bảng (DB phục hồi từ dump mang `OWNER TO hogikids` rồi migrate bằng superuser) ⇒
-- trao sequence cho đúng owner của bảng TRƯỚC khi gắn. Chạy được ALTER TABLE ở trên nghĩa là role này là owner hoặc
-- thành viên role owner (hoặc superuser) ⇒ luôn được phép trao.
CREATE SEQUENCE "RawPancakeOrder_landSeq_seq" AS BIGINT;
DO $$
BEGIN
  EXECUTE format('ALTER SEQUENCE %I OWNER TO %I', 'RawPancakeOrder_landSeq_seq',
    (SELECT pg_get_userbyid(c.relowner) FROM pg_class c
     WHERE c.oid = to_regclass(quote_ident(current_schema()) || '."RawPancakeOrder"')));
END $$;
ALTER SEQUENCE "RawPancakeOrder_landSeq_seq" OWNED BY "RawPancakeOrder"."landSeq";

UPDATE "RawPancakeOrder" r SET "landSeq" = x.rn
FROM (SELECT "id", row_number() OVER (ORDER BY "fetchedAt", "id") AS rn FROM "RawPancakeOrder") x
WHERE x."id" = r."id";

-- Bảng rỗng ⇒ setval(seq, 1, false) ⇒ dòng đầu tiên nhận 1. Có dữ liệu ⇒ lượt nextval kế tiếp = max + 1.
SELECT setval('"RawPancakeOrder_landSeq_seq"', COALESCE(max("landSeq"), 1), max("landSeq") IS NOT NULL)
FROM "RawPancakeOrder";

ALTER TABLE "RawPancakeOrder"
  ALTER COLUMN "landSeq" SET DEFAULT nextval('"RawPancakeOrder_landSeq_seq"'),
  ALTER COLUMN "landSeq" SET NOT NULL;

UPDATE "Order" o SET "rawLandSeq" = m.seq
FROM (
  SELECT o2."id" AS oid, min(r."landSeq") AS seq, count(*) AS n
  FROM "Order" o2
  JOIN "RawPancakeOrder" r
    ON r."externalId" = o2."pancakeId" AND r."shopId" = o2.raw->>'shop_id' AND r."fetchedAt" = o2."rawFetchedAt"
  GROUP BY o2."id"
) m
WHERE m.oid = o."id" AND m.n = 1;

-- Chặn MƠ HỒ — chốt THẬT, trong transaction, SAU khi đã giữ ACCESS EXCLUSIVE hai bảng (không lượt ghi nào chen giữa
-- lúc kiểm và lúc COMMIT). Có ⇒ RAISE EXCEPTION ⇒ cả transaction cuộn lại.
DO $$
DECLARE mo_ho bigint;
BEGIN
  SELECT count(*) INTO mo_ho FROM (
    SELECT o."id" FROM "Order" o
    JOIN "RawPancakeOrder" r
      ON r."externalId" = o."pancakeId" AND r."shopId" = o.raw->>'shop_id' AND r."fetchedAt" = o."rawFetchedAt"
    GROUP BY o."id" HAVING count(*) > 1
  ) t;
  IF mo_ho > 0 THEN
    RAISE EXCEPTION 'landSeq: % đơn Silver khớp >= 2 dòng kho thô cùng mốc land (mơ hồ) — dừng, không đoán bản. Liệt kê: npx tsx scripts/dem-khop-moc-land-don-pancake.ts', mo_ho;
  END IF;
END $$;

COMMIT;
