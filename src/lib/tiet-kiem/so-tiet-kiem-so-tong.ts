import { endOfDay } from "date-fns";

import { prisma } from "@/lib/prisma";
import { laiDuKien, soNgayGiua } from "@/lib/tiet-kiem/cong-thuc-lai-tiet-kiem";
import { docDongTheoSo } from "@/lib/tiet-kiem/doc-tong-theo-so-tiet-kiem";

/**
 * Các SỐ TỔNG của sổ tiết kiệm — cho thẻ Quỹ, banner nhắc đáo hạn và dòng tổng bảng. Tách khỏi
 * `so-tiet-kiem-queries.ts` (file kia dựng từng dòng bảng) vì đây là mối quan tâm khác: vài con số
 * gọn cho chỗ khác mượn, không ai cần trọn `SoTietKiemRow` để in một câu chú thích.
 *
 * `so-tiet-kiem-queries.ts` re-export lại ba hàm này nên mọi nơi gọi cũ giữ nguyên đường import.
 */

/**
 * Đếm SỔ tới ngày đáo hạn mà chưa tất toán — cho banner nhắc ở shell, nên phải RẺ: một câu `count`,
 * không đọc bảng dòng tiền. `endOfDay` để sổ đáo hạn ĐÚNG hôm nay được đếm ngay trong ngày.
 */
export async function demSoDenHan(homNay: Date): Promise<number> {
  return prisma.soTietKiem.count({
    where: { closedAt: null, maturityDate: { lte: endOfDay(homNay) } },
  });
}

/** Năm số cho footnote thẻ Quỹ (spec §9) — bốn số sau nói về CHÍNH sổ đáo hạn sớm nhất. */
export type TongDangGui = {
  /**
   * Σ số tiền ĐANG GỬI của các sổ CHƯA tất toán — SUY TỪ DÒNG TIỀN (Σ SAVINGS_OUT − Σ SAVINGS_IN),
   * KHÔNG phải Σ `principal`. Footnote thẻ Quỹ nói "đã trừ vào quỹ", nên con số phải là tiền THẬT đã
   * ra khỏi quỹ. Hai cách chỉ lệch khi sổ có dòng ghi tay — và đúng lúc lệch là lúc phải nói thật.
   */
  tong: number;
  soSoDangGui: number;
  daoHanGanNhat: Date | null;
  /**
   * Số tiền sẽ NHẬN LẠI ở sổ đáo hạn sớm nhất = số đang gửi của chính sổ đó (0 khi không còn sổ nào).
   * Cùng luật với `tong`: câu "nhận lại {gốc} + lãi" đứng ngay cạnh `tong` trong một câu, lấy
   * `principal` ở đây trong khi `tong` lấy dòng tiền là hai số đá nhau trên cùng một dòng chữ.
   */
  gocDaoHanGanNhat: number;
  /**
   * `laiDuKien` của chính sổ đó (0 khi không còn sổ nào đang gửi). CỐ Ý tính trên `principal`, KHÔNG
   * trên số đang gửi: ngân hàng trả lãi theo số tiền gửi ghi trên hợp đồng, dòng ghi tay của chủ shop
   * không làm ngân hàng đổi cách tính.
   */
  laiDaoHanGanNhat: number;
};

/**
 * Trả cả 5 số trong MỘT lượt đọc để thẻ Quỹ khỏi phải gọi thêm `listSoTietKiem()` rồi tự lọc — câu
 * chú thích "đáo hạn gần nhất {dd/MM} nhận lại {gốc} + lãi ≈ {lãi}" phải nói về ĐÚNG một sổ, ghép số
 * từ hai nguồn là lúc nào đó sẽ ghép nhầm.
 */
export async function tongDangGui(): Promise<TongDangGui> {
  const [so, dong] = await Promise.all([
    prisma.soTietKiem.findMany({
      where: { closedAt: null },
      select: {
        id: true,
        principal: true,
        startDate: true,
        maturityDate: true,
        annualRateBp: true,
      },
    }),
    docDongTheoSo(),
  ]);
  if (so.length === 0) {
    return {
      tong: 0,
      soSoDangGui: 0,
      daoHanGanNhat: null,
      gocDaoHanGanNhat: 0,
      laiDaoHanGanNhat: 0,
    };
  }
  const dangGuiCua = (id: string) => dong.get(id)?.dangGui ?? 0;
  const som = so.reduce((min, s) => (s.maturityDate < min.maturityDate ? s : min));
  return {
    tong: so.reduce((t, s) => t + dangGuiCua(s.id), 0),
    soSoDangGui: so.length,
    daoHanGanNhat: som.maturityDate,
    gocDaoHanGanNhat: dangGuiCua(som.id),
    laiDaoHanGanNhat: laiDuKien(
      som.principal,
      som.annualRateBp,
      soNgayGiua(som.startDate, som.maturityDate)
    ),
  };
}

/**
 * Σ `ThuNhap.amount` có `date` TRONG KỲ — cho dòng tổng bảng sổ tiết kiệm (spec §11).
 *
 * Lọc theo kỳ là BẮT BUỘC, không phải tuỳ chọn: trang Tài chính luôn đang xem MỘT tháng, đặt một số
 * cộng cả lịch sử cạnh các số theo tháng là chủ shop đọc sai chắc chắn (quyết định #6, vòng rà chéo
 * 16/09). `endOfDay` ở biên phải — cùng quy ước với mọi loader báo cáo khác.
 *
 * Đây là số ĐÃ THỰC NHẬN (tiền về rồi), khác hẳn `laiDonToiNay` của từng sổ (lãi chưa về, chỉ để
 * biết). Không trộn hai cột đó vào cùng một tổng.
 */
export async function tongLaiDaNhanTrongKy(range: { from: Date; to: Date }): Promise<number> {
  const tong = await prisma.thuNhap.aggregate({
    where: { date: { gte: range.from, lte: endOfDay(range.to) } },
    _sum: { amount: true },
  });
  return tong._sum.amount ?? 0;
}
