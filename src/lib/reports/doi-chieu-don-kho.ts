import { layCauHinhShop } from "@/lib/ket-noi/cau-hinh-shop";
import { parseVnDate } from "@/lib/ingest/pancake-mapping";
import { prisma } from "@/lib/prisma";

/**
 * ĐỐI CHIẾU ĐƠN SÀN VỚI BẢN SAO TRONG KHO — lưới an toàn chống mất doanh thu âm thầm.
 *
 * Vì sao cần: mỗi đơn Shopee/TikTok đều được Pancake nhân một bản sao sang shop Kho Tổng để trừ
 * tồn (`AF<shopId>O<mã đơn>`). Bản sao KHÔNG tính doanh thu (bất biến #2), nhưng chính vì nó tồn
 * tại độc lập với đơn gốc nên nó là NHÂN CHỨNG: đơn nào có bản sao mà không có đơn gốc trong app
 * thì app đang thiếu đơn đó.
 *
 * Đã xảy ra thật (phát hiện 2026-08-05): Pancake xoá đơn Shopee cũ khỏi shop bán, app thiếu 24 đơn
 * đã giao một cụm đơn ở tháng 3 và nửa đầu tháng 4. Lỗ hổng nằm im 4 tháng, chỉ lộ ra khi
 * chủ shop tình cờ so tay với màn Tổng quan của Pancake. Kiểm này biến phép so đó thành tự động.
 *
 * KHÔNG sửa dữ liệu, chỉ ĐẾM và LIỆT KÊ — bù đơn là việc có chủ đích, chạy tay qua
 * `scripts/bu-don-shopee-tu-don-kho.ts` sau khi người thật nhìn danh sách.
 */

/** Bản sao trong kho có, mà app không có đơn gốc. */
export type DonThieuSoVoiKho = {
  /** `shopee` | `tiktok` — suy từ shopId nằm trong id bản sao. */
  kenh: string;
  /** Mã đơn hiển thị (= `Order.code` của đơn gốc). */
  code: string;
  /** `null` khi `inserted_at` của bản sao hỏng định dạng — hiện "?" thay vì giấu cả đơn. */
  ngayDat: Date | null;
  /** `status_name` của Pancake trên bản sao (delivered / returning / canceled…). */
  trangThaiKho: string;
  /** Tiền hàng ròng theo bản sao (`cod`) — ước lượng phần doanh thu đang thiếu. */
  tienHang: number;
};

export type KetQuaDoiChieuKho = {
  tongBanSao: number;
  thieu: DonThieuSoVoiKho[];
  /** Σ tiền hàng của các đơn thiếu ở trạng thái ĐÃ GIAO — phần doanh thu app đang hụt. */
  tienThieuDaGiao: number;
};

/** Số dòng tối đa trả về; nhiều hơn thì phần đuôi vẫn được cộng vào `tienThieuDaGiao`. */
const GIOI_HAN_LIET_KE = 100;

/**
 * So bản sao trong kho với `Order` theo cặp (kênh, mã đơn) — cùng khoá mà
 * `bu-don-shopee-tu-don-kho.ts` dùng, nên chạy script bù xong là số này về 0.
 *
 * Chỉ soi bản sao của hai shop bán đã biết; bản sao lạ (shopId khác) bỏ qua thay vì đoán kênh.
 */
export async function doiChieuDonKhoVsSan(): Promise<KetQuaDoiChieuKho> {
  // Bronze là kho THÔ nên KHÔNG cast ngày trong SQL: regex hình dạng không kiểm được lịch
  // ('2026-13-45' qua regex nhưng ::timestamp vẫn ném 'out of range'), mà hàm này chạy trong
  // Promise.all của trang Cài đặt — một giá trị dị là sập nguyên trang. Ngày trả về dạng TEXT rồi
  // parse phía JS bằng parseVnDate (parser chuẩn toàn app, neo naive = UTC); hỏng thì null chứ
  // không văng. `cod` giữ cast trong SQL nhưng chặn 15 chữ số (quá là rác, ::bigint sẽ tràn).
  const { kho, shopee, tiktok } = await layCauHinhShop();
  const rows = await prisma.$queryRaw<
    { kenh: string; code: string; ngay_dat_tho: string | null; tt_kho: string; tien: bigint; tong: bigint }[]
  >`
    WITH ban_sao AS (
      SELECT DISTINCT ON ("externalId") "externalId", payload
      FROM "RawPancakeOrder"
      WHERE "shopId" = ${kho} AND "externalId" ~ '^AF[0-9]+O'
      ORDER BY "externalId", "fetchedAt" DESC
    ), tach AS (
      SELECT CASE substring("externalId" from '^AF([0-9]+)O')
               WHEN ${shopee} THEN 'shopee'
               WHEN ${tiktok} THEN 'tiktok'
               ELSE NULL END                                   AS kenh,
             substring("externalId" from '^AF[0-9]+O(.+)$')     AS code,
             payload->>'inserted_at'                            AS ngay_dat_tho,
             COALESCE(payload->>'status_name', '?')             AS tt_kho,
             CASE WHEN payload->>'cod' ~ '^-?[0-9]{1,15}(\\.[0-9]+)?$'
                  THEN (payload->>'cod')::numeric ELSE 0 END::bigint AS tien
      FROM ban_sao
    )
    SELECT t.kenh, t.code, t.ngay_dat_tho, t.tt_kho, t.tien,
           (SELECT count(*) FROM tach WHERE kenh IS NOT NULL)::bigint AS tong
    FROM tach t
    WHERE t.kenh IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "Order" o WHERE o."channelId" = t.kenh AND o.code = t.code
      )
  `;

  const tongBanSao = rows.length > 0 ? Number(rows[0].tong) : await demBanSao();
  const thieu = rows.map((r) => {
    const parsed = r.ngay_dat_tho ? parseVnDate(r.ngay_dat_tho) : null;
    return {
      kenh: r.kenh,
      code: r.code,
      ngayDat: parsed && !Number.isNaN(parsed.getTime()) ? parsed : null,
      trangThaiKho: r.tt_kho,
      tienHang: Number(r.tien),
    };
  });
  // Mới nhất trước; đơn ngày hỏng xếp CUỐI — để chúng nổi lên đầu là chiếm chỗ 100 dòng liệt kê
  // của đơn thật (Postgres DESC mặc định NULLS FIRST, nên sort ở đây thay vì trong SQL).
  thieu.sort((a, b) => (b.ngayDat?.getTime() ?? -Infinity) - (a.ngayDat?.getTime() ?? -Infinity));

  return {
    tongBanSao,
    thieu: thieu.slice(0, GIOI_HAN_LIET_KE),
    tienThieuDaGiao: thieu
      .filter((d) => d.trangThaiKho === "delivered")
      .reduce((s, d) => s + d.tienHang, 0),
  };
}

/** Không đơn nào thiếu ⇒ truy vấn trên trả 0 dòng ⇒ vẫn cần con số tổng để hiện "đã đối chiếu N đơn". */
async function demBanSao(): Promise<number> {
  const { kho, shopee, tiktok } = await layCauHinhShop();
  const [row] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(DISTINCT "externalId")::bigint AS n
    FROM "RawPancakeOrder"
    WHERE "shopId" = ${kho}
      AND ("externalId" LIKE ${`AF${shopee}O%`} OR "externalId" LIKE ${`AF${tiktok}O%`})
  `;
  return Number(row?.n ?? 0);
}
