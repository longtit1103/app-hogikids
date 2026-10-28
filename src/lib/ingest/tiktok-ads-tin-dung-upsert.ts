import type { Prisma } from "@/generated/prisma/client";

import { prisma } from "@/lib/prisma";

import { tinhGrantGomVat, type TinDungAdvertiser } from "./tiktok-ads-tin-dung-mapping";

/**
 * Ghi MỘT ảnh chụp ngày vào Silver `TiktokAdsTinDung` — idempotent theo `(advertiserId, ngay)`: chạy lại đêm sau /
 * dựng lại không nhân đôi; TikTok chỉnh hồi tố ⇒ ảnh chụp mới hơn ghi đè đúng dòng.
 *
 * ẢNH CHỤP LÀ TRỌN NGÀY của Business Center đó ⇒ advertiser từng có dòng ngày này (cùng `bcId`) mà nay vắng khỏi
 * `anh.theoAdvertiser` (danh sách SAU khi transform lọc advertiser chưa có báo cáo chi tiêu) thì XOÁ — nếu không, tín dụng TikTok đã gỡ vẫn bị P&L trừ mãi. Upsert + xoá nằm CHUNG một transaction:
 * người đọc P&L không bao giờ thấy nửa ảnh cũ nửa ảnh mới.
 *
 * Lỗi ⇒ `skipped++` + cảnh báo cho CẢ ảnh chụp, KHÔNG giết lượt (khuôn `tiktok-ads-hoa-don-upsert.ts`); transaction
 * rollback nên số cũ của ngày đó giữ nguyên.
 */

/**
 * Bộ đếm tối thiểu — kiểu cấu trúc để module ingest không phải import ngược kiểu của tầng Bronze.
 * `tinDungAdvertiserNgoaiSo`: số dòng (advertiser × ngày) transform bỏ vì advertiser chưa có báo cáo chi tiêu —
 * TUỲ CHỌN, chỉ đặt khi > 0 (xem `transform-tiktok-ads-tin-dung.ts`).
 */
export type BoDemTinDung = { skipped: number; tinDungAdsUpserted: number; tinDungAdvertiserNgoaiSo?: number };

export async function ghiAnhChupTinDungTiktok(
  bcId: string,
  anh: { ngay: string; ngayLuc: Date; theoAdvertiser: TinDungAdvertiser[] },
  vatRate: number,
  stats: BoDemTinDung,
  warnings: string[],
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      for (const d of anh.theoAdvertiser) {
        const data = {
          bcId,
          grantExVat: d.grantExVat,
          cashExVat: d.cashExVat,
          amountExVat: d.amountExVat,
          grantGomVat: tinhGrantGomVat(d.grantExVat, vatRate),
          raw: d.nguon as unknown as Prisma.InputJsonValue,
        };
        await tx.tiktokAdsTinDung.upsert({
          where: { advertiserId_ngay: { advertiserId: d.advertiserId, ngay: anh.ngayLuc } },
          create: { advertiserId: d.advertiserId, ngay: anh.ngayLuc, ...data },
          update: data,
        });
      }
      // `notIn: []` (ảnh chụp rỗng) ⇒ xoá mọi dòng của BC này ngày này — đúng nghĩa "ngày này nay không còn gì".
      await tx.tiktokAdsTinDung.deleteMany({
        where: {
          bcId,
          ngay: anh.ngayLuc,
          advertiserId: { notIn: anh.theoAdvertiser.map((d) => d.advertiserId) },
        },
      });
    });
    stats.tinDungAdsUpserted += anh.theoAdvertiser.length;
  } catch (e) {
    stats.skipped++;
    warnings.push(
      `Bỏ qua tín dụng TikTok ${bcId} ngày ${anh.ngay}: ${e instanceof Error ? e.message : "ghi lỗi"}`,
    );
  }
}
