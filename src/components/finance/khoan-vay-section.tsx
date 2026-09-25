import { format } from "date-fns";

import type { DeXuatKy } from "@/lib/so-quy/lich-tra-no";
import type { KhoanVayRow } from "@/lib/so-quy/khoan-vay-queries";

import { KhoanVayAddButton } from "./khoan-vay-add-button";
import { KhoanVayTable } from "./khoan-vay-table";
import { LichTraNoDuKienCard } from "./lich-tra-no-du-kien-card";
import { KyTraNoCard } from "./ky-tra-no-card";

/**
 * Khối "Khoản vay" của tab Dòng tiền (spec §5.5) — `id="khoan-vay"` là đích của banner shell và của
 * link "Tạo khoản vay mới" trong modal ghi tay, đừng đổi.
 *
 * Dưới bảng là các thẻ kỳ trả nợ CHỜ DUYỆT — mỗi khoản còn hiệu lực tối đa một thẻ, vì kỳ được duyệt
 * tuần tự từng cái một (con dấu `lastDueHandled` đơn điệu). Server component thuần hiển thị.
 *
 * Cuối khối là bảng DỰ KIẾN N kỳ tới (chỉ đọc, không ghi được) — đặt SAU thẻ chờ duyệt để thứ bấm
 * được nằm trên thứ chỉ để xem.
 */
export function KhoanVaySection({ loans, d0 }: { loans: KhoanVayRow[]; d0: Date | null }) {
  // Một mốc thời gian DUY NHẤT cho cả khối: gọi `new Date()` ở nhiều chỗ thì hai thẻ có thể rơi hai
  // bên nửa đêm và nói hai chuyện khác nhau về cùng một kỳ.
  const homNay = new Date();
  const kyCho = loans.filter(
    (l): l is KhoanVayRow & { kyCho: DeXuatKy } => l.kyCho !== null && l.closedAt === null
  );

  return (
    <div id="khoan-vay" className="scroll-mt-20 rounded-xl border border-hairline p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm text-muted-foreground">Khoản vay</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            dư nợ suy từ các dòng Vay vốn / Trả nợ gốc — lãi ghi ở Sổ chi phí, gốc chỉ vào quỹ
          </p>
        </div>
        <KhoanVayAddButton d0={d0} />
      </div>

      {loans.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">Chưa có khoản vay nào.</p>
      ) : (
        <div className="mt-3">
          <KhoanVayTable rows={loans} d0={d0} />
        </div>
      )}

      {/*
        Key gồm CẢ ngày đến hạn: hai ô Lãi/Gốc trong thẻ là state khởi tạo từ đề xuất, mà duyệt xong
        kỳ 1 là kỳ 2 hiện ra ngay tại chỗ. Key chỉ theo `loan.id` thì React tái dùng thẻ cũ ⇒ tiêu đề
        sang kỳ 2 nhưng hai ô vẫn giữ số chủ shop vừa gõ cho kỳ 1 — bấm tiếp là ghi sai tiền.
      */}
      {kyCho.map((loan) => (
        <KyTraNoCard key={`${loan.id}:${format(loan.kyCho.denNgay, "yyyy-MM-dd")}`} loan={loan} />
      ))}
      <LichTraNoDuKienCard loans={loans} homNay={homNay} />
    </div>
  );
}
