import { endOfDay } from "date-fns";

import { type DateRange } from "@/lib/date-range";
import { prisma } from "@/lib/prisma";
import { pnlPercentBase } from "@/lib/reports/pnl-percent-base";

import type { OrderStatus, Prisma } from "@prisma/client";

/**
 * NGUỒN CÔNG THỨC P&L DUY NHẤT toàn app. Mọi màn phase 5 + phase 6 đọc từ đây,
 * KHÔNG tự viết lại aggregate doanh thu/phí sàn/COGS ở nơi khác.
 */

export interface PnlOrderInput {
  status: OrderStatus;
  channelId: string;
  itemsTotal: number;
  discount: number;
  platformFeeEst: number;
  returnedFee?: number; // phí sàn THỰC sàn giữ (đơn hoàn/hủy); mặc định 0 — OPTIONAL để không phá fixture cũ
  items: { sku: string; quantity: number; costPrice: number | null }[]; // null = variantId null
}

export interface PnlExpenseInput {
  categoryId: string;
  adsSource: string | null;
  channelId: string | null;
  amount: number;
}

/**
 * Một dòng thu nhập ngoài bán hàng trong kỳ (bảng `ThuNhap` — v1 chỉ có lãi sổ tiết kiệm).
 * CỐ Ý chỉ mang `amount`: P&L không được biết khoản này đến từ sổ nào — nó là thu nhập của cả
 * shop, không phân bổ kênh. Giữ hình dạng tối thiểu này cũng là điều kiện để hàng rào cách ly
 * `khong-ro-ri-vao-pnl` không phải nới ra.
 *
 * (Cố ý KHÔNG viết đường dẫn đầy đủ của file lưới đó ở đây: lưới quét CHÍNH VĂN BẢN file này tìm
 * các token trục dòng tiền, nên nhắc tên thư mục của nó là tự làm mình đỏ — đúng tinh thần "kiểm
 * cái chữ" mà lưới đã khai.)
 */
export interface PnlIncomeInput {
  amount: number;
}

export interface PnlBreakdown {
  revenue: number;
  platformFee: number;
  returnedOrderFee: number; // phí sàn THỰC trên đơn hoàn/hủy (Σ returnedFee) — trừ ở lãi ròng, NGOÀI doanh thu
  voucher: number;
  netRevenue: number;
  cogs: number;
  grossProfit: number;
  ads: number;
  adsBySource: Record<string, number>; // key = adsSource thực (META/TIKTOK_ADS/SHOPEE_ADS/…), null → "KHAC"; tab P&L render MỌI key, không bỏ sót
  shipping: number;
  packaging: number;
  returnBom: number;
  fixed: number;
  /**
   * Thu nhập tài chính = Σ `ThuNhap.amount` trong kỳ (lãi sổ tiết kiệm đã NHẬN THẬT).
   * Là phép CỘNG duy nhất vào `netProfit` ngoài doanh thu bán hàng — ghi TRỌN vào tháng tất toán
   * sổ (chủ shop chốt 10/09: P&L khớp tiền thật, KHÔNG phân bổ dồn tích các tháng gửi).
   * Lăng kính kênh ép về 0: lãi tiết kiệm không thuộc kênh bán nào (cùng luật `fixed`/`interest`).
   */
  financialIncome: number;
  interest: number; // lãi vay — chi phí tài chính, dòng riêng, KHÔNG phân bổ kênh
  other: number;
  /**
   * Các `categoryId` THỰC SỰ có phát sinh trong kỳ mà rơi vào dòng "Khác" (ngoài `KNOWN`) — gồm cả
   * `"other"` lẫn danh mục chủ shop tự tạo. CHỈ dùng dựng link drill cho đúng tập đang cộng; KHÔNG
   * tham gia một vế tiền nào. Rỗng khi kỳ không có khoản nào thuộc nhóm này.
   */
  otherCategoryIds: string[];
  netProfit: number;
  orderCount: number;
  returnBomOrderCount: number;
  /**
   * Số SKU **sửa được**: có tên, CÓ biến thể trong app (`costPrice === 0`, tức đã khớp `variantId`)
   * và chưa nhập giá vốn. Đây là tập DUY NHẤT mà bộ lọc "Đã bán, thiếu giá vốn" ở màn Sản phẩm trả
   * về — nên cũng là điều kiện DUY NHẤT để cảnh báo được phép mang link dẫn sang đó.
   */
  skuMissingCount: number;
  /**
   * Số DÒNG HÀNG không tính được COGS mà KHÔNG có biến thể nào để sửa — gộp HAI ca, vì với chủ shop
   * chúng cùng một kết cục "màn Sản phẩm không giúp được":
   *  - không rõ SKU (Pancake không trả `display_id`, hay gặp ở đơn Shopee thiếu `variation_info`);
   *  - CÓ tên SKU nhưng KHÔNG khớp biến thể nào (`costPrice === null`, tức `OrderItem.variantId`
   *    null) — sửa một biến thể trùng tên cũng không đổi COGS của dòng này.
   * Đếm theo DÒNG chứ không gộp vào đếm SKU: gộp chuỗi rỗng vào Set làm mọi dòng như vậy tính
   * chung MỘT "SKU" ma, vừa đếm hụt vừa xui đi tìm SKU không tồn tại.
   */
  skuUnknownLineCount: number;
}

