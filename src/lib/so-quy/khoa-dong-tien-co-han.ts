import { Prisma } from "@/generated/prisma/client";
import { maSqlState, nguyenNhanAdapter } from "@/lib/prisma-loi-adapter";

/**
 * HẠN CHỜ KHOÁ cho các helper khoá dòng tiền (`khoaKhoanVay`/`khoaCacKhoanVay` ·
 * `khoaSoTietKiem`/`khoaCacSoTietKiem`) — chủ shop chốt 01/10: chờ tối đa 10 giây rồi báo bận, tính cho CẢ
 * LƯỢT thao tác (một transaction), không phải cho từng câu khoá.
 *
 * Vì sao cần: Postgres mặc định `lock_timeout = 0` (chờ mãi), còn `timeout` của `$transaction` Prisma 7
 * KHÔNG huỷ câu đang chạy (đo 01/10: tx hạn 1s chờ khoá mà lượt khác giữ 4s ⇒ treo 4,1s). Một transaction
 * kẹt giữ dòng `Loan`/`SoTietKiem` vì thế làm mọi lượt bấm sau xếp hàng, MỖI lượt giữ một kết nối ⇒ cạn
 * pool 10 ⇒ toàn app (kể cả trang không đụng tiền) ném "timeout exceeded when trying to connect".
 * Có hạn thì lượt chờ tự rút sau 10s: câu `FOR UPDATE` ném SQLSTATE 55P03, transaction lùi trọn (không ghi
 * dòng nào), kết nối về pool, người dùng nhận câu "đang bận, thử lại".
 *
 * NGÂN SÁCH CHUNG cho cả transaction: lần khoá ĐẦU TIÊN của một `tx` ghi mốc hạn (`bây giờ + hạn`); mọi câu
 * `FOR UPDATE` sau đó trong CÙNG transaction — kể cả của helper khác (`khoaCacKhoanVay` rồi
 * `khoaCacSoTietKiem`) — chỉ được chờ phần CÒN LẠI. Đặt hạn riêng từng câu thì khoá [A, B] với A nhả lúc 6s
 * còn B bị giữ ⇒ rút ra sau 16s (đo 01/10), trái lời hứa "tối đa 10 giây". Hết ngân sách trước một câu khoá
 * ⇒ ném luôn, không chạm DB.
 *
 * Phạm vi CỐ Ý HẸP: đặt bằng `set_config(…, is_local = true)` (= `SET LOCAL`) ngay TRƯỚC từng câu khoá, trong
 * CÙNG transaction, rồi TRẢ LẠI giá trị cũ ngay sau khi giành được khoá — các câu sau trong transaction
 * (và mọi transaction khác) giữ nguyên hành vi. KHÔNG đặt toàn cục (`options` của pool / ALTER ROLE): khoá
 * tư vấn land đơn/ads CỐ Ý chờ tới lượt, cắt ngang ở đó là mất lượt đồng bộ.
 *
 * Quan hệ với `timeout` của transaction: Prisma 7 hết hạn transaction KHÔNG huỷ câu khoá đang chờ, chỉ chặn
 * câu KẾ bằng P2028. Vì vậy `OPT_TX_DONG_TIEN.timeout` = hạn này + 10s: các câu chạy TRƯỚC/SAU khoá (đọc
 * dòng, CAS, ghi, hậu kiểm — qua Tailscale ở dev) không đua với hạn khoá ra P2028. Lỡ vẫn P2028 (DB chậm bất
 * thường) thì transaction CHƯA commit — `laLoiDongTienBan` gộp nó vào cùng câu "đang bận, thử lại".
 * Khoá bằng test (`tests/khoa-dong-tien-co-han.integration.test.ts`).
 */
export const HAN_CHO_KHOA_DONG_TIEN_MS = 10_000;

/**
 * Option `$transaction` DUY NHẤT cho mọi transaction chạm dòng tiền có khoá (khoản tiền khác, khoản vay,
 * thấu chi, sổ tiết kiệm, khôi phục thùng rác). `timeout` SUY TỪ hạn chờ khoá (+10s cho các câu ngoài khoá)
 * — sửa hạn khoá là timeout đi theo, không còn ba bản chép số trần lệch nhau. `maxWait` 5s: chờ lấy kết
 * nối để MỞ transaction (pool cạn ⇒ P2028 ⇒ cũng thành câu "đang bận").
 */
export const OPT_TX_DONG_TIEN = { timeout: HAN_CHO_KHOA_DONG_TIEN_MS + 10_000, maxWait: 5_000 } as const;

/** Câu người dùng nhận khi hết hạn chờ khoá — transaction đã lùi, chưa ghi gì, bấm lại là được. */
export const THONG_BAO_KHOA_DONG_TIEN_BAN = "Hệ thống đang bận xử lý khoản này, vui lòng thử lại";

