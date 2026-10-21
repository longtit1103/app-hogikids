import { format, subDays } from "date-fns";

import type { Prisma } from "@/generated/prisma/client";
import { KIND_DU_NO_VAY } from "@/lib/cash-movements/cash-movement-kinds";
import { formatVnd } from "@/lib/format";
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
import { type DbQuy, docTongNguon, ngayMoSo } from "@/lib/so-quy/so-quy-queries";

/**
 * Đọc dữ liệu cho bước 2 của màn xác nhận bật (spec §5.4) — CHỈ ĐỌC, rồi giao phép tính cho hàm thuần
 * `tinhChenhLechTaiM`. Hai nhóm số chủ shop GÕ ở bước 1 (dư nợ thẻ, số dư ví cuối M − 1) chưa lưu nên đi
 * vào qua tham số; còn lại đọc DB:
 *  - quỹ app cuối ngày M − 1: `docTongNguon(D0, M − 1)` với ngữ cảnh lọc TƯƠI ép `mocM: null` (trước bật —
 *    bằng đúng ô "Cuối kỳ" của Sổ quỹ ngày M − 1 lúc chưa bật);
 *  - dư nợ thấu chi TẠI cuối M − 1 (`khoanCauTrucTai`), không phải hôm nay — CHỈ hiện dòng tham khảo, KHÔNG
 *    vào chênh lệch (thấu chi giải ngân vào tài khoản: tiền thật lẫn quỹ app đều đã gồm tiền vay);
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

/**
 * VÂN TAY số liệu trước ngày bật — ba số DB màn bước 2 hiện: quỹ app cuối M − 1, dư nợ thấu chi cuối M − 1,
 * Σ phiếu Y. Danh sách điều chỉnh chỉ phụ thuộc quỹ app + phiếu Y; dư nợ thấu chi chỉ là dòng tham khảo nhưng
 * vẫn giữ trong vân tay (hợp đồng đã lưu ở kết quả yêu cầu bật). Sửa HỒ SƠ thấu chi (`duNoMoSo`, `startDate`, `closedAt`) làm
 * vân tay lệch dù quỹ không đổi ⇒ bước bật đòi tính lại — bảo thủ, chấp nhận được. Màn hình gửi lại bộ đã thấy; bước bật tính lại bằng CÙNG hàm
 * (`docSoLieuTruocM`) trong transaction sau khoá EXCLUSIVE — lệch dù một số ⇒ điều chỉnh chủ shop chọn đã cũ.
 * Lưu vào kết quả yêu cầu bật để về sau so quỹ trước M lúc bật với hiện tại.
 */
export type VanTayQuyTruocM = { quyApp: number; duNoThauChi: number; tongPhieuY: number };

export type KetQuaDocChenhLech = ChenhLechTaiM & {
  /** `yyyy-MM-dd` của M − 1 (ngày các số đem so). */
  ngayTruocM: string;
  /** Tiền đang gửi tiết kiệm tại M − 1 — chỉ để dặn "đừng cộng vào số dư", không vào phép tính. */
  tienDangGui: number;
  /** Bộ số màn hình gửi kèm lúc bấm bật (xem `VanTayQuyTruocM`). */
  vanTay: VanTayQuyTruocM;
};

/** Client đọc số liệu trước M — prisma gốc hoặc `tx` bước bật. */
type DbSoLieuTruocM = DbQuy & Pick<Prisma.TransactionClient, "loan" | "phieuNhapNo">;

type SoLieuTruocM = { vanTay: VanTayQuyTruocM; phieuY: MucGiaiThich[]; tienDangGui: number };

/**
 * Phần số liệu DB trước M dùng chung cho màn đối chiếu (prisma) và bước bật (`tx`, sau khoá) — một hàm, hai
 * nơi gọi, để vân tay hai bên so cùng một phép tính.
 */
