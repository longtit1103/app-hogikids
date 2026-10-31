-- doi-chieu-expense-ads-voi-ban-dau-bronze.sql — CHỈ ĐỌC. Chạy TRƯỚC mọi lượt "Dựng lại từ kho thô" (nút Cài đặt hoặc
-- `scripts/rebuild-from-raw.ts`) trên prod, kể từ bản có cột "lanThayCuoi".
--
-- VÌ SAO: lượt dựng lại GHI ĐÈ `Expense` chi tiêu ads (source ADS_API, ngày ≥ mốc Nợ phải trả M) bằng BẢN ĐỨNG ĐẦU
-- của kho thô báo cáo ads (Meta + TikTok Business). Hai nguồn lệch có thể khiến P&L ads đổi mà không ai báo:
--  1. Đầu bảng nay xếp theo mốc phiên bản COALESCE("mocChup","lanThayCuoi","fetchedAt") — nguồn trả lại nội dung cũ (A→B→A)
--     SAU khi deploy thì đầu bảng là A (cột "dau_doi" = true: dựng lại sẽ ra số khác thứ tự cũ).
--  2. A→B→A xảy ra TRƯỚC deploy không để lại dấu: đầu bảng vẫn là B, trong khi đêm đó `/api/ingest/ads` đã ghi số A
--     vào sổ ⇒ dựng lại kéo sổ về số B (cột "lech" khác 0 dù "dau_doi" = false).
-- Có dòng ⇒ ghi vào checklist nghiệm thu, chủ shop duyệt TRƯỚC khi bấm dựng lại. Không có dòng ⇒ dựng lại không đổi
-- chi phí ads.
--
-- Số "dung_lai_moi"/"dung_lai_cu" MÔ PHỎNG đúng luật dựng lại: refId như `prepareAdsExpenseRow`; tiền = round(chi
-- tiêu chưa VAT × (1 + VAT)); VAT Meta 10% (`VAT_META`); VAT TikTok theo THÁNG từ bản mới nhất mỗi hoá đơn Business
-- Center (Σ|tax_amount| / Σ|subtotal| của loại BILL|PAYMENT, ngoài dải 3–20% ⇒ tháng đó KHÔNG dựng lại = NULL, tháng
-- không có hoá đơn ⇒ 10%) — `buildVatByMonth`. Làm tròn numeric của Postgres có thể lệch 1đ với JS ở ca .5 ⇒ chỉ báo
-- |lech| > 1. Dòng sổ source khác ADS_API (chủ shop ghi đè bằng file / nhập tay) dựng lại KHÔNG đụng — vẫn liệt kê để
-- đối chiếu, cột "dung_lai_cham" = false.
--
-- "dung_lai_moi" NULL = tháng có VAT đo được ngoài dải (dựng lại BỎ, sổ giữ nguyên) hoặc chi tiêu không đọc được.
-- Toán tử ->> phải bọc ngoặc khi nối chuỗi (|| cùng mức ưu tiên, kết hợp trái — không bọc là nối nhầm jsonb).
--
-- Chạy:
--   docker exec -i supabase-db psql -U supabase_admin -d postgres -X -v ON_ERROR_STOP=1 \
--     < scripts/sql/doi-chieu-expense-ads-voi-ban-dau-bronze.sql
SET search_path = app;
BEGIN TRANSACTION READ ONLY;

