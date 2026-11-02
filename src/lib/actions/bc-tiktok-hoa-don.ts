"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "@/lib/actions/action-result";
import { mapZodError } from "@/lib/actions/map-zod-error";
import { vaoCuaGhi } from "@/lib/backup/cong-ghi-toan-cuc";
import { BC_ID_TIKTOK_HOP_LE } from "@/lib/bronze/khuon-bc-id-tiktok";
import { formatVnd } from "@/lib/format";
import { ghiNhatKy, ghiNhatKyLoi } from "@/lib/nhat-ky/ghi-nhat-ky";
import { HANH_DONG } from "@/lib/nhat-ky/hanh-dong";
import { bcTiktokDaBiet, docHoaDonTinhNoTheCuaBc } from "@/lib/no-phai-tra/bc-tiktok-hoa-don";
import { docMocM } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { prisma } from "@/lib/prisma";
import { congChuShopAction } from "@/lib/quyen/cong-action";

/**
 * Chủ shop xác nhận một Business Center TikTok "KHÔNG dùng thẻ" (không trả quảng cáo bằng thẻ tín dụng) / bỏ xác nhận.
 * Cổng chốt sao kê thẻ (`lyDoHoaDonTiktokChuaDu`) bỏ BC đã xác nhận khỏi tập xét — gỡ được hai ca CHẶN "BC thiếu quyền
 * finance chưa xác nhận" và "BC từng đọc được nay mất quyền / biến mất" khi BC đó thật sự không liên quan tới thẻ.
 *
 * Chỉ chủ shop: xác nhận sai là cổng ngừng kiểm hoá đơn trừ thẻ của BC. Ghi ba cột `khongDung*` của `TiktokBcHoaDon`
 * — KHÔNG đụng tiền, P&L, quỹ, dư nợ. TỪ CHỐI (`BC_CO_HOA_DON_TRU_THE`) khi BC có hoá đơn tính vào dư nợ thẻ trong
 * 30 ngày gần nhất (cùng tập `dieuKienHoaDonTiktokTinhNoThe`, từ mốc M): hoá đơn đó đang vào nghĩa vụ thẻ — kể cả khi
 * ví TikTok Shop trả — nên BC không thể "không dùng thẻ". Idempotent: đánh dấu BC đã đánh dấu (hay bỏ BC chưa đánh dấu) trả ok, KHÔNG ghi
 * gì, KHÔNG thêm dòng nhật ký (`daDoi: false`); mốc + người xác nhận đầu tiên được giữ.
 */

const bcIdSchema = z.string().trim().regex(BC_ID_TIKTOK_HOP_LE, "Mã Business Center không hợp lệ");
const danhDauSchema = z.object({
  bcId: bcIdSchema,
  ghiChu: z.string().trim().max(500, "Ghi chú tối đa 500 ký tự").default(""),
});

/** Ngần này ngày gần nhất có hoá đơn tính vào dư nợ thẻ ⇒ không cho đánh dấu "không dùng thẻ". */
const SO_NGAY_SOI_HOA_DON_TRU_THE = 30;
const MOT_NGAY_MS = 86_400_000;

class LoiBc extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

function lamMoi(): void {
  revalidatePath("/tai-chinh/no-phai-tra");
}

