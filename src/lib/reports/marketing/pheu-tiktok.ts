import { endOfDay, format } from "date-fns";

import type { DateRange } from "@/lib/date-range";
import { shopIdsChoVai } from "@/lib/ket-noi/cau-hinh-shop";
import { docDemSan, docTiLeSan, docTienSan } from "@/lib/marketing/doc-so-san";
import { prisma } from "@/lib/prisma";

import { chia, cong, khoi, ngayTrongKy } from "./cong-so-san";
import { mocDuLieuSanSang, xepNgayTheoMoc } from "./moc-du-lieu-san-sang";

/**
 * PHỄU TIKTOK (tab Tổng quan) — đọc `RawTiktokShopAnalyticsShop` (endpoint shop/performance,
 * granularity 1D ⇒ mỗi interval đúng MỘT ngày, khoá là start_date).
 *
 * BẤT BIẾN #2: mọi số ở đây là số DO SÀN BÁO (tham khảo). Không được chạm `pnl.ts`, không sửa phí
 * sàn, không đối chiếu "lệch" với đơn Pancake — hai định nghĩa khác nhau.
 *
 * Bốn luật chung của mọi reader Marketing, chép ở đây để đọc file này là đủ hiểu:
 *  1. BẢN MỚI NHẤT: DISTINCT ON (shopId, externalId) ORDER BY fetchedAt DESC, id DESC. `id` là
 *     chốt cuối vì fetchedAt là TIMESTAMP(3) và cả một lô land dùng chung clock_timestamp() —
 *     trùng mili-giây là chuyện thường, thiếu chốt thì bản thắng là tuỳ ý.
 *  2. SO NGÀY BẰNG CHUỖI (format yyyy-MM-dd, giờ VN tính sẵn ở TS), KHÔNG ép kiểu sang date trong
 *     SQL: phép ép đó dịch theo GUC TimeZone của session (prod đang UTC — đo 18/08).
 *  3. HAI BỘ ĐẾM NGÀY (A13 mục 1): soNgayChuaSanSang (> mốc — sàn chưa chốt, KHÔNG null hoá) vs
 *     soNgayThieu (≤ mốc mà Bronze rỗng — hụt thật ⇒ mọi TỔNG trả null).
 *  4. SỐ SÀN DẠNG DỊ ⇒ null, không ra 0 — mọi phép đọc đi qua docTienSan/docTiLeSan/docDemSan.
 *     Parse ở TS chứ không ép kiểu trong SQL: các khối là object lồng nhau, viết luật parse cho
 *     hàng chục trường trong SQL là chép luật ra hai nơi.
 */

export type PheuNgay = {
  ngay: string;
  luotTruyCap: number | null;
  luotXemTrang: number | null;
  donSan: number | null;
  gmvSan: number | null;
};

export type PheuTiktok = {
  /** Σ traffic.avg_visitors — với granularity 1D, "avg" của một ngày chính là số ngày đó. */
  luotTruyCap: number | null;
  luotXemTrang: number | null;
  /** = donSan ÷ luotTruyCap. KHÔNG phải trung bình cộng avg_conversation_rate (cộng tỉ số là vô nghĩa). */
  tiLeChuyenDoi: number | null;
  donSan: number | null;
  gmvSan: number | null;
  gmvTheoNguon: { live: number | null; video: number | null; productCard: number | null };
  /** Σ sales.gross_revenue.overall — CHỈ ngày CÓ key (ngày không đơn thì sàn không trả key này). */
  doanhSoSan: number | null;
  soNgayCoDoanhSo: number;
  /** Σ(doanh số × %GMV_MAX) ÷ Σ doanh số — tỉ trọng có TRỌNG SỐ, không phải trung bình %. */
  tiTrongGmvMax: number | null;
  chuoiNgay: PheuNgay[];
  soNgayThieu: number;
  soNgayChuaSanSang: number;
  mocSanSang: string | null;
};

type HangNgay = { externalId: string; payload: unknown };

/** Ba nguồn GMV sàn tách ở `sales.gmv.breakdowns[].type`. */
const LOAI_GMV = { LIVE: "live", VIDEO: "video", PRODUCT_CARD: "productCard" } as const;

/** Đọc một phần tử breakdown theo `type`; vắng ⇒ undefined (người gọi quyết null hay 0). */
function timBreakdown(khoiCha: Record<string, unknown> | undefined, loai: string) {
  const ds = khoiCha?.breakdowns;
  if (!Array.isArray(ds)) return undefined;
  return ds.find(
    (b) => typeof b === "object" && b !== null && (b as Record<string, unknown>).type === loai,
  ) as Record<string, unknown> | undefined;
}