export async function docSoLieuTruocM(mocMVao: Date, db: DbSoLieuTruocM = prisma): Promise<SoLieuTruocM> {
  const mocM = new Date(`${khoaNgayVn(mocMVao)}T00:00:00+07:00`);
  const truocM = subDays(mocM, 1);
  const khoaTruocM = khoaNgayVn(truocM);
  const cuoiTruocM = mocM;

  const [d0, ctx, loans, dongCauTruc, phieuY] = await Promise.all([
    ngayMoSo(db),
    docNguCanhLoc(db),
    db.loan.findMany({ select: { id: true, kind: true, startDate: true, closedAt: true, duNoMoSo: true } }),
    db.cashMovement.findMany({
      where: {
        date: { lt: cuoiTruocM },
        kind: { in: [...KIND_DU_NO_VAY, "DEPOSIT_OUT", "DEPOSIT_IN", "SAVINGS_OUT", "SAVINGS_IN"] },
      },
      select: { loanId: true, savingsId: true, kind: true, amount: true, date: true },
    }),
    db.phieuNhapNo.findMany({
      where: { lechDaGiaiThich: true },
      select: { refId: true, maPhieu: true, daTraTruoc: true },
    }),
  ]);

  // Quỹ app TRƯỚC khi bật: ép `mocM: null` — bộ lọc chi phí y như cũ dù hồ sơ thẻ/ví đã chuẩn bị.
  const quyApp =
    d0 === null || khoaTruocM < khoaNgayVn(d0)
      ? 0
      : tinhQuyTuTong(await docTongNguon(d0, truocM, { ...ctx, mocM: null }, db));
  const cauTruc = khoanCauTrucTai(truocM, loans, dongCauTruc);

  const chiPhiTheoRef = new Map<string, number>();
  if (phieuY.length > 0) {
    const chi = await db.expense.groupBy({
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

  return {
    vanTay: { quyApp, duNoThauChi: cauTruc.duNoThauChi, tongPhieuY: phieu.reduce((t, m) => t + m.soTien, 0) },
    phieuY: phieu,
    tienDangGui: cauTruc.tienDangGui,
  };
}

/** Chỉ vân tay — cho bước bật (đọc trong `tx`) và test. */
export async function docVanTayQuyTruocM(mocM: Date, db: DbSoLieuTruocM = prisma): Promise<VanTayQuyTruocM> {
  return (await docSoLieuTruocM(mocM, db)).vanTay;
}

const NHAN_VAN_TAY: Record<keyof VanTayQuyTruocM, (nhanTruocM: string) => string> = {
  quyApp: (n) => `quỹ của app cuối ${n}`,
  duNoThauChi: (n) => `dư nợ thấu chi cuối ${n}`,
  tongPhieuY: () => "phiếu nhập duyệt khác số đã trả",
};

/**
 * So vân tay màn hình đã thấy với số tính lại — THUẦN. Trả null khi khớp từng số; lệch ⇒ câu liệt kê từng số
 * đổi (cũ → mới) để chủ shop biết vì sao phải tính lại.
 */
export function moTaVanTayLech(daThay: VanTayQuyTruocM, hienTai: VanTayQuyTruocM, nhanTruocM: string): string | null {
  const lech = (Object.keys(NHAN_VAN_TAY) as (keyof VanTayQuyTruocM)[])
    .filter((k) => daThay[k] !== hienTai[k])
    .map((k) => `${NHAN_VAN_TAY[k](nhanTruocM)}: ${formatVnd(daThay[k])} → ${formatVnd(hienTai[k])}`);
  return lech.length === 0 ? null : lech.join("; ");
}

export async function docChenhLechTaiMTuDb(d: DauVaoDocChenhLech): Promise<KetQuaDocChenhLech> {
  const truocM = subDays(d.mocM, 1);
  const [soLieu, theDb, viDb] = await Promise.all([
    docSoLieuTruocM(d.mocM),
    prisma.theTinDung.findMany({ select: { id: true, ten: true } }),
    prisma.viAdsTraTruoc.findMany({ select: { id: true, nenTang: true } }),
  ]);

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

  const kq = tinhChenhLechTaiM({
    quyApp: soLieu.vanTay.quyApp,
    soDuBank: d.soDuBank,
    tienMat: d.tienMat,
    duNoThauChi: soLieu.vanTay.duNoThauChi,
    the,
    phieuY: soLieu.phieuY,
    viAds,
  });
  return {
    ...kq,
    ngayTruocM: format(truocM, "yyyy-MM-dd"),
    tienDangGui: soLieu.tienDangGui,
    vanTay: soLieu.vanTay,
  };
}
