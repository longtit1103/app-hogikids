import { endOfDay, format } from "date-fns";

import type { DateRange } from "@/lib/date-range";
import { prisma } from "@/lib/prisma";

/**
 * HIỆU QUẢ QUẢNG CÁO THEO CHIẾN DỊCH — Meta + TikTok Ads.
 *
 * Tiền lấy từ `Expense` (danh mục `ads`) chứ KHÔNG lấy từ kho thô: sổ chi phí là
 * nguồn tiền duy nhất của app, đã gồm VAT và đã khớp P&L. Lấy `spend` thô ở đây
 * là dựng con số thứ hai cho cùng một khoản chi — đúng lớp lỗi "đuổi theo con số
 * ở hai nơi" mà repo đã dính nhiều lần.
 *
 * Chỉ số hiển thị/click lấy từ Bronze `RawMetaAdsReport` — nơi DUY NHẤT có chúng.
 * Đo 2026-08-18: Meta có đủ impressions/clicks/reach (1353/1353 dòng). TikTok:
 * probe thật API 2026-08-21 — `/gmv_max/report/get/` TỪ CHỐI impressions/clicks/
 * ctr/cpm (code 40002) ⇒ dấu "—" hiển thị/click của TikTok là GIỚI HẠN SÀN, không
 * phải app chưa kéo. GMV Max CÓ `orders` (số đơn sàn tự attribute) ⇒ cột Đơn + CPO
 * lấy từ Bronze `RawTiktokBusinessReport`. Trống vẫn là null chứ không bịa 0
 * (0 và "không có dữ liệu" là hai chuyện khác nhau).
 *
 * ⚠️ KHÔNG có ROAS quy về doanh thu THẬT ở cấp chiến dịch, và đó là CỐ Ý: app
 * không có cách nào quy doanh thu Pancake về từng chiến dịch (bất biến #2). Bịa
 * một cột như thế ở đây là mời người đọc ra quyết định tiền trên số sai. ROAS cấp
 * KÊNH đã có sẵn và đúng ở `/kenh` (`computeChannelPnl`).
 *
 * Quyết định 2026-08-25 LẬT quyết định 18/08 (và nới quyết định 21/08): `gross_revenue`
 * + `roi` của GMV Max ĐƯỢC kéo và hiển thị TRONG KHU RIÊNG mang nhãn "sàn báo"
 * (`gmvSan`/`roiSan`). Đây là số sàn TỰ NHẬN CÔNG — chuyện KHÁC hẳn ROAS ở trên:
 * nó không quy về doanh thu thật, TUYỆT ĐỐI không vào `pnl.ts`, không sửa phí sàn,
 * không đối chiếu với đơn Pancake. `orders` cũng vậy (số ĐẾM ĐƠN sàn nhận công).
 * `metrics.roi` sàn trả là tỉ số THEO NGÀY nên KHÔNG cộng dồn được — `roiSan` phải
 * là THƯƠNG SỐ Σgross_revenue / Σcost, xem chỗ tính bên dưới.
 */

