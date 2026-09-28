import { endOfDay, format } from "date-fns";

import type { DateRange } from "@/lib/date-range";
import { shopIdsChoVai } from "@/lib/ket-noi/cau-hinh-shop";
import { docDemSan, docTienSan } from "@/lib/marketing/doc-so-san";
import { prisma } from "@/lib/prisma";

import { chia, cong, khoi, ngayTrongKy } from "./cong-so-san";
import { mocDuLieuSanSang, xepNgayTheoMoc } from "./moc-du-lieu-san-sang";
import { quangCaoTheoChienDich } from "./quang-cao-chien-dich";

/**
 * "Nguồn doanh số (sàn báo)" — 8 khối của `analytics_products` + 1 dòng GMV Max (TikTok Ads).
 *
 * ⚠️ SỬA SPEC A5: khối `total` KHÔNG dùng `attributed_gmv`/`attributed_orders` — nó dùng `gmv` và
 * `orders` (đo 20/20 record, fixture chứng minh). Ba khối `affiliate_video`/`affiliate_live`/`shop_tab`
 * dùng bộ tên RIÊNG và KHÔNG có "đơn". Khối vắng = 0 (không phải null/lỗi): TikTok chỉ trả khối nào
 * sản phẩm đó thực sự có hoạt động, và A14 mục 4 chốt CẤM cảnh báo thiếu vì "vắng khối" là bình thường.
 *
 * KHÔNG cộng 8 khối thành "tổng": chúng CHỒNG nhau (affiliate_total = affiliate_video + affiliate_live;
 * total gộp mọi thứ). Hai dòng gộp được đánh dấu `gopChong` để UI tách khu.
 *
 * BẤT BIẾN #2: mọi số ở đây là số sàn TỰ NHẬN CÔNG — tham khảo, không vào `pnl.ts`.
 */
export type KhoiNguon =
  | "total"
  | "seller_video"
  | "seller_live"
  | "seller_product_card"
  | "affiliate_total"
  | "affiliate_video"
  | "affiliate_live"
  | "shop_tab";

type DinhNghiaKhoi = {
  nhan: string;
  /** Khoá khối trong record sản phẩm. */
  khoa: string;
  /** Tên trường TIỀN trong khối (khác nhau theo khối — đây là chỗ dễ sai nhất). */
  truongGmv: string;
  /** Tên trường ĐẾM ĐƠN, hoặc null khi khối không có khái niệm "đơn". */
  truongDon: string | null;
  truongHienThi: string;
  truongClick: string;
  /** Dòng gộp, CHỒNG với các dòng khác ⇒ không vẽ chung cột biểu đồ. */
  gopChong: boolean;
};

export const KHOI_NGUON: Record<KhoiNguon, DinhNghiaKhoi> = {
  total: {
    nhan: "Tổng (sàn)",
    khoa: "total_performance",
    truongGmv: "gmv",
    truongDon: "orders",
    truongHienThi: "product_impressions",
    truongClick: "product_clicks",
    gopChong: true,
  },
  seller_video: {
    nhan: "Video shop",
    khoa: "seller_video_performance",
    truongGmv: "attributed_gmv",
    truongDon: "attributed_orders",
    truongHienThi: "product_impressions",
    truongClick: "product_clicks",
    gopChong: false,
  },
  seller_live: {
    nhan: "Live shop",
    khoa: "seller_live_performance",
    truongGmv: "attributed_gmv",
    truongDon: "attributed_orders",
    truongHienThi: "product_impressions",
    truongClick: "product_clicks",
    gopChong: false,
  },
  seller_product_card: {
    nhan: "Thẻ sản phẩm",
    khoa: "seller_product_card_performance",
    truongGmv: "attributed_gmv",
    truongDon: "attributed_orders",
    truongHienThi: "product_impressions",
    truongClick: "product_clicks",
    gopChong: false,
  },
  affiliate_total: {
    nhan: "Affiliate (tổng)",
    khoa: "affiliate_total_performance",
    truongGmv: "attributed_gmv",
    truongDon: "attributed_orders",
    truongHienThi: "product_impressions",
    truongClick: "product_clicks",
    gopChong: true,
  },
  affiliate_video: {
    nhan: "Affiliate video",
    khoa: "affiliate_video_performance",
    // Tên RIÊNG, không phải attributed_gmv. Và khối này KHÔNG có đơn.
    truongGmv: "attributed_video_gmv",
    truongDon: null,
    truongHienThi: "product_impressions",
    truongClick: "product_clicks",
    gopChong: false,
  },
  affiliate_live: {
    nhan: "Affiliate live",
    khoa: "affiliate_live_performance",
    truongGmv: "live_attributed_gmv",
    truongDon: null,
    truongHienThi: "product_impressions",
    truongClick: "product_clicks",
    gopChong: false,
  },
  shop_tab: {
    nhan: "Tab shop",
    khoa: "shop_tab_performance",
    // Bộ tên hoàn toàn riêng. `shop_tab_sold_items` là số MÓN, KHÔNG phải đơn ⇒ truongDon = null.
    truongGmv: "shop_tab_gmv",
    truongDon: null,
    truongHienThi: "shop_tab_product_impressions",
    truongClick: "shop_tab_product_clicks",
    gopChong: false,
  },
};

