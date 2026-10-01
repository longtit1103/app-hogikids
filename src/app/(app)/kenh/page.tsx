import Link from "next/link";

import { ChannelComparisonSection, type SoSanhKenhDuLieu } from "@/components/kenh/channel-comparison-section";
import { ChannelNotFoundToast } from "@/components/kenh/channel-not-found-toast";
import { ChannelTrendChart } from "@/components/kenh/channel-trend-chart";
import { clampRangeEndToNow, khoangServerThuocTinh, previousComparableRange, resolveRangeFromParams } from "@/lib/date-range";
import { docLuaChonDaLuu } from "@/lib/date-range-cookie-server";
import { prisma } from "@/lib/prisma";
import { quyenGiaVonCua } from "@/lib/queries/che-gia-von-types";
import { yeuCauQuyenTrang } from "@/lib/quyen/cong-trang";
import { computeChannelDailyRevenue } from "@/lib/reports/daily-series";
import { chuThichBienRongTheoKenh } from "@/lib/reports/chu-thich-thu-nhap-tai-chinh";
import { computeChannelPnl, sumThuNhapTaiChinh, type ChannelPnl } from "@/lib/reports/pnl";
import { boChannelPnlTheoQuyen, cheChannelPnl } from "@/lib/reports/pnl-che";

type SearchParams = { tu?: string; den?: string; range?: string; loi?: string };

type ChannelRow = {
  id: string;
  name: string;
  color: string;
  isActive: boolean;
  platformFeePct: number;
  paymentFeePct: number;
};

/**
 * `computeChannelPnl` CHỈ trả kênh có phát sinh (đơn HOẶC chi phí) trong kỳ —
 * kênh đang bật nhưng 0 hoạt động trong kỳ sẽ KHÔNG có trong kết quả. /kenh
 * phải hiện thẻ cho MỌI kênh đang bật (kể cả 0 ₫ — xem edge case "Kỳ không
 * có đơn nào" ở design spec 04), nên zero-fill bằng danh sách kênh thật từ
 * Cài đặt thay vì render thẳng kết quả `computeChannelPnl`.
 */
function zeroChannelPnl(c: ChannelRow): ChannelPnl {
  return {
    channelId: c.id,
    name: c.name,
    color: c.color,
    isActive: c.isActive,
    revenue: 0,
    orderCount: 0,
    aov: null,
    ads: 0,
    platformFee: 0,
    returnBomOrderCount: 0,
    returnBomRatePct: null,
    netProfit: 0,
    roas: null,
    marginPct: null,
  };
}

export default async function KenhPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const nd = await yeuCauQuyenTrang("/kenh", "kenh:xem");
  // `computeChannelPnl` tính đủ (ngoại lệ chốt 30/09, spec phân quyền §4.1); thiếu quyền giá vốn thì
  // chiếu DTO che (`boChannelPnlTheoQuyen`) TRƯỚC khi vào props client bên dưới.
  const quyen = quyenGiaVonCua(nd);

  const sp = await searchParams;
  const now = new Date();
  // Giống /chi-phi, /bao-cao: provider chỉ ghi ?tu=&den= khi chọn "Tùy chọn" —
  // preset khác không có trong URL nên mặc định "this_month". Kẹp biên phải về
  // hôm nay để "Tháng này" không kéo tới cuối tháng (tương lai). Kỳ trước dùng
  // previousComparableRange: ca "Tháng này" so CÙNG số ngày đầu tháng trước
  // (KHỚP hàng KPI Dashboard), các preset khác trượt cùng span như cũ.
  const range = clampRangeEndToNow(
    resolveRangeFromParams({ tu: sp.tu, den: sp.den, range: sp.range }, now, await docLuaChonDaLuu(now)),
    now,
  );

  const [pnlChannels, prevPnlChannels, dailyRevenue, allChannels, thuNhapTaiChinh] = await Promise.all([
    computeChannelPnl(range),
    computeChannelPnl(previousComparableRange(range, now)),
    computeChannelDailyRevenue(range),
    prisma.channel.findMany({
      orderBy: { sortOrder: "asc" },
      select: { id: true, name: true, color: true, isActive: true, platformFeePct: true, paymentFeePct: true },
    }),
    // Chỉ để chú thích biên ròng — người không thấy lãi thì không cần (và không đọc).
    quyen.coQuyenGiaVon ? sumThuNhapTaiChinh(range) : Promise.resolve(0),
  ]);

  const feePctByChannel: Record<string, number> = {};
  for (const c of allChannels) feePctByChannel[c.id] = c.platformFeePct + c.paymentFeePct;

  const pnlByChannelId = new Map(pnlChannels.map((c) => [c.channelId, c]));
  const activeChannels: ChannelPnl[] = allChannels
    .filter((c) => c.isActive)
    .map((c) => pnlByChannelId.get(c.id) ?? zeroChannelPnl(c));
  // Kênh tắt còn dữ liệu lịch sử trong kỳ — computeChannelPnl đã tự lọc "có phát sinh".
  const inactiveWithActivity = pnlChannels.filter((c) => !c.isActive);
  // Lãi tiết kiệm KHÔNG thuộc kênh bán nào (calcPnlCore ép 0 dưới lăng kính kênh) — nói ra để
  // cộng biên ròng các kênh lại không khớp bảng Lãi/Lỗ thì có lời giải thích ngay tại chỗ.
  const ghiChuKenh = quyen.coQuyenGiaVon ? chuThichBienRongTheoKenh(thuNhapTaiChinh) : null;
  const soSanh: SoSanhKenhDuLieu = boChannelPnlTheoQuyen(
    { channels: activeChannels, prevChannels: prevPnlChannels },
    quyen,
  );

  return (
    <div className="flex flex-col gap-6" data-khoang-server={khoangServerThuocTinh(range)}>
      <ChannelNotFoundToast />

      <ChannelComparisonSection du={soSanh} feePctByChannel={feePctByChannel} />

      {ghiChuKenh && <p className="-mt-2 text-xs text-muted-foreground">{ghiChuKenh}</p>}
      {/* Biểu đồ chỉ cần doanh thu/tên/màu — luôn DTO che, kể cả chủ shop (bớt payload client). */}
      <ChannelTrendChart dailyRevenue={dailyRevenue} channels={cheChannelPnl([...activeChannels, ...inactiveWithActivity])} />

      <div className="flex justify-end">
        <Link href="/marketing?tab=quang-cao" className="text-sm text-primary hover:underline">
          Xem quảng cáo →
        </Link>
      </div>
    </div>
  );
}