export type ChienDichQuangCao = {
  campaignId: string;
  ten: string;
  /** true khi dòng này là cụm chi phí ads KHÔNG tra được chiến dịch (refId trống). */
  khongRoChienDich: boolean;
  /** Số dòng chi phí gộp vào — chỉ có nghĩa với dòng "không rõ chiến dịch". */
  soDongGop: number;
  /** "META" | "TIKTOK_ADS" — đúng giá trị `Expense.adsSource`. */
  nguon: string;
  /** Chi tiêu ĐÃ GỒM VAT, lấy thẳng từ sổ chi phí (khớp P&L). */
  chiTieu: number;
  /** null khi nguồn không cung cấp chỉ số (TikTok hiện chưa có). */
  hienThi: number | null;
  click: number | null;
  /** clicks/impressions × 100. null khi thiếu dữ liệu hoặc impressions = 0. */
  ctr: number | null;
  /** chiTieu/impressions × 1000 — tính trên tiền ĐÃ GỒM VAT. */
  cpm: number | null;
  /** chiTieu/clicks — tính trên tiền ĐÃ GỒM VAT. */
  cpc: number | null;
  /**
   * Số đơn sàn TỰ NHẬN CÔNG cho chiến dịch (TikTok GMV Max `orders`) — THAM KHẢO,
   * không phải đơn Pancake, không vào P&L. null = không có dữ liệu (Meta không có
   * metric này; TikTok: kỳ có ngày sổ ghi tiền GMV Max mà app chưa có số đơn hợp lệ
   * từ sàn — chưa backfill / land hụt / payload dị).
   */
  donSan: number | null;
  /**
   * Chi tiêu GMV Max (GỒM VAT) / donSan. Tử số CỐ Ý hẹp hơn `chiTieu` (tổng gộp cả
   * auction nếu có) — đơn chỉ đo được ở GMV Max nên tử/mẫu phải cùng phạm vi.
   */
  cpo: number | null;
  /** GMV sàn TỰ NHẬN CÔNG (`metrics.gross_revenue`, Σ theo ngày) — THAM KHẢO, không vào P&L. */
  gmvSan: number | null;
  /**
   * Phần chi GMV Max (GỒM VAT, từ sổ) của dòng này — mẫu số của `cpo`, và là gốc để bảng con
   * item-level tính dòng "Chưa phân bổ". null khi dòng không phải TikTok GMV Max.
   * Trả ra ngoài thay vì để người gọi tự query lại: chép cái regex refId ra nơi thứ hai là bảo đảm
   * hai nơi sẽ trôi khác nhau.
   */
  chiGmvMax: number | null;
  /** = gmvSan ÷ Σ `metrics.cost` (CHƯA VAT) — đúng cách TikTok tính `roi`. */
  roiSan: number | null;
};

export type QuangCaoTheoChienDich = {
  chienDich: ChienDichQuangCao[];
  tongChiTieu: number;
  /** Nguồn có mặt trong kỳ — để lớp hiển thị biết có cần chú thích "chưa có chỉ số" không. */
  nguonCoChiSo: string[];
  nguonThieuChiSo: string[];
};

type HangChi = {
  campaign_id: string | null;
  ten: string;
  nguon: string;
  chi_tieu: bigint;
  so_dong: number;
};
type HangChiSo = { campaign_id: string; hien_thi: bigint; click: bigint };
type HangDonTiktok = {
  campaign_id: string;
  don: bigint;
  so_ngay_thieu: number;
  chi_gmv: bigint;
  gmv_san: bigint;
  chi_chua_vat_san: bigint;
  so_ngay_thieu_gmv: number;
};

/** Chia an toàn: mẫu 0 hoặc thiếu vế thì trả null, KHÔNG trả 0 (0 đọc ra là "đo được và bằng 0"). */
function chia(tu: number | null, mau: number | null, heSo = 1): number | null {
  if (tu === null || mau === null || mau === 0) return null;
  return (tu / mau) * heSo;
}

/**
 * Gom chi tiêu quảng cáo theo chiến dịch trong kỳ, kèm chỉ số nơi nào có.
 *
 * Khoá chiến dịch là mảnh CUỐI của `Expense.refId`, KHÔNG phải mảnh thứ 3:
 * `prepareAdsExpenseRow` sinh HAI khuôn — `"{NGUỒN}:{ngày}:{campaignId}"` và, riêng
 * TikTok Ads đấu giá, `"TIKTOK_ADS:auction:{ngày}:{campaignId}"` (4 mảnh). Lấy mảnh
 * thứ 3 sẽ nhặt được NGÀY ở khuôn auction ⇒ mọi chiến dịch đấu giá trong cùng một
 * ngày bị gộp thành MỘT dòng mang tên một chiến dịch bất kỳ, mà tổng vẫn đúng nên
 * không có tín hiệu nào báo sai. Đo 2026-08-18: prod chưa có dòng auction nào
 * (shop chạy GMV Max), nhưng đường sinh đã sống nên chặn trước.
 *
 * Dòng ads KHÔNG có `refId` (import file / nhập tay — `ads-import.ts` ghi
 * `refId: null`) không tra được chiến dịch. Chúng gom vào MỘT dòng mang nhãn cố định
 * "(không rõ chiến dịch)" kèm số dòng gộp — KHÔNG mượn tên của một chiến dịch cụ thể
 * (mượn tên là nói với chủ shop rằng chiến dịch đó tiêu cả cụm tiền). Vẫn phải hiện,
 * vì tiền biến mất khỏi bảng là lỗi nặng hơn một dòng xấu xí.
 */