/**
 * Kết quả khi soi qua lăng kính `statusIn` (Dòng tiền). 3 field VÔ NGHĨA dưới
 * lăng kính này bị LOẠI KHỎI KIỂU: `netProfit` (vẫn trừ returnedOrderFee + chi
 * phí sổ bất kể filter), `returnBomOrderCount` ("phần còn lại" chứ không phải
 * hoàn/bom), `returnedOrderFee` (tính trên MỌI đơn của kênh, độc lập filter).
 * Runtime vẫn tính đủ (không đổi số, không đổi hành vi) — guard mức KIỂU, chống
 * đọc nhầm về sau. Lưu ý: guard áp cho lời gọi truyền `statusIn` TƯỜNG MINH
 * (object literal — như cash-flow.ts); caller gom opts động có `statusIn?`
 * optional sẽ rơi về overload đầy đủ — tự chịu trách nhiệm đọc đúng.
 */
export type PnlStatusLensBreakdown = Omit<
  PnlBreakdown,
  "netProfit" | "returnBomOrderCount" | "returnedOrderFee"
>;

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

// CHỐT (plan.md Global Constraints — BẤT BIẾN):
// - Đơn hợp lệ = status ∉ {RETURNED, CANCELLED}, tính theo orderedAt trong kỳ.
// - Phí sàn = Σ platformFeeEst CHỈ của đơn hợp lệ (đơn hoàn/hủy coi như sàn hoàn phí — quyết định grill).
//   Định nghĩa khớp sumPlatformFeeEst (phase 4) — KHÔNG viết aggregate phí sàn thứ hai ở nơi khác.
// - COGS = Σ quantity × Variant.costPrice HIỆN HÀNH (join lúc đọc, KHÔNG snapshot — đổi giá vốn đổi cả kỳ cũ).
//   Item variantId null hoặc costPrice = 0 → cogs dòng = 0. Chia LÀM HAI theo "có sửa được không":
//   costPrice = 0 + sku có tên → skuMissingCount (đếm theo SKU, sửa được ở màn Sản phẩm);
//   còn lại (variantId null, hoặc sku rỗng) → skuUnknownLineCount (đếm theo DÒNG, không sửa được).
// - Danh mục "purchase" (Nhập hàng) là DÒNG TIỀN — KHÔNG BAO GIỜ vào P&L.
// - channelId: chỉ đơn của kênh; expense chỉ dòng gắn đúng kênh và ∉ {purchase, fixed, interest}
//   (không phân bổ chi phí chung). Danh mục "interest" (Lãi vay) VÀO P&L thành dòng riêng, nhưng
//   KHÔNG phân bổ kênh — cùng luật với "fixed" (là chi phí chung của cả shop, không của kênh nào).
/**
 * ĐƠN HỢP LỆ — đơn được tính vào doanh thu/COGS của P&L (bất biến #1).
 *
 * Export ra ngoài vì đã có chỗ thứ hai cần đúng luật này: bảng "áp giá vốn sẽ làm lãi tháng nào đổi
 * bao nhiêu" (`src/lib/gia-von/anh-huong-cogs.ts`). Chép điều kiện sang đó là mở đường cho hai nơi
 * lệch nhau — mà lệch ở đây nghĩa là màn duyệt hứa một con số, P&L ra một con số khác.
 */
