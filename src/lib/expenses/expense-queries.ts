import { Prisma } from "@/generated/prisma/client";
import { differenceInCalendarDays, endOfDay, subDays } from "date-fns";

import { type DateRange } from "@/lib/date-range";
import { dieuKienChiPhiTruQuy } from "@/lib/no-phai-tra/dieu-kien-chi-phi-tru-quy";
import type { NguCanhLoc } from "@/lib/no-phai-tra/the-cua-dong-chi";
import { prisma } from "@/lib/prisma";

/**
 * Lib truy vấn chi phí — nguồn tổng hợp DUY NHẤT cho `/chi-phi` và (phase 5)
 * Dashboard/Báo cáo/Kênh. Phase 5 IMPORT LẠI các hàm này, KHÔNG viết lại
 * aggregate → chữ ký là hợp đồng đóng, giữ nguyên.
 *
 * Biên phải của range luôn `endOfDay(range.to)` (nhất quán calcPnl phase 5).
 */

const PAGE_SIZE = 20;

export type CategoryBreakdownItem = { categoryId: string; name: string; amount: number; pct: number };

export type ExpenseSummary = {
  total: number;
  totalPrev: number;
  topCategory: CategoryBreakdownItem | null;
  adsTotal: number;
  adsTotalPrev: number;
  breakdown: CategoryBreakdownItem[];
};

/**
 * Tổng hợp chi phí sổ trong kỳ + so kỳ liền trước cùng độ dài.
 *  - `total`/`breakdown`: gộp mọi danh mục (KHÔNG gồm phí sàn — phí sàn là số
 *    Pancake trên Order, không phải Expense).
 *  - `adsTotal`: danh mục "ads" mọi nguồn (ADS_API + IMPORT + MANUAL).
 *  - kỳ trước = lùi đúng (differenceInCalendarDays(to, from) + 1) ngày.
 *
 * `opts.chiTienThat` (tab Dòng tiền — TIỀN THẬT ra): mọi tổng chỉ gồm phần TRỪ QUỸ, cùng bộ lọc Sổ quỹ
 * (`dieuKienChiPhiTruQuy`) — bỏ khoản thẻ/ví ads đã gánh sau mốc M. Không truyền (tab Sổ chi phí) ⇒ mọi
 * dòng như cũ: chi phí vẫn là chi phí dù trả bằng gì.
 */
export async function getExpenseSummary(
  range: DateRange,
  opts?: { chiTienThat?: NguCanhLoc }
): Promise<ExpenseSummary> {
  const from = range.from;
  const to = endOfDay(range.to);
  const spanDays = differenceInCalendarDays(range.to, range.from) + 1;
  const prevFrom = subDays(from, spanDays);
  const prevTo = subDays(to, spanDays);

  const ctx = opts?.chiTienThat;
  /** where của khoảng [gte, lte]: Sổ chi phí = mọi dòng; tiền thật = phần trừ quỹ. */
  const trongKhoang = (gte: Date, lte: Date): Prisma.ExpenseWhereInput =>
    ctx === undefined ? { date: { gte, lte } } : dieuKienChiPhiTruQuy(ctx, { gte, lte });
  const chiAds = (w: Prisma.ExpenseWhereInput): Prisma.ExpenseWhereInput =>
    ctx === undefined ? { categoryId: "ads", ...w } : { AND: [w, { categoryId: "ads" }] };

  const [grouped, prevAgg, adsAgg, prevAdsAgg, categories] = await Promise.all([
    prisma.expense.groupBy({
      by: ["categoryId"],
      where: trongKhoang(from, to),
      _sum: { amount: true },
    }),
    prisma.expense.aggregate({
      _sum: { amount: true },
      where: trongKhoang(prevFrom, prevTo),
    }),
    prisma.expense.aggregate({
      _sum: { amount: true },
      where: chiAds(trongKhoang(from, to)),
    }),
    prisma.expense.aggregate({
      _sum: { amount: true },
      where: chiAds(trongKhoang(prevFrom, prevTo)),
    }),
    prisma.expenseCategory.findMany({ select: { id: true, name: true } }),
  ]);

  const nameById = new Map(categories.map((c) => [c.id, c.name]));
  const total = grouped.reduce((sum, g) => sum + (g._sum.amount ?? 0), 0);

  const breakdown: CategoryBreakdownItem[] = grouped
    .map((g) => {
      const amount = g._sum.amount ?? 0;
      return {
        categoryId: g.categoryId,
        name: nameById.get(g.categoryId) ?? g.categoryId,
        amount,
        pct: total > 0 ? (amount / total) * 100 : 0,
      };
    })
    .filter((b) => b.amount > 0) // chỉ danh mục có phát sinh
    .sort((a, b) => b.amount - a.amount);

  return {
    total,
    totalPrev: prevAgg._sum.amount ?? 0,
    topCategory: breakdown[0] ?? null,
    adsTotal: adsAgg._sum.amount ?? 0,
    adsTotalPrev: prevAdsAgg._sum.amount ?? 0,
    breakdown,
  };
}