export async function pheuTiktok(range: DateRange): Promise<PheuTiktok> {
  const to = endOfDay(range.to);
  // Danh sách ĐÓNG (registry khai `shops: TIKTOK_SHOP`) ⇒ lọc được; cache 60s ở cau-hinh-shop.
  const shopIds = await shopIdsChoVai(["tiktokShop"]);
  const [rows, moc] = await Promise.all([
    // externalId CHÍNH LÀ ngày (start_date) ⇒ so chuỗi thẳng trên khoá, không phải đào vào payload
    // (index [shopId, externalId, fetchedAt] chạy được).
    prisma.$queryRaw<HangNgay[]>`
      SELECT DISTINCT ON ("shopId", "externalId") "externalId", payload
      FROM "RawTiktokShopAnalyticsShop"
      WHERE "shopId" = ANY(${shopIds}::text[])
        AND "externalId" >= ${format(range.from, "yyyy-MM-dd")}
        AND "externalId" <= ${format(to, "yyyy-MM-dd")}
      ORDER BY "shopId", "externalId", "fetchedAt" DESC, "id" DESC
    `,
    mocDuLieuSanSang(),
  ]);

  const theoNgay = new Map(rows.map((r) => [r.externalId, r.payload]));
  const ngays = ngayTrongKy(range);
  const { soNgayThieu, soNgayChuaSanSang } = xepNgayTheoMoc(ngays, new Set(theoNgay.keys()), moc.shop);

  let luotTruyCap: number | null = 0;
  let luotXemTrang: number | null = 0;
  let donSan: number | null = 0;
  let gmvSan: number | null = 0;
  const gmvTheoNguon: { live: number | null; video: number | null; productCard: number | null } = {
    live: 0,
    video: 0,
    productCard: 0,
  };
  let doanhSoSan: number | null = 0;
  let tuTiTrong: number | null = 0;
  let soNgayCoDoanhSo = 0;
  const chuoiNgay: PheuNgay[] = [];

  for (const ngay of ngays) {
    const payload = theoNgay.get(ngay);
    if (payload === undefined) continue;

    const traffic = khoi(payload, "traffic");
    const sales = khoi(payload, "sales");
    const diem: PheuNgay = {
      ngay,
      luotTruyCap: docDemSan(traffic?.avg_visitors),
      luotXemTrang: docDemSan(traffic?.avg_page_views),
      donSan: docDemSan(sales?.orders_count),
      gmvSan: docTienSan(khoi(sales, "gmv")?.overall),
    };
    chuoiNgay.push(diem);

    luotTruyCap = cong(luotTruyCap, diem.luotTruyCap);
    luotXemTrang = cong(luotXemTrang, diem.luotXemTrang);
    donSan = cong(donSan, diem.donSan);
    gmvSan = cong(gmvSan, diem.gmvSan);

    for (const [loai, khoaRa] of Object.entries(LOAI_GMV)) {
      // Vắng hẳn phần tử breakdown ⇒ null (không biết), KHÔNG phải 0: sàn vẫn trả "0.00" cho
      // nguồn không phát sinh (đo 3/3 ngày fixture), nên vắng là dấu hiệu hợp đồng đã trôi.
      const b = timBreakdown(khoi(sales, "gmv"), loai);
      gmvTheoNguon[khoaRa] = cong(gmvTheoNguon[khoaRa], b === undefined ? null : docTienSan(b.gmv));
    }

    // `gross_revenue` CHỈ có ở ngày có doanh số (A2 mục 7) — vắng key ≠ lỗi, chỉ là ngày ế.
    const grossRevenue = khoi(sales, "gross_revenue");
    if (grossRevenue !== undefined) {
      soNgayCoDoanhSo++;
      const tienNgay = docTienSan(grossRevenue.overall);
      const pctNgay = docTiLeSan(timBreakdown(grossRevenue, "GMV_MAX")?.percentage);
      doanhSoSan = cong(doanhSoSan, tienNgay);
      tuTiTrong = cong(tuTiTrong, tienNgay === null || pctNgay === null ? null : tienNgay * pctNgay);
    }
  }

  // Hụt THẬT ⇒ mọi TỔNG là null. Đếm ngày/chuỗi ngày vẫn trả về: chúng mô tả ĐỘ PHỦ, và chính
  // chúng là thứ giải thích cho dấu "—" ở các ô tổng.
  const hut = soNgayThieu > 0;
  const t = <T>(v: T): T | null => (hut ? null : v);

  return {
    luotTruyCap: t(luotTruyCap),
    luotXemTrang: t(luotXemTrang),
    tiLeChuyenDoi: t(chia(donSan, luotTruyCap)),
    donSan: t(donSan),
    gmvSan: t(gmvSan),
    gmvTheoNguon: hut
      ? { live: null, video: null, productCard: null }
      : gmvTheoNguon,
    doanhSoSan: t(doanhSoSan),
    soNgayCoDoanhSo,
    tiTrongGmvMax: t(chia(tuTiTrong, doanhSoSan)),
    chuoiNgay,
    soNgayThieu,
    soNgayChuaSanSang,
    mocSanSang: moc.shop,
  };
}
