import { format } from "date-fns";

import type { DeXuatKy } from "@/lib/so-quy/lich-tra-no";
import type { KhoanVayRow } from "@/lib/so-quy/khoan-vay-queries";

import { KhoanVayAddButton } from "./khoan-vay-add-button";
import { KhoanVayTable } from "./khoan-vay-table";
import { KyTraNoCard } from "./ky-tra-no-card";

/**
 * Khối "Khoản vay" của tab Dòng tiền (spec §5.5) — `id="khoan-vay"` là đích của banner shell và của
 * link "Tạo khoản vay mới" trong modal ghi tay, đừng đổi.
 *
 * Dưới bảng là các thẻ kỳ trả nợ CHỜ DUYỆT — mỗi khoản còn hiệu lực tối đa một thẻ, vì kỳ được duyệt
 * tuần tự từng cái một (con dấu `lastDueHandled` đơn điệu). Server component thuần hiển thị.
 */
export function KhoanVaySection({ loans }: { loans: KhoanVayRow[] }) {
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
        <KhoanVayAddButton />
      </div>

      {loans.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">Chưa có khoản vay nào.</p>
      ) : (
        <div className="mt-3">
          <KhoanVayTable rows={loans} />
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
    </div>
  );
}
