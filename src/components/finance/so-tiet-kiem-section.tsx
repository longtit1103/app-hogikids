import { startOfDay } from "date-fns";

import type { KhoanVayRow } from "@/lib/so-quy/khoan-vay-queries";
import type { SoTietKiemRow } from "@/lib/tiet-kiem/so-tiet-kiem-queries";

import { SoDaoHanCard } from "./so-dao-han-card";
import { SoTietKiemAddButton } from "./so-tiet-kiem-add-button";
import { SoTietKiemTable } from "./so-tiet-kiem-table";

/**
 * Sổ CHƯA tất toán và ĐÃ tới ngày đáo hạn. Lọc TỪ danh sách đã đọc Ở PAGE (`listSoTietKiem()`)
 * — KHÔNG gọi `demSoDenHan()` thêm để tránh đọc trùng.
 */
export function sosDenHan(rows: SoTietKiemRow[], homNay: Date): SoTietKiemRow[] {
  const hn = startOfDay(homNay);
  return rows.filter((r) => r.closedAt === null && startOfDay(r.maturityDate) <= hn);
}

/**
 * Khối "Sổ tiết kiệm" của tab Dòng tiền (spec mục 11) — `id="tiet-kiem"`, đặt NGAY SAU
 * `KhoanVaySection` (`cash-flow-tab.tsx`). Server component thuần hiển thị (khuôn
 * `khoan-vay-section.tsx`) — nút thêm và bảng có thao tác là client component giữ state dialog.
 *
 * `laiNhanTrongKy` đi XUYÊN QUA từ page chứ không tự cộng ở đây: dòng tổng của bảng nói về KỲ ĐANG
 * XEM, mà `sos` là danh sách TOÀN BỘ sổ (mọi thời điểm) — cộng `laiThucNhan` của chúng lại là số
 * của cả lịch sử, đặt cạnh các số theo tháng thì chủ shop đọc sai chắc chắn (quyết định #6 vòng rà
 * chéo 16/09).
 */
export function SoTietKiemSection({
  sos,
  loans,
  laiNhanTrongKy,
}: {
  sos: SoTietKiemRow[];
  loans: KhoanVayRow[];
  /** Σ `ThuNhap` có ngày trong KỲ ĐANG XEM (`tongLaiDaNhanTrongKy(monthRange)`, tính ở page). */
  laiNhanTrongKy: number;
}) {
  const denHan = sosDenHan(sos, new Date());

  return (
    <div id="tiet-kiem" className="scroll-mt-20 rounded-xl border border-hairline p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm text-muted-foreground">Sổ tiết kiệm</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            gửi ngân hàng lấy lãi — gốc vào/ra quỹ, lãi vào Lãi/Lỗ khi tất toán
          </p>
        </div>
        <SoTietKiemAddButton loans={loans} />
      </div>

      {sos.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">Chưa có sổ tiết kiệm nào.</p>
      ) : (
        <div className="mt-3">
          <SoTietKiemTable rows={sos} loans={loans} laiNhanTrongKy={laiNhanTrongKy} />
        </div>
      )}

      {denHan.map((so) => (
        <SoDaoHanCard key={so.id} so={so} />
      ))}
    </div>
  );
}