export function laDonHopLe(status: OrderStatus): boolean {
  return status !== "RETURNED" && status !== "CANCELLED";
}

// Overload: KHÔNG truyền `statusIn` → PnlBreakdown đầy đủ (lăng kính P&L mặc định);
// CÓ `statusIn` → PnlStatusLensBreakdown (netProfit/returnBomOrderCount bị loại khỏi kiểu).
// `incomes` CHỈ có ở overload đầu: dưới lăng kính Dòng tiền không có netProfit để cộng vào, nên
// truyền vào đó là vô nghĩa — chặn ngay ở tầng KIỂU thay vì để nó âm thầm không tác dụng.
export function calcPnlCore(
  orders: PnlOrderInput[],
  expenses: PnlExpenseInput[],
  opts?: { channelId?: string; incomes?: PnlIncomeInput[] }
): PnlBreakdown;
export function calcPnlCore(
  orders: PnlOrderInput[],
  expenses: PnlExpenseInput[],
  opts: { channelId?: string; statusIn: OrderStatus[] }
): PnlStatusLensBreakdown;
export function calcPnlCore(
  orders: PnlOrderInput[],
  expenses: PnlExpenseInput[],
  opts?: { channelId?: string; statusIn?: OrderStatus[]; incomes?: PnlIncomeInput[] }
): PnlBreakdown {
  const ord = opts?.channelId ? orders.filter((o) => o.channelId === opts.channelId) : orders;
  // `statusIn` (ADDITIVE — lăng kính Dòng tiền): khi truyền, CHỈ tính đơn có
  // status trong danh sách. Guard `!== undefined` (KHÔNG truthy) để `[]` không
  // âm thầm rơi về default. Mặc định giữ nguyên "đơn hợp lệ" ∉{RETURNED,CANCELLED}
  // → caller cũ (không truyền statusIn) KHÔNG đổi số.
  // LƯU Ý: khi lọc `statusIn`, `orderCount` = số đơn khớp filter (OK), nhưng
  // `returnBomOrderCount` = phần còn lại (KHÔNG phải hoàn/bom) — chỉ có nghĩa
  // khi `statusIn` unset (đã chặn ở KIỂU: overload statusIn trả
  // PnlStatusLensBreakdown không có field này).
  const valid =
    opts?.statusIn !== undefined
      ? ord.filter((o) => opts.statusIn!.includes(o.status))
      : ord.filter((o) => laDonHopLe(o.status));
  const exp = expenses
    .filter((e) => e.categoryId !== "purchase")
    .filter((e) => !opts?.channelId || (e.channelId === opts.channelId && e.categoryId !== "fixed" && e.categoryId !== "interest"));
  const revenue = sum(valid.map((o) => o.itemsTotal));
  const platformFee = sum(valid.map((o) => o.platformFeeEst));
  // Phí sàn THỰC sàn giữ trên đơn HOÀN/HỦY (returnedFee). Tính trên `ord` (mọi status
  // của kênh) lọc RETURNED/CANCELLED — KHÔNG double-count vì các đơn này đóng góp 0 vào
  // revenue/platformFee/cogs/voucher (bị `valid` loại). Độc lập lăng kính `statusIn`.
  const returnedOrderFee = sum(
    ord.filter((o) => o.status === "RETURNED" || o.status === "CANCELLED").map((o) => o.returnedFee ?? 0)
  );
  const voucher = sum(valid.map((o) => o.discount));
  const missing = new Set<string>();
  let dongKhongSuaDuoc = 0;
  let cogs = 0;
  for (const o of valid)
    for (const it of o.items) {
      if (it.costPrice) {
        cogs += it.quantity * it.costPrice;
        continue;
      }
      // Ranh giới ở đây quyết định cảnh báo có được mang LINK hay không (xem chú thích ở type):
      // `costPrice === 0` ⇒ dòng ĐÃ khớp một biến thể, chỉ thiếu giá vốn ⇒ nhập ở màn Sản phẩm là
      // xong. `null` ⇒ không khớp biến thể nào; sku rỗng ⇒ không tra được. Cả hai ca sau đều không
      // có gì để sửa ở màn đó, nên đếm theo DÒNG và KHÔNG được kể vào skuMissingCount.
      if (it.costPrice === 0 && it.sku) missing.add(it.sku);
      else dongKhongSuaDuoc++;
    }
  const byCat = (id: string) => sum(exp.filter((e) => e.categoryId === id).map((e) => e.amount));
  const adsBySource: Record<string, number> = {};
  for (const e of exp)
    if (e.categoryId === "ads") {
      const k = e.adsSource ?? "KHAC";
      adsBySource[k] = (adsBySource[k] ?? 0) + e.amount;
    }
  const ads = byCat("ads");
  // Thêm id vào KNOWN mà QUÊN trừ ở netProfit ⇒ danh mục đó biến mất khỏi lợi nhuận trong khi MỌI test
  // hiện có vẫn xanh — tests/pnl.test.ts "Lãi vay 5tr ⇒ netProfit −5tr" canh đúng ca này.
  const KNOWN = ["purchase", "ads", "shipping", "packaging", "return_bom", "fixed", "interest"];
  // MỘT vị từ, dùng cho CẢ số tiền lẫn tập id: viết hai lần thì sửa một chỗ quên chỗ kia ⇒ link
  // mang tập KHÁC với tập đang cộng, đúng lớp lỗi đoạn này sinh ra để diệt.
  const expKhac = exp.filter((e) => !KNOWN.includes(e.categoryId)); // "other" + danh mục tùy chỉnh
  const other = sum(expKhac.map((e) => e.amount));
  // Dòng "Khác" gộp MỌI danh mục ngoài KNOWN, gồm cả danh mục chủ shop TỰ TẠO ở /cai-dat. Link drill
  // phải mang ĐÚNG tập id đang cộng vào dòng: kẹp cứng `danh_muc=other` thì bấm vào ra sổ trống
  // trong khi bảng vẫn cộng tiền — số đúng mà không lần ra được nó từ đâu.
  //
  // ⚠️ Dưới lăng kính KÊNH, `exp` đã lọc theo kênh ⇒ tập này là id của RIÊNG kênh đó, trong khi sổ
  // chi phí không lọc kênh. Hôm nay vô hại (bảng P&L chỉ dựng từ breakdown KHÔNG kênh); ai render
  // bảng theo kênh sau này phải mang thêm `kenh=` vào href, nếu không Σ sổ > dòng cha.
  const otherCategoryIds = [...new Set(expKhac.map((e) => e.categoryId))].sort();
  const interest = byCat("interest"); // lãi vay (spec 260907 §5.4)
  // Lăng kính kênh ép về 0 NGAY TẠI ĐÂY — giữ MỘT chỗ logic kênh duy nhất (loader chỉ đọc dữ liệu
  // rồi truyền vào, không tự quyết). Lãi tiết kiệm là thu nhập của cả shop: gán nó cho một kênh
  // bán là bịa lãi cho kênh đó, y hệt lý do `fixed`/`interest` không phân bổ kênh.
  const financialIncome = opts?.channelId ? 0 : sum((opts?.incomes ?? []).map((i) => i.amount));
  const netRevenue = revenue - platformFee - voucher;
  const grossProfit = netRevenue - cogs;
  // netProfit CHỈ có nghĩa khi `statusIn` unset (lăng kính P&L mặc định) —
  // returnedOrderFee LUÔN bị trừ ở đây bất kể `statusIn`, giống caveat đã ghi ở
  // `returnBomOrderCount` phía trên. Đã chặn ở KIỂU (overload statusIn trả
  // PnlStatusLensBreakdown không có netProfit) — caller Dòng tiền không đọc
  // được field này lúc compile.
  //
  // ⚠️ `financialIncome` là số CỘNG DUY NHẤT trong công thức này. Mọi nơi suy "chi phí vận hành"
  // bằng HIỆU `grossProfit − netProfit` PHẢI cộng lại khoản này (xem `buildOpexGroup` ở
  // pnl-line-items.ts), nếu không dòng nhóm tự hụt ĐÚNG BẰNG số lãi mà không test cũ nào đỏ.
  const netProfit =
    grossProfit +
    financialIncome -
    ads -
    byCat("shipping") -
    byCat("packaging") -
    byCat("return_bom") -
    byCat("fixed") -
    interest -
    other -
    returnedOrderFee;
  return {
    revenue,
    platformFee,
    returnedOrderFee,
    voucher,
    netRevenue,
    cogs,
    grossProfit,
    ads,
    adsBySource,
    shipping: byCat("shipping"),
    packaging: byCat("packaging"),
    returnBom: byCat("return_bom"),
    fixed: byCat("fixed"),
    financialIncome,
    interest,
    other,
    otherCategoryIds,
    netProfit,
    orderCount: valid.length,
    returnBomOrderCount: ord.length - valid.length,
    skuMissingCount: missing.size,
    skuUnknownLineCount: dongKhongSuaDuoc,
  };
}

