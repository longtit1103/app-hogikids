import type { KetQuaChe, QuyenGiaVon } from "@/lib/queries/che-gia-von-types";
import type { DailyPoint } from "@/lib/reports/daily-series";
import type { ChannelPnl, PnlBreakdown } from "@/lib/reports/pnl";

/**
 * DTO CHE cho số tổng hợp qua `calcPnl`/`computeChannelPnl`/`computeDailySeries` (spec phân quyền §4.1,
 * ngoại lệ chốt 30/09): công thức vẫn chạy ĐẦY ĐỦ trong `pnl.ts` (nguồn chuẩn duy nhất — bất biến #1,
 * file này KHÔNG tính lại vế tiền nào), rồi chiếu sang DTO dưới đây TRƯỚC KHI rời server khi người xem
 * thiếu `gia-von-loi-nhuan:xem`.
 *
 * DTO dựng theo DANH SÁCH TRƯỜNG ĐƯỢC PHÉP (pick từng trường) — KHÔNG spread object đầy đủ rồi xoá
 * trường: thêm trường mới vào `PnlBreakdown`/`ChannelPnl` thì mặc định KHÔNG lọt ra. Kiểu che khai
 * riêng (không `Omit<…>`) để test kiểu bắt được trường thừa.
 */

/**
 * NHÃN KIỂU "đã qua hàm che" — chỉ tồn tại ở mức kiểu (không có khoá thật ở runtime, `Object.keys`
 * không thấy). Không có nhãn này, kiểu che chỉ là tập con cấu trúc của kiểu đầy đủ: TS nhận
 * `PnlBreakdown` vào chỗ `PnlChe` mà không kêu (không kiểm trường thừa với biến), nên một lượt sửa bỏ
 * mất lời gọi `chePnl` ở page vẫn tsc xanh trong khi COGS/LN đi thẳng xuống client. Có nhãn ⇒ chỉ
 * giá trị do chính `che*` dưới đây dựng mới vào được props che. Lưới:
 * `tests/queries/che-gia-von-nhan-kieu.test-d.ts`.
 */
declare const NHAN_DA_CHE: unique symbol;
export type DaChe = { readonly [NHAN_DA_CHE]: true };

/** Các trường của P&L che (không nhãn) — cho chỗ chỉ ĐỌC, nhận được cả bản đầy đủ lẫn bản che. */
export type PnlCheTruong = {
  revenue: number;
  voucher: number;
  platformFee: number;
  netRevenue: number;
  ads: number;
  orderCount: number;
  returnBomOrderCount: number;
};

/** P&L không COGS/lãi/biên: doanh thu, khấu trừ sàn, chi tiêu ads (chi phí marketing, không phải giá vốn), số đơn. */
export type PnlChe = PnlCheTruong & DaChe;

export function chePnl(b: PnlBreakdown): PnlChe {
  const che: PnlCheTruong = {
    revenue: b.revenue,
    voucher: b.voucher,
    platformFee: b.platformFee,
    netRevenue: b.netRevenue,
    ads: b.ads,
    orderCount: b.orderCount,
    returnBomOrderCount: b.returnBomOrderCount,
  };
  // Nhãn chỉ ở mức kiểu — đây là MỘT trong ba chỗ duy nhất được gắn nó (cùng `cheChannelPnl`, `cheDailySeries`).
  return che as PnlChe;
}

/** Các trường của một kênh che (không nhãn) — cho hàng tổng tự cộng ở bảng so sánh, chỗ chỉ đọc. */
export type ChannelPnlCheTruong = {
  channelId: string;
  name: string;
  color: string;
  isActive: boolean;
  revenue: number;
  orderCount: number;
  aov: number | null;
  ads: number;
  platformFee: number;
  returnBomOrderCount: number;
  returnBomRatePct: number | null;
  roas: number | null;
};

/** Một kênh không lãi ròng/biên. */
export type ChannelPnlChe = ChannelPnlCheTruong & DaChe;