/** SQLSTATE `lock_not_available` — Postgres ném khi chờ khoá quá `lock_timeout`. */
const SQLSTATE_HET_HAN_CHO_KHOA = "55P03";

/** Ném khi chờ khoá dòng tiền quá hạn. Action bắt và trả `message` (đã tiếng Việt) cho người dùng. */
export class LoiKhoaDongTienBan extends Error {
  constructor() {
    super(THONG_BAO_KHOA_DONG_TIEN_BAN);
    this.name = "LoiKhoaDongTienBan";
  }
}

/** Lỗi Prisma 7 có phải "chờ khoá quá `lock_timeout`" (55P03) — câu raw ⇒ P2010 mang nguyên nhân adapter. */
export function laHetHanChoKhoa(e: unknown): boolean {
  const n = nguyenNhanAdapter(e);
  return n !== undefined && maSqlState(n) === SQLSTATE_HET_HAN_CHO_KHOA;
}

/**
 * Lỗi nên báo người dùng bằng `THONG_BAO_KHOA_DONG_TIEN_BAN` — dùng ở MỌI hàm ánh xạ lỗi của đường khoá
 * dòng tiền: hết hạn chờ khoá (`LoiKhoaDongTienBan`) HOẶC P2028 (transaction quá `timeout` / không mở được
 * trong `maxWait`). P2028 nghĩa là Prisma từ chối câu kế / COMMIT vì transaction đã hết hạn ⇒ transaction
 * KHÔNG commit, lùi trọn — bấm lại là đúng cách xử lý, y như ca hết hạn khoá.
 */
export function laLoiDongTienBan(e: unknown): boolean {
  if (e instanceof LoiKhoaDongTienBan) return true;
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2028";
}

/**
 * Mốc hạn (epoch ms) của từng transaction, ghi ở lần khoá ĐẦU. Khoá theo chính đối tượng `tx` mà
 * `$transaction` truyền vào callback — mọi helper trong cùng callback nhận đúng đối tượng đó. WeakMap ⇒ tx
 * xong là mốc tự được thu gom; lượt thử lại (`laXungDotGhi`) mở transaction MỚI nên có ngân sách mới.
 */
const hanDenTheoTx = new WeakMap<object, number>();

/**
 * Chạy lần lượt các câu khoá (`SELECT … FOR UPDATE`, mỗi phần tử MỘT câu) trong ngân sách hạn chung của
 * transaction: trước MỖI câu đặt `lock_timeout` = thời gian còn lại tới mốc hạn. Hết ngân sách (trước một
 * câu, hoặc câu đang chờ quá phần còn lại) ⇒ ném `LoiKhoaDongTienBan`; caller để transaction lùi.
 *
 * `hanChoMs` chỉ để test rút ngắn thời gian chờ — code app luôn dùng mặc định. Nó chỉ có tác dụng ở lần
 * khoá ĐẦU của transaction (lần ghi mốc hạn); các lần sau dùng mốc đã ghi.
 */
export async function khoaDongTienCoHan(
  tx: Prisma.TransactionClient,
  cacCauKhoa: ReadonlyArray<() => Promise<unknown>>,
  hanChoMs: number = HAN_CHO_KHOA_DONG_TIEN_MS
): Promise<void> {
  if (!Number.isInteger(hanChoMs) || hanChoMs <= 0) {
    throw new Error(`Hạn chờ khoá dòng tiền phải là số nguyên dương (ms), nhận ${hanChoMs}`);
  }
  if (cacCauKhoa.length === 0) return;
  const hanDen = hanDenTheoTx.get(tx) ?? Date.now() + hanChoMs;
  hanDenTheoTx.set(tx, hanDen);
  const conLai = () => hanDen - Date.now();
  // Ngân sách đã cạn (vd lần khoá trước của cùng transaction ăn hết) ⇒ báo bận ngay, không tốn vòng DB.
  if (conLai() <= 0) throw new LoiKhoaDongTienBan();

  // Hai câu tách rời (không gộp một SELECT): thứ tự tính các cột trong một SELECT không phải hợp đồng của
  // Postgres — đọc giá trị cũ phải chắc chắn xảy ra TRƯỚC khi đặt.
  const [{ cu }] = await tx.$queryRaw<{ cu: string }[]>`SELECT current_setting('lock_timeout') AS cu`;
  try {
    for (const cauKhoa of cacCauKhoa) {
      const ms = conLai();
      if (ms <= 0) throw new LoiKhoaDongTienBan();
      // = `SET LOCAL lock_timeout = '<còn lại>ms'` (SET không nhận tham số bind ⇒ dùng set_config, is_local = true).
      await tx.$queryRaw`SELECT set_config('lock_timeout', ${`${ms}ms`}, true)`;
      await cauKhoa();
    }
  } catch (e) {
    if (laHetHanChoKhoa(e)) throw new LoiKhoaDongTienBan();
    throw e;
  }
  await tx.$queryRaw`SELECT set_config('lock_timeout', ${cu}, true)`;
}
