"use server";

import { format } from "date-fns";
import { z } from "zod";

import { LoiHopDong } from "@/lib/actions/khoan-vay-chung";
import { lamMoiTrang } from "@/lib/actions/lam-moi-trang";
import { mapZodError } from "@/lib/actions/map-zod-error";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { formatVnd } from "@/lib/format";
import { ghiNhatKy } from "@/lib/nhat-ky/ghi-nhat-ky";
import { daBatNoPhaiTra } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { docNguCanhLoc } from "@/lib/no-phai-tra/doc-ngu-canh-loc";
import { dauNgayVn, docGiaoDichThe, docKyNeoThe } from "@/lib/no-phai-tra/du-no-the";
import { duNo } from "@/lib/no-phai-tra/ky-sao-ke";
import { ngayTienMoiSchema } from "@/lib/no-phai-tra/ngay-tien-moi-schema";
import { khoaThe, loiThe } from "@/lib/no-phai-tra/the-tin-dung-queries";
import { bamNoiDung, ghiKetQua, giuYeuCau } from "@/lib/no-phai-tra/yeu-cau-ghi";
import { rangBuocTrungKhoa } from "@/lib/prisma-loi-adapter";
import { prisma } from "@/lib/prisma";
import { congChuShopAction } from "@/lib/quyen/cong-action";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";
import { OPT_TX_DONG_TIEN } from "@/lib/so-quy/khoa-dong-tien-co-han";

/**
 * CHỐT SAO KÊ thẻ tín dụng (spec `design.md` §5.5, §5.8; yêu cầu ghi có mã loại `CHOT_SAO_KE`, §5.3).
 *
 * Chủ shop gõ đúng số trên sao kê ngân hàng (`soDu` cuối ngày `ngayChot`, hạn trả `hanTra`) ⇒ thêm MỘT
 * dòng `KySaoKeThe` — neo mới cho dư nợ, kỳ mới cho số phải trả. App lưu kèm `uocTinhLucChot` = dư nợ
 * app tự tính CUỐI NGÀY `ngayChot` (trước khi có neo mới) để chủ shop thấy chênh lệch sao kê ↔ app.
 *
 * Luật ngày: `ngayChot ∈ [M, hôm qua]` (neo trước M chỉ sinh ở bước bật; hôm nay chưa hết ngày nên sao kê
 * cuối ngày chưa có thật), `hanTra > ngayChot`; cả hai chuẩn hoá 00:00 VN trước khi ghi (unique
 * `(cardId, ngayChot)` khoá theo timestamp).
 *
 * Transaction (khuôn `yeu-cau-ghi.ts`): giữ mã → khoá thẻ → ước tính → chèn kỳ → nhật ký → ghi kết quả.
 * Gửi lại cùng mã + cùng nội dung ⇒ trả kết quả cũ `DA_GHI_ROI`, không ghi gì. Trùng `(cardId, ngayChot)`
 * với mã KHÁC ⇒ P2002 làm Postgres huỷ cả transaction (kể cả dòng giữ mã) ⇒ bắt NGOÀI transaction.
 */

export type KetQuaChotSaoKe = {
  id: string;
  cardId: string;
  /** `yyyy-MM-dd` VN. */
  ngayChot: string;
  soDu: number;
  /** null = thẻ chưa có neo ≤ ngày chốt (app không có số để so). */
  uocTinh: number | null;
  /** `soDu − uocTinh` (dương = sao kê cao hơn app tính); null khi không có ước tính. */
  chenh: number | null;
};

/** `ActionResult` + mã `DA_GHI_ROI` ở nhánh thành công (lượt gửi lại đã ghi trước đó). */
export type KetQuaActionChotSaoKe =
  | { ok: true; data: KetQuaChotSaoKe; code?: "DA_GHI_ROI" }
  | { ok: false; error: string; field?: string; code?: string };

const LOAI_YEU_CAU = "CHOT_SAO_KE";

function chotSaoKeSchema(mocM: Date) {
  return z
    .object({
      yeuCauId: z.string().uuid("Mã yêu cầu không hợp lệ — tải lại trang rồi thử lại"),
      cardId: z.string().min(1, "Chọn thẻ"),
      ngayChot: ngayTienMoiSchema(mocM),
      soDu: z.coerce
        .number()
        .int("Số tiền phải là số nguyên")
        .min(0, "Dư nợ sao kê không âm")
        .max(2_000_000_000, "Số tiền quá lớn (tối đa 2 tỷ)"),
      hanTra: z.coerce
        .date({ error: "Ngày không hợp lệ" })
        .refine((d) => d.getFullYear() >= 2000, "Ngày không hợp lệ"),
      note: z.string().trim().max(500, "Tối đa 500 ký tự").default(""),
    })
    .superRefine((d, ctx) => {
      // `ngayTienMoiSchema` cho phép HÔM NAY (dòng tiền đã phát sinh); sao kê "cuối ngày" thì không.
      if (khoaNgayVn(d.ngayChot) >= khoaNgayVn(new Date())) {
        ctx.addIssue({ code: "custom", path: ["ngayChot"], message: "Ngày chốt sao kê phải trước hôm nay" });
      }
      if (khoaNgayVn(d.hanTra) <= khoaNgayVn(d.ngayChot)) {
        ctx.addIssue({ code: "custom", path: ["hanTra"], message: "Hạn trả phải sau ngày chốt" });
      }
    });
}

