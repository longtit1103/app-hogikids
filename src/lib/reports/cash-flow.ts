import { endOfDay } from "date-fns";

import {
  getCashMovementSummary,
  type CashMovementKindTotal,
} from "@/lib/cash-movements/cash-movement-queries";
import { type DateRange } from "@/lib/date-range";
import { getExpenseSummary, type CategoryBreakdownItem } from "@/lib/expenses/expense-queries";
import { prisma } from "@/lib/prisma";
import { calcPnlCore, pnlOrderSelect, toPnlOrderInput } from "@/lib/reports/pnl";

/**
 * Loader lăng kính "Dòng tiền" của hub Tài chính. TÁI DÙNG `calcPnlCore`
 * (tiền vào) + `getExpenseSummary` (tiền ra) + `getCashMovementSummary` (khoản
 * tiền khác ghi tay — vào/ra ngoài sàn) — KHÔNG viết lại aggregate
 * doanh thu/phí (Bất biến #1: nguồn P&L duy nhất là pnl.ts).
 */

/**
 * Doanh số (GMV) = Σ itemsTotal MỌI đơn trong kỳ (gồm cả hủy/hoàn) — chỉ số
 * quy mô bán, KHÁC doanh thu (chỉ đơn hợp lệ). Không đếm 2 lần vì đơn mirror
 * Kho Tổng đã bị loại ở Bronze→Silver (Order table mirror-free). Biên phải
 * `endOfDay` khớp mọi query kỳ khác (pnl.ts, expense-queries.ts).
 */
export async function sumGmv(range: DateRange): Promise<number> {
  const agg = await prisma.order.aggregate({
    _sum: { itemsTotal: true },
    where: { orderedAt: { gte: range.from, lte: endOfDay(range.to) } },
  });
  return agg._sum.itemsTotal ?? 0;
}

export type CashFlow = {
  /** Tiền vào DỰ KIẾN = netRevenue đơn ĐÃ GIAO (COMPLETED), theo NGÀY ĐẶT. */
  expectedIn: number;
  /** Đơn đang chờ (PENDING/SHIPPING) — chưa tính vào số dư. */
  pendingIn: number;
  pendingCount: number;
  /** Tiền ra thật — MỌI chi phí GỒM Nhập hàng đã ghi. */
  cashOut: number;
  /**
   * Khoản tiền khác GHI TAY (bảng `CashMovement`: vay/góp vốn/bán trực tiếp/thu khác = VÀO; trả nợ
   * gốc/rút vốn = RA), theo `date` trong kỳ. Trục dòng tiền thuần: KHÔNG liên quan P&L và KHÔNG gộp
   * vào `actualIn` (đó là tiền SÀN trả). `otherOut` là số DƯƠNG.
   */
  otherIn: number;
  otherOut: number;
  otherByKind: CashMovementKindTotal[];
  /**
   * Thu nhập tài chính ghi nhận trong kỳ (Σ `ThuNhap.amount` — lãi sổ tiết kiệm đã NHẬN THẬT).
   * Tiền vào THẬT chứ không phải số dự kiến, nên cộng thẳng vào `balance`. Đi đường RIÊNG, KHÔNG
   * gộp vào `otherIn` (ghi tay) hay `expectedIn` (tiền sàn) — gộp là đếm hai lần.
   */
  thuNhapTaiChinh: number;
  /** = expectedIn + otherIn + thuNhapTaiChinh − cashOut − otherOut. */
  balance: number;
  outBreakdown: CategoryBreakdownItem[];
  /**
   * Tiền đã về THẬT — ĐA KÊNH. Mỗi kênh null nếu kỳ chưa có dữ liệu; CẢ HAI null
   * ⇒ UI hiện "Sắp có". (Object LUÔN tồn tại → phải kiểm null TỪNG kênh, không
   * dùng `actualIn ?` vì luôn truthy.)
   */
  actualIn: ActualIn;
};

/** Tiền đã về đa kênh — nối settlement TikTok (đối soát API) + ví Shopee (import tay). */
export type ActualIn = {
  tiktok: TiktokCashIn | null;
  shopee: ShopeeCashIn | null;
};