/**
 * CÔNG THỨC PHÍ SÀN DUY NHẤT TOÀN APP — Σ Order.platformFeeEst của đơn HỢP LỆ
 * (không RETURNED/CANCELLED) theo orderedAt trong kỳ. Đơn RETURNED coi như sàn
 * hoàn phí nên không tính (quyết định grill). Lọc kênh khi truyền channelId.
 */
export async function sumPlatformFeeEst({ from, to }: DateRange, channelId?: string): Promise<number> {
  const agg = await prisma.order.aggregate({
    _sum: { platformFeeEst: true },
    where: {
      orderedAt: { gte: from, lte: endOfDay(to) },
      status: { notIn: ["RETURNED", "CANCELLED"] },
      ...(channelId ? { channelId } : {}),
    },
  });
  return agg._sum.platformFeeEst ?? 0;
}

export type RecurringExpenseRow = {
  id: string;
  description: string;
  categoryName: string;
  channelName: string | null;
  amount: number;
  dayOfMonth: number;
  active: boolean;
  /** Mốc bắt đầu sinh (đầu tháng VN) — NULL với mẫu dựng trước khi có cột. */
  activeFrom: Date | null;
};

/**
 * Danh sách MỌI mẫu định kỳ (đang chạy lẫn đã dừng) — khối "Khoản chi định kỳ" ở tab Sổ chi phí, chủ
 * shop tra lại mẫu nào còn chạy/đã tắt và bật lại mẫu đã dừng. `RecurringExpense` KHÔNG có quan hệ Prisma tới ExpenseCategory/Channel
 * (chỉ `categoryId`/`channelId` dạng String, cố ý không migration thêm quan hệ chỉ cho một khối
 * hiển thị) nên tra tên bằng Map, cùng khuôn `nameById` của `getExpenseSummary` ở trên.
 * Sắp: đang chạy (active) trước, rồi theo mô tả A→Z (so sánh tiếng Việt).
 */
export async function getRecurringExpenseList(): Promise<RecurringExpenseRow[]> {
  const [records, categories, channels] = await Promise.all([
    prisma.recurringExpense.findMany(),
    prisma.expenseCategory.findMany({ select: { id: true, name: true } }),
    prisma.channel.findMany({ select: { id: true, name: true } }),
  ]);

  const categoryNameById = new Map(categories.map((c) => [c.id, c.name]));
  const channelNameById = new Map(channels.map((c) => [c.id, c.name]));

  return records
    .map((r) => ({
      id: r.id,
      description: r.description,
      categoryName: categoryNameById.get(r.categoryId) ?? r.categoryId,
      channelName: r.channelId ? (channelNameById.get(r.channelId) ?? r.channelId) : null,
      amount: r.amount,
      dayOfMonth: r.dayOfMonth,
      active: r.active,
      activeFrom: r.activeFrom,
    }))
    .sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.description.localeCompare(b.description, "vi");
    });
}

export type ExpenseListParams = {
  range: DateRange;
  categoryIds?: string[];
  channelId?: string | "none";
  sources?: ("MANUAL" | "RECURRING" | "IMPORT" | "ADS_API")[];
  q?: string;
  sort: "date_desc" | "date_asc" | "amount_desc" | "amount_asc";
  page: number;
};

