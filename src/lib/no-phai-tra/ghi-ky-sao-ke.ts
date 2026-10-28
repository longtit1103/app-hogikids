import type { Prisma } from "@/generated/prisma/client";
import { LoiHopDong } from "@/lib/actions/khoan-vay-chung";
import { docNguCanhLoc } from "@/lib/no-phai-tra/doc-ngu-canh-loc";
import { docGiaoDichThe, docKyNeoThe } from "@/lib/no-phai-tra/du-no-the";
import { duNo } from "@/lib/no-phai-tra/ky-sao-ke";
import type { NguCanhLoc } from "@/lib/no-phai-tra/the-cua-dong-chi";
import { khoaThe } from "@/lib/no-phai-tra/the-tin-dung-queries";

/**
 * LÕI GHI một kỳ sao kê thẻ (`KySaoKeThe`) — dùng chung cho chốt sao kê GÕ TAY (`actions/chot-sao-ke.ts`) và chốt
 * từ FILE PDF (`actions/sao-ke-the.ts`). Không cổng, không nhật ký, không yêu cầu ghi: phần đó của action gọi.
 *
 * Thứ tự trong transaction của action: giữ mã yêu cầu → `khoaVaDocTheMo` → (việc riêng của action, vd đối chiếu lại
 * sau khoá) → `ghiKySaoKe` → nhật ký → ghi kết quả.
 *
 * Ngày `ngayChot`/`hanTra` caller PHẢI chuẩn hoá 00:00 VN (`dauNgayVn`) trước khi gọi — unique `(cardId, ngayChot)`
 * khoá theo timestamp, cùng ngày khác giờ là lách unique. Luật ngày `[M, hôm qua]`, `hanTra > ngayChot` do schema
 * của action kiểm.
 */

/** Dòng sao kê đã chuẩn hoá để ghi `DongSaoKeThe` (ngày = 00:00 VN). */
export type DongSaoKeGhi = {
  ngayGiaoDich: Date;
  ngayGhiSo: Date;
  ghiNo: number;
  ghiCo: number;
  dienGiai: string;
  laTiktok: boolean;
  hoaDonId: string | null;
};

export type DauVaoGhiKySaoKe = {
  cardId: string;
  ngayChot: Date;
  hanTra: Date;
  soDu: number;
  note: string;
  /**
   * Có `saoKe` ⇒ nguồn "SAO_KE_PDF"; không ⇒ "TAY" (CHECK `KySaoKeThe_sao_ke_pdf_du_truong` ép đúng cặp).
   * `traChuaLen` = Σ lần trả thẻ ngày ≤ ngày chốt chưa lên sao kê (`tongTraChuaLenSaoKe` của lượt đối chiếu) — nghĩa
   * vụ kỳ = `soDu` sao kê − phần này (`ky-sao-ke.ts`).
   */
  saoKe?: { soDu: number; tongBillGhiSoTre: number; traChuaLen: number; hash: string; dong: readonly DongSaoKeGhi[] };
  /** Ngữ cảnh lọc thẻ đã đọc TRONG tx (tránh đọc lại); không truyền ⇒ đọc tươi từ `tx`. */
  ctx?: NguCanhLoc;
};

export type KetQuaGhiKySaoKe = {
  kyId: string;
  /** Dư nợ app tự tính CUỐI NGÀY chốt theo neo cũ (trước khi có neo mới); null = thẻ chưa có neo ≤ ngày chốt. */
  uocTinh: number | null;
};

/**
 * Khoá dòng thẻ (`FOR UPDATE`) rồi đọc lại: không có ⇒ "Không tìm thấy thẻ", đã đóng ⇒ "Thẻ đã đóng". Gọi ĐẦU TIÊN
 * sau bước giữ mã yêu cầu, TRƯỚC mọi phép đọc số để quyết định (đọc trước khoá là quyết trên số cũ).
 */
export async function khoaVaDocTheMo(tx: Prisma.TransactionClient, cardId: string): Promise<{ ten: string }> {
  await khoaThe(tx, cardId);
  const the = await tx.theTinDung.findUnique({ where: { id: cardId }, select: { ten: true, closedAt: true } });
  if (!the) throw new LoiHopDong("Không tìm thấy thẻ", "cardId");
  if (the.closedAt !== null) throw new LoiHopDong("Thẻ đã đóng", "cardId");
  return { ten: the.ten };
}

/**
 * Ghi MỘT kỳ sao kê (neo mới cho dư nợ, kỳ mới cho số phải trả) + các dòng sao kê nếu nhập từ file. Caller ĐÃ gọi
 * `khoaVaDocTheMo` trong cùng tx. `uocTinhLucChot` tính TRƯỚC khi chèn: dư nợ cuối ngày chốt theo neo cũ + giao
 * dịch tới hết ngày chốt — để chủ shop thấy chênh sao kê ↔ app.
 */
export async function ghiKySaoKe(tx: Prisma.TransactionClient, d: DauVaoGhiKySaoKe): Promise<KetQuaGhiKySaoKe> {
  const ctx = d.ctx ?? (await docNguCanhLoc(tx)); // đọc TƯƠI trong tx (đường ghi, không dùng bản nhớ)
  const [kys, gd] = await Promise.all([docKyNeoThe(d.cardId, tx), docGiaoDichThe(d.cardId, d.ngayChot, tx, ctx)]);
  const uocTinh = duNo(kys, gd, d.ngayChot);

  const ky = await tx.kySaoKeThe.create({
    data: {
      cardId: d.cardId,
      ngayChot: d.ngayChot,
      soDu: d.soDu,
      hanTra: d.hanTra,
      laNeoMoSo: false,
      uocTinhLucChot: uocTinh,
      note: d.note,
      ...(d.saoKe
        ? {
            nguon: "SAO_KE_PDF",
            saoKeSoDu: d.saoKe.soDu,
            saoKeTongBillGhiSoTre: d.saoKe.tongBillGhiSoTre,
            saoKeTraChuaLen: d.saoKe.traChuaLen,
            saoKeHash: d.saoKe.hash,
          }
        : {}),
    },
    select: { id: true },
  });

  if (d.saoKe && d.saoKe.dong.length > 0) {
    await tx.dongSaoKeThe.createMany({ data: d.saoKe.dong.map((x) => ({ ...x, kyId: ky.id })) });
  }
  return { kyId: ky.id, uocTinh };
}
