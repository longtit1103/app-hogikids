import { subDays } from "date-fns";

import { chieuTien } from "@/lib/cash-movements/cash-movement-kinds";
import { docNguCanhLoc } from "@/lib/no-phai-tra/doc-ngu-canh-loc";
import type { DongVeMuon } from "@/lib/no-phai-tra/troi-quy-truoc-m";
import { prisma } from "@/lib/prisma";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";
import { bien, boLocNguonQuy, ngayMoSo } from "@/lib/so-quy/so-quy-queries";

/** Trần đọc mỗi nguồn — chỉ báo là gợi ý, không cần đủ từng dòng khi dữ liệu về muộn hàng loạt. */
export const TRAN_DOC_MOI_NGUON = 200;

/**
 * Dòng thuộc quỹ cuối M − 1 (ĐÚNG bộ lọc `boLocNguonQuy`, khoảng [D0, M − 1], ép bộ lọc trước bật như vân tay
 * bước bật) mà được GHI VÀO APP sau lúc bật — gợi ý vì sao quỹ trước ngày bật trôi. CHỈ ĐỌC.
 *
 * Mốc "ghi vào app": `syncedAt` cho ví Shopee / TikTok (ingest chỉ đặt lúc TẠO, update giữ nguyên) và
 * `createdAt` cho Sổ chi phí, ghi tay, thu nhập. KHÔNG dò được: dòng có sẵn đổi trạng thái hay số tiền (lệnh
 * TikTok chuyển PAID, ads tự động ghi đè số ngày cũ) và đơn bán tại quầy (`Order.syncedAt` đổi mỗi lượt đồng
 * bộ) — màn hình nêu các nguồn này trong câu hướng dẫn đối chiếu.
 */
export async function docDongVeMuonTruocM(
  mocM: Date,
  lucBat: Date
): Promise<{ dong: DongVeMuon[]; chamTran: boolean }> {
  const d0 = await ngayMoSo();
  const truocM = subDays(new Date(`${khoaNgayVn(mocM)}T00:00:00+07:00`), 1);
  if (d0 === null || khoaNgayVn(truocM) < khoaNgayVn(d0)) return { dong: [], chamTran: false };
  const loc = boLocNguonQuy(bien(d0, truocM), { ...(await docNguCanhLoc()), mocM: null });
  const sau = { gt: lucBat };
  const lay = { take: TRAN_DOC_MOI_NGUON };

  const [vi, tiktok, adsVi, chiPhi, ghiTay, thuNhap] = await Promise.all([
    prisma.shopeeSettlement.findMany({
      ...lay,
      where: { AND: [loc.shopeeRutVi, { syncedAt: sau }] },
      select: { txnTime: true, amount: true, orderCode: true },
    }),
    prisma.tiktokPayment.findMany({
      ...lay,
      where: { AND: [loc.tiktokVeBank, { syncedAt: sau }] },
      select: { paidTime: true, settlementValue: true, paymentId: true },
    }),
    prisma.tiktokAdsSettlement.findMany({
      ...lay,
      where: { AND: [loc.adsTiktokTruVi, { syncedAt: sau }] },
      select: { orderCreateTime: true, settlementAmount: true },
    }),
    prisma.expense.findMany({
      ...lay,
      where: { AND: [loc.chiPhi, { createdAt: sau }] },
      select: { date: true, amount: true, description: true },
    }),
    prisma.cashMovement.findMany({
      ...lay,
      where: { AND: [loc.ghiTay, { createdAt: sau }] },
      select: { date: true, kind: true, amount: true, cardId: true, description: true },
    }),
    prisma.thuNhap.findMany({
      ...lay,
      where: { AND: [loc.thuNhap, { createdAt: sau }] },
      select: { date: true, amount: true, description: true },
    }),
  ]);

  // Dấu y `dongGopTheoNguon` (cong-thuc-so-quy.ts): rút ví lưu âm ⇒ −âm = vào quỹ; ads trừ ví lưu âm ⇒ cộng lại.
  const dong: DongVeMuon[] = [
    ...vi.map((r) => ({
      nguon: "VI_SHOPEE" as const,
      khoaNgay: khoaNgayVn(r.txnTime),
      tacDong: -r.amount,
      moTa: r.orderCode ? `mã ${r.orderCode}` : "rút ví",
    })),
    // `paidTime` khác null đã nằm trong bộ lọc (`paidTime: khoang`) — nhánh null chỉ để thu hẹp kiểu.
    ...tiktok.flatMap((r) =>
      r.paidTime === null
        ? []
        : [
            {
              nguon: "TIKTOK_VE_BANK" as const,
              khoaNgay: khoaNgayVn(r.paidTime),
              tacDong: r.settlementValue,
              moTa: `lệnh ${r.paymentId}`,
            },
          ]
    ),
    ...adsVi.map((r) => ({
      nguon: "ADS_TIKTOK_VI" as const,
      khoaNgay: khoaNgayVn(r.orderCreateTime),
      tacDong: -r.settlementAmount,
      moTa: "ads trừ vào ví TikTok",
    })),
    ...chiPhi.map((r) => ({
      nguon: "CHI_PHI" as const,
      khoaNgay: khoaNgayVn(r.date),
      tacDong: -r.amount,
      moTa: r.description,
    })),
    ...ghiTay.flatMap((r) => {
      const chieu = chieuTien(r.kind, { coCard: r.cardId !== null });
      if (chieu === "KHONG_QUY") return [];
      return [
        {
          nguon: "GHI_TAY" as const,
          khoaNgay: khoaNgayVn(r.date),
          tacDong: chieu === "IN" ? r.amount : -r.amount,
          moTa: r.description,
        },
      ];
    }),
    ...thuNhap.map((r) => ({
      nguon: "THU_NHAP" as const,
      khoaNgay: khoaNgayVn(r.date),
      tacDong: r.amount,
      moTa: r.description,
    })),
  ];
  const chamTran = [vi, tiktok, adsVi, chiPhi, ghiTay, thuNhap].some((x) => x.length >= TRAN_DOC_MOI_NGUON);
  return { dong, chamTran };
}
