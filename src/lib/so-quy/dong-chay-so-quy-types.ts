/**
 * HỢP ĐỒNG kiểu dữ liệu của Sổ quỹ dạng DÒNG CHẠY (tab "Sổ quỹ" ở /tai-chinh) — tách riêng để phần
 * đọc dữ liệu (`dong-chay-so-quy-queries.ts`) và phần hiển thị cùng bám một định nghĩa.
 *
 * Dòng chạy là CHI TIẾT của đúng con số thẻ "Quỹ còn lại": mỗi dòng là một khoản tiền THẬT đã vào/ra,
 * đọc từ đúng 8 nguồn + đúng cột ngày mà `docTongNguon` (`so-quy-queries.ts`) cộng. Bất biến:
 * `dauKy + Σ(thu − chi) = cuoiKy` và `cuoiKy` BẰNG `tinhSoQuyThang(range).cuoiKy` — lệch là đỏ
 * (`lechDoiChieu`), không bao giờ tự nắn cho khớp.
 */

import type { SoQuyThangDayDu } from "@/lib/so-quy/so-quy-queries";

/** 8 nguồn tiền của Sổ quỹ — mỗi nguồn ứng MỘT trường của `TongNguon` (ghi tay tách vào/ra theo `kind`). */
export type NguonDongQuy =
  /** `CashMovement` — ghi tay ở tab Dòng tiền (vay, góp vốn, trả nợ, sổ tiết kiệm…). */
  | "GHI_TAY"
  /** `TiktokPayment` PAID — TikTok chuyển về bank, theo `paidTime`. */
  | "TIKTOK_VE_BANK"
  /** `ShopeeSettlement` WITHDRAWAL — rút ví Shopee về bank, theo `txnTime`, có dấu. */
  | "SHOPEE_RUT_VI"
  /** `Expense` KHÔNG phải ads tự động — mỗi khoản chi một dòng. */
  | "CHI_PHI"
  /** `Expense` source `ADS_API` — GỘP một dòng / ngày / nền tảng quảng cáo (chủ shop chốt 24/09). */
  | "CHI_PHI_ADS_GOP"
  /** `TiktokAdsSettlement` — ads TikTok sàn đã trừ từ ví, cộng lại vào quỹ, theo `orderCreateTime`. */
  | "ADS_TIKTOK_TRU_VI"
  /** `ThuNhap` — thu nhập tài chính đã nhận (lãi sổ tiết kiệm). */
  | "THU_NHAP"
  /** `Order.paidAtShop` — khách trả tại shop, đơn bán trực tiếp COMPLETED, theo `orderedAt`. */
  | "BAN_TRUC_TIEP";

export type DongSoQuy = {
  /** Khoá ổn định, duy nhất trong kỳ (vd `GHI_TAY:<id>`, `CHI_PHI_ADS_GOP:2026-09-12:META`). */
  key: string;
  /** Thời điểm dùng để xếp thứ tự — CHÍNH cột ngày mà nguồn đó bị lọc theo kỳ. */
  ngay: Date;
  nguon: NguonDongQuy;
  /** Diễn giải cho người đọc (loại ghi tay + mô tả, tên danh mục + ghi chú, "Meta — 5 chiến dịch"…). */
  dienGiai: string;
  /** Tiền VÀO quỹ (≥ 0). Một dòng có TỐI ĐA MỘT trong hai vế `thu`/`chi` khác 0. */
  thu: number;
  /** Tiền RA khỏi quỹ (≥ 0). */
  chi: number;
  /** Số dư quỹ SAU dòng này. */
  soDu: number;
};

export type SoQuyDongChay =
  /** Chưa có dòng ghi tay nào ⇒ chưa mở sổ (thẻ Quỹ chỉ mời nhập quỹ). */
  | { trangThai: "CHUA_MO_SO" }
  /** Kỳ đang xem nằm TRỌN trước ngày mở sổ. */
  | { trangThai: "TRUOC_MO_SO"; d0: Date }
  | {
      trangThai: "CO_SO";
      d0: Date;
      /** Mốc đầu thật của bảng = max(đầu kỳ đang xem, ngày mở sổ). */
      tu: Date;
      den: Date;
      /** = `tinhSoQuyThang(range).dauKy`. */
      dauKy: number;
      /** = `tinhSoQuyThang(range).cuoiKy` (số của THẺ, không phải số tự cộng từ các dòng). */
      cuoiKy: number;
      /**
       * Σ `thu` / Σ `chi` của các dòng. CÓ THỂ khác thu/chi của thẻ Quỹ: thẻ tách vào/ra theo dấu TỔNG
       * từng nguồn (vd rút ví Shopee và dòng đảo rút cùng tháng bù trừ trước), còn ở đây tách theo từng
       * dòng. Hiệu `tongThu − tongChi` thì LUÔN bằng hiệu của thẻ — chỉ `cuoiKy` là con số đối chiếu.
       */
      tongThu: number;
      tongChi: number;
      /** Cũ → mới. Rỗng khi kỳ không phát sinh gì. */
      dong: DongSoQuy[];
      /**
       * `dauKy + tongThu − tongChi` ≠ `cuoiKy` của thẻ ⇒ dòng chạy đọc lệch nguồn/cột ngày với thẻ.
       * KHÔNG nắn số — hiển thị đỏ cả hai con số để chủ shop thấy và báo lại.
       */
      lechDoiChieu: null | { cuoiKyThe: number; cuoiKyTuDong: number };
      /**
       * Nguyên số liệu thẻ "Quỹ còn lại" của cùng kỳ (đã đọc sẵn để lấy đầu/cuối kỳ) — cho tab dùng
       * LẠI đúng khối cảnh báo của thẻ (`SoQuyCanhBao`) và đúng luật nhãn "Cuối kỳ (dự kiến hết
       * tháng)" (`cuoiKy !== quyHomNay` ở tháng hiện tại). Bỏ rơi cảnh báo thì tab trông đầy đủ trong
       * khi thẻ đang kêu quỹ thiếu một khoản.
       */
      the: SoQuyThangDayDu;
    };