export type DongNguonDoanhSo = {
  khoi: KhoiNguon;
  nhan: string;
  gopChong: boolean;
  gmvSan: number | null;
  donSan: number | null;
  hienThi: number | null;
  click: number | null;
  ctr: number | null;
  /**
   * true ⇒ khối này KHÔNG có khái niệm "đơn" (`KHOI_NGUON[khoi].truongDon === null` — affiliate_video/
   * affiliate_live/shop_tab). Tính THẲNG từ định nghĩa khối, KHÔNG phải phép đo mới. UI (fix vòng B-2,
   * việc #3) dùng cờ này để tách "sàn không đo chỉ số này" (donSan mãi mãi null) khỏi "—" do
   * `soNgayThieu > 0` (kỳ này thiếu dữ liệu, donSan null TẠM THỜI) — hai lý do khác nhau, gán nhầm là
   * khẳng định sai sự thật.
   */
  khongCoDon: boolean;
};

export type NguonDoanhSoTiktok = {
  dong: DongNguonDoanhSo[];
  /** Dòng GMV Max lấy từ `quangCaoTheoChienDich` (Expense + Bronze ads) — nguồn KHÁC, nhãn khác. */
  gmvMax: { chiGomVat: number; donSan: number | null; gmvSan: number | null };
  soNgayThieu: number;
  soNgayChuaSanSang: number;
  mocSanSang: string | null;
};

type HangSanPham = { ngay: string; payload: unknown };

/** Bộ cộng của MỘT khối qua mọi sản phẩm × mọi ngày trong kỳ. */
type Tong = {
  gmvSan: number | null;
  donSan: number | null;
  hienThi: number | null;
  click: number | null;
};

/**
 * Đọc một khối của một record sản phẩm và cộng vào bộ đếm. VẮNG KHỐI ⇒ không cộng gì (= 0), đúng
 * luật A14 mục 4: sản phẩm không có hoạt động ở nguồn đó thì sàn bỏ hẳn khối, không phải lỗi.
 */
function congKhoi(tong: Tong, dinhNghia: DinhNghiaKhoi, record: unknown): void {
  const k = khoi(record, dinhNghia.khoa);
  if (k === undefined) return;
  tong.gmvSan = cong(tong.gmvSan, docTienSan(k[dinhNghia.truongGmv]));
  if (dinhNghia.truongDon !== null) {
    tong.donSan = cong(tong.donSan, docDemSan(k[dinhNghia.truongDon]));
  }
  tong.hienThi = cong(tong.hienThi, docDemSan(k[dinhNghia.truongHienThi]));
  tong.click = cong(tong.click, docDemSan(k[dinhNghia.truongClick]));
}

