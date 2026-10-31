import type { Prisma } from "@/generated/prisma/client";

import { tinhGrantGomVat, type TinDungAdvertiser } from "./tiktok-ads-tin-dung-mapping";
import { sqlJson, sqlThoiDiem } from "./tiktok-settlement-upsert";

/**
 * Ghi MỘT ảnh chụp ngày vào Silver `TiktokAdsTinDung` — idempotent theo `(advertiserId, ngay)`: chạy lại đêm sau /
 * dựng lại không nhân đôi; TikTok chỉnh hồi tố ⇒ ảnh chụp mới hơn ghi đè đúng dòng.
 *
 * ẢNH CHỤP LÀ TRỌN NGÀY của Business Center đó ⇒ advertiser từng có dòng ngày này (cùng `bcId`) mà nay vắng khỏi
 * `anh.theoAdvertiser` (danh sách SAU khi transform lọc advertiser chưa có báo cáo chi tiêu) thì XOÁ — nếu không, tín
 * dụng TikTok đã gỡ vẫn bị P&L trừ mãi. Upsert + xoá chạy trong transaction CỦA NGƯỜI GỌI (cùng transaction với bước
 * ĐỌC ảnh chụp, sau `khoaNgayTinDung`): người đọc P&L không bao giờ thấy nửa ảnh cũ nửa ảnh mới, và hai lượt transform
 * cùng ngày không đan nhau.
 */

/**
 * Bộ đếm tối thiểu — kiểu cấu trúc để module ingest không phải import ngược kiểu của tầng Bronze.
 * `tinDungAdsSkippedStale`: số dòng (advertiser × ngày) KHÔNG ghi vì Silver đang giữ bản từ ảnh chụp MỚI HƠN (chốt
 * `nguonFetchedAt`) — kết cục đúng, không phải `skipped`.
 * `tinDungAdvertiserNgoaiSo`: số dòng (advertiser × ngày) transform bỏ vì advertiser chưa có báo cáo chi tiêu —
 * TUỲ CHỌN, chỉ đặt khi > 0 (xem `transform-tiktok-ads-tin-dung.ts`).
 */
export type BoDemTinDung = {
  skipped: number;
  tinDungAdsUpserted: number;
  tinDungAdsSkippedStale: number;
  tinDungAdvertiserNgoaiSo?: number;
};

/**
 * Khoá tư vấn theo NGÀY chi tiêu (gồm MỌI Business Center), giữ tới hết transaction. Theo ngày chứ không theo BC vì
 * khoá duy nhất của Silver là `(advertiserId, ngay)` — hai BC cùng báo một advertiser thì đụng cùng dòng. Người gọi
 * giữ khoá TỪ bước đọc ảnh chụp mới nhất TỚI bước ghi: lượt tới sau chờ rồi đọc lại kho thô (READ COMMITTED) nên luôn
 * cầm ảnh ít nhất mới bằng lượt trước. Transaction chỉ giữ đúng khoá này ⇒ không khoá chéo với khoá land đơn / khoá
 * ghi đơn. `$executeRaw` vì hàm trả `void` (`$queryRaw` ném "Failed to deserialize column").
 */