/**
 * Select tối thiểu để dựng `PnlOrderInput`. `computeDailySeries` (Task 3) fetch
 * đơn 1 lần rồi bucket theo ngày dùng LẠI select + `toPnlOrderInput` này → map
 * GIỐNG HỆT loader, không có định nghĩa doanh thu/COGS thứ hai lệch nhau.
 */
export const pnlOrderSelect = {
  status: true,
  channelId: true,
  itemsTotal: true,
  discount: true,
  platformFeeEst: true,
  returnedFee: true,
  items: { select: { sku: true, quantity: true, variant: { select: { costPrice: true } } } },
} satisfies Prisma.OrderSelect;

type PnlOrderRow = {
  status: OrderStatus;
  channelId: string;
  itemsTotal: number;
  discount: number;
  platformFeeEst: number;
  returnedFee: number;
  items: { sku: string; quantity: number; variant: { costPrice: number } | null }[];
};

/** Map 1 dòng Order (theo `pnlOrderSelect`) → `PnlOrderInput`. costPrice null CHỈ khi variantId null. */
export function toPnlOrderInput(o: PnlOrderRow): PnlOrderInput {
  return {
    status: o.status,
    channelId: o.channelId,
    itemsTotal: o.itemsTotal,
    discount: o.discount,
    platformFeeEst: o.platformFeeEst,
    returnedFee: o.returnedFee,
    items: o.items.map((it) => ({
      sku: it.sku,
      quantity: it.quantity,
      costPrice: it.variant?.costPrice ?? null, // null CHỈ khi variantId null (không có variant)
    })),
  };
}

