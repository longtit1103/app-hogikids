import { prisma } from "@/lib/prisma";

/**
 * SỐ SÀN QUYẾT TOÁN CHO MỘT ĐƠN — dữ liệu ĐỐI CHIẾU, KHÔNG phải nguồn P&L.
 *
 * Vì sao đọc thẳng Bronze: Silver `TiktokSettlement` là cấp SAO KÊ (một dòng gộp
 * nhiều đơn) nên không trả lời được "đơn này sàn trả bao nhiêu". Số cấp đơn chỉ
 * có ở `RawTiktokShopTransaction` (stream `tiktok/statement_transactions` bản
 * 202501). Cùng lối đi với `doi-chieu-don-kho.ts` — lớp báo cáo đọc Bronze khi
 * việc cần là ĐỐI CHIẾU, không phải dựng số cho P&L.
 *
 * BẤT BIẾN #7 giữ nguyên: số ở đây TUYỆT ĐỐI không được chảy ngược vào công thức
 * P&L. Phí sàn của P&L vẫn là `fee_marketplace` của Pancake; lấy thêm số sàn ở
 * đây cộng vào là đếm hai lần. Ở màn hình, hai cột đứng CẠNH nhau để người đọc tự
 * so, không cái nào sửa cái nào.
 *
 * Khoá nối: `Order.pancakeId` CHÍNH LÀ `order_id` của TikTok (Pancake dùng mã đơn
 * sàn làm id). Đo prod 2026-08-06: map được 375/440 đơn TikTok (T6 100%, T7 94%);
 * phần không map là đơn cũ hoặc chưa quyết toán xong.
 */

/** Các vế của tiền vận chuyển — cộng lại đúng bằng `shipNet` (đo: khớp 9067/9067 dòng). */
export type VeVanChuyen = {
  /** Phí ship thực tế, ÂM (shop phải trả). */
  phiThucTe: number;
  /** Sàn chiết khấu phí ship, thường dương và bù đúng bằng phiThucTe. */
  sanChietKhau: number;
  /** Phí ship của đơn hoàn, ÂM. */
  phiShipHoan: number;
  /** Sàn bù lại phí ship đơn hoàn. */
  sanBuShipHoan: number;
  /** Tiền khách trả ship. */
  khachTra: number;
};

export type QuyetToanDon = {
  /** Số giao dịch quyết toán đã cộng dồn cho đơn này. */
  soGiaoDich: number;
  /** NET sàn trả về = doanhThu + phiVaThue + shipNet + dieuChinh (đo: khớp 9067/9067). */
  settlement: number;
  doanhThu: number;
  /** Phí + thuế sàn giữ, ÂM. */
  phiVaThue: number;
  /** Tiền vận chuyển RÒNG, ÂM khi shop chịu. Thường bằng 0 vì sàn trợ giá bù đủ. */
  shipNet: number;
  dieuChinh: number;
  ve: VeVanChuyen;
};

/** Chuỗi số trong payload TikTok → Int VND. Thiếu/không parse được → 0. */
const so = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

/**
 * Cộng dồn MỌI giao dịch quyết toán của một đơn.
 *
 * Cộng dồn chứ không lấy dòng mới nhất: sàn phát sinh giao dịch RIÊNG cho mỗi lần
 * điều chỉnh (đo prod: có đơn 3 giao dịch với 3 `id` và 3 số tiền khác nhau) —
 * lấy một dòng là bỏ mất phần điều chỉnh, ra số sai mà nhìn vẫn hợp lý.
 *
 * Trả `null` khi đơn chưa có giao dịch nào (chưa quyết toán, hoặc kênh không phải
 * TikTok) ⇒ lớp hiển thị ẩn hẳn khối, KHÔNG hiện số 0 (0 và "chưa có" là hai
 * chuyện khác nhau).
 */
