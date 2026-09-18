import { shopIdsChoVai } from "@/lib/ket-noi/cau-hinh-shop";
import { prisma } from "@/lib/prisma";

/**
 * MỐC DỮ LIỆU SẴN SÀNG — theo TỪNG stream, không phải một mốc chung.
 *
 * Đo P0 25/08: shop/videos/lives có số tới 23/08 còn products mới tới 22/08 (chậm 1 ngày), và
 * checkpoint P2 (A14 mục 3) đo lại lúc 14:12 thấy mốc TRÔI khác nhau theo giờ (shop 24/08 vs
 * products 22/08) ⇒ cấm hard-code "products chậm 1 ngày". Dùng một mốc chung thì hoặc ta gọi
 * products ngày sàn chưa chốt (ghi số dở dang, sửa không được vì Bronze append-only), hoặc ta bỏ
 * mất một ngày của ba endpoint kia.
 *
 * `latest_available_date` nằm ở VỎ envelope mà `landRaw` chỉ lưu từng PHẦN TỬ ⇒ suy mốc từ chính
 * dữ liệu đã land: workflow không bao giờ hỏi ngày vượt mốc, nên max(ngày đã land) = mốc sàn báo.
 *
 * BẤT BIẾN #2: đây là số THAM KHẢO của sàn — file này (và mọi reader trong thư mục) TUYỆT ĐỐI
 * không được import vào `pnl.ts` / Dashboard / `/kenh` (lưới `tests/unit/marketing/khong-ro-ri-vao-pnl.test.ts`).
 *
 * LỌC `shopId` LÀ BẮT BUỘC (áp cho MỌI reader analytics): stream analytics khai `shops: TIKTOK_SHOP`
 * — danh sách ĐÓNG, id thật lấy từ cấu hình `Setting`. Bỏ mệnh đề lọc thì bản clone có hai shop
 * TikTok Shop trong cùng DB sẽ cộng ĐÔI mọi tổng (và mốc sẵn sàng trôi theo shop lạ) mà không một
 * dòng log nào đỏ. Bảng Bronze ads GMV Max thì NGƯỢC LẠI — xem `gmv-max-theo-san-pham.ts`.
 */
export type MocSanSang = {
  shop: string | null;
  products: string | null;
  videos: string | null;
  lives: string | null;
};

export async function mocDuLieuSanSang(): Promise<MocSanSang> {
  const shopIds = await shopIdsChoVai(["tiktokShop"]);
  const [shop, products, videos, lives] = await Promise.all([
    // externalId của stream shop CHÍNH LÀ ngày (start_date của interval 1D) — chuỗi ISO so đúng
    // thứ tự từ điển nên max() trên chuỗi là max() theo thời gian.
    prisma.$queryRaw<{ m: string | null }[]>`
      SELECT max("externalId") AS m FROM "RawTiktokShopAnalyticsShop"
      WHERE "shopId" = ANY(${shopIds}::text[])
    `,
    // externalId = ngày:id ⇒ 10 ký tự đầu là ngày.
    prisma.$queryRaw<{ m: string | null }[]>`
      SELECT max(left("externalId", 10)) AS m FROM "RawTiktokShopAnalyticsProduct"
      WHERE "shopId" = ANY(${shopIds}::text[])
    `,
    prisma.$queryRaw<{ m: string | null }[]>`
      SELECT max(left("externalId", 10)) AS m FROM "RawTiktokShopAnalyticsVideo"
      WHERE "shopId" = ANY(${shopIds}::text[])
    `,
    // start_time là epoch giây DẠNG CHUỖI. Đổi múi giờ TƯỜNG MINH — đây là chỗ DUY NHẤT của mục
    // Marketing được phép đổi TZ, và phải viết ra chứ không dựa vào GUC TimeZone của session
    // (prod đo 18/08 đang là UTC): phiên 00:00–06:59 giờ VN rơi vào ngày HÔM TRƯỚC theo UTC, mốc
    // lùi một ngày là cả một ngày dữ liệu bị xếp nhầm sang "sàn chưa chốt".
    // Chuỗi không phải toàn chữ số thì bỏ qua phiên đó — ép kiểu là văng cả truy vấn.
    prisma.$queryRaw<{ m: string | null }[]>`
      SELECT to_char(
               max(to_timestamp((payload->>'start_time')::bigint) AT TIME ZONE 'Asia/Ho_Chi_Minh'),
               'YYYY-MM-DD'
             ) AS m
      FROM "RawTiktokShopAnalyticsLive"
      WHERE "shopId" = ANY(${shopIds}::text[])
        AND payload->>'start_time' ~ '^[0-9]+$'
    `,
  ]);

  return {
    shop: shop[0]?.m ?? null,
    products: products[0]?.m ?? null,
    videos: videos[0]?.m ?? null,
    lives: lives[0]?.m ?? null,
  };
}

/**
 * Xếp mỗi ngày trong kỳ vào ĐÚNG một trong ba rổ (A13 mục 1) — dùng chung cho mọi reader có
 * chuỗi ngày, để hai bộ đếm không trôi khác nhau giữa các file:
 *
 *  - có số      : Bronze có dòng cho ngày đó.
 *  - chưa sẵn sàng: ngày > mốc của stream — SÀN chưa chốt số. KHÔNG null hoá tổng; UI chỉ ghi
 *    "Sàn mới có số tới ngày X". Null hoá ở đây là bắt chủ shop nhìn dấu "—" mỗi sáng, đúng thứ
 *    làm người ta tập quen với dấu "—" rồi bỏ qua nó cả lúc hụt thật.
 *  - thiếu      : ngày ≤ mốc mà Bronze rỗng — hụt THẬT (workflow lỗi) ⇒ mọi trường TỔNG trả null.
 *
 * Mốc `null` (chưa land dòng nào của stream) ⇒ mọi ngày vắng tính là THIẾU: không có mốc nghĩa là
 * không có bằng chứng nào cho thấy sàn chưa chốt, mà im lặng cộng 0 là bịa.
 */
export function xepNgayTheoMoc(
  ngayTrongKy: readonly string[],
  ngayCoSo: ReadonlySet<string>,
  moc: string | null,
): { soNgayThieu: number; soNgayChuaSanSang: number } {
  let soNgayThieu = 0;
  let soNgayChuaSanSang = 0;
  for (const ngay of ngayTrongKy) {
    if (ngayCoSo.has(ngay)) continue;
    if (moc !== null && ngay > moc) soNgayChuaSanSang++;
    else soNgayThieu++;
  }
  return { soNgayThieu, soNgayChuaSanSang };
}
