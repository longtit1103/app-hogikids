import type { Prisma } from "@prisma/client";

/**
 * KHOÁ TƯ VẤN POSTGRES cho bước LAND ĐƠN HÀNG vào Bronze.
 *
 * Vì sao cần: guard thứ tự của webhook (`laSuKienCuHon`) là ĐỌC-RỒI-GHI trên hai câu
 * lệnh tách rời — đọc bản Bronze mới nhất, quyết định, rồi mới `landRaw`. Hai sự kiện
 * của CÙNG một đơn chạy song song (n8n bắn cách nhau vài trăm ms) có thể cùng đọc
 * TRƯỚC khi bên nào kịp ghi: bản MỚI land trước, bản CŨ land sau và THẮNG vì transform
 * luôn chọn `fetchedAt` mới nhất. Hậu quả đã đo 27/07: phí sàn thật tụt về số tạm, đơn
 * RETURNED lùi về PENDING rồi được tính lại vào doanh thu (phá bất biến #1) — và KHÔNG
 * tự lành, vì lượt API kế tiếp trùng hash nên không land lại, `rebuild-from-raw` cũng
 * chọn đúng bản cũ đó.
 *
 * `pg_advisory_xact_lock` tự nhả khi transaction kết thúc (kể cả khi lỗi/rollback) nên
 * không có đường nào để quên trả khoá.
 *
 * MỘT KHOÁ CHUNG cho mọi đơn, KHÔNG khoá theo từng `externalId`: đường API
 * (`/api/ingest/raw`) land CẢ TRANG bằng một câu INSERT, không có khoá per-đơn nào khớp
 * được với nó. Muốn guard của webhook thật sự đúng thì webhook và API phải loại trừ nhau
 * — mà cả hai chỉ giữ khoá trong vài mili-giây (một truy vấn đọc + một INSERT), nên xếp
 * hàng chung không gây nghẽn: n8n đẩy tuần tự từng trang, webhook thì mỗi lần một đơn.
 */

/** Số khoá tuỳ chọn, chỉ cần DUY NHẤT trong app. Đổi số = mất tác dụng loại trừ. */
const KHOA_LAND_DON = 260_727_001;

/**
 * Giữ khoá land đơn tới hết transaction `tx`. Gọi TRƯỚC mọi truy vấn đọc-để-quyết-định.
 *
 * Dùng `$executeRaw`, KHÔNG `$queryRaw`: `pg_advisory_xact_lock` trả kiểu `void`, mà `$queryRaw`
 * cố giải mã cột kết quả nên ném "Failed to deserialize column of type 'void'".
 */
export async function giuKhoaLandDon(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${KHOA_LAND_DON}::bigint)`;
}