/**
 * Tiền TikTok đã thanh toán trong kỳ — tầng ĐỐI CHIẾU độc lập P&L (bất biến #2).
 * `net` theo `statement_time` (con số CHÍNH); `adsDeducted`/`bankPaid` là dòng
 * đối chiếu trên trục ngày KHÁC net → KHÔNG ghép "gộp=net+ads" (theo tháng vô nghĩa).
 */
export type TiktokCashIn = {
  net: number; // Σ settlement statement (net đã trừ phí+ads)
  adsDeducted: number; // |Σ| ads TikTok tự trừ (theo order_create_time — đối chiếu)
  bankPaid: number; // Σ payment PAID (lệnh rút bank — khác cơ sở kỳ)
  channel: "tiktok";
};

/**
 * Tiền ví Shopee trong kỳ (import file ví tay) — độc lập P&L (bất biến #2).
 * `net` = Σ amount type∈{REVENUE,ADJUSTMENT} theo `txnTime` (điều chỉnh/hoàn ÂM tự
 * giảm — gộp vào net theo quyết định user). `withdrawn` = |Σ| WITHDRAWAL (rút bank).
 * KHÔNG có ads (Shopee không trừ ads vào ví như TikTok).
 * `unclassifiedCount`/`unclassifiedAmount` = dòng loại OTHER (nhãn Shopee lạ, chưa map) —
 * KHÔNG cộng vào `net` (có thể là phí, không hẳn tiền về) nhưng phải HIỆN để không
 * undercount âm thầm nếu Shopee thêm loại tiền-vào mới. UI cảnh báo khi count > 0.
 */
export type ShopeeCashIn = {
  net: number;
  withdrawn: number;
  unclassifiedCount: number;
  unclassifiedAmount: number;
  channel: "shopee";
};

/**
 * Dòng tiền dự kiến trong kỳ. FETCH đơn 1 LẦN rồi gọi `calcPnlCore` 2 lần
 * in-memory (COMPLETED / PENDING+SHIPPING) — KHÔNG `calcPnl`×2 vì query không
 * lọc status ở SQL nên sẽ fetch trùng. Trang PHẢI `ensureRecurringExpensesForMonths`
 * TRƯỚC (getExpenseSummary không tự backfill chi phí định kỳ).
 */