export async function quangCaoTheoChienDich(range: DateRange): Promise<QuangCaoTheoChienDich> {
  const to = endOfDay(range.to);

  const [chiRows, chiSoRows, donTiktokRows] = await Promise.all([
    prisma.$queryRaw<HangChi[]>`
      SELECT
        -- Mảnh CUỐI, không phải mảnh thứ 3 — khuôn auction có 4 mảnh (xem docblock).
        NULLIF(substring("refId" from '([^:]+)$'), '') AS campaign_id,
        -- Tên chiến dịch: Expense.description giữ nguyên tên sàn đặt. Một campaignId
        -- về lý thuyết có thể đổi tên giữa kỳ ⇒ lấy tên của dòng MỚI NHẤT. Thêm
        -- description làm chốt phụ để hai dòng cùng ngày không cho kết quả tuỳ ý.
        (array_agg(description ORDER BY date DESC, description))[1] AS ten,
        COALESCE("adsSource", 'KHAC')           AS nguon,
        SUM(amount)::bigint                     AS chi_tieu,
        COUNT(*)::int                           AS so_dong
      FROM "Expense"
      WHERE "categoryId" = 'ads'
        AND date >= ${range.from}
        AND date <= ${to}
      GROUP BY 1, 3
    `,
    prisma.$queryRaw<HangChiSo[]>`
      WITH moi_nhat AS (
        -- Bronze khử trùng theo NỘI DUNG nên Meta gửi lại cùng (ngày, chiến dịch)
        -- với số đã chốt lại là THÊM DÒNG chứ không đè. Cộng thẳng ⇒ hiển thị/click
        -- phồng lên. Giữ đúng một bản mới nhất cho mỗi khoá gốc.
        SELECT DISTINCT ON ("shopId", "externalId") payload
        FROM "RawMetaAdsReport"
        -- So bằng CHUỖI "YYYY-MM-DD" tính sẵn theo giờ VN, KHÔNG ép kiểu Date sang
        -- ::date trong SQL: phép ép đó dịch theo GUC TimeZone của session Postgres,
        -- mà prod đang là UTC (đo 2026-08-18) ⇒ mốc 01/05 00:00+07 thành 2026-04-30, kéo thêm
        -- MỘT NGÀY vào đầu kỳ ⇒ hiển thị/click phồng lên, CPM/CPC rẻ đi mà không
        -- có dấu hiệu gì. Chuỗi ISO so đúng thứ tự từ điển nên so trực tiếp là an toàn.
        WHERE payload->>'date_start' >= ${format(range.from, "yyyy-MM-dd")}
          AND payload->>'date_start' <= ${format(to, "yyyy-MM-dd")}
        -- id chốt cuối: fetchedAt là TIMESTAMP(3) và cả một lô land dùng chung
        -- clock_timestamp() nên trùng mili-giây là chuyện thường — thiếu chốt thì
        -- bản thắng là tuỳ ý. Cùng khuôn transform-raw-helpers.ts.
        ORDER BY "shopId", "externalId", "fetchedAt" DESC, "id" DESC
      )
      SELECT
        payload->>'campaign_id' AS campaign_id,
        -- Số trong payload Meta là CHUỖI; giá trị dị làm văng cả truy vấn mà hàm
        -- này chạy trong Promise.all của trang /kenh ⇒ lọc regex trước khi ép kiểu.
        SUM(CASE WHEN payload->>'impressions' ~ '^[0-9]+$' THEN (payload->>'impressions')::numeric ELSE 0 END)::bigint AS hien_thi,
        SUM(CASE WHEN payload->>'clicks'      ~ '^[0-9]+$' THEN (payload->>'clicks')::numeric      ELSE 0 END)::bigint AS click
      FROM moi_nhat
      WHERE payload->>'campaign_id' IS NOT NULL
      GROUP BY 1
    `,
    prisma.$queryRaw<HangDonTiktok[]>`
      WITH gmv_chi AS (
        -- Phía TIỀN, đi theo TỪNG NGÀY: chỉ dòng sổ GMV Max — khuôn refId 3 mảnh
        -- "TIKTOK_ADS:{ngày}:{campaignId}"; dòng auction mang infix 'auction:' nên không
        -- khớp mẫu. Ngày lấy từ CHÍNH refId (chuỗi n8n sinh, khớp từng byte với khoá
        -- Bronze), KHÔNG đi qua cột date — né mọi phép đổi múi giờ.
        --
        -- Vì sao phải theo ngày chứ không gom thẳng theo campaign (review đối kháng 21/08
        -- xác nhận cả hai lỗ): (a) campaign chạy CẢ auction lẫn GMV Max thì chiTieu tổng
        -- gộp 2 loại nhưng orders chỉ có ở GMV Max — chia tổng là CPO thổi phồng câm;
        -- (b) ngày sổ CÓ tiền mà Bronze KHÔNG có dòng (land best-effort hỏng lẻ — ca
        -- "ads mồ côi" demAdsMoCoi đã mô hình hoá) thì tổng đơn cộng THIẾU mà không có
        -- tín hiệu. Join theo (campaign, ngày) từ phía sổ đóng cả hai: tử số CPO là
        -- chi_gmv riêng, ngày nào sổ có mà Bronze thiếu orders hợp lệ thì so_ngay_thieu
        -- bắt được ⇒ lớp trên trả null.
        SELECT
          substring("refId" from '^TIKTOK_ADS:([0-9]{4}-[0-9]{2}-[0-9]{2}):') AS ngay,
          NULLIF(substring("refId" from '([^:]+)$'), '') AS campaign_id,
          SUM(amount)::bigint AS chi_gmv
        FROM "Expense"
        WHERE "categoryId" = 'ads'
          AND "adsSource" = 'TIKTOK_ADS'
          AND "refId" ~ '^TIKTOK_ADS:[0-9]{4}-[0-9]{2}-[0-9]{2}:'
          AND date >= ${range.from}
          AND date <= ${to}
        GROUP BY 1, 2
      ),
      don_bronze AS (
        -- Cùng khuôn khử-bắn-lại với query Meta ở trên: Bronze khử trùng theo NỘI DUNG,
        -- payload giàu metric hơn (thêm key orders từ 21/08) land BẢN MỚI cùng khoá
        -- (externalId = campaign_id:ngày) — giữ đúng một bản mới nhất cho mỗi khoá gốc.
        -- CHỈ GMV Max (khoá trần): dòng auction xin bộ metric khác, không bao giờ có orders.
        -- So chuỗi ngày ISO, KHÔNG ép ::date — cùng lý do bẫy GUC TimeZone của query Meta;
        -- stat_time_day có thể mang giờ ("YYYY-MM-DD 00:00:00") ⇒ left(...,10), cùng phép
        -- cắt với idExpr của streams.ts.
        SELECT DISTINCT ON ("shopId", "externalId")
          payload->'dimensions'->>'campaign_id' AS campaign_id,
          left(payload->'dimensions'->>'stat_time_day', 10) AS ngay,
          payload->'metrics'->>'orders' AS orders_tho,
          -- Từ 25/08 (spec §5.4). Bản land TRƯỚC ngày đó KHÔNG có 2 key này ⇒ cột NULL ⇒ rơi vào
          -- so_ngay_thieu_gmv ⇒ lớp trên trả null. Đúng cách metric orders đã đi từ 22/06.
          payload->'metrics'->>'gross_revenue' AS gmv_tho,
          -- Mẫu số ROI: chi CHƯA VAT do CHÍNH sàn báo (không phải tiền sổ đã +VAT).
          payload->'metrics'->>'cost' AS chi_san_tho,
          -- ĐỊNH NGHĨA DUY NHẤT của "ngày đọc được số sàn": phải có CẢ tử LẪN mẫu. Kẹp mỗi một vế là
          -- hở CHIỀU NGƯỢC — ngày gmv đọc được mà cost dị/vắng sẽ cộng vào tử, bỏ khỏi mẫu, mà cổng
          -- phủ-ngày không bắt ⇒ roiSan phồng câm. Dùng CHUNG cho cả 3 phép tổng/đếm bên dưới.
          (payload->'metrics'->>'gross_revenue' ~ '^[0-9]+(\\.[0-9]+)?$'
            AND payload->'metrics'->>'cost' ~ '^[0-9]+(\\.[0-9]+)?$') AS doc_duoc_gmv
        FROM "RawTiktokBusinessReport"
        WHERE "externalId" NOT LIKE 'auction:%'
          AND left(payload->'dimensions'->>'stat_time_day', 10) >= ${format(range.from, "yyyy-MM-dd")}
          AND left(payload->'dimensions'->>'stat_time_day', 10) <= ${format(to, "yyyy-MM-dd")}
        ORDER BY "shopId", "externalId", "fetchedAt" DESC, "id" DESC
      )
      SELECT
        g.campaign_id,
        SUM(CASE WHEN b.orders_tho ~ '^[0-9]+$' THEN b.orders_tho::numeric ELSE 0 END)::bigint AS don,
        -- Ngày sổ có tiền GMV Max mà Bronze KHÔNG có dòng (b.orders_tho NULL vì LEFT JOIN
        -- hụt) HOẶC có dòng mà orders không đọc được (bản land trước 21/08 chưa backfill,
        -- payload dị). Còn ≥1 ngày như vậy thì tổng đơn của kỳ là THIẾU ⇒ lớp trên trả
        -- null thay vì cộng thiếu — "—" và 0 là hai chuyện khác nhau.
        COUNT(*) FILTER (
          WHERE b.orders_tho IS NULL OR NOT (b.orders_tho ~ '^[0-9]+$')
        )::int AS so_ngay_thieu,
        -- Tử số CPO: CHỈ tiền GMV Max (đã gồm VAT, từ sổ). Campaign chạy kèm auction thì
        -- chiTieu tổng của dòng bảng vẫn gộp cả 2 loại — nhưng chia tổng cho đơn GMV Max
        -- là trộn tử/mẫu hai phạm vi khác nhau.
        SUM(g.chi_gmv)::bigint AS chi_gmv,
        -- Tử VÀ mẫu của ROI sàn cùng chạy trên MỘT tập ngày (doc_duoc_gmv) — cả hai chiều: thiếu gmv
        -- hay thiếu cost đều loại ngày đó khỏi CẢ HAI tổng. Sàn trả tiền dạng CHUỖI, có thể mang phần
        -- thập phân ("219789.00").
        SUM(CASE WHEN b.doc_duoc_gmv THEN b.gmv_tho::numeric ELSE 0 END)::bigint AS gmv_san,
        SUM(CASE WHEN b.doc_duoc_gmv THEN b.chi_san_tho::numeric ELSE 0 END)::bigint AS chi_chua_vat_san,
        -- Cổng phủ-ngày RIÊNG cho GMV: orders có từ 22/06, gross_revenue chỉ có sau backfill 25/08 ⇒
        -- hai vùng phủ khác nhau, dùng chung bộ đếm là bịa số cho một trong hai. IS NOT TRUE gom cả
        -- ca LEFT JOIN hụt (NULL — ads mồ côi) lẫn ca đọc không được một trong hai vế.
        COUNT(*) FILTER (WHERE b.doc_duoc_gmv IS NOT TRUE)::int AS so_ngay_thieu_gmv
      FROM gmv_chi g
      LEFT JOIN don_bronze b ON b.campaign_id = g.campaign_id AND b.ngay = g.ngay
      WHERE g.campaign_id IS NOT NULL
      GROUP BY 1
    `,
  ]);

  const chiSoTheoId = new Map(chiSoRows.map((r) => [r.campaign_id, r]));
  const donTheoId = new Map(donTiktokRows.map((r) => [r.campaign_id, r]));

  const chienDich: ChienDichQuangCao[] = chiRows.map((r) => {
    const campaignId = r.campaign_id ?? "";
    const khongRo = campaignId === "";
    // Chỉ số CHỈ có ở Meta, nên chỉ gắn cho dòng nguồn META. Tra bằng campaignId
    // trần thì một chiến dịch TikTok trùng mã với chiến dịch Meta sẽ MƯỢN hiển
    // thị/click của Meta — hai sàn đánh mã riêng nên xác suất thấp, nhưng không có
    // gì chặn, và số mượn được thì nhìn vẫn hợp lý.
    const cs = khongRo || r.nguon !== "META" ? undefined : chiSoTheoId.get(campaignId);
    // Đơn sàn báo CHỈ có ở TikTok GMV Max — guard nguồn y hệt, chiều ngược lại.
    const ds = khongRo || r.nguon !== "TIKTOK_ADS" ? undefined : donTheoId.get(campaignId);
    const chiTieu = Number(r.chi_tieu);
    const hienThi = cs ? Number(cs.hien_thi) : null;
    const click = cs ? Number(cs.click) : null;
    // Kỳ có ngày sổ ghi tiền GMV Max mà Bronze thiếu orders hợp lệ ⇒ null
    // (cộng thiếu là số sai không tín hiệu).
    const donSan = ds && ds.so_ngay_thieu === 0 ? Number(ds.don) : null;
    // Cùng luật cổng phủ-ngày với donSan, nhưng ĐẾM RIÊNG: `orders` có từ 22/06, `gross_revenue` chỉ có
    // sau backfill 25/08 ⇒ hai vùng phủ khác nhau, dùng chung bộ đếm là bịa số cho một trong hai.
    const gmvSan = ds && ds.so_ngay_thieu_gmv === 0 ? Number(ds.gmv_san) : null;
    // Mẫu số là chi CHƯA VAT do CHÍNH sàn báo — KHÔNG phải `chiTieu` của sổ (đã +VAT ⇒ ROI thấp hơn
    // số sàn ~10% mà vẫn mang nhãn "sàn báo" = nói dối). Và là THƯƠNG SỐ chứ không cộng `metrics.roi`:
    // roi là tỉ số theo từng ngày, cộng tỉ số qua nhiều ngày ra số vô nghĩa.
    const roiSan = chia(gmvSan, gmvSan === null ? null : Number(ds!.chi_chua_vat_san));

    return {
      campaignId,
      // Nhãn CỐ ĐỊNH cho cụm không tra được, KHÔNG mượn tên một chiến dịch cụ thể:
      // mượn tên là nói với chủ shop rằng chiến dịch đó tiêu cả cụm tiền.
      ten: khongRo ? "(không rõ chiến dịch)" : r.ten,
      khongRoChienDich: khongRo,
      soDongGop: r.so_dong,
      nguon: r.nguon,
      chiTieu,
      hienThi,
      click,
      ctr: chia(click, hienThi, 100),
      cpm: chia(chiTieu, hienThi, 1000),
      cpc: chia(chiTieu, click),
      donSan,
      // Tử số là chi GMV Max riêng (không phải chiTieu tổng): campaign chạy kèm auction
      // mà chia tổng thì CPO thổi phồng đúng bằng phần tiền auction — câm, không tín hiệu.
      cpo: chia(donSan === null ? null : Number(ds!.chi_gmv), donSan),
      gmvSan,
      roiSan,
      // Tiền SỔ, luôn đọc được khi dòng có chi GMV Max — KHÔNG kẹp theo cổng phủ-ngày của
      // orders/gmv (hai thứ đó là số SÀN, thiếu hay đủ không đổi số tiền đã chi).
      chiGmvMax: ds ? Number(ds.chi_gmv) : null,
    };
  });

  chienDich.sort((a, b) => b.chiTieu - a.chiTieu);

  // Một nguồn chỉ bị gọi là "thiếu chỉ số" khi KHÔNG dòng nào của nó có chỉ số.
  // Phân biệt với ca "dòng này không tra được" (vd chi phí nhập tay không có refId):
  // gộp hai ca lại thì chú thích chân bảng sẽ nói "Meta chưa trả chỉ số" ngay bên
  // trên mấy dòng Meta đang hiện đủ số — tự mâu thuẫn với chính cái bảng.
  // Chỉ xét dòng CÓ chi tiêu, vì lớp hiển thị ẩn dòng 0đ: chú thích mà mô tả dòng
  // đang bị ẩn thì chủ shop không có cách nào đối chiếu.
  const coChiSo = new Set<string>();
  const moiNguon = new Set<string>();
  for (const c of chienDich) {
    if (c.chiTieu <= 0) continue;
    moiNguon.add(c.nguon);
    if (c.hienThi !== null) coChiSo.add(c.nguon);
  }
  const thieuChiSo = new Set([...moiNguon].filter((n) => !coChiSo.has(n)));

  return {
    chienDich,
    tongChiTieu: chienDich.reduce((s, c) => s + c.chiTieu, 0),
    nguonCoChiSo: [...coChiSo].sort(),
    nguonThieuChiSo: [...thieuChiSo].sort(),
  };
}
