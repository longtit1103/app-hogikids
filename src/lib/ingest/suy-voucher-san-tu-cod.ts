/**
 * SUY KHOẢN SÀN TÀI TRỢ MÀ PANCAKE BỎ TRỐNG, dùng `cod` làm trọng tài.
 *
 * Bối cảnh: Pancake gộp mọi khuyến mãi vào `discount_each_product`, rồi khai riêng phần SÀN gánh ở
 * `advanced_platform_fee.marketplace_voucher` để bên đọc biết khoản nào shop không mất tiền. Có đơn
 * nó gộp nhưng QUÊN khai (đo prod 2026-08-05: 3/314 đơn) — app trừ luôn phần sàn gánh vào doanh thu
 * của shop, ghi thiếu 80.170 đ. Đây cùng một lỗi tiền mà PR #71 đã sửa, chỉ khác chỗ: lần đó Pancake
 * CÓ khai nên công thức bắt được, ba đơn này Pancake BỎ TRỐNG nên lọt lưới.
 *
 * Trọng tài: `cod` là tiền hàng ròng Pancake TỰ TÍNH, không đi qua công thức của app. Trên 314 đơn
 * hợp lệ, đẳng thức `itemsTotal = cod + fee_marketplace + total_discount` đúng 311 — ba ca lệch chính
 * là ba ca khai thiếu, và phần lệch khớp ĐÚNG TỪNG ĐỒNG `platform_discount_amount` mà TikTok Shop
 * API báo riêng (20.700 / 33.460 / 26.010). Nói cách khác nguyên nhân đã được xác định, không phải
 * "cứ lệch là bù".
 *
 * Vì "lệch" có thể đến từ nhiều nguyên nhân khác (phí sai, ship, dữ liệu dị), luật này CỐ TÌNH hẹp:
 * chỉ chạm đúng hình dạng đã chứng minh, còn lại chỉ cảnh báo để người thật nhìn.
 *
 * Bổ sung sau review đối kháng 2026-08-05: `cod` là tiền THU HỘ nên GỒM CẢ SHIP — đơn có ship thì
 * đẳng thức thiếu số hạng và phần lệch chính là tiền ship. Nay từ chối thẳng nhóm đơn đó (ĐK4).
 *
 * Bổ sung 2026-08-07: đẳng thức chỉ được chứng minh trên đơn ĐÃ GIAO XONG — ĐK0 là ALLOWLIST
 * `COMPLETED`, mọi trạng thái khác đứng ngoài. Hai nhóm ngoài vùng, hai kiểu hỏng khác nhau: đơn
 * HOÀN/HỦY có `fee_marketplace` tạm (số thật ở `returned_fee`) và `cod` ≈ tổng gộp nên lệch sinh ra
 * không phải khoản sàn gánh (đo prod 2026-08-06: 16 đơn bị suy oan một khoản đáng kể, thổi GMV/dải tổng
 * trang Đơn hàng); đơn ĐANG XỬ LÝ (PENDING/SHIPPING) có phí 0 vì sàn chưa đối soát nên cùng hình
 * dạng lệch — mà nhóm này NẰM TRONG doanh thu P&L, suy oan là thổi thẳng lãi. Đơn chưa xong chờ
 * giao xong re-sync là luật chạy, không mất gì.
 *
 * ⚠️ BÀI HỌC ĐẮT (đo prod 2026-08-07, lượt rebuild sau khi ship): từng thêm điều kiện "`total_discount`
 * âm ⇒ từ chối" vì ĐOÁN số âm là dữ liệu đảo khoản. Nó chặn đúng CẢ BA đơn mà luật này sinh ra để
 * cứu — doanh thu prod tụt đúng 80.170 đ ngay lượt dựng lại đầu tiên. Sự thật đọc từ payload: trên
 * đơn ĐÃ GIAO, `total_discount` âm CHÍNH LÀ cách Pancake ghi khoản SÀN gánh, trị tuyệt đối khớp
 * TỪNG ĐỒNG phần suy từ cod ở 3/3 đơn (−20.700 / −33.460 / −26.010), và đơn 583311185310680831 có
 * `cod + fee = 230.000 = total_price` — Pancake tự chốt tiền hàng KHÔNG trừ đồng giảm giá nào, tức
 * sàn gánh trọn. Hai đường độc lập (dấu âm của Pancake · trọng tài cod) cùng ra một số. Đừng thêm
 * cổng chặn dựa trên phỏng đoán về ý nghĩa một field — đọc payload thật trước.
 */