export async function layQuyetToanDon(pancakeId: string): Promise<QuyetToanDon | null> {
  const rows = await prisma.$queryRaw<
    {
      so_giao_dich: bigint;
      settlement: bigint;
      doanh_thu: bigint;
      phi_va_thue: bigint;
      ship_net: bigint;
      dieu_chinh: bigint;
      phi_thuc_te: bigint;
      san_chiet_khau: bigint;
      phi_ship_hoan: bigint;
      san_bu_ship_hoan: bigint;
      khach_tra: bigint;
    }[]
  >`
    WITH moi_nhat AS (
      -- MỘT bản cho mỗi giao dịch: Bronze dedupe theo NỘI DUNG (payloadHash) nên
      -- TikTok bắn lại cùng giao dịch với số khác là thêm DÒNG, không đè. SUM thẳng
      -- sẽ cộng cả bản cũ lẫn bản mới ⇒ số sàn quyết toán phồng lên mà nhìn vẫn hợp
      -- lý. Đây là khuôn DISTINCT ON ... ORDER BY fetchedAt DESC mà transform và
      -- rebuild đều dùng — hàm này từng là chỗ duy nhất phá lệ.
      -- Đo prod 2026-08-06: nhóm ORDER hiện chưa có giao dịch nào 2 phiên bản (số
      -- hôm nay đúng), nhưng đã có 2 giao dịch khác bị bắn lại thật ⇒ chặn trước.
      SELECT DISTINCT ON ("shopId", "externalId") payload
      FROM "RawTiktokShopTransaction"
      WHERE payload->>'order_id' = ${pancakeId}
      -- id chốt cuối: fetchedAt là TIMESTAMP(3), một lô land dùng chung
      -- clock_timestamp() nên trùng mili-giây đi được; thiếu chốt thì bản thắng tuỳ
      -- ý. Khối đối soát ở /tai-chinh dùng CÙNG khuôn và nối sang đây bằng một
      -- hyperlink — lệch chốt là hai màn nói hai số cho cùng một đơn.
      ORDER BY "shopId", "externalId", "fetchedAt" DESC, "id" DESC
    ),
    -- Chuỗi tiền của TikTok nằm trong JSON dạng CHUỖI ("−15150"). Ép kiểu thẳng thì
    -- một giá trị dị (null, chuỗi rỗng, chữ) làm văng cả truy vấn — mà hàm này chạy
    -- trong Promise.all của trang Đơn hàng nên sẽ hạ NGUYÊN TRANG danh sách, không
    -- chỉ hỏng cái drawer. Lọc bằng regex trước khi cast, cùng cách
    -- platform-fee-breakdown.ts guard jsonb_typeof.
    so AS (
      SELECT
        CASE WHEN payload->>'settlement_amount' ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (payload->>'settlement_amount')::numeric ELSE 0 END AS settlement,
        CASE WHEN payload->>'revenue_amount' ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (payload->>'revenue_amount')::numeric ELSE 0 END AS doanh_thu,
        CASE WHEN payload->>'fee_tax_amount' ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (payload->>'fee_tax_amount')::numeric ELSE 0 END AS phi_va_thue,
        CASE WHEN payload->>'shipping_cost_amount' ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (payload->>'shipping_cost_amount')::numeric ELSE 0 END AS ship_net,
        CASE WHEN payload->>'adjustment_amount' ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (payload->>'adjustment_amount')::numeric ELSE 0 END AS dieu_chinh,
        CASE WHEN payload->'shipping_cost_breakdown'->>'actual_shipping_fee_amount' ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (payload->'shipping_cost_breakdown'->>'actual_shipping_fee_amount')::numeric ELSE 0 END AS phi_thuc_te,
        CASE WHEN payload->'shipping_cost_breakdown'->>'shipping_fee_discount_amount' ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (payload->'shipping_cost_breakdown'->>'shipping_fee_discount_amount')::numeric ELSE 0 END AS san_chiet_khau,
        CASE WHEN payload->'shipping_cost_breakdown'->>'return_shipping_fee_amount' ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (payload->'shipping_cost_breakdown'->>'return_shipping_fee_amount')::numeric ELSE 0 END AS phi_ship_hoan,
        CASE WHEN payload->'shipping_cost_breakdown'->>'shipping_fee_guarantee_reimbursement' ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (payload->'shipping_cost_breakdown'->>'shipping_fee_guarantee_reimbursement')::numeric ELSE 0 END AS san_bu_ship_hoan,
        CASE WHEN payload->'shipping_cost_breakdown'->>'customer_paid_shipping_fee_amount' ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (payload->'shipping_cost_breakdown'->>'customer_paid_shipping_fee_amount')::numeric ELSE 0 END AS khach_tra
      FROM moi_nhat
      -- Bản bắn lại có thể RỚT hẳn field type (đã gặp thật) — lọc cứng bằng 'ORDER'
      -- sẽ vứt đúng bản mới nhất đó đi. Đơn hàng đã được chặn bằng order_id ở trên
      -- rồi nên nới ở đây không kéo nhầm giao dịch quảng cáo vào.
      WHERE payload->>'type' = 'ORDER' OR payload->>'type' IS NULL
    )
    SELECT
      COUNT(*)::bigint                              AS so_giao_dich,
      COALESCE(SUM(settlement), 0)::bigint          AS settlement,
      COALESCE(SUM(doanh_thu), 0)::bigint           AS doanh_thu,
      COALESCE(SUM(phi_va_thue), 0)::bigint         AS phi_va_thue,
      COALESCE(SUM(ship_net), 0)::bigint            AS ship_net,
      COALESCE(SUM(dieu_chinh), 0)::bigint          AS dieu_chinh,
      COALESCE(SUM(phi_thuc_te), 0)::bigint         AS phi_thuc_te,
      COALESCE(SUM(san_chiet_khau), 0)::bigint      AS san_chiet_khau,
      COALESCE(SUM(phi_ship_hoan), 0)::bigint       AS phi_ship_hoan,
      COALESCE(SUM(san_bu_ship_hoan), 0)::bigint    AS san_bu_ship_hoan,
      COALESCE(SUM(khach_tra), 0)::bigint           AS khach_tra
    FROM so
  `;

  const r = rows[0];
  if (!r || Number(r.so_giao_dich) === 0) return null;

  return {
    soGiaoDich: Number(r.so_giao_dich),
    settlement: so(r.settlement),
    doanhThu: so(r.doanh_thu),
    phiVaThue: so(r.phi_va_thue),
    shipNet: so(r.ship_net),
    dieuChinh: so(r.dieu_chinh),
    ve: {
      phiThucTe: so(r.phi_thuc_te),
      sanChietKhau: so(r.san_chiet_khau),
      phiShipHoan: so(r.phi_ship_hoan),
      sanBuShipHoan: so(r.san_bu_ship_hoan),
      khachTra: so(r.khach_tra),
    },
  };
}
