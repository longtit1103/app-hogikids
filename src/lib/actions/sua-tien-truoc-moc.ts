"use server";

import { format } from "date-fns";
import { z } from "zod";

import type { ActionResult } from "@/lib/actions/action-result";
import { maLoiNhatKy } from "@/lib/actions/khoan-vay-chung";
import { lamMoiTrang } from "@/lib/actions/lam-moi-trang";
import { mapZodError } from "@/lib/actions/map-zod-error";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { ghiNhatKy, ghiNhatKyLoi } from "@/lib/nhat-ky/ghi-nhat-ky";
import { daBatNoPhaiTra, khoaChiaSeBatNoPhaiTra, LoiChuaBat } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import {
  cauKhongSuaTien,
  keHoachBuSuaTien,
  type KetQuaSuaTienTruocMoc,
  LoiSuaTienTruocMoc,
  lyDoKhongSuaTienTruocMoc,
  moTaDongBu,
  moTaNhatKySuaTien,
  TRAN_SO_TIEN_CHI_PHI,
} from "@/lib/no-phai-tra/sua-tien-truoc-moc";
import { prisma } from "@/lib/prisma";
import { congChuShopAction } from "@/lib/quyen/cong-action";
import { laLoiDongTienBan, OPT_TX_DONG_TIEN, THONG_BAO_KHOA_DONG_TIEN_BAN } from "@/lib/so-quy/khoa-dong-tien-co-han";
import { ngayMoSo } from "@/lib/so-quy/so-quy-queries";

/**
 * "Sửa số tiền trước mốc" — lối DUY NHẤT đổi số tiền một dòng chi phí ngày < M sau khi đã bật nợ phải trả, CHỈ chủ
 * shop. Cổng khoá sổ `chanSoChiPhiDaKhoa` CỐ Ý không gọi ở đây: lối này là ngoại lệ có chủ đích của cổng vì TỰ BÙ —
 * cùng transaction ghi thêm một dòng điều chỉnh mở sổ ±Δ ngày M nên quỹ từ M không đổi một đồng, chỉ Lãi/Lỗ tháng của
 * dòng đó đổi Δ. Luật + toán: `no-phai-tra/sua-tien-truoc-moc.ts`. Không đổi ngày / thẻ / danh mục.
 *
 * Thứ tự trong transaction (đều sau khoá chung với bước bật — câu đầu, vô điều kiện):
 *  1. đọc M (chưa bật ⇒ `CHUA_BAT_NO_PHAI_TRA`); bước bật đang chạy ⇒ chờ nó commit rồi đọc M mới;
 *  2. đọc LẠI dòng chi ⇒ tư cách (lõi thuần) ⇒ số cũ khớp số màn hình đã thấy ⇒ Δ ≠ 0;
 *  3. đọc D0 TRONG transaction (dòng < D0 nằm ngoài quỹ ⇒ không bù);
 *  4. `updateMany` có rào (id + số tiền / ngày / danh mục / nguồn / refId / thẻ cũ): hai lượt sửa đồng thời cùng dòng
 *     ⇒ lượt sau chờ khoá dòng rồi thấy số tiền đã đổi ⇒ 0 dòng ⇒ lùi, đúng MỘT dòng bù được ghi;
 *  5. thêm dòng bù (nếu có) + nhật ký (số tiền nằm ở `doiTuong.moTa`, `ghiChu` chỉ khoá allowlist).
 */

const schema = z.object({
  amountMoi: z.coerce
    .number()
    .int("Số tiền phải là số nguyên")
    .positive("Số tiền phải lớn hơn 0")
    .max(TRAN_SO_TIEN_CHI_PHI, "Số tiền quá lớn (tối đa 2 tỷ)"),
  /** Số tiền màn hình đang hiện — lệch với DB ⇒ tab cũ, bắt tải lại thay vì đè lên số người khác vừa sửa. */
  amountCuDaThay: z.coerce.number().int().nonnegative(),
  lyDo: z.string().trim().min(1, "Ghi lý do sửa").max(120, "Lý do tối đa 120 ký tự"),
});

const LY_DO_NHAT_KY = "SUA_TIEN_TRUOC_MOC";
const CAU_VUA_DOI = "Khoản chi vừa được sửa ở nơi khác — tải lại trang rồi sửa lại.";

