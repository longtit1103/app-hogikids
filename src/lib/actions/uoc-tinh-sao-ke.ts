"use server";

import { z } from "zod";

import type { ActionResult } from "@/lib/actions/action-result";
import { mapZodError } from "@/lib/actions/map-zod-error";
import { uocTinhDuNoTai } from "@/lib/no-phai-tra/uoc-tinh-du-no-tai";
import { congChuShopAction } from "@/lib/quyen/cong-action";

/**
 * Bọc server action cho `uocTinhDuNoTai`: form chốt sao kê (chỉ chủ shop — cùng cổng với `chotSaoKe`)
 * hỏi "ước tính của app tại ngày đó" khi chủ shop đổi ngày chốt. THUẦN ĐỌC: không ghi, không nhật ký.
 */
const schema = z.object({
  cardId: z.string().min(1, "Chọn thẻ"),
  ngay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ngày không hợp lệ"),
});

export async function docUocTinhSaoKe(input: unknown): Promise<ActionResult<{ uocTinh: number | null }>> {
  const c = await congChuShopAction();
  if (!c.ok) return c;
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  try {
    return { ok: true, data: { uocTinh: await uocTinhDuNoTai(parsed.data.cardId, parsed.data.ngay) } };
  } catch (e) {
    console.error("Không tính được ước tính dư nợ thẻ:", e);
    return { ok: false, error: "Không tính được ước tính của app — thử lại sau." };
  }
}
