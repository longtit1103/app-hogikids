/**
 * Chú thích chân tab THEO NGUỒN. Bài học 21/08: gán lý do của một nguồn cho mọi nguồn là khẳng định
 * sai sự thật ("TikTok không trả chỉ số" dán lên bảng Meta đang hiện đủ số). Mỗi nguồn một câu riêng,
 * và chỉ hiện câu của nguồn thật sự có mặt trên tab.
 */

export type NguonMarketing = "TIKTOK_SHOP_ANALYTICS" | "TIKTOK_ADS" | "PANCAKE";

const CAU: Record<NguonMarketing, string> = {
  TIKTOK_SHOP_ANALYTICS:
    "Số phễu/nội dung/creator lấy từ TikTok Shop Analytics — do sàn tự nhận công cho hoạt động, theo múi giờ shop (VN). Chỉ tham khảo.",
  TIKTOK_ADS:
    "Chi tiêu lấy từ Sổ chi phí (đã gồm VAT, khớp Lãi/Lỗ); Đơn/GMV/ROI lấy từ TikTok Ads — số sàn tự nhận công, không phải doanh thu.",
  PANCAKE: "Đơn, doanh thu và hoa hồng là số THẬT từ Pancake — cùng nguồn với Lãi/Lỗ và mục Kênh.",
};

export function ChuThichNguon({ nguon }: { nguon: NguonMarketing[] }) {
  return (
    <div className="flex flex-col gap-1 border-t border-hairline pt-2 text-xs text-muted-foreground">
      {nguon.map((n) => (
        <p key={n}>{CAU[n]}</p>
      ))}
    </div>
  );
}
