import type { CashMovementRow } from "@/lib/cash-movements/cash-movement-queries";
import { formatVnd } from "@/lib/format";
import type { KhoanVayRow } from "@/lib/so-quy/khoan-vay-queries";
import type { SoTietKiemRow } from "@/lib/tiet-kiem/so-tiet-kiem-queries";

import { CashMovementAddButton } from "./cash-movement-add-button";
import { CashMovementTable } from "./cash-movement-table";

/**
 * Khối "Nhập quỹ / rút quỹ (ghi tay)" của tab Dòng tiền — góp vốn/nhập quỹ, vay vốn, thu khác, bán
 * trực tiếp, trả nợ gốc, rút vốn. Trục DÒNG TIỀN thuần: đóng góp vào quỹ, KHÔNG vào Lãi/Lỗ, KHÔNG
 * gộp vào "Tiền đã về" (tiền sàn trả). Server component thuần hiển thị; nút thêm + bảng sửa/xoá là
 * client con.
 *
 * `id="ghi-tay"` để neo được từ ngoài: thẻ Quỹ lúc CHƯA mở sổ cũng có một nút "+ Nhập quỹ", nên mọi
 * phép tìm nút theo tên đều phải nói rõ đang tìm nút nào.
 */
export function CashMovementSection({
  inTotal,
  outTotal,
  rows,
  loans,
  soTietKiem,
  d0,
}: {
  inTotal: number;
  outTotal: number;
  rows: CashMovementRow[];
  /** Danh sách khoản vay cho ô chọn trong modal ghi tay (dòng Vay vốn / Trả nợ gốc). */
  loans: KhoanVayRow[];
  /** Sổ tiết kiệm cho ô chọn ở form ghi tay khi loại dòng là `SAVINGS_OUT`/`SAVINGS_IN`. */
  soTietKiem: SoTietKiemRow[];
  /** Ngày mở sổ quỹ (`soQuy.d0`); null = chưa mở sổ. Modal cần để hỏi lại khi ghi lùi trước D0. */
  d0: Date | null;
}) {
  return (
    <div id="ghi-tay" className="scroll-mt-20 rounded-xl border border-hairline p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm text-muted-foreground">Nhập quỹ / rút quỹ (ghi tay)</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            góp vốn / nhập quỹ · vay vốn · thu khác · bán trực tiếp — trả nợ gốc · rút vốn — chỉ quỹ,
            không vào Lãi/Lỗ
          </p>
        </div>
        <CashMovementAddButton loans={loans} soTietKiem={soTietKiem} d0={d0} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-surface-card p-3">
          <p className="text-xs text-muted-foreground">Vào khác</p>
          <p className="mt-1 font-serif text-xl text-ink">{formatVnd(inTotal)}</p>
        </div>
        <div className="rounded-xl bg-surface-card p-3">
          <p className="text-xs text-muted-foreground">Ra khác</p>
          <p className="mt-1 font-serif text-xl text-ink">{formatVnd(outTotal)}</p>
        </div>
      </div>

      <div className="mt-3">
        <CashMovementTable rows={rows} loans={loans} soTietKiem={soTietKiem} d0={d0} />
      </div>
    </div>
  );
}
