/**
 * HỢP ĐỒNG kiểu dữ liệu của biểu đồ quỹ + dự báo "quỹ sắp cạn" (tab "Sổ quỹ" và banner toàn app).
 *
 * Lịch sử = số dư CUỐI NGÀY lấy từ chính dòng chạy (`docSoQuyDongChay`) ⇒ khớp thẻ "Quỹ còn lại".
 * Dự báo = kịch bản THẬN TRỌNG 30 ngày: quỹ hôm nay + các khoản ĐÃ GHI ngày sau hôm nay (dòng chạy của
 * cửa sổ tương lai) + các khoản CHI đã biết nhưng CHƯA ghi (kỳ trả nợ dự kiến `duKienNKy`, chi phí định
 * kỳ đang bật chưa sinh dòng). KHÔNG cộng tiền sàn sẽ về (chưa biết) — nói rõ trên màn hình. Kỳ trả nợ đã duyệt trước
 * hạn (nếu có đường ghi) KHÔNG nằm trong `duKienNKy` (đã đóng dấu) mà nằm trong phần "đã ghi" ⇒ không đếm
 * hai lần. Hạn chế đã biết: ghi tay trả gốc TRƯỚC kỳ vẫn bị `duKienNKy` tính lại kỳ đó (lệch về phía thận
 * trọng, cùng cách thẻ lịch trả nợ dự kiến đang làm).
 */

/** Khoá ngày `yyyy-MM-dd` theo giờ VN. */
export type KhoaNgay = string;

export type DiemSoDu = {
  ngay: KhoaNgay;
  /** Số dư quỹ CUỐI ngày đó. */
  soDu: number;
  /** true = điểm dự báo (sau hôm nay), false = số đã xảy ra. */
  duBao: boolean;
};

export type LoaiKhoanDuKien =
  /** Đã có dòng tiền ghi ngày sau hôm nay (vd kỳ trả nợ duyệt trước hạn). */
  | "DA_GHI"
  /** Kỳ trả nợ dự kiến chưa ghi (`duKienNKy` — tiền thật chuyển ngân hàng); kỳ QUÁ HẠN tính vào hôm nay. */
  | "KY_TRA_NO"
  /**
   * Chi phí định kỳ đang bật CHƯA sinh dòng: lần phát sinh sau hôm nay (trong cửa sổ), và lần của THÁNG
   * NÀY đã tới hạn mà chưa sinh (chưa ai mở tháng) ⇒ tính vào hôm nay.
   */
  | "DINH_KY";

export type KhoanDuKien = {
  ngay: KhoaNgay;
  /** Đóng góp CÓ DẤU vào quỹ: âm = tiền ra, dương = tiền vào. */
  soTien: number;
  moTa: string;
  loai: LoaiKhoanDuKien;
};

export type DuBaoQuy =
  | { trangThai: "CHUA_MO_SO" }
  | {
      trangThai: "CO_SO";
      homNay: KhoaNgay;
      quyHomNay: number;
      /** Quỹ tối thiểu chủ shop đặt; chưa đặt = 0. */
      nguong: number;
      nguongDaDat: boolean;
      /** Tối đa 90 điểm tới HÔM NAY (bắt đầu từ ngày mở sổ nếu sổ mở chưa đủ 90 ngày). */
      lichSu: DiemSoDu[];
      /** 30 điểm SAU hôm nay. */
      duBao: DiemSoDu[];
      /** Mọi khoản làm đổi số dư trong cửa sổ dự báo, cũ → mới. */
      khoanDuKien: KhoanDuKien[];
      /** Ngày dự báo ĐẦU TIÊN số dư < ngưỡng (null = không chạm) + các khoản của đúng ngày đó. */
      cham: null | { ngay: KhoaNgay; soDu: number; khoan: KhoanDuKien[] };
      /** Điểm thấp nhất trong cửa sổ dự báo. */
      thapNhat: { ngay: KhoaNgay; soDu: number };
    };

/** Bản rút gọn cho banner toàn app — null khi không chạm ngưỡng / chưa mở sổ. */
export type CanhBaoSapCan = null | {
  ngay: KhoaNgay;
  soDu: number;
  nguong: number;
  /** Chưa đặt ngưỡng (= 0) ⇒ "chạm" nghĩa là dự báo quỹ ÂM — câu banner phải nói đúng như vậy. */
  nguongDaDat: boolean;
};