export async function danhDauBcTiktokKhongDung(input: unknown): Promise<ActionResult<{ daDoi: boolean }>> {
  const c = await congChuShopAction();
  if (!c.ok) return c;
  const { nguoiDung } = c;
  const cua = vaoCuaGhi();
  if (!cua.ok) return cua.loi;
  try {
    const parsed = danhDauSchema.safeParse(input);
    if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
    const { bcId, ghiChu } = parsed.data;
    try {
      const daDoi = await prisma.$transaction(async (tx) => {
        // BC app đã biết (bảng bền / kho thô / nhật ký đồng bộ stream hoá đơn) — chặn đánh dấu mã gõ nhầm.
        if (!(await bcTiktokDaBiet(tx, bcId))) throw new LoiBc(`App chưa biết Business Center ${bcId}`);
        // Dòng có thể chưa tồn tại (BC chỉ có hoá đơn trong kho thô) ⇒ chèn rỗng trước, rồi khoá dòng — lượt đánh dấu
        // song song và route dấu lượt (`INSERT … ON CONFLICT`) xếp hàng trên cùng dòng.
        await tx.$executeRaw`
          INSERT INTO "TiktokBcHoaDon" ("bcId", "createdAt", "updatedAt")
          VALUES (${bcId}::text, (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC'))
          ON CONFLICT ("bcId") DO NOTHING
        `;
        const [dong] = await tx.$queryRaw<{ khongDungTu: Date | null }[]>`
          SELECT "khongDungTu" FROM "TiktokBcHoaDon" WHERE "bcId" = ${bcId}::text FOR UPDATE
        `;
        if (dong?.khongDungTu != null) return false;
        const mocM = await docMocM(tx);
        if (mocM !== null) {
          const bayGio = Date.now();
          const tuSoi = new Date(Math.max(bayGio - SO_NGAY_SOI_HOA_DON_TRU_THE * MOT_NGAY_MS, mocM.getTime()));
          const hoaDon = await docHoaDonTinhNoTheCuaBc(tx, [bcId], tuSoi, new Date(bayGio + MOT_NGAY_MS));
          if (hoaDon.length > 0) {
            const tong = hoaDon.reduce((t, h) => t + h.amount, 0);
            throw new LoiBc(
              `BC ${bcId} có ${hoaDon.length} hoá đơn TikTok trừ tiền (tổng ${formatVnd(tong)}) trong ` +
                `${SO_NGAY_SOI_HOA_DON_TRU_THE} ngày gần nhất — các hoá đơn này đang tính vào dư nợ thẻ nên không đánh dấu ` +
                `"không dùng thẻ" được; cấp vai trò finance cho token TikTok Business để cổng kiểm được BC, hoặc chốt sao ` +
                `kê bằng form tay`,
              "BC_CO_HOA_DON_TRU_THE",
            );
          }
        }
        await tx.tiktokBcHoaDon.update({
          where: { bcId },
          data: { khongDungTu: new Date(), khongDungGhiChu: ghiChu === "" ? null : ghiChu, khongDungBoi: nguoiDung.email },
        });
        await ghiNhatKy(tx, {
          actor: nguoiDung,
          hanhDong: HANH_DONG.BC_TIKTOK_DANH_DAU_KHONG_DUNG,
          doiTuong: { loai: "TiktokBcHoaDon", id: bcId, moTa: `BC ${bcId} không dùng thẻ${ghiChu ? ` — ${ghiChu}` : ""}` },
        });
        return true;
      });
      if (daDoi) lamMoi();
      return { ok: true, data: { daDoi } };
    } catch (e) {
      if (e instanceof LoiBc) return { ok: false, error: e.message, field: "bcId", ...(e.code ? { code: e.code } : {}) };
      console.error("Lỗi đánh dấu BC TikTok không dùng thẻ:", e);
      await ghiNhatKyLoi({
        actor: nguoiDung,
        hanhDong: HANH_DONG.BC_TIKTOK_DANH_DAU_KHONG_DUNG,
        doiTuong: { loai: "TiktokBcHoaDon", id: bcId },
      });
      return { ok: false, error: "Lỗi khi lưu xác nhận Business Center — thử lại" };
    }
  } finally {
    cua.ra();
  }
}

export async function boDanhDauBcTiktokKhongDung(bcIdTho: unknown): Promise<ActionResult<{ daDoi: boolean }>> {
  const c = await congChuShopAction();
  if (!c.ok) return c;
  const { nguoiDung } = c;
  const cua = vaoCuaGhi();
  if (!cua.ok) return cua.loi;
  try {
    const parsed = bcIdSchema.safeParse(bcIdTho);
    if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
    const bcId = parsed.data;
    try {
      const daDoi = await prisma.$transaction(async (tx) => {
        const [dong] = await tx.$queryRaw<{ khongDungTu: Date | null }[]>`
          SELECT "khongDungTu" FROM "TiktokBcHoaDon" WHERE "bcId" = ${bcId}::text FOR UPDATE
        `;
        if (dong?.khongDungTu == null) return false;
        await tx.tiktokBcHoaDon.update({
          where: { bcId },
          data: { khongDungTu: null, khongDungGhiChu: null, khongDungBoi: null },
        });
        await ghiNhatKy(tx, {
          actor: nguoiDung,
          hanhDong: HANH_DONG.BC_TIKTOK_BO_DANH_DAU_KHONG_DUNG,
          doiTuong: { loai: "TiktokBcHoaDon", id: bcId, moTa: `BC ${bcId} — cổng sao kê xét lại` },
        });
        return true;
      });
      if (daDoi) lamMoi();
      return { ok: true, data: { daDoi } };
    } catch (e) {
      console.error("Lỗi bỏ đánh dấu BC TikTok không dùng thẻ:", e);
      await ghiNhatKyLoi({
        actor: nguoiDung,
        hanhDong: HANH_DONG.BC_TIKTOK_BO_DANH_DAU_KHONG_DUNG,
        doiTuong: { loai: "TiktokBcHoaDon", id: bcId },
      });
      return { ok: false, error: "Lỗi khi bỏ xác nhận Business Center — thử lại" };
    }
  } finally {
    cua.ra();
  }
}
