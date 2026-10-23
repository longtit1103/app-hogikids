/**
 * Lớp khoá PHỤ theo IP thật của client — chặn một nguồn rải lượt đoán qua NHIỀU email (khoá theo email
 * ở `login-lockout.ts` không thấy được kiểu này: mỗi email mới là một bộ đếm mới). Khoá theo email vẫn
 * là chốt chính, giữ nguyên.
 *
 * IP lấy từ header `cf-connecting-ip` do Cloudflare gắn (Cloudflare GHI ĐÈ header này, client không tự
 * đặt được qua Tunnel). THIẾU header ⇒ KHÔNG đếm theo IP: lúc đó thứ duy nhất có là địa chỉ socket,
 * mà sau Tunnel mọi request đều tới từ CÙNG MỘT IP (cloudflared) — đếm theo nó là một kẻ gõ sai khoá
 * cả shop. Dev local / test cũng không có header nên lớp này tự tắt.
 *
 * Ngưỡng RỘNG hơn email (20 lượt sai / khoá 5 phút) vì cả shop có thể chung một IP công cộng (NAT Wi-Fi
 * cửa hàng): vài người gõ nhầm không được chạm ngưỡng. Bộ đếm quên sau 5 phút im lặng (cửa sổ trượt),
 * và KHÔNG xoá khi đăng nhập đúng — xoá được thì kẻ có một tài khoản thật chỉ cần đăng nhập đúng xen
 * kẽ là rải lượt đoán vô hạn.
 *
 * Giới hạn đã biết: lượt kiểm IP nằm trong cổng nối tiếp THEO EMAIL, nên các lượt CÙNG IP nhưng KHÁC
 * email chạy song song có thể vượt ngưỡng đúng bằng số lượt đang bay (mỗi lượt vẫn trả đủ chi phí
 * scrypt). Lớp này nhằm chặn rải lượt KÉO DÀI và giới hạn số dòng nhật ký, không phải chốt tuyệt đối.
 */

import { taoBoDemKhoaTam } from "@/lib/auth/bo-dem-khoa-tam";

/** Số lượt sai liên tiếp từ một IP thì khoá IP đó. */
export const SO_LAN_SAI_TOI_DA_THEO_IP = 20;
/** Thời gian khoá một IP; cũng là cửa sổ im lặng để bộ đếm của IP đó về 0. */
export const THOI_GIAN_KHOA_IP_MS = 5 * 60_000;
/** Trần số IP theo dõi cùng lúc — export cho test kiểm dọn/trần, không phải để chỉnh runtime. */
export const TRAN_SO_IP_THEO_DOI = 1000;

const boDemTheoIp = taoBoDemKhoaTam({
  soLanSaiToiDa: SO_LAN_SAI_TOI_DA_THEO_IP,
  thoiGianKhoaMs: THOI_GIAN_KHOA_IP_MS,
  tranSoKhoa: TRAN_SO_IP_THEO_DOI,
  quetSauSoLanGhi: 100,
  quenKhiImLang: true,
});

/** Trần độ dài IP dạng chữ (IPv6 kèm IPv4 nhúng tối đa 45 ký tự). */
const DO_DAI_IP_TOI_DA = 45;
const KY_TU_IP = /^[0-9a-f:.]+$/;

/**
 * Đọc IP client từ `cf-connecting-ip`. Thiếu, rỗng hay không giống IP ⇒ `null` (KHÔNG đếm theo IP).
 * Chữ thường hoá để cùng một IPv6 viết hoa/thường không thành hai bộ đếm.
 */
export function docIpCloudflare(h: { get(name: string): string | null }): string | null {
  const tho = h.get("cf-connecting-ip");
  if (!tho) return null;
  const ip = tho.trim().toLowerCase();
  if (ip.length === 0 || ip.length > DO_DAI_IP_TOI_DA || !KY_TU_IP.test(ip)) return null;
  return ip;
}

/** Số giây IP còn bị khoá, 0 khi không khoá. */
export function giayConKhoaTheoIp(ip: string, now: number = Date.now()): number {
  return boDemTheoIp.giayConKhoa(ip, now);
}

/** Ghi một lượt sai cho IP. */
export function ghiLuotSaiTheoIp(ip: string, now: number = Date.now()): void {
  boDemTheoIp.ghiLuotSai(ip, now);
}

/** Xoá bộ đếm của một IP — CHỈ cho test dọn trạng thái; mã chạy thật không gọi (xem đầu file). */
export function xoaBoDemTheoIp(ip: string): void {
  boDemTheoIp.xoa(ip);
}
