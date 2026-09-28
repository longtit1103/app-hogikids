"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "@/lib/actions/action-result";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

// ---- Cài đặt › Ngưỡng cảnh báo tồn mặc định ---------------------------------

const lowStockThresholdSchema = z.number().int().min(0).max(999);

/**
 * Ngưỡng cảnh báo tồn mặc định — áp cho SKU chưa có `lowStockThreshold` riêng.
 * `revalidatePath("/ton-kho")` để badge "Sắp hết" tính lại ngay; `"/", "layout"`
 * vì Dashboard cũng đọc ngưỡng này cho cảnh báo tồn thấp.
 */
export async function updateDefaultLowStockThreshold(value: number): Promise<ActionResult> {
  await requireUser();
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = lowStockThresholdSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: "Ngưỡng phải là số nguyên từ 0 đến 999" };
  }

  try {
    await prisma.setting.upsert({
      where: { key: "defaultLowStockThreshold" },
      update: { value: String(parsed.data) },
      create: { key: "defaultLowStockThreshold", value: String(parsed.data) },
    });
  } catch {
    return { ok: false, error: "Lỗi khi lưu ngưỡng tồn" };
  }

  revalidatePath("/", "layout");
  revalidatePath("/ton-kho");
  return { ok: true, data: undefined };
}
