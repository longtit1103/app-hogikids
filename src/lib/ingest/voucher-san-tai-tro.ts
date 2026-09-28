/**
 * VOUCHER DO SÀN TÀI TRỢ (`advanced_platform_fee.marketplace_voucher`).
 *
 * Pancake gộp mọi khuyến mãi vào `discount_each_product` của từng dòng (là giảm giá MỖI ĐƠN VỊ, nên
 * giảm giá của dòng = `quantity × discount_each_product`), nhưng một phần trong đó là mã giảm giá SÀN
 * trả thay khách — shop KHÔNG mất tiền, nên KHÔNG được trừ khỏi doanh thu.
 *
 * Bằng chứng (đo trên 471 đơn thật, 2026-08-03): TikTok tính hoa hồng / phí thanh toán / thuế trên
 * giá TRƯỚC khi trừ khoản này, và tiền thực về `cod` = (giá đó − `fee_marketplace`). Ví dụ đơn 580:
 * giá gốc 230.000, giảm giá dòng 40.800 (trong đó 30.800 là sàn tài trợ) → hoa hồng 33.000 = 15% ×
 * 220.000, phí thanh toán 13.200 = 6% × 220.000, và `cod` 153.245 = 220.000 − 66.755. 436/471 đơn
 * khớp công thức này; 0 đơn khớp cách tính cũ (trừ cả voucher sàn).
 *
 * `marketplace_voucher` là số mức ĐƠN, còn doanh thu phải khớp tới từng DÒNG (tab Sản phẩm cộng
 * `unitPrice × quantity − lineDiscount` và phải ra đúng `Order.itemsTotal` — xem
 * `tests/reports-revenue-parity.test.ts`). Vì vậy phải phân bổ nó về các dòng.
 */

/** Kẹp voucher sàn vào [0, Σ giảm giá dòng] — có đơn Pancake ghi voucher LỚN HƠN tổng giảm giá dòng. */
export function voucherSanApDung(voucherSanTho: number, tongGiamGiaDong: number): number {
  return Math.min(Math.max(0, voucherSanTho), Math.max(0, tongGiamGiaDong));
}

/**
 * Chia `voucherSan` về từng dòng theo TỈ LỆ giảm giá của dòng đó (phương pháp phần dư lớn nhất).
 *
 * Bảo đảm: kết quả toàn số nguyên, `Σ kết quả === voucherSan` CHÍNH XÁC (không lệch do làm tròn),
 * và mỗi dòng không bao giờ nhận nhiều hơn phần giảm giá của chính nó. Nhờ vậy phần giảm giá SHOP
 * chịu (`giamGiaDong[i] − kết quả[i]`) luôn ≥ 0 và tổng của chúng khớp `itemsTotal`.
 *
 * `voucherSan` phải đã qua `voucherSanApDung` (≤ Σ giamGiaDong).
 */
export function phanBoVoucherSanTheoDong(giamGiaDongVao: number[], voucherSan: number): number[] {
  // Kẹp ≥ 0 NGAY TẠI ĐÂY: dòng âm sẽ làm tổng nhỏ hơn thật ⇒ dòng khác nhận vượt phần của nó ⇒
  // lineDiscount âm ⇒ doanh thu dòng bị thổi lên. Caller cũng kẹp, nhưng cam kết phải đứng độc lập.
  const giamGiaDong = giamGiaDongVao.map((d) => Math.max(0, d));
  const tong = giamGiaDong.reduce((s, v) => s + v, 0);
  const apDung = voucherSanApDung(voucherSan, tong);
  if (apDung === 0 || tong === 0) return giamGiaDong.map(() => 0);

  const chinhXac = giamGiaDong.map((d) => (d * apDung) / tong);
  const phanBo = chinhXac.map((x) => Math.floor(x));
  let con = apDung - phanBo.reduce((s, v) => s + v, 0);

  // Phần dư (do làm tròn xuống) rải cho dòng có phần lẻ lớn nhất; hoà thì ưu tiên dòng đầu để kết
  // quả TẤT ĐỊNH (cùng input luôn cho cùng output — rebuild-from-raw phải dựng lại y hệt).
  const thuTu = chinhXac
    .map((x, i) => ({ i, le: x - Math.floor(x) }))
    .sort((a, b) => b.le - a.le || a.i - b.i);

  // Vòng lặp có chặn trên: mỗi lượt rải ít nhất 1 đồng khi còn chỗ trống, mà `con` < số dòng.
  for (let vong = 0; con > 0 && vong <= giamGiaDong.length; vong++) {
    for (const { i } of thuTu) {
      if (con === 0) break;
      if (phanBo[i] < giamGiaDong[i]) {
        phanBo[i] += 1;
        con -= 1;
      }
    }
  }
  return phanBo;
}
