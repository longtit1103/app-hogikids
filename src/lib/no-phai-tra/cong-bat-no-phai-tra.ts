import { format } from "date-fns";

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { khoaDongTienCoHan } from "@/lib/so-quy/khoa-dong-tien-co-han";

/**
 * CỔNG BẬT "Nợ phải trả" (tiền hàng NCC + thẻ tín dụng + ví ads trả trước) — spec §2, §5.4.
 *
 * Mốc M = `Setting.noPhaiTraTuNgay` (`yyyy-MM-dd`, giờ VN), CHỈ được ghi bởi bước xác nhận bật (câu
 * CUỐI của transaction đó). Chưa có dòng ⇒ TẮT: công thức Sổ quỹ y như cũ, và MỌI đường ghi tiền mới
 * (`CARD_PAY`, `SUPPLIER_*`, `CUTOVER_*`, `ADS_TOPUP`, `Expense.cardId`, `KySaoKeThe`) phải gọi
 * `daBatNoPhaiTra()` ở đầu và bị từ chối. Hồ sơ không mang tiền (thẻ, gắn nền tảng, phiếu nợ) thì không.
 *
 * Không có dòng, hoặc giá trị rỗng / toàn khoảng trắng ⇒ TẮT (spec §2 "Rỗng = tắt": xoá trắng ô cấu
 * hình là cách tự nhiên để tắt). Giá trị CÓ CHỮ mà HỎNG (sai định dạng, ngày không có thật) thì NÉM chứ
 * không hiểu là "tắt": ai đó đã định bật mà gõ sai — im lặng tắt là quỹ quay về cách tính cũ giữa chừng
 * mà không ai biết, nổ to dễ sửa hơn số sai lặng lẽ.
 */

export const KEY_NO_PHAI_TRA_TU_NGAY = "noPhaiTraTuNgay";

/**
 * Tên khoá tư vấn (transaction-level) của BƯỚC BẬT — MỘT hằng dùng chung, hai chuỗi `hashtext` lệch nhau
 * là hai khoá khác nhau, không loại trừ gì. Bước xác nhận bật lấy EXCLUSIVE; các action hồ sơ mà kết quả
 * phụ thuộc "đã bật chưa" (`taoThe`: có neo hay không; `ganNenTang`: được gắn lùi ngày hay không) lấy SHARED.
 */
export const KHOA_BAT_NO_PHAI_TRA = "bat-no-phai-tra";

/** Client đọc được bảng `Setting` — prisma gốc hoặc `tx` của transaction đang chạy. */
type DbDocSetting = Pick<Prisma.TransactionClient, "setting">;

export class LoiChuaBat extends Error {
  readonly code = "CHUA_BAT_NO_PHAI_TRA" as const;

  constructor() {
    super("Chưa bật theo dõi nợ phải trả — vào bước xác nhận bật trước khi ghi khoản này.");
    this.name = "LoiChuaBat";
  }
}

const DINH_DANG_NGAY = /^\d{4}-\d{2}-\d{2}$/;

/** `yyyy-MM-dd` ⇒ 00:00 giờ VN; ném khi sai định dạng hoặc ngày không có thật (vd 2026-02-30). */
function docNgayVn(value: string): Date {
  const moc = DINH_DANG_NGAY.test(value) ? new Date(`${value}T00:00:00+07:00`) : new Date(Number.NaN);
  // So ngược lại theo giờ VN (process TZ neo Asia/Ho_Chi_Minh): `new Date("2026-02-30…")` không NaN mà
  // trượt sang 02/03 — chỉ phép so khứ hồi mới bắt được.
  if (Number.isNaN(moc.getTime()) || format(moc, "yyyy-MM-dd") !== value) {
    throw new Error(`Setting ${KEY_NO_PHAI_TRA_TU_NGAY} hỏng: ${JSON.stringify(value)} — cần dạng yyyy-MM-dd`);
  }
  return moc;
}

/** Mốc M (00:00 giờ VN) hoặc `null` khi chưa bật (không có dòng / giá trị rỗng hoặc toàn khoảng trắng). */
export async function docMocM(db: DbDocSetting = prisma): Promise<Date | null> {
  const row = await db.setting.findUnique({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY }, select: { value: true } });
  if (row === null || row.value.trim() === "") return null;
  return docNgayVn(row.value);
}

/** Cổng đầu mỗi action tiền mới: trả M, hoặc ném `LoiChuaBat` khi chưa bật. */
export async function daBatNoPhaiTra(db: DbDocSetting = prisma): Promise<Date> {
  const m = await docMocM(db);
  if (m === null) throw new LoiChuaBat();
  return m;
}

/**
 * Khoá SHARED với bước bật — gọi ĐẦU TIÊN trong transaction, VÔ ĐIỀU KIỆN, TRƯỚC `docMocM(tx)`. Ca đua cần
 * chặn: action đọc M = null trong lúc bước bật đang chạy (chưa commit) ⇒ tạo thẻ KHÔNG neo, bước bật lại
 * không thấy thẻ đó ⇒ sau khi bật thẻ không có điểm xuất phát dư nợ. Có khoá thì action chờ bước bật commit
 * rồi mới đọc M (ReadCommitted ⇒ câu đọc sau khi giành khoá thấy giá trị mới). Các lượt SHARED không chặn nhau.
 * Chờ CÓ HẠN trong ngân sách chung của transaction (`khoaDongTienCoHan`) — quá hạn ⇒ `LoiKhoaDongTienBan`.
 * `$executeRaw`: `pg_advisory_xact_lock_shared` trả `void`, `$queryRaw` không giải mã được kiểu đó.
 */
export async function khoaChiaSeBatNoPhaiTra(tx: Prisma.TransactionClient): Promise<void> {
  await khoaDongTienCoHan(tx, [
    () => tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${KHOA_BAT_NO_PHAI_TRA}::text))`,
  ]);
}

/**
 * Khoá EXCLUSIVE của BƯỚC BẬT — câu ĐẦU transaction xác nhận bật. Loại trừ mọi lượt SHARED (`taoThe`,
 * `ganNenTang`, hồ sơ ví) và lượt bật thứ hai (hai tab cùng bấm ⇒ lượt sau chờ, rồi đọc thấy M đã có).
 * Khoá tư vấn cấp transaction là REENTRANT trong cùng phiên: gọi lại trong cùng tx không tự chặn mình.
 */
export async function khoaDocQuyenBatNoPhaiTra(tx: Prisma.TransactionClient): Promise<void> {
  await khoaDongTienCoHan(tx, [
    () => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${KHOA_BAT_NO_PHAI_TRA}::text))`,
  ]);
}