export function cheChannelPnl(rows: readonly ChannelPnl[]): ChannelPnlChe[] {
  return rows.map((c): ChannelPnlChe => {
    const che: ChannelPnlCheTruong = {
    channelId: c.channelId,
    name: c.name,
    color: c.color,
    isActive: c.isActive,
    revenue: c.revenue,
    orderCount: c.orderCount,
    aov: c.aov,
    ads: c.ads,
    platformFee: c.platformFee,
    returnBomOrderCount: c.returnBomOrderCount,
    returnBomRatePct: c.returnBomRatePct,
    roas: c.roas,
    };
    return che as ChannelPnlChe;
  });
}

/** Dòng kênh ĐẦY ĐỦ (có lãi) hay DTO che — component narrow bằng key có mặt thật ở runtime. */
export function coLaiKenh(c: ChannelPnl | ChannelPnlChe): c is ChannelPnl {
  return "netProfit" in c;
}

/** Điểm biểu đồ ngày chỉ doanh thu. */
export type DailyPointChe = { date: string; revenue: number } & DaChe;

export function cheDailySeries(points: readonly DailyPoint[]): DailyPointChe[] {
  return points.map((p) => ({ date: p.date, revenue: p.revenue }) as DailyPointChe);
}

// ─── Chiếu theo quyền — page gọi `calcPnl`/`computeChannelPnl`/`computeDailySeries` như cũ rồi qua đây ──

export type PnlTheoQuyen = KetQuaChe<{ pnl: PnlBreakdown }, { pnl: PnlChe }>;

export function pnlTheoQuyen(b: PnlBreakdown, quyen: QuyenGiaVon): PnlTheoQuyen {
  return quyen.coQuyenGiaVon ? { coQuyenGiaVon: true, pnl: b } : { coQuyenGiaVon: false, pnl: chePnl(b) };
}

export type ChannelPnlTheoQuyen = KetQuaChe<{ rows: ChannelPnl[] }, { rows: ChannelPnlChe[] }>;

export function channelPnlTheoQuyen(rows: ChannelPnl[], quyen: QuyenGiaVon): ChannelPnlTheoQuyen {
  return quyen.coQuyenGiaVon ? { coQuyenGiaVon: true, rows } : { coQuyenGiaVon: false, rows: cheChannelPnl(rows) };
}

export type DailySeriesTheoQuyen = KetQuaChe<{ points: DailyPoint[] }, { points: DailyPointChe[] }>;

export function dailySeriesTheoQuyen(points: DailyPoint[], quyen: QuyenGiaVon): DailySeriesTheoQuyen {
  return quyen.coQuyenGiaVon
    ? { coQuyenGiaVon: true, points }
    : { coQuyenGiaVon: false, points: cheDailySeries(points) };
}

// ─── Bộ nhiều kỳ theo quyền — page có nhiều P&L cùng lúc (hàng KPI 3 kỳ, kỳ này + kỳ trước) ──────────

/**
 * Chiếu một BỘ P&L (mỗi khoá một kỳ) theo quyền: đủ quyền ⇒ trả nguyên; thiếu ⇒ `chePnl` từng kỳ.
 * Page gọi hàm này thay vì tự rẽ nhánh + gọi `chePnl` rời — một chỗ rẽ duy nhất, có test.
 */
export function boPnlTheoQuyen<K extends string>(
  bo: Record<K, PnlBreakdown>,
  quyen: QuyenGiaVon
): KetQuaChe<Record<K, PnlBreakdown>, Record<K, PnlChe>> {
  if (quyen.coQuyenGiaVon) return { coQuyenGiaVon: true as const, ...bo };
  const che = {} as Record<K, PnlChe>;
  for (const k of Object.keys(bo) as K[]) che[k] = chePnl(bo[k]);
  return { coQuyenGiaVon: false as const, ...che };
}

/** Cùng khuôn `boPnlTheoQuyen` cho bộ danh sách kênh (kỳ này + kỳ trước ở `/kenh`). */
export function boChannelPnlTheoQuyen<K extends string>(
  bo: Record<K, ChannelPnl[]>,
  quyen: QuyenGiaVon
): KetQuaChe<Record<K, ChannelPnl[]>, Record<K, ChannelPnlChe[]>> {
  if (quyen.coQuyenGiaVon) return { coQuyenGiaVon: true as const, ...bo };
  const che = {} as Record<K, ChannelPnlChe[]>;
  for (const k of Object.keys(bo) as K[]) che[k] = cheChannelPnl(bo[k]);
  return { coQuyenGiaVon: false as const, ...che };
}