export type ExpenseRow = {
  id: string;
  date: Date;
  categoryId: string;
  categoryName: string;
  categoryIsHidden: boolean;
  adsSource: string | null;
  description: string;
  channelId: string | null;
  channelName: string | null;
  channelColor: string | null;
  amount: number;
  source: string;
  recurringId: string | null;
  /** `LOAN:{loanId}:{yyyy-MM-dd}` = dòng lãi do duyệt kỳ trả nợ sinh ra (hộp xoá nói rõ). */
  refId: string | null;
  /** "Trừ vào thẻ" (nợ phải trả §5.6) — form sửa điền sẵn; null = trừ quỹ ngay như mọi khoản chi. */
  cardId: string | null;
  /** Tên thẻ của `cardId` cho nhãn nhỏ trên bảng; null khi không gắn thẻ. */
  tenThe: string | null;
};

function buildOrderBy(sort: ExpenseListParams["sort"]): Prisma.ExpenseOrderByWithRelationInput {
  switch (sort) {
    case "date_asc":
      return { date: "asc" };
    case "amount_desc":
      return { amount: "desc" };
    case "amount_asc":
      return { amount: "asc" };
    case "date_desc":
    default:
      return { date: "desc" };
  }
}

/**
 * Trang danh sách chi phí (20 dòng/trang) + `count` và `totalAmount` (aggregate
 * cùng WHERE) cho dòng "Tổng: X khoản — Y ₫".
 * Lọc: range + categoryId in + kênh (`"none"` → chưa gắn kênh) + source in +
 * mô tả chứa `q` (không phân biệt hoa/thường).
 */
export async function getExpensesPage(
  p: ExpenseListParams
): Promise<{ rows: ExpenseRow[]; count: number; totalAmount: number }> {
  const where: Prisma.ExpenseWhereInput = {
    date: { gte: p.range.from, lte: endOfDay(p.range.to) },
  };

  // `undefined` = KHÔNG lọc danh mục. Mảng RỖNG = có yêu cầu lọc nhưng không id nào hợp lệ ⇒ phải
  // ra 0 dòng. Gộp hai ca lại (`length > 0`) là để bộ lọc tự bốc hơi đúng lúc nó cần chặt nhất.
  if (p.categoryIds) {
    where.categoryId = { in: p.categoryIds };
  }
  if (p.channelId === "none") {
    where.channelId = null; // chi phí chưa gắn kênh
  } else if (p.channelId) {
    where.channelId = p.channelId;
  }
  if (p.sources && p.sources.length > 0) {
    where.source = { in: p.sources };
  }
  if (p.q && p.q.trim()) {
    where.description = { contains: p.q.trim(), mode: "insensitive" };
  }

  const [records, count, agg] = await Promise.all([
    prisma.expense.findMany({
      where,
      orderBy: buildOrderBy(p.sort),
      skip: (p.page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { category: true, channel: true, theTinDung: { select: { ten: true } } },
    }),
    prisma.expense.count({ where }),
    prisma.expense.aggregate({ _sum: { amount: true }, where }),
  ]);

  return { rows: records.map(sangExpenseRow), count, totalAmount: agg._sum.amount ?? 0 };
}

/** Dòng Expense kèm danh mục + kênh (+ tên thẻ nếu câu đọc có lấy) — đầu vào của `sangExpenseRow`. */
export type ExpenseKemQuanHe = Prisma.ExpenseGetPayload<{ include: { category: true; channel: true } }> & {
  theTinDung?: { ten: string } | null;
};

/**
 * Bản ghi Prisma → `ExpenseRow` — MỘT chỗ dựng cho mọi bảng chi phí (Sổ chi phí, tab ads của trang kênh)
 * để thêm cột không phải sửa nhiều nơi. Câu đọc không lấy tên thẻ ⇒ `tenThe` null (nhãn không hiện),
 * `cardId` vẫn đúng giá trị thật cho form sửa.
 */
export function sangExpenseRow(e: ExpenseKemQuanHe): ExpenseRow {
  return {
    id: e.id,
    date: e.date,
    categoryId: e.categoryId,
    categoryName: e.category.name,
    categoryIsHidden: e.category.isHidden,
    adsSource: e.adsSource,
    description: e.description,
    channelId: e.channelId,
    channelName: e.channel?.name ?? null,
    channelColor: e.channel?.color ?? null,
    amount: e.amount,
    source: e.source,
    recurringId: e.recurringId,
    refId: e.refId,
    cardId: e.cardId,
    tenThe: e.theTinDung?.ten ?? null,
  };
}
