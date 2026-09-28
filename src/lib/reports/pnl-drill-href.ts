import type { OrderStatus } from "@prisma/client";
import { endOfMonth, format, startOfMonth } from "date-fns";

import { ORDER_STATUS_META } from "@/lib/orders/order-status-meta";

/**
 * Giải quyết href drill-down của bảng P&L — module THUẦN (không JSX) để test
 * được bằng vitest, `pnl-tab.tsx` chỉ gọi lại.
 *
 * Quy ước DUY NHẤT: mọi đích drill đều được neo kỳ = đầu/cuối THÁNG đang hiển
 * thị trên bảng P&L. TUYỆT ĐỐI KHÔNG copy `range`/`tu`/`den` toàn cục: bảng
 * P&L luôn tính theo THÁNG dương lịch chứa `range.to`, còn range toàn cục có
 * thể là preset `today`/`7d` hay một custom range vài ngày. Copy range toàn cục
 * sẽ mở trang đích theo kỳ KHÁC với con số người dùng vừa bấm — số bên đó không
 * cộng lại ra số trên dòng P&L (mất trung thực số liệu).
 *
 * Mỗi đích có schema query RIÊNG nên tên param ngày không giống nhau:
 * `/tai-chinh` + `/bao-cao` đọc range toàn cục (`tu`/`den`), còn `/don-hang`
 * dùng bộ lọc riêng của nó (`ngay_tu`/`ngay_den`). Đích không nằm trong bảng
 * `DRILL_TARGETS` trả href nguyên vẹn.
 *
 * Mọi trường hợp đều GIỮ query có sẵn trong href (vd `tab=so-chi-phi`,
 * `danh_muc=ads`) và chỉ thêm/ghi đè đúng param của đích đó.
 */

/** Định dạng ngày trên query, khớp `serializeDateRange` ở `src/lib/date-range.ts`. */
const QUERY_DATE_FORMAT = "yyyy-MM-dd";

/**
 * Trạng thái mà P&L KHÔNG tính vào doanh thu (xem `src/lib/reports/pnl.ts`:
 * đơn hợp lệ = loại RETURNED + CANCELLED).
 */
const PNL_EXCLUDED_STATUSES: readonly OrderStatus[] = ["RETURNED", "CANCELLED"];

/**
 * Slug trạng thái của "đơn hợp lệ" — DẪN XUẤT từ `ORDER_STATUS_META` bằng cách
 * loại các trạng thái P&L không tính, KHÔNG hardcode chuỗi. Thêm trạng thái mới
 * vào `ORDER_STATUS_META` là nó tự vào đây, đúng như P&L cũng sẽ tự tính nó —
 * hai bên không thể lệch định nghĩa "hợp lệ".
 *
 * (`ORDER_STATUS_META` chỉ import KIỂU từ `@prisma/client` nên module này vẫn
 * thuần, không kéo Prisma runtime vào.)
 */
export const VALID_ORDER_STATUS_SLUGS: readonly string[] = (
  Object.keys(ORDER_STATUS_META) as OrderStatus[]
)
  .filter((status) => !PNL_EXCLUDED_STATUSES.includes(status))
  .map((status) => ORDER_STATUS_META[status].slug);

/** Slug các trạng thái P&L loại khỏi doanh thu (hoàn/hủy) — DẪN XUẤT, không hardcode. */
export const EXCLUDED_ORDER_STATUS_SLUGS: readonly string[] = PNL_EXCLUDED_STATUSES.map(
  (status) => ORDER_STATUS_META[status].slug,
);

/** Mô tả cách neo kỳ cho một nhóm đích drill. */
type DrillTarget = {
  /** Path gốc của đích (khớp đúng path hoặc path con). */
  base: string;
  /** Tên param ngày bắt đầu / kết thúc trên schema query của đích. */
  fromParam: string;
  toParam: string;
  /** Param cố định phải gắn kèm để số bên đích khớp dòng P&L vừa bấm. */
  extraParams?: Record<string, string>;
};

/**
 * Các đích drill cần neo kỳ. Đích nào không có ở đây thì href giữ nguyên.
 *
 * `/don-hang` phải kèm `trang_thai`: trang này mặc định hiện MỌI đơn, kể cả
 * hoàn hàng và hủy/bom — hai loại P&L cố tình loại khỏi doanh thu. Không lọc
 * thì dải tổng bên Đơn hàng luôn to hơn dòng P&L vừa bấm, người dùng tưởng số
 * sai trong khi cả hai đều đúng theo định nghĩa của mình.
 */
const DRILL_TARGETS: readonly DrillTarget[] = [
  { base: "/tai-chinh", fromParam: "tu", toParam: "den" },
  { base: "/bao-cao", fromParam: "tu", toParam: "den" },
  {
    base: "/don-hang",
    fromParam: "ngay_tu",
    toParam: "ngay_den",
    extraParams: { trang_thai: VALID_ORDER_STATUS_SLUGS.join(",") },
  },
];

/**
 * Tách href thành path + query + NEO (`#…`) để thêm param mà không mất query cũ VÀ không mất neo.
 * Cắt neo TRƯỚC khi cắt `?`: `URLSearchParams` không biết gì về neo, để nguyên thì `#tiet-kiem`
 * chui vào giá trị param cuối rồi bị encode thành `%23` — link mở sai tab và không cuộn tới khối
 * cần xem.
 */
function splitHref(href: string): { path: string; params: URLSearchParams; neo: string } {
  const viTriNeo = href.indexOf("#");
  const neo = viTriNeo === -1 ? "" : href.slice(viTriNeo);
  const khongNeo = viTriNeo === -1 ? href : href.slice(0, viTriNeo);
  const [path, qs] = khongNeo.split("?");
  return { path, params: new URLSearchParams(qs), neo };
}

/** Đích đến có nằm dưới `base` không (khớp đúng path, không dính `/tai-chinh-abc`). */
function isUnder(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}

export function resolvePnlDrillHref(href: string, month: Date): string {
  const { path, params, neo } = splitHref(href);

  const target = DRILL_TARGETS.find((t) => isUnder(path, t.base));
  if (!target) {
    return href;
  }

  params.set(target.fromParam, format(startOfMonth(month), QUERY_DATE_FORMAT));
  params.set(target.toParam, format(endOfMonth(month), QUERY_DATE_FORMAT));
  for (const [key, value] of Object.entries(target.extraParams ?? {})) {
    if (!params.has(key)) params.set(key, value); // dòng tự set trang_thai (hoàn/hủy) được giữ nguyên
  }
  return `${path}?${params.toString()}${neo}`;
}
