import { endOfDay, startOfDay } from "date-fns";

import type { DateRange } from "@/lib/date-range";
import { shopIdsChoVai } from "@/lib/ket-noi/cau-hinh-shop";
import { docDemSan, docTiLeSan, docTienSan } from "@/lib/marketing/doc-so-san";
import { prisma } from "@/lib/prisma";

import { khoi } from "./cong-so-san";
import { mocDuLieuSanSang } from "./moc-du-lieu-san-sang";

/**
 * BẢNG PHIÊN LIVE (tab Nội dung) — `RawTiktokShopAnalyticsLive`, 1 dòng/PHIÊN (khoá = id phiên).
 *
 * KHÔNG có `soNgayThieu` ở đây và đó là CÓ CHỦ ĐÍCH: phiên live là thực thể có id riêng, không
 * phải chuỗi ngày — đếm "ngày thiếu" cho nó là bịa ra một chiều dữ liệu không tồn tại.
 *
 * Lọc kỳ bằng `start_time` (epoch GIÂY dạng CHUỖI) so với hai mốc epoch tính sẵn ở TS từ biên
 * ngày giờ VN. Epoch là mốc TUYỆT ĐỐI nên phép so không dính múi giờ nào cả — khác hẳn việc đổi
 * epoch thành ngày rồi so ngày, chỗ mà GUC TimeZone của session (prod đang UTC) sẽ đẩy phiên
 * 00:00–06:59 giờ VN lùi sang hôm trước.
 *
 * A4: shop CHƯA tự live (60/60 phiên là của creator) ⇒ sàn không trả `duration` (tính từ
 * end − start) và không trả `interaction_performance` ⇒ `coCotTuongTac` hiện là false.
 *
 * BẤT BIẾN #2: số sàn tự nhận công — tham khảo, không vào `pnl.ts`.
 */
export type PhienLive = {
  id: string;
  tieuDe: string | null;
  taiKhoan: string | null;
  /** ISO giờ VN, suy từ `start_time` (epoch giây dạng CHUỖI). */
  batDau: string;
  /** `end_time − start_time`, giây. Sàn KHÔNG trả `duration` cho phiên của creator (A4). */
  thoiLuongGiay: number | null;
  donSku: number | null;
  gmvSan: number | null;
  khach: number | null;
  /** `click_to_order_rate` — khuôn "0.00%". */
  clickSangDon: number | null;
  /** `products_added`. */
  spThemVaoLive: number | null;
  /** true khi phiên CÓ `interaction_performance` (chỉ có với tài khoản shop/marketing). */
  coTuongTac: boolean;
};

export type LiveTiktok = {
  phien: PhienLive[];
  /** false ⇒ UI ẨN cả cụm cột tương tác + hiện chú thích của A4. */
  coCotTuongTac: boolean;
  mocSanSang: string | null;
};

type HangLive = { externalId: string; payload: unknown };

/** Khuôn ISO giờ VN "YYYY-MM-DDTHH:MM:SS+07:00" — viết TƯỜNG MINH, không dựa vào TZ tiến trình. */
const GIO_VN = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function isoGioVn(epochGiay: number): string {
  const p = Object.fromEntries(
    GIO_VN.formatToParts(new Date(epochGiay * 1000)).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+07:00`;
}

/** epoch giây dạng CHUỖI toàn chữ số; dị ⇒ null (KHÔNG rơi về 0 = 1970). */
function docEpoch(v: unknown): number | null {
  if (typeof v !== "string" || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

function chuoiHoacNull(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

export async function liveTiktok(range: DateRange): Promise<LiveTiktok> {
  const tu = Math.floor(startOfDay(range.from).getTime() / 1000);
  const den = Math.floor(endOfDay(range.to).getTime() / 1000);
  const shopIds = await shopIdsChoVai(["tiktokShop"]);

  const [rows, moc] = await Promise.all([
    prisma.$queryRaw<HangLive[]>`
      SELECT DISTINCT ON ("shopId", "externalId") "externalId", payload
      FROM "RawTiktokShopAnalyticsLive"
      WHERE "shopId" = ANY(${shopIds}::text[])
        AND payload->>'start_time' ~ '^[0-9]+$'
        AND (payload->>'start_time')::bigint >= ${String(tu)}::bigint
        AND (payload->>'start_time')::bigint <= ${String(den)}::bigint
      ORDER BY "shopId", "externalId", "fetchedAt" DESC, "id" DESC
    `,
    mocDuLieuSanSang(),
  ]);

  const phien: PhienLive[] = [];
  for (const r of rows) {
    const p = khoi(r.payload) ?? {};
    const batDauEpoch = docEpoch(p.start_time);
    // Cổng regex ở SQL đã loại ca này; giữ phép kiểm ở TS để hàm không phụ thuộc vào việc người
    // sau có giữ nguyên mệnh đề WHERE hay không.
    if (batDauEpoch === null) continue;
    const ketThucEpoch = docEpoch(p.end_time);
    const sales = khoi(p, "sales_performance");
    phien.push({
      id: r.externalId,
      tieuDe: chuoiHoacNull(p.title),
      taiKhoan: chuoiHoacNull(p.username),
      batDau: isoGioVn(batDauEpoch),
      thoiLuongGiay: ketThucEpoch === null ? null : ketThucEpoch - batDauEpoch,
      donSku: docDemSan(sales?.sku_orders),
      gmvSan: docTienSan(sales?.gmv),
      khach: docDemSan(sales?.customers),
      clickSangDon: docTiLeSan(sales?.click_to_order_rate),
      spThemVaoLive: docDemSan(sales?.products_added),
      coTuongTac: khoi(p, "interaction_performance") !== undefined,
    });
  }

  // Mới nhất trước — cùng quy ước với mọi bảng có mốc thời gian trong app.
  phien.sort((a, b) => (a.batDau < b.batDau ? 1 : a.batDau > b.batDau ? -1 : 0));

  return {
    phien,
    coCotTuongTac: phien.some((p) => p.coTuongTac),
    mocSanSang: moc.lives,
  };
}