export async function khoaNgayTinDung(tx: Prisma.TransactionClient, ngay: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`tin-dung:${ngay}`}, 0))`;
}

export type KetQuaGhiTinDung = { ghi: number; cuHon: number };

/**
 * Ghi ảnh chụp trong transaction đã giữ `khoaNgayTinDung`. Lỗi ⇒ NÉM để người gọi cuộn lại cả transaction (số cũ của
 * ngày đó giữ nguyên) và đếm `skipped`.
 *
 * Lá chắn CHÍNH là khoá ngày + đọc ảnh mới nhất trong khoá (người gọi). Chốt `nguonFetchedAt` (mốc của dòng kho thô
 * đã dựng ảnh này) là lưới THỨ HAI, nằm TRONG từng câu ghi để không có khe giữa so và ghi:
 *  - upsert từng dòng = MỘT câu `INSERT … ON CONFLICT ("advertiserId","ngay") DO UPDATE … WHERE mốc đang lưu NULL hoặc
 *    ≤ mốc ảnh này` — dòng đang mang mốc MỚI HƠN (của ảnh mới hơn, cùng hay khác BC) không bị đè, đếm `cuHon`;
 *  - xoá advertiser vắng khỏi ảnh CHỈ xoá dòng mang mốc NULL hoặc ≤ mốc ảnh này — dòng ảnh mới hơn vừa ghi không bị gỡ;
 *  - có dòng CỦA CHÍNH BC này ngày này mang mốc mới hơn ⇒ ảnh này cũ hơn ảnh đã ghi ⇒ BỎ CẢ ẢNH: ghi tiếp sẽ dựng lại
 *    advertiser mà ảnh mới đã gỡ (dòng không còn, không câu điều kiện nào chặn được). Bước này là đọc-rồi-quyết, chỉ
 *    kín dưới khoá ngày.
 * NULL = dòng có trước cột ⇒ cho ghi; bằng mốc ⇒ cho ghi (lượt dựng lại đọc đúng dòng đã ghi — idempotent).
 * Còn hở (chấp nhận): ảnh RỖNG mới hơn để lại 0 dòng nên không còn chỗ mang mốc — chỉ khoá ngày che được ca "ảnh cũ có
 * dòng tới sau ảnh rỗng"; hiện mọi đường ghi bảng này đều qua khoá.
 */
export async function ghiAnhChupTinDungTiktok(
  tx: Prisma.TransactionClient,
  bcId: string,
  anh: { ngay: string; ngayLuc: Date; theoAdvertiser: TinDungAdvertiser[] },
  vatRate: number,
  mocNguon: Date,
): Promise<KetQuaGhiTinDung> {
  const ids = anh.theoAdvertiser.map((d) => d.advertiserId);
  const cuaBcMoiHon = await tx.tiktokAdsTinDung.count({
    where: { bcId, ngay: anh.ngayLuc, nguonFetchedAt: { gt: mocNguon } },
  });
  if (cuaBcMoiHon > 0) return { ghi: 0, cuHon: anh.theoAdvertiser.length };

  let ghi = 0;
  let cuHon = 0;
  for (const d of anh.theoAdvertiser) {
    const kq = await tx.$queryRaw<{ ghi: number }[]>`
      INSERT INTO "TiktokAdsTinDung" AS t (
        "id", "advertiserId", "ngay", "bcId", "grantExVat", "cashExVat", "amountExVat", "grantGomVat", "raw",
        "syncedAt", "nguonFetchedAt"
      ) VALUES (
        gen_random_uuid()::text, ${d.advertiserId}::text, ${sqlThoiDiem(anh.ngayLuc)}, ${bcId}::text,
        ${d.grantExVat}::int, ${d.cashExVat}::int, ${d.amountExVat}::int,
        ${tinhGrantGomVat(d.grantExVat, vatRate)}::int, ${sqlJson(d.nguon)}, ${sqlThoiDiem(new Date())},
        ${sqlThoiDiem(mocNguon)}
      )
      ON CONFLICT ("advertiserId", "ngay") DO UPDATE SET
        "bcId" = EXCLUDED."bcId", "grantExVat" = EXCLUDED."grantExVat", "cashExVat" = EXCLUDED."cashExVat",
        "amountExVat" = EXCLUDED."amountExVat", "grantGomVat" = EXCLUDED."grantGomVat", "raw" = EXCLUDED."raw",
        "nguonFetchedAt" = EXCLUDED."nguonFetchedAt"
      WHERE t."nguonFetchedAt" IS NULL OR t."nguonFetchedAt" <= EXCLUDED."nguonFetchedAt"
      RETURNING 1 AS ghi
    `;
    if (kq.length > 0) ghi++;
    else cuHon++;
  }
  // `notIn: []` (ảnh chụp rỗng) ⇒ xoá mọi dòng của BC này ngày này — đúng nghĩa "ngày này nay không còn gì". Điều kiện
  // mốc: không bao giờ gỡ dòng mà một ảnh MỚI HƠN đã ghi.
  await tx.tiktokAdsTinDung.deleteMany({
    where: {
      bcId,
      ngay: anh.ngayLuc,
      advertiserId: { notIn: ids },
      OR: [{ nguonFetchedAt: null }, { nguonFetchedAt: { lte: mocNguon } }],
    },
  });
  return { ghi, cuHon };
}
