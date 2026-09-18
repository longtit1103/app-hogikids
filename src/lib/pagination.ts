import { redirect } from "next/navigation";

/** Trần số trang: 1.000.000 trang × 20 dòng = 20 triệu dòng — xa hơn mọi bảng thật của shop. */
const TRANG_TOI_DA = 1_000_000;

/**
 * Đọc `?trang=` thành số trang dùng được cho `skip`/`OFFSET`.
 *
 * Kẹp CẢ HAI cận. Cận trên là thứ hay bị bỏ: `Number.parseInt` trên chuỗi toàn chữ số dài (~16 ký
 * tự trở lên) trả về số vượt tầm số nguyên an toàn của JS, nhân với 20 dòng/trang là một `OFFSET`
 * mà Prisma/Postgres từ chối ⇒ trang lỗi 500. Kẹp về trần thì `veTrangCuoiNeuVuot` bên dưới đưa
 * người dùng về trang cuối như mọi ca vượt trang khác.
 *
 * Rác không parse được (`abc`, `1e999`, `Infinity`, số âm, `0`) → trang 1.
 */
export function docSoTrang(giaTri: string | undefined | null): number {
  const n = Number.parseInt(giaTri ?? "", 10);
  if (Number.isNaN(n) || n < 1) return 1;
  return Math.min(n, TRANG_TOI_DA);
}

/**
 * Đưa người dùng về TRANG CUỐI khi `?trang=` vượt quá số trang thật.
 *
 * Vì sao cần: các trang danh sách chỉ kẹp cận DƯỚI (`Math.max(1, …)`). Gõ `?trang=999` — hoặc
 * đang ở trang 5 rồi lọc lại còn 2 trang — cho ra `OFFSET` vượt cuối bảng: danh sách rỗng, mà
 * thanh phân trang cũng tính theo trang hiện tại nên biến mất luôn ⇒ ngõ cụt, không có đường bấm
 * quay lại. Chuyển hướng (thay vì lặng lẽ hiển thị trang cuối) còn sửa luôn URL cho khớp thứ đang
 * xem, nên bấm F5 hay chia sẻ link đều ra đúng chỗ.
 *
 * ⚠️ `redirect()` của Next hoạt động bằng cách NÉM lỗi điều khiển — TUYỆT ĐỐI không gọi hàm này
 * bên trong `try/catch` nuốt lỗi, và chỉ gọi SAU khi đã có `total`.
 */
export type ThamSoTrang = {
  /** Đường dẫn trang, vd "/don-hang". */
  duongDan: string;
  /** Toàn bộ searchParams đang có — giữ nguyên bộ lọc khi chuyển hướng. */
  sp: Record<string, string | undefined>;
  /** Trang đang yêu cầu (đã kẹp cận dưới ≥ 1). */
  trang: number;
  /** Tổng số dòng khớp BỘ LỌC (không phải số dòng của trang). */
  tong: number;
  soDongMoiTrang: number;
  /** Tên tham số querystring giữ số trang — mặc định "trang". Cho phép NHIỀU bảng cùng route dùng
   *  tham số trang RIÊNG (vd `/marketing?tab=noi-dung` tách `trangvideo`/`tranglive` — hai bảng Video/
   *  Phiên live dài khác hẳn nhau, dùng chung `?trang=` khiến "trang sau" của bảng này đẩy bảng kia
   *  sang trang rỗng rồi tự mâu thuẫn với dòng đếm của chính nó). */
  thamSo?: string;
};

/**
 * URL cần chuyển tới, hoặc `null` khi trang đang xem vẫn hợp lệ.
 *
 * Tách THUẦN khỏi `veTrangCuoiNeuVuot` để test được phép dựng URL (giữ bộ lọc, bỏ `?trang=1` thừa)
 * mà không phải mock `next/navigation`.
 */
export function urlTrangCuoiNeuVuot(args: ThamSoTrang): string | null {
  const { duongDan, sp, trang, tong, soDongMoiTrang, thamSo = "trang" } = args;
  const trangCuoi = Math.max(1, Math.ceil(tong / soDongMoiTrang));
  if (trang <= trangCuoi) return null;

  const params = new URLSearchParams();
  for (const [khoa, giaTri] of Object.entries(sp)) {
    if (khoa !== thamSo && giaTri !== undefined && giaTri !== "") params.set(khoa, giaTri);
  }
  // Trang 1 là mặc định ⇒ để URL sạch, không gắn `?<thamSo>=1`.
  if (trangCuoi > 1) params.set(thamSo, String(trangCuoi));
  const qs = params.toString();
  return qs ? `${duongDan}?${qs}` : duongDan;
}

export function veTrangCuoiNeuVuot(args: ThamSoTrang): void {
  const url = urlTrangCuoiNeuVuot(args);
  if (url) redirect(url);
}