/**
 * Loader Prisma → `calcPnlCore`. Biên phải kỳ dùng `endOfDay(range.to)` cho CẢ
 * orders (orderedAt) lẫn expenses (date), khớp `getExpenseSummary`/
 * `sumPlatformFeeEst` phase 4. KHÔNG lọc channelId ở query expense — core lọc
 * (giữ 1 chỗ logic kênh). Đơn `orderedAt` lùi ngày do sync sửa → số kỳ cũ đổi —
 * đúng chủ đích (COGS + status là số hiện hành, không snapshot).
 */
export async function calcPnl(range: DateRange, opts?: { channelId?: string }): Promise<PnlBreakdown> {
  const to = endOfDay(range.to);
  const [orders, expenses, incomes] = await Promise.all([
    prisma.order.findMany({
      where: {
        orderedAt: { gte: range.from, lte: to },
        ...(opts?.channelId ? { channelId: opts.channelId } : {}),
      },
      select: pnlOrderSelect,
    }),
    prisma.expense.findMany({
      where: { date: { gte: range.from, lte: to } },
      select: { categoryId: true, adsSource: true, channelId: true, amount: true },
    }),
    // Thu nhập ngoài bán hàng (lãi sổ tiết kiệm đã nhận). KHÔNG lọc/bỏ theo `channelId` ở đây:
    // `calcPnlCore` ép về 0 dưới lăng kính kênh — giữ MỘT chỗ logic kênh. Query vẫn chạy khi có
    // channelId, đổi lại là không có chỗ thứ hai quyết định chuyện kênh; bảng này nhập tay, vài
    // chục dòng mỗi năm, có index theo `date`.
    prisma.thuNhap.findMany({
      where: { date: { gte: range.from, lte: to } },
      select: { amount: true },
    }),
  ]);

  return calcPnlCore(orders.map(toPnlOrderInput), expenses, { ...opts, incomes });
}

