/**
 * Công thức Sổ quỹ — THUẦN, không Prisma. Quỹ = tiền THẬT: ghi tay + TikTok về bank −
 * Shopee rút ví (có dấu) − Sổ chi phí + cộng lại ads TikTok sàn đã trừ từ ví (có dấu, lưu âm) + thu
 * nhập tài chính + tiền khách trả tại shop cho đơn bán trực tiếp.
 * KHÔNG dùng số thu DỰ KIẾN theo đơn đã giao, cũng KHÔNG dùng net sàn chốt còn nằm trong ví — cộng
 * chúng cùng tiền đã về là đếm 2 lần (lưới tests/unit/so-quy/khong-dung-tien-du-kien.test.ts).
 */
export type TongNguon = {
  /** Σ CashMovement chiều VÀO (dương). */
  ghiTayVao: number;
  /** Σ CashMovement chiều RA (dương). */
  ghiTayRa: number;
  /** Σ TiktokPayment.settlementValue trạng thái PAID (dương). */
  tiktokVeBank: number;
  /** Σ ShopeeSettlement.amount type=WITHDRAWAL, CÓ DẤU (rút = âm). */
  shopeeRutViCoDau: number;
  /** Σ Expense.amount MỌI danh mục, MỌI nguồn (dương) — gồm cả Nhập hàng. */
  chiPhi: number;
  /** Σ TiktokAdsSettlement.settlementAmount, CÓ DẤU (sàn trừ ví ⇒ lưu ÂM). */
  adsTiktokViCoDau: number;
  /** Σ ThuNhap.amount (dương) — thu nhập ngoài bán hàng đã NHẬN, hiện chỉ có lãi sổ tiết kiệm. */
  thuNhap: number;
  /**
   * Σ `Order.paidAtShop` đơn bán trực tiếp COMPLETED (dương) — khách trả NGAY tại shop nên là tiền
   * THẬT, không phải tiền dự kiến như đơn sàn. Đơn đã vào đây thì KHÔNG ghi tay `DIRECT_SALE`.
   */
  banTrucTiep: number;
};

export const TONG_RONG: TongNguon = {
  ghiTayVao: 0,
  ghiTayRa: 0,
  tiktokVeBank: 0,
  shopeeRutViCoDau: 0,
  chiPhi: 0,
  adsTiktokViCoDau: 0,
  thuNhap: 0,
  banTrucTiep: 0,
};

/**
 * Đóng góp CÓ DẤU của từng nguồn vào quỹ — một chỗ định nghĩa dấu, thu/chi và số dư cùng đọc từ đây.
 *
 * `thuNhap` là nguồn BẮT BUỘC, không phải "thêm cho đủ": lúc tất toán một sổ tiết kiệm, GỐC về quỹ
 * bằng dòng `CashMovement` kind `SAVINGS_IN` (đã nằm trong `ghiTayVao`), còn LÃI đi ĐƯỜNG KHÁC —
 * bảng `ThuNhap` — vì Lãi/Lỗ chỉ được phép đọc bảng đó, không được đọc sổ tiết kiệm. Thiếu nguồn này
 * thì chủ shop nhận 210tr về tài khoản mà thẻ Quỹ chỉ tăng 200tr: hụt đúng phần lãi, và KHÔNG con số
 * nào khác đỏ vì mọi tổng vẫn "hợp lý". Đối xứng với `chiPhi`: `Expense` là nguồn TRỪ quỹ ở MỌI danh
 * mục, `ThuNhap` là nguồn CỘNG quỹ ở mọi loại.
 */
export function dongGopTheoNguon(t: TongNguon): number[] {
  return [
    t.ghiTayVao,
    -t.ghiTayRa,
    t.tiktokVeBank,
    -t.shopeeRutViCoDau, // rút = âm ⇒ −âm = dương; dòng đảo rút dương tự trừ lại. KHÔNG Math.abs.
    -t.chiPhi,
    -t.adsTiktokViCoDau, // lưu âm ⇒ −âm = cộng lại phần ví đã trả ads
    t.thuNhap, // tiền lãi ĐÃ VỀ tài khoản — dương, nên `thuChiTuTong` tự xếp vào vế THU
    t.banTrucTiep, // khách trả tại shop — dương, vế THU
  ];
}

export function tinhQuyTuTong(t: TongNguon): number {
  return dongGopTheoNguon(t).reduce((s, v) => s + v, 0);
}

/** thu − chi LUÔN bằng tinhQuyTuTong(t) — tách theo DẤU của từng nguồn, không theo tên nguồn. */
export function thuChiTuTong(t: TongNguon): { thu: number; chi: number } {
  let thu = 0;
  let chi = 0;
  for (const v of dongGopTheoNguon(t)) {
    if (v >= 0) thu += v;
    else chi += -v;
  }
  return { thu, chi };
}

export type SoQuyThang = {
  /** Ngày mở sổ = ngày dòng ghi tay đầu tiên; null = chưa mở sổ. */
  d0: Date | null;
  dauKy: number;
  thu: number;
  chi: number;
  cuoiKy: number;
  /** Số dư quỹ tới HÔM NAY (không phụ thuộc kỳ đang xem). */
  quyHomNay: number;
  /** Kỳ đang xem nằm TRỌN trước ngày mở sổ ⇒ chưa có sổ, đừng hiện 4 số 0 như thật. */
  truocMoSo: boolean;
};

/** Ghép 3 tổng (trước from · trong tháng · tới hôm nay) thành 4 số sổ quỹ. `truocThang` đã là tổng [D0, from). */
export function ghepSoQuyThang(
  d0: Date | null,
  truocThang: TongNguon,
  trongThang: TongNguon,
  toiHomNay: TongNguon,
  truocMoSo: boolean
): SoQuyThang {
  const dauKy = tinhQuyTuTong(truocThang);
  const { thu, chi } = thuChiTuTong(trongThang);
  return {
    d0,
    dauKy,
    thu,
    chi,
    cuoiKy: dauKy + thu - chi,
    quyHomNay: tinhQuyTuTong(toiHomNay),
    truocMoSo,
  };
}

/**
 * Nhãn ô "Cuối kỳ" của Sổ quỹ — MỘT luật cho cả thẻ "Quỹ còn lại" lẫn tab Sổ quỹ dòng chạy.
 *
 * Tháng đang chạy: số to là quỹ tới HÔM NAY, còn "Cuối kỳ" là quỹ tới CUỐI THÁNG. Hai số lệch nhau
 * khi có khoản ghi ngày sau hôm nay (chi phí định kỳ, kỳ trả nợ duyệt trước) — không gắn nhãn thì chủ
 * shop cộng các ô lại thấy khác số to và tưởng app tính sai. Tháng đã qua thì hai số là một.
 */
export function nhanCuoiKySoQuy(
  soQuy: Pick<SoQuyThang, "cuoiKy" | "quyHomNay">,
  laThangHienTai: boolean
): { duKien: boolean; nhan: string; ghiChu: string | undefined } {
  const duKien = laThangHienTai && soQuy.cuoiKy !== soQuy.quyHomNay;
  return {
    duKien,
    nhan: duKien ? "Cuối kỳ (dự kiến hết tháng)" : "Cuối kỳ",
    ghiChu: duKien ? "đã tính khoản ghi ngày sau hôm nay" : undefined,
  };
}