export async function nguonDoanhSoTiktok(range: DateRange): Promise<NguonDoanhSoTiktok> {
  const to = endOfDay(range.to);
  const shopIds = await shopIdsChoVai(["tiktokShop"]);
  const [rows, moc, ads] = await Promise.all([
    // externalId = ngày:id ⇒ 10 ký tự đầu là ngày; so CHUỖI, không ép kiểu date (bẫy GUC TimeZone).
    prisma.$queryRaw<HangSanPham[]>`
      SELECT DISTINCT ON ("shopId", "externalId") left("externalId", 10) AS ngay, payload
      FROM "RawTiktokShopAnalyticsProduct"
      WHERE "shopId" = ANY(${shopIds}::text[])
        AND left("externalId", 10) >= ${format(range.from, "yyyy-MM-dd")}
        AND left("externalId", 10) <= ${format(to, "yyyy-MM-dd")}
      ORDER BY "shopId", "externalId", "fetchedAt" DESC, "id" DESC
    `,
    mocDuLieuSanSang(),
    // Dòng GMV Max KHÔNG query riêng: cùng một con số chi/đơn/GMV đã có ở bảng chiến dịch. Viết
    // truy vấn thứ hai cho cùng con số là dựng nguồn sự thật thứ hai — đúng lớp lỗi repo đã dính.
    quangCaoTheoChienDich(range),
  ]);

  const ngays = ngayTrongKy(range);
  const { soNgayThieu, soNgayChuaSanSang } = xepNgayTheoMoc(
    ngays,
    new Set(rows.map((r) => r.ngay)),
    moc.products,
  );

  const tongs = new Map<KhoiNguon, Tong>(
    (Object.keys(KHOI_NGUON) as KhoiNguon[]).map((k) => [
      k,
      // Khối KHÔNG có khái niệm "đơn" khởi tạo null và ở NGUYÊN null — 0 ở ô đó là nói rằng đã
      // đo được và bằng không, trong khi sàn không hề có phép đo ấy.
      { gmvSan: 0, donSan: KHOI_NGUON[k].truongDon === null ? null : 0, hienThi: 0, click: 0 },
    ]),
  );

  for (const r of rows) {
    for (const [k, dinhNghia] of Object.entries(KHOI_NGUON) as [KhoiNguon, DinhNghiaKhoi][]) {
      congKhoi(tongs.get(k)!, dinhNghia, r.payload);
    }
  }

  const hut = soNgayThieu > 0;
  const dong: DongNguonDoanhSo[] = (Object.keys(KHOI_NGUON) as KhoiNguon[]).map((k) => {
    const t = tongs.get(k)!;
    const gmvSan = hut ? null : t.gmvSan;
    const donSan = hut ? null : t.donSan;
    const hienThi = hut ? null : t.hienThi;
    const click = hut ? null : t.click;
    return {
      khoi: k,
      nhan: KHOI_NGUON[k].nhan,
      gopChong: KHOI_NGUON[k].gopChong,
      gmvSan,
      donSan,
      hienThi,
      // CTR TÍNH LẠI từ hai bộ đếm cộng được (A13 mục 5) — chuỗi `ctr` của sàn là tỉ số THEO NGÀY,
      // cộng hay trung bình qua nhiều ngày là số vô nghĩa.
      click,
      ctr: chia(click, hienThi),
      khongCoDon: KHOI_NGUON[k].truongDon === null,
    };
  });

  const dongTiktokAds = ads.chienDich.filter((c) => c.nguon === "TIKTOK_ADS");
  return {
    dong,
    gmvMax: {
      // Tiền SỔ (đã gồm VAT). Dòng TikTok Ads không có phần GMV Max (chỉ auction) thì
      // `chiGmvMax` null ⇒ cộng 0: nó thật sự không tiêu đồng nào ở GMV Max.
      chiGomVat: dongTiktokAds.reduce((s, c) => s + (c.chiGmvMax ?? 0), 0),
      donSan: dongTiktokAds.reduce<number | null>((s, c) => cong(s, c.donSan), 0),
      gmvSan: dongTiktokAds.reduce<number | null>((s, c) => cong(s, c.gmvSan), 0),
    },
    soNgayThieu,
    soNgayChuaSanSang,
    mocSanSang: moc.products,
  };
}
