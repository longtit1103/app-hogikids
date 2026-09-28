/**
 * Mốc "lượt vá tồn kho từ API" gần nhất — để chủ shop KIỂM ĐƯỢC chứ không phải tin suông.
 *
 * VÌ SAO CẦN: từ khi webhook được ghi thẳng `Variant.stock`, thứ giữ cho tồn không lệch lâu dài là
 * lượt vá đêm (`POST /api/ingest/resync-products`). Nếu lượt đó ngừng chạy — mất cron n8n, workflow
 * bị sửa nhầm, app không nhận request — thì tồn vẫn hiển thị bình thường và KHÔNG CÓ GÌ ĐỎ LÊN:
 * mọi tín hiệu hỏng khác đều nằm trong log n8n mà chủ shop không mở. Bài học đúng như token Meta
 * (xem `tokens/token-expiry.ts`): cảnh báo nằm ngoài app coi như không tồn tại.
 */

/** Key trong bảng `Setting`. Route ghi, màn Cài đặt đọc — một nguồn tên, không viết chuỗi 2 nơi. */
export const KEY_MOC_VA_TON_KHO = "lastStockResyncAt";

/**
 * Quá ngần này giờ mà chưa vá lại là BẤT THƯỜNG. Lượt vá chạy 1 lần/đêm (03:00) ⇒ 26 giờ = 1 ngày
 * + biên 2 giờ, đủ để một đêm chạy trễ không kêu oan nhưng bỏ hẳn một đêm thì kêu.
 */
export const GIO_COI_LA_TRE = 26;

export type MucVaTonKho = "ok" | "tre" | "chua-co";

export type TinhTrangVaTonKho = {
  mocLuc: Date | null;
  gioTruoc: number | null;
  muc: MucVaTonKho;
};

/**
 * Đọc mốc từ giá trị thô trong `Setting`. Giá trị rác/thiếu → `chua-co` (KHÔNG đoán là "ổn": mốc
 * không đọc được cũng là một cách hỏng, và im lặng ở đây thì không còn ai canh lượt vá).
 */
export function tinhTrangVaTonKho(value: string | null | undefined, bayGio = new Date()): TinhTrangVaTonKho {
  if (!value) return { mocLuc: null, gioTruoc: null, muc: "chua-co" };
  const moc = new Date(value);
  if (Number.isNaN(moc.getTime())) return { mocLuc: null, gioTruoc: null, muc: "chua-co" };
  const gioTruoc = (bayGio.getTime() - moc.getTime()) / 3_600_000;
  return { mocLuc: moc, gioTruoc, muc: gioTruoc > GIO_COI_LA_TRE ? "tre" : "ok" };
}
