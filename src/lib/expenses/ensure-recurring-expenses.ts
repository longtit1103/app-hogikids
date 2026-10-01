import { randomUUID } from "node:crypto";

import { Prisma } from "@/generated/prisma/client";
import { addMonths, endOfDay, format, getDaysInMonth, setDate, startOfMonth } from "date-fns";

import { dangPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { khoaThangDinhKy } from "@/lib/expenses/khoa-thang-dinh-ky";
import { prisma } from "@/lib/prisma";

import type { DateRange } from "@/lib/date-range";

/**
 * Backfill chi phí định kỳ cho NHIỀU tháng — gọi ở đầu trang cho ĐÚNG các
 * tháng sắp render (báo cáo tháng cũ, trend 12 tháng, range tùy chọn) để
 * tháng quá khứ không bị THIẾU chi phí định kỳ (netProfit cao ảo).
 *
 * Dedupe theo key `yyyy-MM` (giờ VN) nên truyền trùng tháng — kể cả Date khác
 * nhau trong cùng tháng — chỉ ensure 1 lần. Chạy TUẦN TỰ từng tháng (mỗi tháng
 * tối đa 1 câu chèn `ON CONFLICT DO NOTHING` trong `ensureRecurringExpenses`).
 * Guard tháng tương lai (`target > today`) giữ nguyên ở core. Trả TỔNG Expense
 * vừa tạo.
 *
 * Lưu ý semantics: khoản định kỳ `active` áp cho MỌI tháng được render từ tháng
 * của mốc `activeFrom` trở đi (`mauDinhKySinhChoThang`). Mẫu tạo mới và mẫu bật
 * lại đều mang mốc ⇒ không sinh lùi. Mẫu dựng TRƯỚC khi có cột giữ `activeFrom
 * NULL` = không cận dưới (hành vi cũ): nó vẫn sinh cho cả tháng trước khi được tạo.
 *
 * ĐƯỜNG SỬA ĐÚNG là "Xoá và dừng lặp lại" (`deleteExpense(id, "stop_recurring")`) rồi
 * nhập tay tháng cần. **KHÔNG phải "Xoá dòng này"** (`deleteExpense(id, "only")`) như chú
 * thích cũ ở đây từng dạy: mẫu vẫn `active` nên cổng chống trùng dưới đây thấy tháng đó
 * trống và sinh lại đúng dòng vừa xoá ở lần render kế — chủ shop xoá rồi thấy nó quay lại.
 * Cùng lý do, `updateExpense` CHẶN dời dòng định kỳ sang tháng khác (chi phí đếm 2 lần).
 */
export async function ensureRecurringExpensesForMonths(months: Date[]): Promise<number> {
  const seen = new Set<string>();
  let created = 0;

  for (const month of months) {
    const key = format(month, "yyyy-MM");
    if (seen.has(key)) continue;
    seen.add(key);
    created += await ensureRecurringExpenses(month);
  }

  return created;
}

/**
 * Liệt kê đầu-tháng (giờ VN) của mọi tháng dương lịch giao với `range` — input
 * cho `ensureRecurringExpensesForMonths` ở các trang render theo range tùy
 * chọn (`/chi-phi`, dashboard). Range từ picker đã bị `clampDateRange` chặn
 * ≤ 366 ngày nên kết quả bounded ≤ 13 tháng.
 */
export function monthStartsInRange(range: DateRange): Date[] {
  const months: Date[] = [];
  for (let m = startOfMonth(range.from); m <= range.to; m = addMonths(m, 1)) {
    months.push(m);
  }
  return months;
}

/**
 * Ngày đến hạn của MỘT mẫu chi định kỳ trong MỘT tháng cụ thể — kẹp `dayOfMonth` 29–31 về ngày cuối
 * tháng khi tháng đó thiếu ngày (vd 31 → 30/11, 28/02). Hàm THUẦN, export để dùng CHUNG bởi nơi sinh
 * (`ensureRecurringExpenses` dưới đây) và nơi cảnh báo chỉ-đọc (`so-quy-queries.ts` — đếm khoản
 * định kỳ đến hạn mà chưa sinh) — tách hai công thức ngày đến hạn là sớm muộn lệch nhau.
 */
export function ngayDenHanDinhKy(dayOfMonth: number, month: Date): Date {
  return setDate(startOfMonth(month), Math.min(dayOfMonth, getDaysInMonth(month)));
}

/**
 * Mẫu chi định kỳ có được sinh cho tháng `month` không — cổng mốc `activeFrom`: `NULL` ⇒ mọi tháng
 * (mẫu dựng trước khi có cột, hành vi cũ); có mốc ⇒ chỉ tháng >= tháng của mốc. So theo THÁNG (giờ VN,
 * container TZ=Asia/Ho_Chi_Minh), không theo ngày: mốc giữa tháng vẫn sinh lần đến hạn đầu tháng đó.
 * Hàm THUẦN dùng CHUNG bởi nơi sinh (dưới đây) và nơi đếm "đến hạn chưa sinh" (`so-quy-queries.ts`) —
 * một nơi quên cổng là cảnh báo đòi mở một tháng mà mở ra bộ sinh cũng không sinh, không bao giờ tắt.
 * (Dự báo quỹ `du-bao-quy.ts` so cùng luật trên khoá ngày chuỗi vì lõi đó không dùng `Date`.)
 */
export function mauDinhKySinhChoThang(activeFrom: Date | null, month: Date): boolean {
  return activeFrom === null || startOfMonth(month) >= startOfMonth(activeFrom);
}

/**
 * Sinh Expense định kỳ cho một tháng (mặc định tháng hiện tại) — LAZY +
 * IDEMPOTENT: mỗi RecurringExpense.active sinh TỐI ĐA 1 Expense/tháng.
 *
 * Gọi ở đầu mỗi màn cần dữ liệu chi phí (`/chi-phi`, `/bao-cao`, `/`, cả lượt
 * tải sẵn tab). Trả về SỐ Expense THẬT SỰ vừa chèn trong lần gọi này (0 nếu đã đủ
 * hoặc lượt song song đã chèn trước).
 *
 * Quy tắc ngày:
 *  - dayOfMonth 29–31 gặp tháng thiếu ngày → kẹp về ngày cuối tháng.
 *  - target > "hôm nay" (chưa tới hạn trong tháng) → chưa sinh.
 * "Hôm nay" neo `new Date()` thật (giờ VN — container/dev đều UTC+7), lấy tới
 * cuối ngày để một khoản đến hạn HÔM NAY vẫn được sinh.
 *
 * Chống trùng do POSTGRES bảo đảm: UNIQUE `(recurringId, recurringMonth)` + MỘT câu
 * `INSERT … ON CONFLICT DO NOTHING` (`chenDongDinhKy`). Hai request đua nhau thì một bên chèn, bên kia
 * bỏ qua êm (không lỗi, không retry). Câu chèn tự xét lại `active`/mốc trên dòng mẫu đã khoá
 * `FOR SHARE` ⇒ "Xoá và dừng lặp lại" chạy xen giữa không làm dòng vừa xoá sống lại. Một câu = nguyên
 * tử: request bị huỷ giữa chừng (rời trang khi đang stream) hoặc chèn trọn hoặc không chèn gì — không
 * có transaction tương tác nào để bị cắt ngang thành "Transaction not found" ⇒ trang 500.
 */
export async function ensureRecurringExpenses(month: Date = new Date()): Promise<number> {
  // Đây là writer DUY NHẤT bắn khi chỉ điều hướng trang (`/`, `/tai-chinh` gọi ở đầu render). Giữa
  // lượt phục hồi nó hoặc ghi dòng rồi bị bản backup lùi mất, hoặc throw và biến trang thành 500.
  // Trả 0 an toàn vì backfill này lazy + idempotent — lần render sau khi phục hồi xong sinh lại đủ.
  if (dangPhucHoi()) return 0;

  const khoaThang = khoaThangDinhKy(month);
  const today = endOfDay(new Date());
  const recurrings = await prisma.recurringExpense.findMany({ where: { active: true } });
  const denHan = recurrings.flatMap((r) => {
    // Tháng trước mốc (mẫu mới tạo / vừa bật lại) → không sinh: không ghi lùi vào tháng đã dừng.
    if (!mauDinhKySinhChoThang(r.activeFrom, month)) return [];
    const target = ngayDenHanDinhKy(r.dayOfMonth, month);
    if (target > today) return []; // chưa tới hạn trong tháng → chưa sinh
    return [{ r, target }];
  });
  if (denHan.length === 0) return 0;

  // Lượt kiểm CHỈ ĐỌC trước: gần như mọi lần render, mọi dòng của tháng đã có sẵn ⇒ không phát câu
  // ghi nào. Chỉ là lối tắt — thiếu kiểm này thì câu chèn dưới đây vẫn đúng nhờ ON CONFLICT.
  const daCo = await prisma.expense.findMany({
    where: { recurringId: { in: denHan.map((d) => d.r.id) }, recurringMonth: khoaThang },
    select: { recurringId: true },
  });
  const daCoIds = new Set(daCo.map((e) => e.recurringId));
  const thieu = denHan.filter((d) => !daCoIds.has(d.r.id));
  if (thieu.length === 0) return 0;

  return chenDongDinhKy(thieu, startOfMonth(addMonths(month, 1)));
}

/**
 * Câu chèn DUY NHẤT của bộ sinh: `INSERT … SELECT … FOR SHARE OF r … ON CONFLICT DO NOTHING`.
 *
 * Danh sách `thieu` đọc từ các câu TRƯỚC (autocommit, mỗi câu một snapshot) nên có thể đã cũ khi tới
 * đây: "Xoá và dừng lặp lại" (`deleteExpense(id, "stop_recurring")`) commit xen giữa là dòng vừa xoá
 * sống lại với id mới nếu câu chèn tin danh sách cũ. Vì vậy câu chèn KHÔNG tin gì từ app ngoài id mẫu,
 * ngày đến hạn và khoá tháng — mọi điều kiện sinh được xét LẠI trên dòng mẫu ngay trong câu:
 *  - `JOIN … AND r.active` (+ cổng mốc `activeFrom`, cùng luật `mauDinhKySinhChoThang`): mẫu đã dừng,
 *    hoặc vừa bật lại với mốc sau tháng này, thì không chèn.
 *  - `FOR SHARE OF r`: lượt đang giữ khoá mẫu (`deleteExpense`/`updateExpense`/`batLaiDinhKy` khoá
 *    `FOR UPDATE`, `stopRecurring` UPDATE thẳng) chưa commit thì câu này CHỜ; ở READ COMMITTED, khoá nhả
 *    xong Postgres đánh giá lại hàng mẫu bản MỚI (EvalPlanQual) nên thấy `active=false` và bỏ hàng. Thiếu
 *    khoá thì câu chèn vẫn chạy trên snapshot cũ, chờ ở UNIQUE sau dòng đang bị xoá rồi chèn lại nó.
 *  - `amount`/`description`/`categoryId`/`channelId` lấy từ `r` chứ không từ bản đọc trước.
 *  - `ORDER BY r.id`: hai lượt sinh song song khoá mẫu + chèn theo CÙNG thứ tự ⇒ không khoá chéo nhau.
 *  - `ON CONFLICT DO NOTHING`: lượt song song đã chèn trước thì bỏ qua êm (UNIQUE
 *    `(recurringId, recurringMonth)`).
 * Một câu = nguyên tử: request bị huỷ giữa chừng thì chèn trọn hoặc không chèn gì.
 *
 * Ngày gửi dạng chuỗi ISO rồi đổi `::timestamptz AT TIME ZONE 'UTC'` ⇒ đúng giờ UTC mà Prisma vẫn ghi vào
 * cột `timestamp` không múi giờ, bất kể `TimeZone` của phiên. Id sinh ở app (`randomUUID`) vì
 * `@default(cuid())` là mặc định PHÍA Prisma, cột dưới DB không có mặc định; không nơi nào đọc định dạng
 * id của `Expense`. `createdAt` lấy mặc định DB. Trả số dòng chèn THẬT.
 */
async function chenDongDinhKy(
  thieu: { r: { id: string }; target: Date }[],
  dauThangSau: Date
): Promise<number> {
  const hang = thieu.map(({ r, target }) =>
    Prisma.sql`(${randomUUID()}::text, ${r.id}::text, (${target.toISOString()}::timestamptz AT TIME ZONE 'UTC'), ${khoaThangDinhKy(target)}::text)`
  );
  // Lãi vay (`interest`) KHÔNG phân bổ kênh (bất biến #1) — `createExpense` đã chặn dựng mẫu Lãi vay
  // mang kênh, nhưng mẫu dựng TRƯỚC cổng đó (không action nào sửa được mẫu) vẫn mang kênh cũ ⇒ `CASE`
  // gỡ kênh ngay tại chỗ sinh để mỗi tháng không đẻ thêm dòng làm mọc kênh rỗng.
  return prisma.$executeRaw`
    INSERT INTO "Expense" ("id", "date", "categoryId", "description", "channelId", "amount", "source", "recurringId", "recurringMonth")
    SELECT v.id, v.ngay, r."categoryId", r."description",
      CASE WHEN r."categoryId" = 'interest' THEN NULL ELSE r."channelId" END,
      r."amount", 'RECURRING'::"ExpenseSource", r.id, v.thang
    FROM (VALUES ${Prisma.join(hang)}) AS v(id, rid, ngay, thang)
    JOIN "RecurringExpense" r
      ON r.id = v.rid
      AND r.active
      AND (r."activeFrom" IS NULL OR r."activeFrom" < (${dauThangSau.toISOString()}::timestamptz AT TIME ZONE 'UTC'))
    ORDER BY r.id
    FOR SHARE OF r
    ON CONFLICT DO NOTHING
  `;
}
