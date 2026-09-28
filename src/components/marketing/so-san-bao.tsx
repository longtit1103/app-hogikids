/**
 * RÀO của mục Marketing (spec §4.7): bọc MỌI tiền / đếm đơn / ROI do sàn báo.
 *
 * Vì sao phải là component chứ không phải "nhớ ghi chú thích": bất biến #2 nói doanh thu chỉ đến từ
 * Pancake. Một con số sàn nằm trần trên màn hình, cạnh các con số thật, sẽ được đọc như tiền thật —
 * và quyết định tiền sẽ ra trên số sai. Ép qua một component là biến "nhớ" thành thứ máy kiểm được.
 */

export const TOOLTIP_SO_SAN_BAO =
  "Số do TikTok tự nhận công cho hoạt động này. Chỉ để so sánh tương đối; doanh thu/lãi thật xem ở Kênh (Pancake).";

export function SoSanBao({ children }: { children: React.ReactNode }) {
  return (
    // `title` chứ không phải tooltip JS: Playwright tự rê chuột khi click nên test tooltip-hover
    // xanh giả (bài học PR #73). Thuộc tính `title` assert được bằng toHaveAttribute, không cần hover.
    <span className="inline-flex items-baseline gap-1" title={TOOLTIP_SO_SAN_BAO}>
      {children}
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">sàn báo</span>
    </span>
  );
}