WITH moc AS (
  -- M ("yyyy-MM-dd" giờ VN); chưa bật ⇒ mọi ngày (dựng lại ghi đủ mọi ngày).
  SELECT COALESCE(NULLIF(trim((SELECT value FROM "Setting" WHERE key = 'noPhaiTraTuNgay')), ''), '0001-01-01') AS m
),
meta_moi AS (
  SELECT DISTINCT ON ("shopId", "externalId") "shopId", "externalId", "payloadHash", payload
  FROM "RawMetaAdsReport"
  ORDER BY "shopId", "externalId", COALESCE("mocChup", "lanThayCuoi", "fetchedAt") DESC, "id" DESC
),
meta_cu AS (
  SELECT DISTINCT ON ("shopId", "externalId") "shopId", "externalId", "payloadHash", payload
  FROM "RawMetaAdsReport"
  ORDER BY "shopId", "externalId", "fetchedAt" DESC, "id" DESC
),
tt_moi AS (
  SELECT DISTINCT ON ("shopId", "externalId") "shopId", "externalId", "payloadHash", payload
  FROM "RawTiktokBusinessReport"
  ORDER BY "shopId", "externalId", COALESCE("mocChup", "lanThayCuoi", "fetchedAt") DESC, "id" DESC
),
tt_cu AS (
  SELECT DISTINCT ON ("shopId", "externalId") "shopId", "externalId", "payloadHash", payload
  FROM "RawTiktokBusinessReport"
  ORDER BY "shopId", "externalId", "fetchedAt" DESC, "id" DESC
),
hoa_don AS (
  SELECT DISTINCT ON ("shopId", "externalId") payload
  FROM "RawTiktokBusinessInvoice"
  ORDER BY "shopId", "externalId", "fetchedAt" DESC, "id" DESC
),
vat_thang AS (
  SELECT left(payload->>'create_time', 7) AS thang,
    sum(abs(CASE WHEN payload->>'subtotal' ~ '^-?[0-9]+([.][0-9]+)?$' THEN (payload->>'subtotal')::numeric ELSE 0 END))
      FILTER (WHERE payload->>'transaction_type' ~* 'BILL|PAYMENT') AS sub,
    sum(abs(CASE WHEN payload->>'tax_amount' ~ '^-?[0-9]+([.][0-9]+)?$' THEN (payload->>'tax_amount')::numeric ELSE 0 END))
      FILTER (WHERE payload->>'transaction_type' ~* 'BILL|PAYMENT') AS thue
  FROM hoa_don
  WHERE left(payload->>'create_time', 7) ~ '^[0-9]{4}-[0-9]{2}$'
  GROUP BY 1
),
vat AS (
  -- NULL = tháng có hoá đơn mà tỉ lệ ngoài dải ⇒ dựng lại BỎ tháng đó.
  SELECT thang,
    CASE WHEN coalesce(sub, 0) = 0 THEN 0.1
         WHEN thue / sub BETWEEN 0.03 AND 0.2 THEN thue / sub
    END AS ti_le
  FROM vat_thang
),
dong AS (
  SELECT 'META' AS nguon,
    'META:' || (m.payload->>'date_start') || ':' || (m.payload->>'campaign_id') AS ref_id,
    m.payload->>'date_start' AS ngay,
    m."payloadHash" <> c."payloadHash" AS dau_doi,
    CASE WHEN m.payload->>'spend' ~ '^[0-9]+([.][0-9]+)?$' THEN round((m.payload->>'spend')::numeric) END AS chi_moi,
    CASE WHEN c.payload->>'spend' ~ '^[0-9]+([.][0-9]+)?$' THEN round((c.payload->>'spend')::numeric) END AS chi_cu,
    0.1::numeric AS ti_le_vat
  FROM meta_moi m JOIN meta_cu c USING ("shopId", "externalId")
  UNION ALL
  SELECT 'TIKTOK_ADS',
    'TIKTOK_ADS:' || CASE WHEN m.payload->'metrics'->>'spend' IS NOT NULL THEN 'auction:' ELSE '' END
      || left(m.payload->'dimensions'->>'stat_time_day', 10) || ':' || (m.payload->'dimensions'->>'campaign_id'),
    left(m.payload->'dimensions'->>'stat_time_day', 10),
    m."payloadHash" <> c."payloadHash",
    CASE WHEN coalesce(m.payload->'metrics'->>'spend', m.payload->'metrics'->>'cost') ~ '^[0-9]+([.][0-9]+)?$'
      THEN round(coalesce(m.payload->'metrics'->>'spend', m.payload->'metrics'->>'cost')::numeric) END,
    CASE WHEN coalesce(c.payload->'metrics'->>'spend', c.payload->'metrics'->>'cost') ~ '^[0-9]+([.][0-9]+)?$'
      THEN round(coalesce(c.payload->'metrics'->>'spend', c.payload->'metrics'->>'cost')::numeric) END,
    CASE WHEN v.thang IS NULL THEN 0.1 ELSE v.ti_le END
  FROM tt_moi m JOIN tt_cu c USING ("shopId", "externalId")
  LEFT JOIN vat v ON v.thang = left(m.payload->'dimensions'->>'stat_time_day', 7)
),
gop AS (
  -- Nhiều tài khoản quảng cáo cùng (chiến dịch, ngày) chung một refId — cộng lại, đếm số dòng kho thô.
  SELECT nguon, ref_id, ngay, bool_or(dau_doi) AS dau_doi, count(*) AS so_dong_kho_tho,
    sum(round(chi_moi * (1 + ti_le_vat))) AS dung_lai_moi,
    sum(round(chi_cu * (1 + ti_le_vat))) AS dung_lai_cu
  FROM dong, moc
  WHERE ref_id IS NOT NULL AND ngay >= moc.m
  GROUP BY 1, 2, 3
)
SELECT g.nguon, g.ref_id, g.ngay, e.source AS nguon_so, e.amount AS so_hien_tai, g.dung_lai_moi, g.dung_lai_cu,
  g.dung_lai_moi - e.amount AS lech, g.dau_doi, g.so_dong_kho_tho,
  coalesce(e.source = 'ADS_API', true) AS dung_lai_cham
FROM gop g
LEFT JOIN "Expense" e ON e."refId" = g.ref_id
WHERE g.dau_doi
   OR e.id IS NULL
   OR g.dung_lai_moi IS NULL
   OR abs(g.dung_lai_moi - e.amount) > 1
ORDER BY g.ngay, g.nguon, g.ref_id;

ROLLBACK;
