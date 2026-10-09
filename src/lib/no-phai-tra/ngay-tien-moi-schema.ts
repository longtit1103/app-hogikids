import { format } from "date-fns";
import { z } from "zod";

import { ngayGhiTaySchema } from "@/lib/actions/ngay-ghi-tay-schema";

/**
 * Ngày của dữ liệu TIỀN MỚI sau mốc bật nợ phải trả (spec §5.8): `CARD_PAY`, `SUPPLIER_PAY`,
 * `SUPPLIER_REFUND`, `Expense.cardId`, `KySaoKeThe` (chốt sao kê) — áp cho TẠO, SỬA và KHÔI PHỤC.
 *
 * = `ngayGhiTaySchema` (không tương lai, không năm rác — giữ nguyên thứ tự refine của nó) + chặn ngày
 * TRƯỚC M: tiền trước M đã nằm trong số mở đầu (`daTraTruoc`, `daTraTruocMoSo`, `CUTOVER_*`), ghi lùi
 * là trừ hai lần và đổi quỹ của tháng đã qua.
 *
 * Luật gốc chạy LẠI qua `safeParse` (không `.pipe` — kiểu coerce của zod 4 không ghép được) và lỗi
 * của nó đứng TRƯỚC lỗi "trước M" (`mapZodError` lấy issue đầu). Bước coerce riêng có câu báo tiếng Việt để `Date` hỏng (Invalid Date) không lộ message tiếng Anh của
 * zod như schema gốc; `null`/`0` (ô ngày bị xoá trống) vẫn do refine "hợp lệ" của schema gốc bắt.
 */
export function ngayTienMoiSchema(mocM: Date): z.ZodType<Date> {
  const nhanM = format(mocM, "dd/MM/yyyy");
  return z.coerce
    .date({ error: "Ngày không hợp lệ" })
    .superRefine((d, ctx) => {
      // Chạy NGUYÊN schema gốc trên chính Date đã coerce — một định nghĩa luật ngày ghi tay, không chép.
      const goc = ngayGhiTaySchema.safeParse(d);
      if (!goc.success) for (const issue of goc.error.issues) ctx.addIssue({ code: "custom", message: issue.message });
    })
    .refine((d) => d >= mocM, `Trước ngày bật theo dõi nợ (${nhanM})`);
}
