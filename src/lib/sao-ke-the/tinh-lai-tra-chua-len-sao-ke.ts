import { format } from "date-fns";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { formatVnd } from "@/lib/format";
import { ghiNhatKy, type ActorNhatKy } from "@/lib/nhat-ky/ghi-nhat-ky";
import { docNguCanhLoc } from "@/lib/no-phai-tra/doc-ngu-canh-loc";
import { docGiaoDichAppChoSaoKe, ngayChotTruocCua } from "@/lib/no-phai-tra/doi-chieu-sao-ke-voi-app";
import type { DbDocThe } from "@/lib/no-phai-tra/du-no-the";
import type { NguCanhLoc } from "@/lib/no-phai-tra/the-cua-dong-chi";
import { khoaThe } from "@/lib/no-phai-tra/the-tin-dung-queries";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";
import { OPT_TX_DONG_TIEN } from "@/lib/so-quy/khoa-dong-tien-co-han";

import { SO_NGAY_GHI_SO_TRE_MAC_DINH } from "./doi-chieu-sao-ke-the";
import { ghepChiTraVoiSaoKe, LECH_NGAY_GHEP_THE, type GiaoDichAppGhiCo } from "./ghep-chi-tra-the-voi-sao-ke";
import { laThanhToanNoThe, type DongSaoKe } from "./techcombank-sao-ke-parser";

/**
 * TÍNH LẠI "trả chưa lên sao kê" (`KySaoKeThe.saoKeTraChuaLen`) cho kỳ sao kê PDF đã chốt TRƯỚC khi có cột — cột NULL
 * thì nghĩa vụ kỳ vẫn kẹp tại neo (đòi thừa đúng phần trả đó khi kỳ có cả bill ghi sổ trễ). Gọi từ script
 * `scripts/tinh-lai-sao-ke-tra-chua-len.ts`: xem trước (`lietKeKyCanTinhLai`) ⇒ chủ shop duyệt ⇒ ghi theo danh sách id
 * (`ghiTraChuaLenChoCacKy`).
 *
 * CÙNG LUẬT với lúc chốt: dòng sao kê ĐÃ LƯU (`DongSaoKeThe`) ↔ giao dịch thẻ app tới D + 3 qua `ghepChiTraVoiSaoKe`
 * (trả thẻ ghép cùng số tiền, lệch ≤ 3 ngày; chỉ phần ngày ∈ (D − 5, D] không ghép được là "chưa lên sao kê"). File PDF
 * không lưu ở server nên đây là nguồn duy nhất còn lại; dòng đã lưu không có cột "là thanh toán" ⇒ suy lại bằng ĐÚNG
 * luật diễn giải của parser (`laThanhToanNoThe`).
 *
 * KHÔNG đổi neo `soDu`, quỹ, P&L hay dòng tiền nào — chỉ ghi một cột của kỳ, kèm nhật ký.
 */

type DbTinhLai = DbDocThe & Pick<Prisma.TransactionClient, "dongSaoKeThe">;

export type KetQuaTinhLai = {
  kyId: string;
  cardId: string;
  /** `yyyy-MM-dd` VN. */
  ngayChot: string;
  /** Neo đang lưu. */
  soDu: number;
  saoKeSoDu: number;
  saoKeTongBillGhiSoTre: number;
  /** `soDu − saoKeSoDu − saoKeTongBillGhiSoTre` — lúc chốt không sửa số thì = chi thẻ chưa lên − trả chưa lên. Để soi. */
  neoTruSaoKeVaBill: number;
  /** `CARD_PAY` ngày ∈ (D − 5, D] không thấy trên sao kê ⇒ chưa lên sao kê. */
  traChuaLen: GiaoDichAppGhiCo[];
  tong: number;
};

const COT_KY = {
  id: true,
  cardId: true,
  ngayChot: true,
  soDu: true,
  nguon: true,
  saoKeSoDu: true,
  saoKeTongBillGhiSoTre: true,
  saoKeTraChuaLen: true,
} as const;

type KyPdf = {
  id: string;
  cardId: string;
  ngayChot: Date;
  soDu: number;
  nguon: string;
  saoKeSoDu: number | null;
  saoKeTongBillGhiSoTre: number | null;
  saoKeTraChuaLen: number | null;
};