export async function suaSoTienTruocMoc(
  id: string,
  input: unknown
): Promise<ActionResult<KetQuaSuaTienTruocMoc>> {
  const c = await congChuShopAction();
  if (!c.ok) return c;
  const { nguoiDung } = c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };
  if (typeof id !== "string" || id.trim() === "") return { ok: false, error: "Thiếu khoản chi cần sửa" };

  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  const { amountMoi, amountCuDaThay, lyDo } = parsed.data;

  let ketQua: KetQuaSuaTienTruocMoc;
  try {
    ketQua = await prisma.$transaction(async (tx) => {
      await khoaChiaSeBatNoPhaiTra(tx);
      const mocM = await daBatNoPhaiTra(tx);

      const dong = await tx.expense.findUnique({
        where: { id },
        select: {
          date: true,
          categoryId: true,
          refId: true,
          source: true,
          cardId: true,
          amount: true,
          description: true,
        },
      });
      if (dong === null) throw new LoiSuaTienTruocMoc("KHONG_TIM_THAY", CAU_VUA_DOI);
      const lyDoChan = lyDoKhongSuaTienTruocMoc(dong, mocM);
      if (lyDoChan !== null) throw new LoiSuaTienTruocMoc(lyDoChan, cauKhongSuaTien(lyDoChan, mocM));
      if (dong.amount !== amountCuDaThay) throw new LoiSuaTienTruocMoc("SO_TIEN_DA_DOI", CAU_VUA_DOI);
      if (amountMoi === dong.amount) {
        throw new LoiSuaTienTruocMoc("SO_TIEN_KHONG_DOI", "Số tiền mới bằng số đang ghi — không có gì để sửa.");
      }

      const d0 = await ngayMoSo(tx);
      const bu = keHoachBuSuaTien(dong.date, dong.amount, amountMoi, d0);

      const { count } = await tx.expense.updateMany({
        where: {
          id,
          amount: dong.amount,
          date: dong.date,
          categoryId: dong.categoryId,
          source: dong.source,
          refId: dong.refId,
          cardId: null,
        },
        data: { amount: amountMoi },
      });
      if (count === 0) throw new LoiSuaTienTruocMoc("SO_TIEN_DA_DOI", CAU_VUA_DOI);

      const thongTin = { ngayDong: dong.date, moTaDong: dong.description, cu: dong.amount, moi: amountMoi, lyDo };
      let cutoverId: string | null = null;
      if (bu.coBu) {
        const row = await tx.cashMovement.create({
          data: {
            kind: bu.chieu === "IN" ? "CUTOVER_ADJ_IN" : "CUTOVER_ADJ_OUT",
            amount: bu.soTien,
            date: mocM,
            description: moTaDongBu(thongTin),
            yeuCauId: null,
          },
          select: { id: true },
        });
        cutoverId = row.id;
      }

      const moTa = moTaNhatKySuaTien({ ...thongTin, bu, mocM });
      await ghiNhatKy(tx, {
        actor: nguoiDung,
        hanhDong: "CHI_PHI_SUA_TIEN_TRUOC_MOC",
        doiTuong: { loai: "Expense", id, moTa },
        ghiChu: { lyDo: LY_DO_NHAT_KY, thang: format(dong.date, "yyyy-MM") },
      });
      if (cutoverId !== null) {
        await ghiNhatKy(tx, {
          actor: nguoiDung,
          hanhDong: "DONG_TIEN_TAO",
          doiTuong: { loai: "CashMovement", id: cutoverId, moTa },
          ghiChu: { lyDo: LY_DO_NHAT_KY },
        });
      }
      return bu.coBu ? { coBu: true, chieu: bu.chieu, soTienBu: bu.soTien } : { coBu: false };
    }, OPT_TX_DONG_TIEN);
  } catch (e) {
    await ghiNhatKyLoi({
      actor: nguoiDung,
      hanhDong: "CHI_PHI_SUA_TIEN_TRUOC_MOC",
      doiTuong: { loai: "Expense", id },
      ghiChu: { lyDo: maLoiNhatKy(e) },
    });
    if (e instanceof LoiChuaBat || e instanceof LoiSuaTienTruocMoc) return { ok: false, code: e.code, error: e.message };
    if (laLoiDongTienBan(e)) return { ok: false, error: THONG_BAO_KHOA_DONG_TIEN_BAN };
    console.error("[suaSoTienTruocMoc]", e);
    return { ok: false, error: "Lỗi khi sửa số tiền khoản chi" };
  }

  lamMoiTrang();
  return { ok: true, data: ketQua };
}
