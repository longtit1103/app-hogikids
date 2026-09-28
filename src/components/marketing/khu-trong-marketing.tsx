/**
 * Empty-state dùng chung cho tab chưa có nguồn dữ liệu. Câu chữ lấy NGUYÊN VĂN từ spec §5.1/§5.3 —
 * e2e neo vào chính chuỗi này, đổi chữ là phải đổi cả spec lẫn test cùng lúc.
 *
 * Ruling P2-R39: "Cài đặt → Kết nối" trỏ tới khối KHÔNG TỒN TẠI — tên thật của khối chứa cấu hình
 * kết nối + log đồng bộ ở `/cai-dat` là "Kết nối & Đồng bộ" (`src/app/(app)/cai-dat/page.tsx`).
 */

export const CHUA_KET_NOI_ANALYTICS = "Chưa kết nối TikTok Shop Analytics — xem Cài đặt → Kết nối & Đồng bộ";
// `CAN_SCOPE_AFFILIATE` đã GỠ (P3): scope Affiliate có từ 26/08, tab creator nay đọc dữ liệu thật —
// trạng thái rỗng mới là "Kỳ này chưa có đơn affiliate" (trong `creator-section.tsx`).

export function KhuTrongMarketing({ tieuDe, loiNhan }: { tieuDe: string; loiNhan: string }) {
  return (
    <section className="rounded-xl border border-hairline p-4">
      <h2 className="text-sm text-muted-foreground">{tieuDe}</h2>
      <p className="mt-2 text-xs text-muted-foreground">{loiNhan}</p>
    </section>
  );
}
