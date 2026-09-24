import { Prisma } from "@prisma/client";
import { addMonths, endOfDay, endOfMonth, format, getDaysInMonth, setDate, startOfMonth } from "date-fns";

import { dangPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { prisma } from "@/lib/prisma";

import type { DateRange } from "@/lib/date-range";

/**
 * Backfill chi phí định kỳ cho NHIỀU tháng — gọi ở đầu trang cho ĐÚNG các
 * tháng sắp render (báo cáo tháng cũ, trend 12 tháng, range tùy chọn) để
 * tháng quá khứ không bị THIẾU chi phí định kỳ (netProfit cao ảo).
 *
 * Dedupe theo key `yyyy-MM` (giờ VN) nên truyền trùng tháng — kể cả Date khác
 * nhau trong cùng tháng — chỉ ensure 1 lần. Chạy TUẦN TỰ từng tháng (mỗi tháng
 * 1 transaction Serializable + retry P2034 sẵn có trong
 * `ensureRecurringExpenses`) để không tự đua với chính mình. Guard tháng
 * tương lai (`target > today`) giữ nguyên ở core. Trả TỔNG Expense vừa tạo.
 *
 * Lưu ý semantics (Path A — schema không có mốc bắt đầu): khoản định kỳ
 * `active` áp cho MỌI tháng được render, kể cả tháng trước khi khoản đó được
 * tạo. Khoản mới phát sinh gần đây bị sinh lùi cho tháng cũ.
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
 * Sinh Expense định kỳ cho một tháng (mặc định tháng hiện tại) — LAZY +
 * IDEMPOTENT: mỗi RecurringExpense.active sinh TỐI ĐA 1 Expense/tháng.
 *
 * Gọi ở đầu mỗi màn cần dữ liệu chi phí (`/chi-phi`, và phase 5 thêm `/bao-cao`
 * và `/`). Trả về SỐ Expense vừa tạo trong lần gọi này (0 nếu đã đủ).
 *
 * Quy tắc ngày:
 *  - dayOfMonth 29–31 gặp tháng thiếu ngày → kẹp về ngày cuối tháng.
 *  - target > "hôm nay" (chưa tới hạn trong tháng) → chưa sinh.
 * "Hôm nay" neo `new Date()` thật (giờ VN — container/dev đều UTC+7), lấy tới
 * cuối ngày để một khoản đến hạn HÔM NAY vẫn được sinh.
 *
 * Vì schema KHÔNG có unique (recurringId, tháng), check-then-create phải nằm
 * trong 1 transaction Serializable. Nếu 2 request đua nhau, Prisma ném P2034
 * (write conflict/deadlock) → retry ĐÚNG 1 lần rồi mới propagate.
 */
export async function ensureRecurringExpenses(month: Date = new Date()): Promise<number> {
  // Đây là writer DUY NHẤT bắn khi chỉ điều hướng trang (`/`, `/tai-chinh` gọi ở đầu render). Giữa
  // lượt phục hồi nó hoặc ghi dòng rồi bị bản backup lùi mất, hoặc throw và biến trang thành 500.
  // Trả 0 an toàn vì backfill này lazy + idempotent — lần render sau khi phục hồi xong sinh lại đủ.
  if (dangPhucHoi()) return 0;

  try {
    return await runEnsureRecurringExpenses(month);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      // Retry đúng 1 lần; nếu vẫn P2034 thì để nó ném ra ngoài.
      return await runEnsureRecurringExpenses(month);
    }
    throw error;
  }
}

async function runEnsureRecurringExpenses(month: Date): Promise<number> {
  const start = startOfMonth(month);
  const end = endOfMonth(month);
  const today = endOfDay(new Date());

  return prisma.$transaction(
    async (tx) => {
      const recurrings = await tx.recurringExpense.findMany({ where: { active: true } });
      let created = 0;

      for (const r of recurrings) {
        // Kẹp ngày để 29–31 không tràn sang tháng sau.
        const target = setDate(start, Math.min(r.dayOfMonth, getDaysInMonth(month)));
        if (target > today) continue; // chưa tới hạn trong tháng → chưa sinh

        const existed = await tx.expense.findFirst({
          where: { recurringId: r.id, date: { gte: start, lte: end } },
          select: { id: true },
        });
        if (existed) continue; // đã sinh trong tháng → bỏ qua (idempotent)

        await tx.expense.create({
          data: {
            date: target,
            categoryId: r.categoryId,
            description: r.description,
            // Lãi vay (`interest`) KHÔNG phân bổ kênh (bất biến #1) — `createExpense` đã chặn dựng mẫu
            // Lãi vay mang kênh, nhưng mẫu dựng TRƯỚC cổng đó (và không có action nào sửa được mẫu)
            // vẫn mang kênh cũ. Gỡ ngay tại chỗ sinh để mỗi tháng không đẻ thêm dòng làm mọc kênh rỗng.
            channelId: r.categoryId === "interest" ? null : r.channelId,
            amount: r.amount,
            source: "RECURRING",
            recurringId: r.id,
          },
        });
        created++;
      }

      return created;
    },
    { isolationLevel: "Serializable" }
  );
}