export async function chotSaoKe(input: unknown): Promise<KetQuaActionChotSaoKe> {
  const c = await congChuShopAction();
  if (!c.ok) return c;
  const { nguoiDung } = c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  let mocM: Date;
  try {
    mocM = await daBatNoPhaiTra();
  } catch (e) {
    // `LoiChuaBat` ⇒ code `CHUA_BAT_NO_PHAI_TRA`; Setting hỏng ⇒ câu chung (không thành 500).
    return { ok: false, ...loiThe(e, "Lỗi khi đọc mốc bật theo dõi nợ") };
  }

  const parsed = chotSaoKeSchema(mocM).safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  const { yeuCauId, cardId, soDu, note } = parsed.data;
  const ngayChot = dauNgayVn(parsed.data.ngayChot);
  const hanTra = dauNgayVn(parsed.data.hanTra);
  const khoaChot = khoaNgayVn(ngayChot);
  // Vân tay trên dữ liệu ĐÃ chuẩn hoá (khoá ngày, không giờ): gửi lại cùng ngày khác giờ vẫn là cùng nội dung.
  const bam = bamNoiDung({ cardId, ngayChot: khoaChot, soDu, hanTra: khoaNgayVn(hanTra), note });

  try {
    const kq = await prisma.$transaction(async (tx) => {
      const giu = await giuYeuCau(tx, { id: yeuCauId, loai: LOAI_YEU_CAU, bam });
      if (giu !== "MOI") {
        if (giu.cu.bamNoiDung !== bam) throw new LoiHopDong("Mã yêu cầu đã dùng cho nội dung khác");
        // Đã commit mà không có kết quả = đường ghi quên `ghiKetQua` — nổ, KHÔNG coi là "đã ghi rồi".
        if (giu.cu.ketQua === null) throw new Error(`YeuCauGhi ${yeuCauId}: yêu cầu chưa hoàn tất`);
        return { daGhiRoi: true as const, data: (giu.cu.ketQua as { data: KetQuaChotSaoKe }).data };
      }

      await khoaThe(tx, cardId);
      const the = await tx.theTinDung.findUnique({ where: { id: cardId }, select: { ten: true, closedAt: true } });
      if (!the) throw new LoiHopDong("Không tìm thấy thẻ", "cardId");
      if (the.closedAt !== null) throw new LoiHopDong("Thẻ đã đóng", "cardId");

      // Ước tính TRƯỚC khi chèn neo mới: duNo cuối ngày chốt theo neo cũ + giao dịch tới hết ngày chốt.
      const ctx = await docNguCanhLoc(tx); // đọc TƯƠI trong tx (action ghi, không dùng bản nhớ)
      const [kys, gd] = await Promise.all([docKyNeoThe(cardId, tx), docGiaoDichThe(cardId, ngayChot, tx, ctx)]);
      const uocTinh = duNo(kys, gd, ngayChot);

      const ky = await tx.kySaoKeThe.create({
        data: { cardId, ngayChot, soDu, hanTra, laNeoMoSo: false, uocTinhLucChot: uocTinh, note },
      });
      const chenh = uocTinh === null ? null : soDu - uocTinh;
      const data: KetQuaChotSaoKe = { id: ky.id, cardId, ngayChot: khoaChot, soDu, uocTinh, chenh };

      // `ghiChu` nhật ký chỉ nhận khoá allowlist (không có ô tiền) ⇒ ba con số đi vào `moTa`.
      await ghiNhatKy(tx, {
        actor: nguoiDung,
        hanhDong: "THE_CHOT_SAO_KE",
        doiTuong: {
          loai: "KySaoKeThe",
          id: ky.id,
          moTa:
            `${the.ten} ${format(ngayChot, "dd/MM/yyyy")}: sao kê ${formatVnd(soDu)}` +
            (uocTinh === null ? " · chưa có ước tính" : ` · ước tính ${formatVnd(uocTinh)} · chênh ${formatVnd(chenh ?? 0)}`),
        },
        ghiChu: { ky: khoaChot },
      });
      await ghiKetQua(tx, yeuCauId, { ok: true, data });
      return { daGhiRoi: false as const, data };
    }, OPT_TX_DONG_TIEN);

    if (kq.daGhiRoi) return { ok: true, data: kq.data, code: "DA_GHI_ROI" };
    lamMoiTrang();
    return { ok: true, data: kq.data };
  } catch (e) {
    // Unique DUY NHẤT có thể vỡ trong transaction này là `(cardId, ngayChot)` — bước giữ mã dùng ON CONFLICT.
    // Dòng trùng có thể là kỳ sao kê HOẶC neo mở sổ của thẻ thêm sau khi bật (cùng bảng) ⇒ câu báo nói cả hai.
    if (rangBuocTrungKhoa(e) !== undefined) {
      return { ok: false, error: `Thẻ đã có kỳ/neo ở ngày này (${format(ngayChot, "dd/MM/yyyy")})`, field: "ngayChot" };
    }
    return { ok: false, ...loiThe(e, "Lỗi khi chốt sao kê") };
  }
}