/**
 * Σ thu nhập tài chính của kỳ — dành cho màn CHỈ cần con số này để chú thích (trang /kenh: biên
 * ròng từng kênh KHÔNG gồm khoản này). Gọi `calcPnl` chỉ để lấy một số là kéo theo cả query đơn
 * hàng + chi phí của kỳ. Biên phải `endOfDay(range.to)` khớp mọi query kỳ khác của app.
 */
export async function sumThuNhapTaiChinh(range: DateRange): Promise<number> {
  const agg = await prisma.thuNhap.aggregate({
    _sum: { amount: true },
    where: { date: { gte: range.from, lte: endOfDay(range.to) } },
  });
  return agg._sum.amount ?? 0;
}

// Mẫu số "% / doanh thu" toàn app: `pnl-percent-base.ts` — module thuần riêng vì Client Component
// cũng gọi (import từ đây là kéo Prisma vào browser bundle).

export interface ChannelPnl {
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
  netProfit: number;
  roas: number | null;
  marginPct: number | null;
}

/**
 * P&L từng kênh trong kỳ. Trả về MỌI kênh có phát sinh (đơn HOẶC chi phí gắn
 * kênh), KỂ CẢ kênh đã tắt (`isActive=false`) — trang /kenh vẫn cần thấy chúng.
 * Mỗi kênh = `calcPnl(range, { channelId })` + các tỉ số dẫn xuất.
 *
 * LƯU Ý: Σ netProfit kênh ≠ netProfit toàn shop (fixed + interest + chi phí không gắn kênh
 * KHÔNG phân bổ về kênh — chủ đích, khớp quy tắc lọc chi phí của calcPnlCore).
 */
export async function computeChannelPnl(range: DateRange): Promise<ChannelPnl[]> {
  const to = endOfDay(range.to);
  const [orderChannels, expenseChannels] = await Promise.all([
    prisma.order.findMany({
      where: { orderedAt: { gte: range.from, lte: to } },
      select: { channelId: true },
      distinct: ["channelId"],
    }),
    prisma.expense.findMany({
      where: { date: { gte: range.from, lte: to }, channelId: { not: null } },
      select: { channelId: true },
      distinct: ["channelId"],
    }),
  ]);

  const channelIds = new Set<string>();
  for (const o of orderChannels) channelIds.add(o.channelId);
  for (const e of expenseChannels) if (e.channelId) channelIds.add(e.channelId);
  if (channelIds.size === 0) return [];

  const channels = await prisma.channel.findMany({
    where: { id: { in: [...channelIds] } },
    orderBy: { sortOrder: "asc" },
    select: { id: true, name: true, color: true, isActive: true },
  });

  return Promise.all(
    channels.map(async (ch) => {
      const b = await calcPnl(range, { channelId: ch.id });
      const returnDenom = b.orderCount + b.returnBomOrderCount;
      return {
        channelId: ch.id,
        name: ch.name,
        color: ch.color,
        isActive: ch.isActive,
        revenue: b.revenue,
        orderCount: b.orderCount,
        aov: b.orderCount ? b.revenue / b.orderCount : null,
        ads: b.ads,
        platformFee: b.platformFee,
        returnBomOrderCount: b.returnBomOrderCount,
        returnBomRatePct: returnDenom ? (b.returnBomOrderCount / returnDenom) * 100 : null,
        netProfit: b.netProfit,
        roas: b.ads > 0 ? b.revenue / b.ads : null,
        marginPct: pnlPercentBase(b) ? (b.netProfit / pnlPercentBase(b)) * 100 : null,
      };
    })
  );
}