import type { OrderStatus } from "@prisma/client";

export type KetQuaSuyVoucherSan = {
  /** Khoản sàn tài trợ suy ra được, CỘNG thêm vào voucher sàn đã khai. 0 = không đụng gì. */
  boSung: number;
  /** Cảnh báo cho `MappedOrder.warnings` (đã bù, hoặc lệch bất thường cần người xem). */
  canhBao: string | null;
};

const KHONG_DUNG: KetQuaSuyVoucherSan = { boSung: 0, canhBao: null };

export function suyVoucherSanTuCod(input: {
  maDon: string;
  /** Trạng thái đã map — luật CHỈ chạy trên COMPLETED (vùng đã chứng minh); còn lại không suy không báo. */
  status: OrderStatus;
  /** `total_price` — giá niêm yết trước giảm giá dòng. */
  grossTotal: number;
  /** Σ quantity × discount_each_product (đã clamp ≥ 0). */
  sumEachDiscount: number;
  /** Voucher sàn Pancake ĐÃ khai (sau khi kẹp). */
  voucherSanDaKhai: number;
  /** `cod` — tiền hàng ròng Pancake tự chốt. `null`/0 ⇒ không có trọng tài, bỏ qua. */
  cod: number | null;
  /** `fee_marketplace` — phí sàn THẬT (chỉ có nghĩa ở kênh dùng phí thật). */
  feeMarketplace: number;
  /**
   * `total_discount` ĐÃ KẸP ≥ 0 — voucher mức đơn (shop chịu), Pancake trừ khỏi cod.
   *
   * Vì sao kẹp chứ không từ chối số âm: trên đơn ĐÃ GIAO, `total_discount` âm chính là cách Pancake
   * ghi khoản SÀN gánh — không phải dữ liệu dị (đo prod 2026-08-07, 3/3 đơn: trị tuyệt đối khớp
   * TỪNG ĐỒNG phần suy ra từ cod; đơn 583311185310680831 có cod + phí = đúng `total_price`, tức
   * Pancake tự chốt tiền hàng không trừ đồng giảm giá nào). Số âm đó KHÔNG phải khoản shop trừ nên
   * không được vào vế mốc; kẹp về 0 rồi để cod làm trọng tài cho ra đúng số ở cả ba đơn.
   */
  discountMucDon: number;
  /**
   * `shipping_fee` + `advanced_platform_fee.diff_shipping_fee`. `cod` là tiền THU HỘ nên GỒM CẢ
   * TIỀN SHIP (`tests/fixtures/pancake/ghi-chu-shape-thuc-te.md`) — đơn có ship thì đẳng thức thiếu
   * hẳn một số hạng, lệch sinh ra là tiền ship chứ không phải sàn tài trợ.
   */
  tienShip: number;
  /** Kênh có phí sàn thật (Shopee/TikTok). Kênh ước tính % thì `cod` không so được. */
  dungPhiThat: boolean;
}): KetQuaSuyVoucherSan {
  const { maDon, grossTotal, sumEachDiscount, voucherSanDaKhai, cod, feeMarketplace, discountMucDon } = input;

  // ĐK0: ALLOWLIST — chỉ đơn ĐÃ GIAO XONG. Chặn kiểu liệt kê trạng thái xấu là vẽ ranh giới sai
  // phía: đơn PENDING/SHIPPING mang cùng hình dạng dữ liệu (cod > 0 nhưng phí 0 vì sàn CHƯA đối
  // soát) sẽ bị suy oan, mà nhóm đó NẰM TRONG doanh thu P&L — nặng hơn cả ca đơn hoàn. Tập chứng
  // minh 314 đơn gần như toàn đơn hoàn tất (đơn đang giao 0/5 có chi tiết phí). Đơn chưa xong
  // không mất gì: giao xong re-sync là luật chạy. Im lặng, không cảnh báo — lệch trên đơn chưa
  // chốt là chuyện thường, báo mỗi lượt sync chỉ thành nhiễu.
  if (input.status !== "COMPLETED") return KHONG_DUNG;
  // ĐK1: chỉ kênh có phí sàn thật — kênh khác `platformFeeEst` là ước tính %, đẳng thức không đứng.
  if (!input.dungPhiThat) return KHONG_DUNG;
  // ĐK2: phải có trọng tài. cod vắng/0 (đơn chưa chốt tiền) ⇒ không có gì để đối chiếu.
  if (cod == null || cod <= 0) return KHONG_DUNG;
  // ĐK3: Pancake ĐÃ khai thì tin số nó khai — không suy diễn đè lên dữ liệu có thật.
  if (voucherSanDaKhai > 0) return KHONG_DUNG;
  // ĐK4: đơn có tiền ship thì `cod` gồm cả ship ⇒ đẳng thức thiếu số hạng, phần lệch KHÔNG suy ra
  // được là sàn tài trợ. Đo prod 2026-08-05: đơn 260618D33GY0R4 lệch đúng `shipping_fee` 42.500 đ,
  // đơn 260516HYR5495D lệch đúng `diff_shipping_fee` 8.000 đ — hai ca đó thoát NHỜ MAY (Σ giảm giá
  // dòng = 0), không phải nhờ thiết kế. Từ chối tuyệt đối thay vì cộng/trừ ship vào đẳng thức: chưa
  // đo được ship vào cod ở mọi hình thái đơn, mà đây là đường DUY NHẤT tự cộng thêm doanh thu.
  if (input.tienShip !== 0) {
    return {
      boSung: 0,
      canhBao:
        `Đơn ${maDon}: có tiền ship (${input.tienShip} đ) nên cod không so được với tiền hàng ` +
        `⇒ KHÔNG suy khoản sàn tài trợ. Nếu Pancake khai thiếu thật thì phải sửa tay.`,
    };
  }

  const itemsTotalHienTai = grossTotal - (sumEachDiscount - voucherSanDaKhai);
  const mocPancake = cod + feeMarketplace + discountMucDon;
  // DƯƠNG = app ghi THIẾU so với mốc Pancake tự chốt (đúng chiều của ca sàn tài trợ chưa khai:
  // app trừ nhầm phần sàn gánh nên tiền hàng nhỏ đi). ÂM = ghi THỪA, chuyện khác hẳn.
  const thieu = mocPancake - itemsTotalHienTai;
  if (thieu === 0) return KHONG_DUNG;

  // Ghi THỪA: chưa gặp ca nào (0/314 đơn) và không có giả thuyết nào giải thích, nên tuyệt đối
  // không tự sửa — chỉ báo để người thật soi.
  if (thieu < 0) {
    return {
      boSung: 0,
      canhBao:
        `Đơn ${maDon}: tiền hàng app (${itemsTotalHienTai}) CAO hơn cod+phí+voucher (${mocPancake}) ` +
        `${-thieu} đ — bất thường chưa có lời giải, KHÔNG tự sửa, kiểm tra dữ liệu Pancake`,
    };
  }

  // ĐK5: khoản sàn gánh phải nằm TRONG giảm giá dòng — không thể lớn hơn tổng đã giảm. Vượt nghĩa là
  // lệch đến từ chỗ khác (phí, ship, dữ liệu dị) chứ không phải sàn tài trợ ⇒ không sửa, chỉ báo.
  if (voucherSanDaKhai + thieu > sumEachDiscount) {
    return {
      boSung: 0,
      canhBao:
        `Đơn ${maDon}: lệch ${thieu} đ so với cod nhưng vượt Σ giảm giá dòng (${sumEachDiscount}) ` +
        `⇒ KHÔNG phải sàn tài trợ chưa khai, KHÔNG tự sửa — kiểm tra phí sàn/vận chuyển của đơn`,
    };
  }

  return {
    boSung: thieu,
    canhBao:
      `Đơn ${maDon}: Pancake bỏ trống marketplace_voucher nhưng cod cho thấy sàn tài trợ ${thieu} đ ` +
      `⇒ đã cộng lại vào doanh thu (không tính là shop giảm giá)`,
  };
}