/** `yyyy-MM-dd` + n ngày (lịch thuần, không múi giờ). */
function congNgayKhoa(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

async function tinhChoKy(db: DbTinhLai, ky: KyPdf, ctx: NguCanhLoc): Promise<KetQuaTinhLai> {
  const D = khoaNgayVn(ky.ngayChot);
  const [kys, dongLuu] = await Promise.all([
    db.kySaoKeThe.findMany({ where: { cardId: ky.cardId }, select: { ngayChot: true } }),
    db.dongSaoKeThe.findMany({
      where: { kyId: ky.id },
      select: { ngayGiaoDich: true, ngayGhiSo: true, ghiNo: true, ghiCo: true, dienGiai: true, laTiktok: true },
      orderBy: [{ ngayGiaoDich: "asc" }, { id: "asc" }],
    }),
  ]);
  const { ngayChotTruoc } = ngayChotTruocCua(
    kys.map((k) => k.ngayChot),
    D
  );
  const giaoDichApp = await docGiaoDichAppChoSaoKe(db, ky.cardId, congNgayKhoa(D, LECH_NGAY_GHEP_THE), ctx);
  const dong: DongSaoKe[] = dongLuu.map((d) => ({
    ngayGiaoDich: khoaNgayVn(d.ngayGiaoDich),
    ngayGhiSo: khoaNgayVn(d.ngayGhiSo),
    ghiNo: d.ghiNo,
    ghiCo: d.ghiCo,
    dienGiai: d.dienGiai,
    laTiktok: d.laTiktok,
    laThanhToan: laThanhToanNoThe(d.dienGiai),
  }));
  const kq = ghepChiTraVoiSaoKe(dong, giaoDichApp, {
    ngaySaoKe: D,
    mocTre: congNgayKhoa(D, -SO_NGAY_GHI_SO_TRE_MAC_DINH),
    ngayChotTruoc,
    mocM: ctx.mocM === null ? null : khoaNgayVn(ctx.mocM),
  });
  const saoKeSoDu = ky.saoKeSoDu ?? 0;
  const bill = ky.saoKeTongBillGhiSoTre ?? 0;
  return {
    kyId: ky.id,
    cardId: ky.cardId,
    ngayChot: D,
    soDu: ky.soDu,
    saoKeSoDu,
    saoKeTongBillGhiSoTre: bill,
    neoTruSaoKeVaBill: ky.soDu - saoKeSoDu - bill,
    traChuaLen: kq.traChuaLenSaoKe,
    tong: kq.traChuaLenSaoKe.reduce((s, g) => s + g.soTien, 0),
  };
}

/** Xem trước: mọi kỳ `SAO_KE_PDF` còn `saoKeTraChuaLen` NULL kèm số tính lại. Chỉ ĐỌC. */
export async function lietKeKyCanTinhLai(db: DbTinhLai): Promise<KetQuaTinhLai[]> {
  const ctx = await docNguCanhLoc(db);
  const kys = await db.kySaoKeThe.findMany({
    where: { nguon: "SAO_KE_PDF", saoKeTraChuaLen: null },
    select: COT_KY,
    orderBy: [{ ngayChot: "asc" }, { id: "asc" }],
  });
  const ra: KetQuaTinhLai[] = [];
  for (const k of kys) ra.push(await tinhChoKy(db, k, ctx));
  return ra;
}

export type KetQuaGhiTinhLai = { ghi: KetQuaTinhLai[]; boQua: { kyId: string; lyDo: string }[] };

/**
 * Ghi cột cho đúng các kỳ chủ shop đã duyệt — MỘT transaction: khoá thẻ (`FOR UPDATE`, theo thứ tự id thẻ) rồi đọc lại
 * kỳ + tính lại trên dữ liệu tươi (không tin số lúc xem trước), ghi cột + nhật ký từng kỳ. Kỳ không tồn tại / không phải
 * PDF / đã có số ⇒ bỏ qua có lý do (chạy lại là no-op, không bao giờ ghi đè số đã có).
 */
export async function ghiTraChuaLenChoCacKy(
  db: Pick<PrismaClient, "$transaction">,
  kyIds: readonly string[],
  actor: ActorNhatKy
): Promise<KetQuaGhiTinhLai> {
  const ids = [...new Set(kyIds)];
  return db.$transaction(async (tx) => {
    const kys = await tx.kySaoKeThe.findMany({ where: { id: { in: ids } }, select: COT_KY });
    const theoId = new Map(kys.map((k) => [k.id, k]));
    for (const cardId of [...new Set(kys.map((k) => k.cardId))].sort()) await khoaThe(tx, cardId);

    const ctx = await docNguCanhLoc(tx);
    const kq: KetQuaGhiTinhLai = { ghi: [], boQua: [] };
    for (const id of ids) {
      if (!theoId.has(id)) {
        kq.boQua.push({ kyId: id, lyDo: "không tìm thấy kỳ sao kê" });
        continue;
      }
      // Đọc lại SAU khoá thẻ: lượt chốt / sửa song song đã commit thì thấy ở đây.
      const ky = await tx.kySaoKeThe.findUniqueOrThrow({ where: { id }, select: COT_KY });
      if (ky.nguon !== "SAO_KE_PDF") {
        kq.boQua.push({ kyId: id, lyDo: "không phải kỳ nhập từ sao kê PDF" });
        continue;
      }
      if (ky.saoKeTraChuaLen !== null) {
        kq.boQua.push({ kyId: id, lyDo: `đã có số (${formatVnd(ky.saoKeTraChuaLen)}) — không ghi đè` });
        continue;
      }
      const t = await tinhChoKy(tx, ky, ctx);
      await tx.kySaoKeThe.update({ where: { id }, data: { saoKeTraChuaLen: t.tong } });
      await ghiNhatKy(tx, {
        actor,
        hanhDong: "CHOT_SAO_KE_PDF",
        doiTuong: {
          loai: "KySaoKeThe",
          id,
          moTa:
            `Ghi bổ sung trả chưa lên sao kê ${formatVnd(t.tong)} (${t.traChuaLen.length} lần) cho kỳ ` +
            `${format(ky.ngayChot, "dd/MM/yyyy")} — sao kê ${formatVnd(t.saoKeSoDu)}, neo ${formatVnd(t.soDu)} giữ nguyên ` +
            `(script tính lại, chủ shop duyệt)`,
        },
        ghiChu: { ky: t.ngayChot, lyDo: "TINH_LAI_TRA_CHUA_LEN_SAO_KE" },
      });
      kq.ghi.push(t);
    }
    return kq;
  }, OPT_TX_DONG_TIEN);
}
