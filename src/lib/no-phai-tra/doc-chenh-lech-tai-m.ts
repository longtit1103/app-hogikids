import { format, subDays } from "date-fns";

import { docNguCanhLoc } from "@/lib/no-phai-tra/doc-ngu-canh-loc";
import { khoanCauTrucTai } from "@/lib/no-phai-tra/khoan-cau-truc-tai-ngay";
import {
  tinhChenhLechTaiM,
  type ChenhLechTaiM,
  type MucGiaiThich,
} from "@/lib/no-phai-tra/tinh-chenh-lech-tai-m";
import { NHAN_NEN_TANG_VI } from "@/lib/no-phai-tra/vi-ads-queries";
import { prisma } from "@/lib/prisma";
import { tinhQuyTuTong } from "@/lib/so-quy/cong-thuc-so-quy";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";
import { docTongNguon, ngayMoSo } from "@/lib/so-quy/so-quy-queries";

/**
 * Đọc dữ liệu cho bước 2 của màn xác nhận bật (spec §5.4) — CHỈ ĐỌC, rồi giao phép tính cho hàm thuần
 * `tinhChenhLechTaiM`. Hai nhóm số chủ shop GÕ ở bước 1 (dư nợ thẻ, số dư ví cuối M − 1) chưa lưu nên đi
 * vào qua tham số; còn lại đọc DB:
 *  - quỹ app cuối ngày M − 1: `docTongNguon(D0, M − 1)` với ngữ cảnh lọc TƯƠI ép `mocM: null` (trước bật —
 *    bằng đúng ô "Cuối kỳ" của Sổ quỹ ngày M − 1 lúc chưa bật);
 *  - dư nợ thấu chi TẠI cuối M − 1 (`khoanCauTrucTai`), không phải hôm nay — trả hết sau M − 1 vẫn tính;
 *  - phiếu phương án Y: phiếu đã đánh dấu "đã giải thích" mà Sổ chi phí (cùng `refId`, CHỈ dòng ngày < M)
 *    ≠ `daTraTruoc`.
 */

export type DauVaoDocChenhLech = {
  mocM: Date;
  soDuBank: number;
  tienMat: number;
  /** Dư nợ tổng cuối M − 1 từng thẻ (chủ shop gõ). */
  the: readonly { cardId: string; duNo: number }[];
  /** Số dư thật cuối M − 1 từng ví ads trả trước (chủ shop gõ). */
  viAds: readonly { viAdsId: string; soDu: number }[];
};

export type KetQuaDocChenhLech = ChenhLechTaiM & {
  /** `yyyy-MM-dd` của M − 1 (ngày các số đem so). */
  ngayTruocM: string;
  /** Tiền đang gửi tiết kiệm tại M − 1 — chỉ để dặn "đừng cộng vào số dư", không vào phép tính. */
  tienDangGui: number;
};

export async function docChenhLechTaiMTuDb(d: DauVaoDocChenhLech): Promise<KetQuaDocChenhLech> {
  const truocM = subDays(d.mocM, 1);
  const khoaTruocM = khoaNgayVn(truocM);
  const cuoiTruocM = new Date(new Date(`${khoaTruocM}T00:00:00+07:00`).getTime() + 86_400_000);

  const [d0, ctx, loans, dongCauTruc, theDb, viDb, phieuY] = await Promise.all([
    ngayMoSo(),
    docNguCanhLoc(),
    prisma.loan.findMany({ select: { id: true, kind: true, startDate: true, closedAt: true, duNoMoSo: true } }),
    prisma.cashMovement.findMany({
      where: {
        date: { lt: cuoiTruocM },
        kind: { in: ["LOAN_IN", "LOAN_REPAY", "DEPOSIT_OUT", "DEPOSIT_IN", "SAVINGS_OUT", "SAVINGS_IN"] },
      },
      select: { loanId: true, savingsId: true, kind: true, amount: true, date: true },
    }),
    prisma.theTinDung.findMany({ select: { id: true, ten: true } }),
    prisma.viAdsTraTruoc.findMany({ select: { id: true, nenTang: true } }),
    prisma.phieuNhapNo.findMany({
      where: { lechDaGiaiThich: true },
      select: { refId: true, maPhieu: true, daTraTruoc: true },
    }),
  ]);

  // Quỹ app TRƯỚC khi bật: ép `mocM: null` — bộ lọc chi phí y như cũ dù hồ sơ thẻ/ví đã chuẩn bị.
  const quyApp =
    d0 === null || khoaTruocM < khoaNgayVn(d0)
      ? 0
      : tinhQuyTuTong(await docTongNguon(d0, truocM, { ...ctx, mocM: null }));
  const cauTruc = khoanCauTrucTai(truocM, loans, dongCauTruc);

  const tenThe = new Map(theDb.map((t) => [t.id, t.ten]));
  const the: MucGiaiThich[] = d.the.map((t) => {
    const ten = tenThe.get(t.cardId);
    if (ten === undefined) throw new Error(`Không tìm thấy thẻ ${t.cardId}`);
    return { khoa: `the:${t.cardId}`, nhan: `nợ thẻ ${ten}`, soTien: t.duNo };
  });

  const nenTangVi = new Map(viDb.map((v) => [v.id, v.nenTang]));
  const viAds: MucGiaiThich[] = d.viAds.map((v) => {
    const nenTang = nenTangVi.get(v.viAdsId);
    if (nenTang === undefined) throw new Error(`Không tìm thấy hồ sơ ví ${v.viAdsId}`);
    return {
      khoa: `vi:${v.viAdsId}`,
      nhan: `ví ${NHAN_NEN_TANG_VI[nenTang] ?? nenTang} đã nạp, chưa chạy (sổ chưa trừ)`,
      soTien: -v.soDu,
    };
  });

  const chiPhiTheoRef = new Map<string, number>();
  if (phieuY.length > 0) {
    const chi = await prisma.expense.groupBy({
      by: ["refId"],
      // CHỈ dòng trước M — đúng tập quỹ(M − 1) đã trừ. Dòng ≥ M (bước bật còn chặn `CON_NHAP_HANG_SAU_M`)
      // không nằm trong quỹ cuối M − 1 nên không giải thích được gì ở đó.
      where: { refId: { in: phieuY.map((p) => p.refId) }, date: { lt: cuoiTruocM } },
      _sum: { amount: true },
    });
    for (const c of chi) if (c.refId !== null) chiPhiTheoRef.set(c.refId, c._sum.amount ?? 0);
  }
  const phieu: MucGiaiThich[] = phieuY
    .map((p) => ({
      khoa: `phieu:${p.refId}`,
      // `maPhieu` đã mang dấu `#` (`#123`) — nhãn này thành MÔ TẢ dòng điều chỉnh lưu vĩnh viễn.
      nhan: `phiếu ${p.maPhieu} duyệt khác số đã trả`,
      soTien: (chiPhiTheoRef.get(p.refId) ?? 0) - p.daTraTruoc,
    }))
    .filter((m) => m.soTien !== 0);

  const kq = tinhChenhLechTaiM({
    quyApp,
    soDuBank: d.soDuBank,
    tienMat: d.tienMat,
    duNoThauChi: cauTruc.duNoThauChi,
    the,
    phieuY: phieu,
    viAds,
  });
  return { ...kq, ngayTruocM: format(truocM, "yyyy-MM-dd"), tienDangGui: cauTruc.tienDangGui };
}
