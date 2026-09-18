"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatVnd } from "@/lib/format";

/** Sổ còn chọn được — CALLER (cửa 6, `cash-movement-form-modal.tsx`, Phase 04) đã lọc theo loại dòng
 *  đang ghi (`SAVINGS_OUT`/`SAVINGS_IN`); server còn khoá lại lần cuối (`kiemSoTietKiemConHieuLuc` +
 *  đếm `SAVINGS_OUT` trong transaction) nên danh sách sai ở đây chỉ là UX kém, không phải lỗ hổng. */
export type SoTietKiemChon = { id: string; name: string; dangGui: number };

/**
 * Ô chọn sổ tiết kiệm trong form "Khoản tiền khác" (cửa 6, spec §8.1) — hiện khi loại dòng là
 * `SAVINGS_OUT`/`SAVINGS_IN`. Component THUẦN: không tự đoán lý do rỗng — luật "sổ nào chọn được"
 * (sổ chưa tất toán, sổ chưa từng có dòng gửi cho `SAVINGS_OUT`…) thuộc về cửa 6 (Phase 04), truyền
 * qua `emptyMessage` để không đoán sai một luật không thuộc phase này (khuôn `khoan-vay-select.tsx`,
 * rút gọn vì sổ tiết kiệm không có nhánh BULLET/tất toán nhiều tầng như khoản vay).
 */
export function SoTietKiemSelect({
  sos,
  value,
  onChange,
  error,
  emptyMessage,
  onTaoMoi,
}: {
  sos: SoTietKiemChon[];
  value: string;
  onChange: (id: string) => void;
  error?: string;
  /** Câu giải thích vì sao danh sách rỗng — do CALLER tính theo loại dòng đang ghi. */
  emptyMessage: React.ReactNode;
  /** Đóng modal rồi đưa mắt về khối Sổ tiết kiệm — modal đang mở che hết trang nên
   *  `<a href="#tiet-kiem">` trần chỉ đổi hash rồi đứng yên (khuôn `khoan-vay-select.tsx`). */
  onTaoMoi: () => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-muted-foreground">Sổ tiết kiệm</label>
      {sos.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {emptyMessage}{" "}
          <button type="button" onClick={onTaoMoi} className="underline underline-offset-2">
            Tạo sổ tiết kiệm mới
          </button>
        </p>
      ) : (
        <Select value={value} onValueChange={(v) => onChange(typeof v === "string" ? v : "")}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Chọn sổ tiết kiệm" />
          </SelectTrigger>
          <SelectContent>
            {sos.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name} — đang gửi {formatVnd(s.dangGui)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {error && <p className="text-xs text-error">{error}</p>}
    </div>
  );
}
