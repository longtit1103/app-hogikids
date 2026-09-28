import type { Prisma } from "@prisma/client";

/**
 * KHOÁ TƯ VẤN POSTGRES cho mọi lượt GHI chi tiêu quảng cáo vào sổ `Expense`.
 *
 * Hai đường ghi chạy độc lập nhau và đều theo kiểu ĐỌC-ẢNH-CHỤP-RỒI-GHI:
 *   - `/api/ingest/ads` (n8n đẩy mỗi đêm) — đọc `napSoChiTieuAds` rồi upsert từng dòng;
 *   - import file CSV/XLSX ở `/chi-phi` — đọc dòng đã có rồi `createMany`, chế độ ghi đè
 *     còn XOÁ dòng `ADS_API` của ngày đó trước.
 *
 * Không loại trừ nhau thì chi phí quảng cáo ĐẾM 2 LẦN theo hai kịch bản đã chỉ ra:
 *   - hai lượt import cùng file cùng đọc "chưa có gì" rồi cùng `createMany`;
 *   - import ghi đè commit SAU lúc lượt ingest chụp ảnh sổ nhưng TRƯỚC lúc nó tạo dòng
 *     `ADS_API` ⇒ cổng "ngày đã ghi đè bằng file" đọc phải ảnh cũ và cho ghi thêm.
 * Cả hai làm lãi ròng của ngày đó tụt mà không ai truy ra được vì sổ trông vẫn hợp lệ.
 *
 * `pg_advisory_xact_lock` tự nhả khi transaction kết thúc ⇒ không có đường quên trả khoá.
 * ẢNH CHỤP SỔ PHẢI ĐỌC TRONG CÙNG TRANSACTION — giữ khoá mà vẫn đọc ảnh từ ngoài thì
 * khoá chỉ chặn được lúc GHI, còn quyết định vẫn dựa trên dữ liệu cũ.
 */

/** Số khoá tuỳ chọn, chỉ cần DUY NHẤT trong app (khác `khoa-land-don.ts`). */
const KHOA_GHI_CHI_TIEU_ADS = 260_727_002;

/**
 * Giữ khoá ghi chi tiêu ads tới hết transaction `tx`. Gọi TRƯỚC khi đọc ảnh chụp sổ.
 *
 * Dùng `$executeRaw`, KHÔNG `$queryRaw`: `pg_advisory_xact_lock` trả kiểu `void`, mà `$queryRaw`
 * cố giải mã cột kết quả nên ném "Failed to deserialize column of type 'void'".
 */
export async function giuKhoaGhiChiTieuAds(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${KHOA_GHI_CHI_TIEU_ADS}::bigint)`;
}
