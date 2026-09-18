import { startOfDay } from "date-fns";
import { z } from "zod";

import { LoiHopDong } from "@/lib/actions/khoan-vay-chung";
import { ngayGhiTaySchema } from "@/lib/actions/ngay-ghi-tay-schema";
import { LoiSoDuTietKiemAm } from "@/lib/tiet-kiem/vi-tu-so-tiet-kiem";

/**
 * Phần DÙNG CHUNG của `so-tiet-kiem.ts` (file `"use server"` chỉ export được async function nên
 * schema / mapper / hằng phải ở đây). Khuôn: `khoan-vay-chung.ts`.
 *
 * File này CỐ Ý không có `export async function` nào: lưới `tests/khoa-bao-tri-duong-ghi.test.ts`
 * quét `src/lib/actions/` theo hướng fail-closed, mọi export async đều phải khai vào bảng đường ghi.
 */

/** Tiền đề `TIETKIEM:{savingsId}` cho `ThuNhap.refId` — cổng chống ghi lãi 2 lần (spec §5.2). */
export const REF_LAI_PREFIX = "TIETKIEM:";

const LOI_LAI_SUAT = "Lãi suất 0–100%/năm";
const LOI_KY_HAN = "Kỳ hạn 1–600 tháng";

/** Trần 2 tỷ: Prisma Int (int32) chết ở 2.147.483.647 — cùng ngưỡng với `expenses.ts`/`khoan-vay.ts`. */
const soTienGuiSchema = z.coerce
  .number()
  .int("Số tiền phải là số nguyên")
  .positive("Số tiền phải lớn hơn 0")
  .max(2_000_000_000, "Số tiền quá lớn (tối đa 2 tỷ)");

/**
 * Ngày đáo hạn nằm ở TƯƠNG LAI trong đại đa số ca ⇒ KHÔNG dùng `ngayGhiTaySchema` (schema đó chặn
 * ngày tương lai vì nó dành cho dòng tiền ĐÃ phát sinh). Vẫn giữ chốt sanity năm ≥ 2000 để ô Ngày
 * bị xoá trống (null ⇒ 01/01/1970) không lọt.
 */
const ngayDaoHanSchema = z.coerce
  .date()
  .refine((d) => d.getFullYear() >= 2000, "Ngày không hợp lệ");

/**
 * Hồ sơ sổ tiết kiệm. `startDate` dùng `ngayGhiTaySchema` (CHẶN ngày tương lai) vì tiền đã rời tài
 * khoản rồi chủ shop mới ghi — và vì chính ngày đó là ngày dòng `SAVINGS_OUT`, tức mốc D0 của Sổ quỹ.
 */
export const soTietKiemSchema = z
  .object({
    name: z.string().trim().min(1, "Nhập tên sổ").max(60, "Tối đa 60 ký tự"),
    bank: z.string().trim().max(60, "Tối đa 60 ký tự").default(""),
    principal: soTienGuiSchema,
    startDate: ngayGhiTaySchema,
    termMonths: z.coerce.number().int(LOI_KY_HAN).min(1, LOI_KY_HAN).max(600, LOI_KY_HAN),
    /** LƯU, không tính lại: ngân hàng có ca đáo hạn lệch (ngày nghỉ, tháng 30/31) — spec §5.1. */
    maturityDate: ngayDaoHanSchema,
    /** Lãi %/năm × 100 (5,2%/năm = 520) — Int, không Decimal (repo tuyệt đối Int). */
    annualRateBp: z.coerce.number().int(LOI_LAI_SUAT).min(0, LOI_LAI_SUAT).max(10_000, LOI_LAI_SUAT),
    /** TUỲ CHỌN, chỉ để so lãi vay-để-gửi (spec §6.3) — KHÔNG mang một đồng nào. */
    loanId: z.string().cuid("Chọn khoản vay nguồn").nullable().optional(),
    note: z.string().trim().max(500, "Tối đa 500 ký tự").default(""),
  })
  .superRefine((d, ctx) => {
    if (startOfDay(d.maturityDate) <= startOfDay(d.startDate)) {
      ctx.addIssue({
        code: "custom",
        path: ["maturityDate"],
        message: "Ngày đáo hạn phải sau ngày gửi",
      });
    }
  })
  .transform((d) => ({
    ...d,
    // `startOfDay` giờ VN cho CẢ HAI mốc: `startDate` là ngày dòng `SAVINGS_OUT` (bất biến #3), còn
    // `maturityDate` bị so với `closedAt` để suy "rút trước hạn" — lệch giờ là badge sai.
    startDate: startOfDay(d.startDate),
    maturityDate: startOfDay(d.maturityDate),
    loanId: d.loanId ?? null,
  }));

/**
 * P2025 = "record not found" của Prisma — CHỈ mã này mới là "không tìm thấy" (cùng lý do với
 * `khoan-vay-chung.ts`). P2002 chỉ có một đường trùng duy nhất: `ThuNhap.refId @unique`. P2003 là
 * khoá ngoại `loanId` trỏ khoản vay không tồn tại — Postgres ném câu thô, dịch tại đây.
 */
export function loiSoTietKiem(e: unknown, macDinh: string): { error: string; field?: string } {
  if (e instanceof LoiHopDong) return { error: e.message, field: e.field };
  if (e instanceof LoiSoDuTietKiemAm) return { error: e.message };
  const code = (e as { code?: string })?.code;
  if (code === "P2025") return { error: "Không tìm thấy sổ tiết kiệm" };
  if (code === "P2002") return { error: "Sổ này đã ghi lãi rồi" };
  if (code === "P2003") return { error: "Không tìm thấy khoản vay nguồn — chọn lại", field: "loanId" };
  return { error: macDinh };
}