export async function computeCashFlow(range: DateRange): Promise<CashFlow> {
  const to = endOfDay(range.to);
  const [
    orderRows,
    expSummary,
    settleAgg,
    adsAgg,
    bankAgg,
    shopeeNetAgg,
    shopeeWithdrawAgg,
    shopeeOtherAgg,
    otherSummary,
    thuNhapAgg,
  ] = await Promise.all([
    prisma.order.findMany({
      where: { orderedAt: { gte: range.from, lte: to } },
      select: pnlOrderSelect,
    }),
    getExpenseSummary(range),
    // [Tiền đã về] Silver TikTok — độc lập P&L. net theo statement_time, ads theo
    // order_create_time, bank theo paid_time (status=PAID).
    // `_count` đi kèm `_sum` ở MỌI aggregate dưới đây: "kỳ này có dữ liệu chưa" phải hỏi bằng SỐ
    // DÒNG, không phải bằng tổng tiền. Một kỳ có giao dịch bù trừ nhau đúng bằng 0 (khoản hoàn âm
    // triệt tiêu khoản thu) sẽ ra tổng 0 ở cả 3 dòng và bị đọc nhầm thành "chưa có dữ liệu" — card
    // biến mất, chủ shop tưởng sàn chưa trả đồng nào trong khi tiền có về và có bị trừ.
    prisma.tiktokSettlement.aggregate({
      _sum: { settlementAmount: true },
      _count: true,
      where: { statementTime: { gte: range.from, lte: to } },
    }),
    prisma.tiktokAdsSettlement.aggregate({
      _sum: { settlementAmount: true },
      _count: true,
      where: { orderCreateTime: { gte: range.from, lte: to } },
    }),
    prisma.tiktokPayment.aggregate({
      _sum: { settlementValue: true },
      _count: true,
      where: { status: "PAID", paidTime: { gte: range.from, lte: to } },
    }),
    // [Tiền đã về] Silver ví Shopee — độc lập P&L. net gộp REVENUE+ADJUSTMENT (hoàn
    // âm tự giảm) theo txnTime; withdrawn = |Σ WITHDRAWAL|.
    prisma.shopeeSettlement.aggregate({
      _sum: { amount: true },
      _count: true,
      where: { type: { in: ["REVENUE", "ADJUSTMENT"] }, txnTime: { gte: range.from, lte: to } },
    }),
    prisma.shopeeSettlement.aggregate({
      _sum: { amount: true },
      _count: true,
      where: { type: "WITHDRAWAL", txnTime: { gte: range.from, lte: to } },
    }),
    // Dòng loại OTHER (nhãn Shopee chưa map) — chỉ ĐẾM + Σ để cảnh báo, KHÔNG cộng vào net.
    prisma.shopeeSettlement.aggregate({
      _sum: { amount: true },
      _count: true,
      where: { type: "OTHER", txnTime: { gte: range.from, lte: to } },
    }),
    // Khoản tiền khác ghi tay — trục dòng tiền thuần, không chạm P&L (bất biến #1).
    getCashMovementSummary(range),
    // Lãi sổ tiết kiệm đã nhận trong kỳ — tiền thật, cùng trục với `cashOut`/`otherIn`.
    prisma.thuNhap.aggregate({
      _sum: { amount: true },
      where: { date: { gte: range.from, lte: to } },
    }),
  ]);

  const orders = orderRows.map(toPnlOrderInput);
  const completed = calcPnlCore(orders, [], { statusIn: ["COMPLETED"] });
  const pending = calcPnlCore(orders, [], { statusIn: ["PENDING", "SHIPPING"] });

  const expectedIn = completed.netRevenue;
  const cashOut = expSummary.total; // gồm mọi danh mục kể cả "purchase" (Nhập hàng)
  const thuNhapTaiChinh = thuNhapAgg._sum.amount ?? 0;

  const net = settleAgg._sum.settlementAmount ?? 0;
  const adsDeducted = Math.abs(adsAgg._sum.settlementAmount ?? 0); // ads lưu âm → hiện dương
  const bankPaid = bankAgg._sum.settlementValue ?? 0;
  const tiktok: TiktokCashIn | null =
    // "Có dữ liệu chưa" hỏi bằng SỐ DÒNG (xem ghi chú ở khối aggregate), không bằng tổng tiền.
    settleAgg._count === 0 && adsAgg._count === 0 && bankAgg._count === 0
      ? null // kỳ chưa có settlement TikTok
      : { net, adsDeducted, bankPaid, channel: "tiktok" };

  const shopeeNet = shopeeNetAgg._sum.amount ?? 0;
  const shopeeWithdrawn = Math.abs(shopeeWithdrawAgg._sum.amount ?? 0); // WITHDRAWAL âm → hiện dương
  const shopeeUnclassifiedCount = shopeeOtherAgg._count;
  const shopeeUnclassifiedAmount = shopeeOtherAgg._sum.amount ?? 0;
  const shopee: ShopeeCashIn | null =
    // Kỳ có OTHER (dù net/withdrawn = 0) vẫn hiện card để cảnh báo "chưa phân loại", không ẩn im.
    shopeeNetAgg._count === 0 && shopeeWithdrawAgg._count === 0 && shopeeUnclassifiedCount === 0
      ? null // kỳ chưa có ví Shopee
      : {
          net: shopeeNet,
          withdrawn: shopeeWithdrawn,
          unclassifiedCount: shopeeUnclassifiedCount,
          unclassifiedAmount: shopeeUnclassifiedAmount,
          channel: "shopee",
        };

  return {
    expectedIn,
    pendingIn: pending.netRevenue,
    pendingCount: pending.orderCount,
    cashOut,
    otherIn: otherSummary.inTotal,
    otherOut: otherSummary.outTotal,
    otherByKind: otherSummary.byKind,
    thuNhapTaiChinh,
    balance:
      expectedIn + otherSummary.inTotal + thuNhapTaiChinh - cashOut - otherSummary.outTotal,
    outBreakdown: expSummary.breakdown,
    actualIn: { tiktok, shopee },
  };
}
