import { endOfDay, format } from "date-fns";

import type { DateRange } from "@/lib/date-range";
import { shopIdsChoVai } from "@/lib/ket-noi/cau-hinh-shop";
import { docDemSan, docTiLeSan, docTienSan } from "@/lib/marketing/doc-so-san";
import { prisma } from "@/lib/prisma";

import { chia, cong, khoi, ngayTrongKy } from "./cong-so-san";
import { mocDuLieuSanSang, xepNgayTheoMoc } from "./moc-du-lieu-san-sang";

/**
 * BẢNG VIDEO (tab Nội dung) — `RawTiktokShopAnalyticsVideo`, khoá `<ngày>:<id video>`.
 *
 * Hai phép tính lại KHÁC HẲN nhau, đừng gộp:
 *  - `gpmSan` = gmv ÷ views × 1000 — CẢ tử lẫn mẫu đều cộng được qua ngày ⇒ tính lại là ĐÚNG.
 *  - `ctr` (click_through_rate) KHÔNG có mẫu số nào sàn trả (không có impressions) ⇒ kỳ nhiều
 *    ngày là null. Trung bình cộng của các tỉ số là một con số không đo cái gì cả (A13 mục 5).
 *
 * BẤT BIẾN #2: số sàn tự nhận công — tham khảo, không vào `pnl.ts`.
 */
export type VideoSan = {
  id: string;
  /** null với record gom "video không xác định" (`id = "0"`) — UI hiện "(không rõ video)". */
  tieuDe: string | null;
  taiKhoan: string | null;
  /** "OFFICIAL_ACCOUNTS" | "AFFILIATE_ACCOUNTS" | "MARKETING_ACCOUNTS" — từ `creator.author_type`. */
  loaiTaiKhoan: string | null;
  /** `video_post_time` — chuỗi naive "YYYY-MM-DD HH:MM:SS" của sàn, GIỮ NGUYÊN (giờ shop = giờ VN). */
  dangLuc: string | null;
  luotXem: number | null;
  /** CTR sàn báo: chỉ có nghĩa khi video xuất hiện ĐÚNG 1 ngày trong kỳ; nhiều ngày ⇒ null. */
  ctr: number | null;
  donSku: number | null;
  gmvSan: number | null;
  /** = gmvSan ÷ luotXem × 1000 (hai vế đều cộng được ⇒ tính lại là ĐÚNG, khác CTR). */
  gpmSan: number | null;
  sanPham: { id: string; ten: string }[];
  soNgayCoSo: number;
};

export type VideoTiktok = {
  video: VideoSan[];
  soNgayThieu: number;
  soNgayChuaSanSang: number;
  mocSanSang: string | null;
};

export type LoaiTaiKhoanVideo =
  | "ALL"
  | "OFFICIAL_ACCOUNTS"
  | "AFFILIATE_ACCOUNTS"
  | "MARKETING_ACCOUNTS";

type HangVideo = { ngay: string; id: string; payload: unknown };

