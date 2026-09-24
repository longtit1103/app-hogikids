"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "@/lib/actions/action-result";
import { mapZodError } from "@/lib/actions/map-zod-error";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { TRAN_QUY_TOI_THIEU } from "@/lib/so-quy/du-bao-quy";
import { KEY_QUY_TOI_THIEU } from "@/lib/so-quy/du-bao-quy-queries";

/**
 * Quỹ tối thiểu chủ shop tự đặt — ngưỡng của cảnh báo "quỹ sắp cạn" (tab Sổ quỹ + banner toàn app).
 * Lưu một ô `Setting` riêng; key đó KHÔNG nằm trong allowlist view kho khoá của n8n (fail-closed),
 * nên n8n không đọc được và nó cũng không lẫn vào luồng secret nào.
 *
 * Số nguyên THẬT (không `coerce`): ô tiền phía client đã quy về số qua `parseAmountInput`; nhận chuỗi
 * rỗng ở đây mà ép thành 0 là lặng lẽ tắt cảnh báo khi chủ shop chỉ lỡ xoá ô.
 */
const schema = z.object({
  soTien: z
    .number({ error: "Nhập số tiền quỹ tối thiểu" })
    .int("Số tiền phải là số nguyên")
    .min(0, "Số tiền không được âm")
    .max(TRAN_QUY_TOI_THIEU, "Số tiền quá lớn (tối đa 2 tỷ)"),
});

export async function datQuyToiThieu(input: unknown): Promise<ActionResult> {
  await requireUser();
  // Ô `Setting` nằm trong đúng bảng lượt phục hồi nạp lại — ghi giữa lượt là bị bản backup lùi mất.
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  const value = String(parsed.data.soTien);

  try {
    await prisma.setting.upsert({
      where: { key: KEY_QUY_TOI_THIEU },
      create: { key: KEY_QUY_TOI_THIEU, value },
      update: { value },
    });
  } catch (e) {
    console.error("[so-quy] datQuyToiThieu lỗi ghi Setting", e);
    return { ok: false, error: "Lỗi khi lưu quỹ tối thiểu" };
  }

  // Tab Sổ quỹ đọc ngưỡng trực tiếp; banner "sắp cạn" nằm ở layout nên làm mới cả cây.
  revalidatePath("/tai-chinh");
  revalidatePath("/", "layout");
  return { ok: true, data: undefined };
}
