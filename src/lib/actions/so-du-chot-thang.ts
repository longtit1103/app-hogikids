"use server";

import { z } from "zod";

import type { ActionResult } from "@/lib/actions/action-result";
import { lamMoiTrang } from "@/lib/actions/lam-moi-trang";
import { mapZodError } from "@/lib/actions/map-zod-error";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { thangChot } from "@/lib/so-quy/doi-chieu-so-du-chot";
import { ngayMoSo } from "@/lib/so-quy/so-quy-queries";

/**
 * Hai server action cho bản CHỐT SỐ DƯ THẬT cuối tháng (tab Dòng tiền) — hàng rào bắt sai cộng dồn
 * sổ quỹ. Đây là THƯỚC ĐO, không phải nguồn tiền: không ghi `CashMovement`, không đổi quỹ, không vào
 * Lãi/Lỗ. Vì thế KHÔNG cần transaction / khoá cha / khoá việc nặng — một dòng, không có số dẫn xuất.
 *
 * Một tháng một dòng: `luu` là upsert theo `thang`, lưu lại cùng tháng = sửa đè. Xoá là xoá thẳng,
 * CỐ Ý không qua thùng rác — ba con số gõ lại mất 10 giây, dựng cả cơ chế khôi phục là thừa.
 *
 * Lỗi LUẬT (chưa mở sổ / tháng tương lai / trước ngày mở sổ) trả về KHÔNG kèm `field`: ô tháng trên
 * form là hidden, không có chỗ để tô — kèm field là câu báo rơi vào khoá không ai render và chủ shop
 * bấm Lưu mà im lặng tuyệt đối (bài học S7, 23/09). Chỉ lỗi zod của ô nhập thật mới mang `field`.
 */

/** Trần 2 tỷ: Prisma Int (int32) chết ở 2.147.483.647 — cùng ngưỡng với `Expense.amount`. */
const TRAN = 2_000_000_000;
const LOI_QUA_LON = "Số tiền quá lớn (tối đa 2 tỷ)";

const soDuBankSchema = z.coerce
  .number()
  .int("Số tiền phải là số nguyên")
  // Thấu chi làm bank ÂM là hợp lệ — chỉ kẹp độ lớn.
  .min(-TRAN, LOI_QUA_LON)
  .max(TRAN, LOI_QUA_LON);

const tienMatSchema = z.coerce
  .number()
  .int("Số tiền phải là số nguyên")
  .min(0, "Tiền mặt không thể âm")
  .max(TRAN, LOI_QUA_LON);

/** Ô tháng bị trống ⇒ `z.coerce.date()` ra 01/01/1970 — chốt sanity năm ≥ 2000 như `ngayGhiTaySchema`. */
const thangSchema = z.coerce.date().refine((d) => d.getFullYear() >= 2000, "Tháng không hợp lệ");

const chotSchema = z.object({
  thang: thangSchema,
  soDuBank: soDuBankSchema,
  tienMat: tienMatSchema,
  note: z.string().trim().max(200, "Tối đa 200 ký tự").default(""),
});

const xoaSchema = z.object({ thang: thangSchema });

/**
 * Tháng nào được phép chốt: đã mở sổ · không ở tương lai · không trước tháng mở sổ. Trả câu báo hoặc
 * null. Dùng chung cho lưu lẫn xoá (xoá bản chốt của tháng không hợp lệ cũng vô nghĩa như lưu).
 */
async function loiThangKhongHopLe(thang: Date): Promise<string | null> {
  const d0 = await ngayMoSo();
  if (d0 === null) return "Chưa mở sổ quỹ — ghi khoản tiền đầu tiên trước";
  if (thang > thangChot(new Date())) return "Không chốt số dư cho tháng tương lai";
  if (thang < thangChot(d0)) return "Tháng này nằm trước ngày mở sổ — không có gì để đối chiếu";
  return null;
}

export async function luuSoDuChotThang(input: unknown): Promise<ActionResult<{ thang: Date }>> {
  await requireUser();
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = chotSchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  const thang = thangChot(parsed.data.thang);

  const loi = await loiThangKhongHopLe(thang);
  if (loi !== null) return { ok: false, error: loi };

  const { soDuBank, tienMat, note } = parsed.data;
  await prisma.soDuChotThang.upsert({
    where: { thang },
    create: { thang, soDuBank, tienMat, note },
    update: { soDuBank, tienMat, note },
  });
  lamMoiTrang();
  return { ok: true, data: { thang } };
}

export async function xoaSoDuChotThang(input: unknown): Promise<ActionResult<null>> {
  await requireUser();
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = xoaSchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  const thang = thangChot(parsed.data.thang);

  const { count } = await prisma.soDuChotThang.deleteMany({ where: { thang } });
  if (count === 0) return { ok: false, error: "Không tìm thấy bản chốt của tháng này" };
  lamMoiTrang();
  return { ok: true, data: null };
}