function chuoiHoacNull(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** `products` của record: mảng {id, name}. Phần tử dị bị bỏ, không làm hỏng cả dòng. */
function docSanPham(v: unknown): { id: string; ten: string }[] {
  if (!Array.isArray(v)) return [];
  const ra: { id: string; ten: string }[] = [];
  for (const p of v) {
    const id = chuoiHoacNull(khoi(p)?.id);
    if (id === null) continue;
    ra.push({ id, ten: chuoiHoacNull(khoi(p)?.name) ?? id });
  }
  return ra;
}

export async function videoTiktok(
  range: DateRange,
  opts?: { loaiTaiKhoan?: LoaiTaiKhoanVideo },
): Promise<VideoTiktok> {
  const to = endOfDay(range.to);
  const shopIds = await shopIdsChoVai(["tiktokShop"]);
  const [rows, moc] = await Promise.all([
    // externalId = ngày:id — tách hai mảnh ngay trong SQL (khoá do landRaw dựng, khuôn cố định).
    // ORDER BY externalId cũng chính là thứ tự (ngày, id) ⇒ bản của ngày CUỐI trong kỳ là bản
    // metadata thắng khi duyệt tuần tự bên dưới.
    prisma.$queryRaw<HangVideo[]>`
      SELECT DISTINCT ON ("shopId", "externalId")
        left("externalId", 10) AS ngay,
        substring("externalId" from 12) AS id,
        payload
      FROM "RawTiktokShopAnalyticsVideo"
      WHERE "shopId" = ANY(${shopIds}::text[])
        AND left("externalId", 10) >= ${format(range.from, "yyyy-MM-dd")}
        AND left("externalId", 10) <= ${format(to, "yyyy-MM-dd")}
      ORDER BY "shopId", "externalId", "fetchedAt" DESC, "id" DESC
    `,
    mocDuLieuSanSang(),
  ]);

  const ngays = ngayTrongKy(range);
  const { soNgayThieu, soNgayChuaSanSang } = xepNgayTheoMoc(
    ngays,
    new Set(rows.map((r) => r.ngay)),
    moc.videos,
  );

  type Gom = VideoSan & { ngayMoiNhat: string };
  const gom = new Map<string, Gom>();

  for (const r of [...rows].sort((a, b) => (a.ngay < b.ngay ? -1 : a.ngay > b.ngay ? 1 : 0))) {
    const p = khoi(r.payload) ?? {};
    const creator = khoi(p, "creator");
    const cu = gom.get(r.id);
    const luotXemNgay = docDemSan(p.views);
    const g: Gom = cu ?? {
      id: r.id,
      tieuDe: null,
      taiKhoan: null,
      loaiTaiKhoan: null,
      dangLuc: null,
      luotXem: 0,
      ctr: null,
      donSku: 0,
      gmvSan: 0,
      gpmSan: null,
      sanPham: [],
      soNgayCoSo: 0,
      ngayMoiNhat: r.ngay,
    };

    g.luotXem = cong(g.luotXem, luotXemNgay);
    g.donSku = cong(g.donSku, docDemSan(p.sku_orders));
    g.gmvSan = cong(g.gmvSan, docTienSan(p.gmv));
    g.soNgayCoSo++;
    // Metadata: bản của NGÀY MỚI NHẤT. Tiêu đề/tài khoản đổi giữa kỳ là chuyện của sàn — lấy bản
    // mới nhất là quy ước rõ ràng, "bản nào cũng được" thì hai lượt chạy ra hai bảng khác nhau.
    if (r.ngay >= g.ngayMoiNhat || cu === undefined) {
      g.ngayMoiNhat = r.ngay;
      g.tieuDe = chuoiHoacNull(p.title);
      g.taiKhoan = chuoiHoacNull(p.username) ?? chuoiHoacNull(creator?.user_name);
      g.loaiTaiKhoan = chuoiHoacNull(creator?.author_type);
      g.dangLuc = chuoiHoacNull(p.video_post_time);
      g.sanPham = docSanPham(p.products);
    }
    gom.set(r.id, g);
  }

  const loc = opts?.loaiTaiKhoan ?? "ALL";
  const hut = soNgayThieu > 0;
  const video: VideoSan[] = [...gom.values()]
    .filter((g) => loc === "ALL" || g.loaiTaiKhoan === loc)
    .map(({ ngayMoiNhat: _bo, ...g }) => {
      const luotXem = hut ? null : g.luotXem;
      const gmvSan = hut ? null : g.gmvSan;
      const gpm = chia(gmvSan, luotXem, 1000);
      return {
        ...g,
        luotXem,
        donSku: hut ? null : g.donSku,
        gmvSan,
        // VND không có đơn vị nhỏ hơn đồng — làm tròn như `docTienSan`, không cắt cụt.
        gpmSan: gpm === null ? null : Math.round(gpm),
        // CTR chỉ có nghĩa khi video xuất hiện ĐÚNG một ngày trong kỳ — xem docblock đầu file.
        ctr: g.soNgayCoSo === 1 && !hut ? docTiLeSan(ctrCuaNgay(rows, g.id)) : null,
      };
    })
    // Chốt phụ (lượt xem, rồi id): phần lớn video có GMV = 0 nên thiếu chốt là hai lượt chạy ra
    // hai thứ tự bảng khác nhau.
    .sort(
      (a, b) =>
        (b.gmvSan ?? -1) - (a.gmvSan ?? -1) ||
        (b.luotXem ?? -1) - (a.luotXem ?? -1) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );

  return { video, soNgayThieu, soNgayChuaSanSang, mocSanSang: moc.videos };
}

/** Chuỗi `click_through_rate` của video ở ngày duy nhất nó có số trong kỳ. */
function ctrCuaNgay(rows: HangVideo[], id: string): unknown {
  return khoi(rows.find((r) => r.id === id)?.payload)?.click_through_rate;
}
